const fuzzysort = require('fuzzysort');

const SYNONYMS = {
  'k8s': ['kubernetes', 'k8s'],
  'kubernetes': ['kubernetes', 'k8s'],
  'ai': ['artificial intelligence', 'ai', 'machine learning', 'ml'],
  'ml': ['machine learning', 'ml', 'ai'],
  'devops': ['devops', 'dev ops', 'development operations'],
  'cicd': ['ci/cd', 'cicd', 'continuous integration', 'continuous deployment'],
  'eks': ['eks', 'elastic kubernetes service', 'amazon eks'],
  'aks': ['aks', 'azure kubernetes service'],
  'gke': ['gke', 'google kubernetes engine']
};

function expandWithSynonyms(term) {
  const lower = term.toLowerCase();
  if (SYNONYMS[lower]) {
    return SYNONYMS[lower];
  }
  return [term];
}

function fuzzyMatch(text, searchTerms, threshold = 0.6) {
  if (!text || !searchTerms) return { score: 0, matched: false };

  const terms = searchTerms.toLowerCase().split(' ');
  const textLower = text.toLowerCase();

  let totalScore = 0;
  let matchedTerms = 0;

  terms.forEach(term => {
    if (textLower.includes(term)) {
      totalScore += 100;
      matchedTerms++;
    } else {
      const result = fuzzysort.single(term, text);
      if (result && result.score > -3000) {
        totalScore += Math.abs(result.score) / 30;
        matchedTerms++;
      }
    }
  });

  const avgScore = terms.length > 0 ? totalScore / terms.length : 0;
  const matchRatio = terms.length > 0 ? matchedTerms / terms.length : 0;

  return {
    score: avgScore,
    matched: matchRatio >= threshold
  };
}

function calcRelevance(title, excerpt, terms) {
  if (!title && !excerpt) return 0;

  const titleMatch = fuzzyMatch(title || '', terms);
  const excerptMatch = fuzzyMatch(excerpt || '', terms);

  let score = (titleMatch.score * 3) + excerptMatch.score;

  if (titleMatch.matched) score += 50;

  const fullText = ((title || '') + ' ' + (excerpt || '')).toLowerCase();
  if (fullText.includes(terms.toLowerCase())) {
    score += 30;
  }

  return Math.round(score);
}

module.exports = {
  SYNONYMS,
  expandWithSynonyms,
  fuzzyMatch,
  calcRelevance
};
