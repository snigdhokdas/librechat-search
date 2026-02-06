const express = require('express');
const { MongoClient } = require('mongodb');
const redis = require('redis');

const app = express();
app.use(express.json({ limit: '100mb' }));

const MONGO_URI = process.env.MONGO_URI;
const REDIS_URI = process.env.REDIS_URI;
const PORT = process.env.PORT || 3008;

let mongoClient;
let db;
let redisClient;

console.log('========================================');
console.log('ANALYTICS SERVICE - ENHANCED v2.0');
console.log('Features: Query Tracking, Caching, Dashboard');
console.log('========================================');

async function initMongo() {
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db();
    
    await db.collection('search_analytics').createIndex({ timestamp: -1 });
    await db.collection('search_analytics').createIndex({ endpoint: 1 });
    await db.collection('search_analytics').createIndex({ query: 1 });
    await db.collection('search_analytics').createIndex({ userId: 1 });
    
    console.log('[MONGO] ✓ Connected and indexed');
  } catch (e) {
    console.error('[MONGO] Connection failed:', e.message);
    throw e;
  }
}

async function initRedis() {
  try {
    redisClient = redis.createClient({ url: REDIS_URI });
    redisClient.on('error', err => console.error('[REDIS] Error:', err));
    await redisClient.connect();
    console.log('[REDIS] ✓ Connected');
  } catch (e) {
    console.error('[REDIS] Connection failed:', e.message);
    throw e;
  }
}

app.get('/health', (req, res) => {
  const mongoOk = mongoClient && mongoClient.topology && mongoClient.topology.isConnected();
  const redisOk = redisClient && redisClient.isOpen;
  
  res.json({
    status: mongoOk && redisOk ? 'healthy' : 'degraded',
    service: 'Analytics Service',
    version: '2.0',
    components: {
      mongodb: mongoOk ? 'connected' : 'disconnected',
      redis: redisOk ? 'connected' : 'disconnected'
    }
  });
});

