const express = require('express');
const axios = require('axios');
const { searchConfluence, searchSharePoint, searchBox, rankAndMergeResults, formatResults } = require('./lib/sources');
const { trackQuery, checkCache, storeCache } = require('./lib/analytics');
const { extractUserQuery, isConversationTitleRequest, extractUserQueryFromEmbeddedConversation, generateTitleFromQuery } = require('./lib/helpers');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3001;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

const SOURCE_CONFIG = {
  confluence: {
    search: (q) => searchConfluence(q),
    displayModel: 'openai-confluence-search',
    endpointName: 'openai-confluence',
    titlePrefix: 'Confluence'
  },
  sharepoint: {
    search: (q) => searchSharePoint(q),
    displayModel: 'openai-sharepoint-search',
    endpointName: 'openai-sharepoint',
    titlePrefix: 'SharePoint'
  },
  box: {
    search: (q) => searchBox(q),
    displayModel: 'openai-box-search',
    endpointName: 'openai-box',
    titlePrefix: 'Box'
  },
  unified: {
    search: async (q) => {
      const [c, s, b] = await Promise.all([
        searchConfluence(q), searchSharePoint(q), searchBox(q)
      ]);
      return rankAndMergeResults(c, s, b);
    },
    displayModel: 'openai-unified-search',
    endpointName: 'unified-openai',
    titlePrefix: 'Search'
  }
};

console.log('========================================');
console.log('OPENAI SEARCH PROXY v1.0');
console.log('Sources: confluence, sharepoint, box, unified');
console.log('Model:', OPENAI_MODEL);
console.log('========================================');

// Validate source middleware
function validateSource(req, res, next) {
  const source = req.params.source;
  if (!SOURCE_CONFIG[source]) {
    return res.status(404).json({
      error: `Unknown source: ${source}. Valid sources: ${Object.keys(SOURCE_CONFIG).join(', ')}`
    });
  }
  req.sourceConfig = SOURCE_CONFIG[source];
  next();
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'OpenAI Search Proxy',
    version: '1.0',
    model: OPENAI_MODEL,
    sources: Object.keys(SOURCE_CONFIG)
  });
});

// Models endpoint (per source)
app.get('/:source/models', validateSource, (req, res) => {
  const config = req.sourceConfig;
  res.json({
    object: 'list',
    data: [{
      id: config.displayModel,
      object: 'model',
      created: 1677610602,
      owned_by: 'openai'
    }]
  });
});

// Call OpenAI API
async function callOpenAI(messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  console.log(`[OPENAI] Calling API (${OPENAI_MODEL})...`);

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: OPENAI_MODEL,
      messages,
      max_completion_tokens: 16384
    },
    {
      timeout: 135000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    }
  );

  const content = response.data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content from OpenAI');

  console.log('[OPENAI] Success, length:', content.length);
  return content.trim();
}

// Send SSE streaming response
function sendStreamResponse(res, content, model) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const words = content.split(' ');
  const chunkSize = 6;

  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize).join(' ') + ' ';
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
    })}\n\n`);
  }

  res.write(`data: ${JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// Main chat completions endpoint
app.post('/:source/chat/completions', validateSource, async (req, res) => {
  const start = Date.now();
  const config = req.sourceConfig;
  const qdata = {
    timestamp: new Date(),
    endpoint: config.endpointName,
    model: OPENAI_MODEL,
    success: false,
    cached: false,
    query: '',
    userId: req.headers['x-user-id'] || 'anonymous',
    responseTime: 0,
    resultsCount: 0,
    sources: {}
  };

  try {
    const { messages = [], stream = false } = req.body;

    console.log(`\n========== [${req.params.source.toUpperCase()}] NEW REQUEST ==========`);

    // Handle title generation
    if (isConversationTitleRequest(messages)) {
      const titleContent = messages[messages.length - 1].content;
      const userQuery = extractUserQueryFromEmbeddedConversation(titleContent);
      const title = generateTitleFromQuery(userQuery, config.titlePrefix);
      console.log('[TITLE]', title);

      return res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: config.displayModel,
        choices: [{ index: 0, message: { role: 'assistant', content: title }, finish_reason: 'stop' }]
      });
    }

    const userQuery = extractUserQuery(messages);
    console.log('[QUERY]', userQuery);
    qdata.query = userQuery;

    // Check cache
    const cache = await checkCache(userQuery, config.endpointName);
    if (cache.cached) {
      console.log('[CACHE HIT]');
      qdata.cached = true;
      qdata.success = true;
      qdata.responseTime = Date.now() - start;
      qdata.resultsCount = cache.results.resultsCount || 0;
      qdata.sources = cache.results.sources || {};
      trackQuery(qdata);

      const content = (cache.results.formattedResponse || 'Cached') + '\n\n[From cache]';

      if (stream) return sendStreamResponse(res, content, config.displayModel);
      return res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: config.displayModel,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
      });
    }

    // Search source(s)
    console.log('[SEARCH] Searching...');
    const results = await config.search(userQuery);
    qdata.resultsCount = results.length;

    if (req.params.source === 'unified') {
      qdata.sources = {
        confluence: results.filter(r => r.source === 'Confluence').length,
        sharepoint: results.filter(r => r.source === 'SharePoint').length,
        box: results.filter(r => r.source === 'Box').length
      };
    } else {
      qdata.sources = { [req.params.source]: results.length };
    }

    console.log('[RESULTS]', results.length, 'total');

    // Build enhanced messages for OpenAI
    const enhancedMessages = [...messages];

    if (results.length > 0) {
      const formatted = formatResults(results, userQuery);
      const sourceLabel = req.params.source === 'unified'
        ? 'Confluence, SharePoint, and Box'
        : config.titlePrefix;
      enhancedMessages.push({
        role: 'system',
        content: `Please provide a comprehensive answer based on these search results from ${sourceLabel}. ` +
          `Include source citations and URLs in your response.\n\nSearch Results:\n${formatted}\n\n` +
          `User question: ${userQuery}\n\nProvide a detailed answer with proper source attribution and include the URLs.`
      });
    } else {
      enhancedMessages.push({
        role: 'system',
        content: `I searched for "${userQuery}" but did not find specific results. However, I can still help answer the question.`
      });
    }

    // Call OpenAI
    const content = await callOpenAI(enhancedMessages);

    if (!content || content.trim().length === 0) {
      throw new Error('Empty content generated');
    }

    // Store in cache
    const cacheData = {
      formattedResponse: content,
      resultsCount: results.length,
      sources: qdata.sources
    };
    storeCache(userQuery, config.endpointName, cacheData);

    qdata.success = true;
    qdata.responseTime = Date.now() - start;
    trackQuery(qdata);

    console.log(`[SUCCESS] ${qdata.responseTime}ms`);

    if (stream) return sendStreamResponse(res, content, config.displayModel);

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: config.displayModel,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
    });

  } catch (error) {
    console.error('[ERROR]', error.message);
    qdata.success = false;
    qdata.responseTime = Date.now() - start;
    qdata.error = error.message;
    trackQuery(qdata);

    res.status(500).json({
      error: { message: error.message, type: 'api_error', code: 'internal_error' }
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenAI Search Proxy running on port ${PORT}`);
  console.log('Routes: /:source/chat/completions where source = confluence|sharepoint|box|unified');
});
