const axios = require('axios');
const { extractSearchTerms } = require('./helpers');
const { calcRelevance } = require('./fuzzy');

async function searchConfluence(query, limit = 25) {
  try {
    const token = process.env.ATLASSIAN_CONFLUENCE_TOKEN;
    const cloudId = process.env.ATLASSIAN_CLOUD_ID;
    const domain = process.env.ATLASSIAN_DOMAIN;

    if (!token || !cloudId) {
      console.log('[CONFLUENCE] Credentials missing');
      return [];
    }

    const searchTerms = extractSearchTerms(query);
    console.log('[CONFLUENCE] Searching:', searchTerms);

    const response = await axios.get(
      `https://api.atlassian.com/ex/confluence/${cloudId}/rest/api/search`,
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        params: {
          cql: `text ~ "${searchTerms}" AND type=page`,
          limit,
          expand: 'content.space,content.body.view'
        },
        timeout: 90000
      }
    );

    const results = response.data.results || [];
    console.log('[CONFLUENCE] Found:', results.length);

    return results.map(result => {
      const content = result.content;
      const title = content?.title || 'Untitled';
      const spaceKey = content?.space?.key || 'Unknown';

      let pageUrl = '';
      if (content?._links?.webui) {
        pageUrl = content._links.webui.startsWith('http')
          ? content._links.webui
          : `https://${domain}/wiki${content._links.webui}`;
      } else if (content?.id) {
        pageUrl = `https://${domain}/wiki/spaces/${spaceKey}/pages/${content.id}`;
      }

      const excerpt = (content?.body?.view?.value || '').replace(/<[^>]*>/g, '').substring(0, 200).trim();

      return {
        source: 'Confluence',
        title,
        url: pageUrl,
        excerpt,
        metadata: `Space: ${spaceKey}`,
        relevanceScore: calcRelevance(title, excerpt, searchTerms)
      };
    });
  } catch (e) {
    console.error('[CONFLUENCE] Error:', e.message);
    return [];
  }
}

async function searchSharePoint(query, limit = 25) {
  try {
    const token = process.env.MICROSOFT_ACCESS_TOKEN;

    if (!token) {
      console.log('[SHAREPOINT] Credentials missing');
      return [];
    }

    const searchTerms = extractSearchTerms(query);
    console.log('[SHAREPOINT] Searching:', searchTerms);

    const response = await axios.post(
      'https://graph.microsoft.com/v1.0/search/query',
      {
        requests: [{
          entityTypes: ['driveItem'],
          query: { queryString: searchTerms },
          from: 0,
          size: limit
        }]
      },
      {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 90000
      }
    );

    const hits = response.data.value?.[0]?.hitsContainers?.[0]?.hits || [];
    console.log('[SHAREPOINT] Found:', hits.length);

    return hits.map(hit => {
      const resource = hit.resource;
      return {
        source: 'SharePoint',
        title: resource.name || 'Untitled',
        url: resource.webUrl || '',
        excerpt: (hit.summary || '').substring(0, 200).trim(),
        metadata: `Type: ${resource.file?.mimeType || 'Unknown'}`,
        relevanceScore: calcRelevance(resource.name || '', hit.summary || '', searchTerms)
      };
    });
  } catch (e) {
    console.error('[SHAREPOINT] Error:', e.message);
    return [];
  }
}

async function searchBox(query, limit = 25) {
  try {
    const token = process.env.BOX_ACCESS_TOKEN;

    if (!token) {
      console.log('[BOX] Credentials missing');
      return [];
    }

    const searchTerms = extractSearchTerms(query);
    console.log('[BOX] Searching:', searchTerms);

    const response = await axios.get(
      'https://api.box.com/2.0/search',
      {
        headers: { 'Authorization': `Bearer ${token}` },
        params: { query: searchTerms, type: 'file', limit, fields: 'id,name,description,size' },
        timeout: 90000
      }
    );

    const entries = response.data.entries || [];
    console.log('[BOX] Found:', entries.length);

    return entries.map(file => ({
      source: 'Box',
      title: file.name || 'Untitled',
      url: `https://app.box.com/file/${file.id}`,
      excerpt: (file.description || '').substring(0, 200).trim(),
      metadata: `Size: ${((file.size || 0) / 1024).toFixed(2)} KB`,
      relevanceScore: calcRelevance(file.name || '', file.description || '', searchTerms)
    }));
  } catch (e) {
    console.error('[BOX] Error:', e.message);
    return [];
  }
}

function rankAndMergeResults(confluenceResults, sharepointResults, boxResults, topN = 50) {
  const all = [];
  if (confluenceResults) all.push(...confluenceResults);
  if (sharepointResults) all.push(...sharepointResults);
  if (boxResults) all.push(...boxResults);

  all.sort((a, b) => b.relevanceScore - a.relevanceScore);

  const filtered = all.filter(item => item.relevanceScore > 10);
  console.log('[RANKING] Total:', all.length, 'After filtering:', filtered.length);

  return filtered.slice(0, topN);
}

function formatResults(results, query) {
  if (!results || results.length === 0) {
    return `No results found for "${query}".`;
  }

  const counts = {
    Confluence: results.filter(r => r.source === 'Confluence').length,
    SharePoint: results.filter(r => r.source === 'SharePoint').length,
    Box: results.filter(r => r.source === 'Box').length
  };

  // Only show sources that have results
  const activeSources = Object.entries(counts).filter(([, c]) => c > 0);
  const sourceLabel = activeSources.map(([s]) => s).join(', ');

  let out = `Found ${results.length} results from ${sourceLabel}:\n`;
  activeSources.forEach(([source, count]) => {
    out += `  - ${source}: ${count}\n`;
  });
  out += '\n';

  results.forEach((r, i) => {
    out += `${i + 1}. [${r.source}] "${r.title}"\n`;
    if (r.url) out += `   URL: ${r.url}\n`;
    if (r.metadata) out += `   ${r.metadata}\n`;
    if (r.excerpt) out += `   Preview: ${r.excerpt}${r.excerpt.length >= 200 ? '...' : ''}\n`;
    out += '\n';
  });

  return out;
}

module.exports = {
  searchConfluence,
  searchSharePoint,
  searchBox,
  rankAndMergeResults,
  formatResults
};