app.post('/api/analytics/track', async (req, res) => {
  try {
    const data = {
      ...req.body,
      timestamp: new Date(),
      ip: req.ip,
      userAgent: req.headers['user-agent']
    };
    
    await db.collection('search_analytics').insertOne(data);
    
    console.log('[TRACK] Query logged:', data.query?.substring(0, 50));
    res.json({ success: true });
  } catch (e) {
    console.error('[TRACK] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Normalize query for cache key
function normalizeCacheKey(query) {
  if (!query) return 'empty';
  
  // Stop words to remove
  const stopWords = ['what', 'is', 'are', 'the', 'a', 'an', 'please', 'tell', 'me', 'about', 'how', 'why', 'when', 'where', 'can', 'you', 'do', 'does'];
  
  // Clean and normalize
  const normalized = query
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, ' ')  // Remove punctuation
    .split(/\s+/)               // Split into words
    .filter(w => w.length > 1 && !stopWords.includes(w))  // Remove stop words
    .sort()                     // Sort alphabetically (so "k8s devops" = "devops k8s")
    .join(' ');
  
  return normalized || 'empty';
}

app.post('/api/analytics/cache/check', async (req, res) => {
  try {
    const { query, endpoint } = req.body;
    const normalizedKey = normalizeCacheKey(query);
    const key = `cache:${endpoint}:${normalizedKey}`;
    
    console.log('[CACHE] Original query:', query);
    console.log('[CACHE] Normalized key:', normalizedKey);
    
    const cached = await redisClient.get(key);
    
    if (cached) {
      console.log('[CACHE] HIT for:', normalizedKey);
      res.json({ cached: true, results: JSON.parse(cached) });
    } else {
      console.log('[CACHE] MISS for:', normalizedKey);
      res.json({ cached: false });
    }
  } catch (e) {
    console.error('[CACHE] Check error:', e.message);
    res.json({ cached: false });
  }
});

app.post('/api/analytics/cache/store', async (req, res) => {
  try {
    const { query, endpoint, results } = req.body;
    const normalizedKey = normalizeCacheKey(query);
    const key = `cache:${endpoint}:${normalizedKey}`;
    
    // Cache for 24 hours (86400 seconds) instead of 1 hour
    // Options: 3600 (1hr), 21600 (6hrs), 43200 (12hrs), 86400 (24hrs), 604800 (7 days)
    await redisClient.setEx(key, 86400, JSON.stringify(results));
    
    console.log('[CACHE] STORED:', query.substring(0, 50), '(TTL: 24 hours)');
    res.json({ success: true });
  } catch (e) {
    console.error('[CACHE] Store error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


function calculateCostOptimization(queries) {
  // Pricing per 1M tokens
  const pricing = {
    // OpenAI Models
    'gpt-5-mini': { input: 0.30, output: 1.20 },
    'gpt-5-nano': { input: 0.10, output: 0.40 },
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4.1': { input: 3.00, output: 12.00 },
    
    // Gemini Models
    'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    'gemini-2.5-flash-lite': { input: 0.05, output: 0.20 },
    'gemini-2.0-flash-exp': { input: 0.0, output: 0.0 },
    'gemini-2.0-flash': { input: 0.10, output: 0.40 }
  };
  
  // Estimate tokens from response time (~50 tokens per second)
  function estimateTokens(responseTime) {
    return Math.ceil((responseTime / 1000) * 50);
  }
  
  function estimateCost(query) {
    const model = query.model || 'gpt-5-mini';
    const tokens = estimateTokens(query.responseTime || 5000);
    const modelPrice = pricing[model] || pricing['gpt-5-mini'];
    const inputCost = (tokens * 0.3 * modelPrice.input) / 1000000;
    const outputCost = (tokens * 0.7 * modelPrice.output) / 1000000;
    return inputCost + outputCost;
  }
  
  let totalCost = 0;
  let cachedQueries = 0;
  let totalQueries = queries.length;
  
  queries.forEach(q => {
    if (q.cached) {
      cachedQueries++;
    } else {
      totalCost += estimateCost(q);
    }
  });
  
  const cacheHitRate = totalQueries > 0 ? (cachedQueries / totalQueries) : 0;
  const targetCacheRate = 0.60;
  const cacheSavings = totalCost * Math.max(0, targetCacheRate - cacheHitRate);
  
  // Group queries for duplicate analysis
  const queryGroups = {};
  queries.forEach(q => {
    const normalized = (q.query || '').toLowerCase().trim();
    if (!queryGroups[normalized]) {
      queryGroups[normalized] = { 
        count: 0, 
        totalCost: 0, 
        sumResponseTime: 0
      };
    }
    queryGroups[normalized].count++;
    if (!q.cached) queryGroups[normalized].totalCost += estimateCost(q);
    queryGroups[normalized].sumResponseTime += q.responseTime || 0;
  });
  
  const expensiveQueries = Object.entries(queryGroups)
    .map(([query, data]) => ({
      query,
      count: data.count,
      totalCost: data.totalCost,
      avgResponseTime: Math.round(data.sumResponseTime / data.count),
      estimatedCost: data.count > 0 ? data.totalCost / data.count : 0
    }))
    .filter(q => q.count > 2 && q.totalCost > 0.0001)
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, 5);
  
  const recommendations = [];
  
  if (cacheHitRate < 0.50) {
    recommendations.push({
      title: 'Improve Cache Hit Rate',
      description: `Current cache hit rate is ${Math.round(cacheHitRate * 100)}%. Target 60% for better cost efficiency.`,
      savings: cacheSavings * 30
    });
  }
  
  const slowQueries = queries.filter(q => !q.cached && q.responseTime > 30000);
  if (slowQueries.length > 5) {
    const slowCost = slowQueries.slice(0, 5).reduce((sum, q) => sum + estimateCost(q), 0);
    recommendations.push({
      title: 'Optimize Slow Queries',
      description: `${slowQueries.length} queries take >30s. Optimize search parameters.`,
      savings: slowCost * 0.3 * 30
    });
  }
  
  const freeModelQueries = queries.filter(q => q.model === 'gemini-2.0-flash-exp');
  const freeModelPercent = totalQueries > 0 ? (freeModelQueries.length / totalQueries) : 0;
  if (freeModelPercent < 0.3 && totalQueries > 20) {
    recommendations.push({
      title: 'Use More Free Models',
      description: `Only ${Math.round(freeModelPercent * 100)}% queries use free gemini-2.0-flash-exp. Increase usage for zero cost.`,
      savings: totalCost * 0.15 * 30
    });
  }
  
  const potentialSavings = recommendations.reduce((sum, r) => sum + r.savings, 0);
  
  return {
    totalEstimatedCost: totalCost * 30,
    potentialSavings: Math.min(potentialSavings, totalCost * 30 * 0.7),
    cacheHitRate: Math.round(cacheHitRate * 100),
    recommendations: recommendations,
    expensiveQueries: expensiveQueries
  };
}

app.get('/api/analytics/dashboard', async (req, res) => {
  try {
    const pipeline = [
      {
        $facet: {
          totalQueries: [{ $count: 'count' }],
          successRate: [
            { $group: { _id: '$success', count: { $sum: 1 } } }
          ],
          avgResponseTime: [
            { $group: { _id: null, avg: { $avg: '$responseTime' } } }
          ],
          cacheHitRate: [
            { $group: { _id: '$cached', count: { $sum: 1 } } }
          ],
          topQueries: [
            { $group: { _id: '$query', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          sourceBreakdown: [
            { $group: { _id: '$endpoint', total: { $sum: 1 } } }
          ],
          recentQueries: [
            { $sort: { timestamp: -1 } },
            { $limit: 20 },
            { $project: { query: 1, timestamp: 1, responseTime: 1, resultsCount: 1, cached: 1 } }
          ]
        }
      }
    ];
    
    const results = await db.collection('search_analytics').aggregate(pipeline).toArray();
    const data = results[0];
    
    // Calculate cost optimization
    const allQueries = await db.collection('search_analytics').find({}).toArray();
    const costOptimization = calculateCostOptimization(allQueries);
    
    const dashboard = {
      totalQueries: data.totalQueries[0]?.count || 0,
      successRate: calculateSuccessRate(data.successRate),
      avgResponseTime: Math.round(data.avgResponseTime[0]?.avg || 0),
      cacheHitRate: calculateCacheHitRate(data.cacheHitRate),
      topQueries: data.topQueries,
      sourceBreakdown: formatSourceBreakdown(data.sourceBreakdown),
      recentQueries: data.recentQueries,
      costOptimization: costOptimization
    };
    
    res.json(dashboard);
  } catch (e) {
    console.error('[DASHBOARD] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/analytics/queries', async (req, res) => {
  try {
    const { limit = 100, skip = 0, endpoint } = req.query;
    
    const filter = endpoint ? { endpoint } : {};
    
    const queries = await db.collection('search_analytics')
      .find(filter)
      .sort({ timestamp: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .toArray();
    
    res.json({ queries, total: await db.collection('search_analytics').countDocuments(filter) });
  } catch (e) {
    console.error('[QUERIES] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function calculateSuccessRate(data) {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  const successful = data.find(d => d._id === true)?.count || 0;
  return total > 0 ? Math.round((successful / total) * 100) : 0;
}

function calculateCacheHitRate(data) {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  const hits = data.find(d => d._id === true)?.count || 0;
  return total > 0 ? Math.round((hits / total) * 100) : 0;
}

function formatSourceBreakdown(data) {
  // Map endpoint values to friendly source names
  const endpointToSource = {
    'gemini-confluence': 'Confluence',
    'openai-confluence': 'Confluence',
    'gemini-sharepoint': 'Sharepoint',
    'openai-sharepoint': 'Sharepoint',
    'gemini-box': 'Box',
    'openai-box': 'Box'
  };
  
  const breakdown = {};
  
  data.forEach(item => {
    const endpoint = item._id;
    const sourceName = endpointToSource[endpoint] || endpoint;
    
    // Accumulate counts for the same source (gemini + openai)
    if (breakdown[sourceName]) {
      breakdown[sourceName] += item.total;
    } else {
      breakdown[sourceName] = item.total;
    }
  });
  
  return breakdown;
}

async function init() {
  await initMongo();
  await initRedis();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Analytics Service running on port ${PORT}`);
    console.log('Ready to track queries and serve dashboard!');
  });
}

init().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
