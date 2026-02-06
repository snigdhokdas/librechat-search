const express = require('express');
const axios = require('axios');
const { searchConfluence, searchSharePoint, searchBox, rankAndMergeResults, formatResults } = require('./lib/sources');
const { trackQuery, checkCache, storeCache } = require('./lib/analytics');
const { extractUserQuery, isConversationTitleRequest, extractUserQueryFromEmbeddedConversation, generateTitleFromQuery } = require('./lib/helpers');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SOURCE_CONFIG = {
  confluence: {
    search: (q) => searchConfluence(q),
    displayModel: 'gemini-confluence-search',
    endpointName: 'gemini-confluence',
    titlePrefix: 'Confluence'
  },
  sharepoint: {
    search: (q) => searchSharePoint(q),
    displayModel: 'gemini-sharepoint-search',
    endpointName: 'gemini-sharepoint',
    titlePrefix: 'SharePoint'
  },
  box: {
    search: (q) => searchBox(q),
    displayModel: 'gemini-box-search',
    endpointName: 'gemini-box',
    titlePrefix: 'Box'
  },
  unified: {
    search: async (q) => {
      const [c, s, b] = await Promise.all([
        searchConfluence(q), searchSharePoint(q), searchBox(q)
      ]);
      return rankAndMergeResults(c, s, b);
    },
    displayModel: 'gemini-unified-search',
    endpointName: 'unified-gemini',
    titlePrefix: 'Search'
  }
};

console.log('========================================');
console.log('GEMINI SEARCH PROXY v1.0');
console.log('Sources: confluence, sharepoint, box, unified');
console.log('Model:', GEMINI_MODEL);
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
    service: 'Gemini Search Proxy',
    version: '1.0',
    model: GEMINI_MODEL,
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
      owned_by: 'gemini'
    }]
  });
});

// Call Gemini API
async function callGeminiAPI(prompt) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY not configured');

  console.log('[GEMINI] Calling API...');

  const response = await axios.post(
    GEMINI_API_URL,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192
      }
    },
    {
      timeout: 90000,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      }
    }
  );

  const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('No content from Gemini');

  console.log('[GEMINI] Success, length:', content.length);
  return content.trim();
}

// Send SSE streaming response
function sendStreamResponse(res, content, model) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const chunkSize = 50;
  for (let i = 0; i < content.length; i += chunkSize) {
    const piece = content.substring(i, i + chunkSize);
    const chunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }]
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
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

// Send JSON response
function sendJsonResponse(res, content, model, promptLength) {
  res.json({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: Math.ceil(promptLength / 4),
      completion_tokens: Math.ceil(content.length / 4),
      total_tokens: Math.ceil((promptLength + content.length) / 4)
    }
  });
}

// Main chat completions endpoint
app.post('/:source/chat/completions', validateSource, async (req, res) => {
  const start = Date.now();
  const config = req.sourceConfig;
  const qdata = {
    timestamp: new Date(),
    endpoint: config.endpointName,
    model: GEMINI_MODEL,
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

      if (stream) {
        return sendStreamResponse(res, title, config.displayModel);
      }
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

      const content = (cache.results.formattedResponse || 'Cached') + '\n\n_[From cache]_';

      if (stream) return sendStreamResponse(res, content, config.displayModel);
      return sendJsonResponse(res, content, config.displayModel, 100);
    }

    // Search source(s)
    console.log('[SEARCH] Searching...');
    const results = await config.search(userQuery);
    qdata.resultsCount = results.length;

    // Track source counts for unified
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

    // Build prompt
    let prompt;
    if (results.length > 0) {
      const formatted = formatResults(results, userQuery);
      const sourceLabel = req.params.source === 'unified'
        ? 'Confluence, SharePoint, and Box'
        : config.titlePrefix;
      prompt = `Based on these search results from ${sourceLabel}:\n\n${formatted}\n\n` +
        `Question: ${userQuery}\n\n` +
        'Provide a comprehensive answer with source links using [Title](URL) format.';
    } else {
      prompt = `No results found for: ${userQuery}. Provide a helpful general answer.`;
    }

    // Call Gemini
    const content = await callGeminiAPI(prompt);

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
    return sendJsonResponse(res, content, config.displayModel, prompt.length);

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
  console.log(`Gemini Search Proxy running on port ${PORT}`);
  console.log('Routes: /:source/chat/completions where source = confluence|sharepoint|box|unified');
});
