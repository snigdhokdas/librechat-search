const axios = require('axios');

const ANALYTICS_URL = process.env.ANALYTICS_URL || 'http://analytics-service.librechat.svc.cluster.local:3008';

async function trackQuery(qdata) {
  try {
    await axios.post(ANALYTICS_URL + '/api/analytics/track', qdata, { timeout: 5000 });
  } catch (e) {
    console.error('[ANALYTICS] Failed:', e.message);
  }
}

async function checkCache(query, endpoint) {
  try {
    const r = await axios.post(
      ANALYTICS_URL + '/api/analytics/cache/check',
      { query: query.toLowerCase().trim(), endpoint },
      { timeout: 5000 }
    );
    return r.data;
  } catch (e) {
    return { cached: false };
  }
}

async function storeCache(query, endpoint, results) {
  try {
    await axios.post(
      ANALYTICS_URL + '/api/analytics/cache/store',
      { query: query.toLowerCase().trim(), endpoint, results },
      { timeout: 5000 }
    );
  } catch (e) {
    console.error('[CACHE] Store failed:', e.message);
  }
}

module.exports = { trackQuery, checkCache, storeCache };
