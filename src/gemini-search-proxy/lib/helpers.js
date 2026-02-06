const { expandWithSynonyms } = require('./fuzzy');

function extractUserQuery(messages) {
  const userMessages = messages.filter(msg =>
    msg.role === 'user' &&
    !msg.content.includes('title for the conversation') &&
    !msg.content.includes('title case conventions') &&
    !msg.content.includes('concise') &&
    msg.content.length > 1 &&
    msg.content.length < 500
  );

  return userMessages.length > 0 ? userMessages[userMessages.length - 1].content : 'search';
}

function isConversationTitleRequest(messages) {
  if (!messages || messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') return false;

  const content = lastMessage.content.toLowerCase();
  return content.includes('title for the conversation') ||
         content.includes('generate a title') ||
         content.includes('create a title') ||
         content.includes('conversation title') ||
         (content.includes('concise') && content.includes('title'));
}

function extractUserQueryFromEmbeddedConversation(content) {
  const userMatch = content.match(/User:\s*([^\n]+)/i);
  if (userMatch && userMatch[1]) {
    return userMatch[1].trim();
  }

  const conversationMatch = content.match(/Conversation:\s*\n\s*User:\s*([^\n]+)/i);
  if (conversationMatch && conversationMatch[1]) {
    return conversationMatch[1].trim();
  }

  return null;
}

function generateTitleFromQuery(userQuery, prefix) {
  if (!userQuery || userQuery.length < 1) {
    return prefix || 'Search';
  }

  const stopWords = ['what', 'is', 'are', 'the', 'a', 'an', 'how', 'where', 'when', 'why', 'tell', 'me', 'about'];
  const words = userQuery
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.includes(word.toLowerCase()))
    .slice(0, 5);

  if (words.length === 0) {
    return prefix || 'Search';
  }

  const searchTerm = words.join(' ');
  const capitalizedTerm = searchTerm.charAt(0).toUpperCase() + searchTerm.slice(1).toLowerCase();

  const title = (prefix ? prefix + ': ' : 'Search: ') + capitalizedTerm;
  return title.length <= 30 ? title : capitalizedTerm;
}

function extractSearchTerms(query) {
  const stopWords = ['what', 'is', 'are', 'the', 'a', 'an', 'please', 'tell', 'me', 'about', 'show', 'provide', 'with', 'how', 'where', 'when', 'why'];

  const words = query.toLowerCase()
    .replace(/[^\w\s.-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 1 && !stopWords.includes(word));

  // Expand with synonyms for better recall
  const expandedTerms = [];
  words.slice(0, 4).forEach(word => {
    const synonyms = expandWithSynonyms(word);
    expandedTerms.push(...synonyms);
  });

  const uniqueTerms = [...new Set(expandedTerms)];
  return uniqueTerms.length > 0 ? uniqueTerms.slice(0, 6).join(' ') : query.trim();
}

module.exports = {
  extractUserQuery,
  isConversationTitleRequest,
  extractUserQueryFromEmbeddedConversation,
  generateTitleFromQuery,
  extractSearchTerms
};
