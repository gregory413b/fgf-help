const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Load .env file if it exists (no dependency needed)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const Anthropic = require('@anthropic-ai/sdk').default;

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ARTICLES_FILE = path.join(DATA_DIR, 'articles.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';

// Initialize Anthropic client (reads ANTHROPIC_API_KEY from env)
let anthropic = null;
try {
  if (process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic();
  }
} catch (err) {
  console.warn('Could not initialize Anthropic client:', err.message);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load articles into memory
let articles = {};
let meta = {};

function loadData() {
  try {
    if (fs.existsSync(ARTICLES_FILE)) {
      articles = JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf8'));
    }
    if (fs.existsSync(META_FILE)) {
      meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading data:', err.message);
  }
}

loadData();

// --- Search Engine ---

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

function buildSearchIndex() {
  const index = {};
  for (const [url, article] of Object.entries(articles)) {
    const titleTokens = tokenize(article.title);
    const contentTokens = tokenize(article.plainText);
    const categoryTokens = (article.categories || []).flatMap(c => tokenize(c));

    const allTokens = new Set([...titleTokens, ...contentTokens, ...categoryTokens]);

    for (const token of allTokens) {
      if (!index[token]) index[token] = [];
      const titleBoost = titleTokens.includes(token) ? 10 : 0;
      const categoryBoost = categoryTokens.includes(token) ? 5 : 0;
      const freq = contentTokens.filter(t => t === token).length;
      index[token].push({ url, score: titleBoost + categoryBoost + Math.min(freq, 10) });
    }
  }
  return index;
}

let searchIndex = buildSearchIndex();

function search(query, limit = 20) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const stopWords = new Set(['how', 'to', 'do', 'i', 'the', 'a', 'an', 'is', 'what', 'where', 'when', 'why', 'can', 'my', 'in', 'on', 'for', 'with', 'it', 'this', 'that', 'of', 'and', 'or', 'if', 'up', 'set']);
  const meaningfulTokens = queryTokens.filter(t => !stopWords.has(t));
  const searchTokens = meaningfulTokens.length > 0 ? meaningfulTokens : queryTokens;

  const scores = {};

  for (const token of searchTokens) {
    if (searchIndex[token]) {
      for (const { url, score } of searchIndex[token]) {
        scores[url] = (scores[url] || 0) + score;
      }
    }

    for (const indexToken of Object.keys(searchIndex)) {
      if (indexToken.startsWith(token) && indexToken !== token) {
        for (const { url, score } of searchIndex[indexToken]) {
          scores[url] = (scores[url] || 0) + score * 0.5;
        }
      }
      if (token.length > 3 && indexToken.includes(token) && !indexToken.startsWith(token)) {
        for (const { url, score } of searchIndex[indexToken]) {
          scores[url] = (scores[url] || 0) + score * 0.3;
        }
      }
    }
  }

  for (const url of Object.keys(scores)) {
    const article = articles[url];
    if (!article) continue;
    const titleLower = article.title.toLowerCase();
    const matchCount = searchTokens.filter(t => titleLower.includes(t)).length;
    if (matchCount > 1) scores[url] += matchCount * 5;

    const queryLower = query.toLowerCase();
    if (titleLower.includes(queryLower)) scores[url] += 20;
    if (article.plainText.toLowerCase().includes(queryLower)) scores[url] += 5;
  }

  return Object.entries(scores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([url, score]) => {
      const article = articles[url];
      return { url, title: article.title, categories: article.categories, score };
    });
}

// --- AI Assistant ---

const SYSTEM_PROMPT = `You are an expert FG Funnels support specialist. Your job is to help users with any question about FG Funnels by providing clear, step-by-step tutorials and guidance.

BEHAVIOR RULES:
- Be conversational, friendly, and confident — like a knowledgeable colleague helping someone out.
- Provide step-by-step instructions when applicable. Use numbered steps.
- Use markdown formatting: headers (##), bold (**text**), numbered lists, bullet points.
- When you reference a specific FG Funnels feature or setting, be precise about where to find it in the interface (e.g., "Go to Settings > Integrations > Stripe").
- If the provided knowledge base articles don't fully answer the question, say so honestly and suggest what the user might try or where to look.
- Always synthesize information from the provided articles into a cohesive answer — do NOT just list or summarize individual articles.
- Do NOT list source articles at the end — the system handles that automatically.
- If the user asks something completely unrelated to FG Funnels, politely redirect them.
- Keep responses thorough but not unnecessarily verbose. Aim for practical, actionable help.`;

// Conversation session store
const conversations = new Map();
const SESSION_TTL = 30 * 60 * 1000;

function getOrCreateSession(sessionId) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, { messages: [], lastAccess: Date.now() });
  }
  const session = conversations.get(sessionId);
  session.lastAccess = Date.now();
  return session;
}

// Cleanup stale sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of conversations) {
    if (now - session.lastAccess > SESSION_TTL) {
      conversations.delete(id);
    }
  }
}, 10 * 60 * 1000);

function buildArticleContext(searchResults, maxArticles = 5) {
  const contextParts = [];
  let totalChars = 0;
  const MAX_CONTEXT_CHARS = 30000;

  for (const result of searchResults.slice(0, maxArticles)) {
    const article = articles[result.url];
    if (!article) continue;

    let articleText = `### ${article.title}\n\n`;

    if (article.sections && article.sections.length > 0) {
      for (const section of article.sections) {
        if (section.heading) articleText += `**${section.heading}**\n`;
        articleText += section.content.join('\n') + '\n\n';
      }
    } else {
      articleText += article.plainText + '\n\n';
    }

    if (totalChars + articleText.length > MAX_CONTEXT_CHARS) {
      const remaining = MAX_CONTEXT_CHARS - totalChars;
      if (remaining > 500) {
        articleText = articleText.substring(0, remaining) + '\n[...truncated]';
      } else {
        break;
      }
    }

    contextParts.push(articleText);
    totalChars += articleText.length;
  }

  return contextParts.join('\n---\n\n');
}

// --- API Routes ---

app.post('/api/ask', async (req, res) => {
  const { question, sessionId = 'default' } = req.body;

  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }

  if (!anthropic) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'ANTHROPIC_API_KEY is not set. Create a .env file in the fgf-help folder with: ANTHROPIC_API_KEY=your-key-here' })}\n\n`);
    res.end();
    return;
  }

  // Step 1: Search for relevant articles
  const searchResults = search(question, 8);
  const sourceArticles = searchResults.slice(0, 5).map(r => ({
    title: r.title,
    url: r.url
  }));

  // Step 2: Build context
  const articleContext = buildArticleContext(searchResults, 5);

  // Step 3: Get conversation session
  const session = getOrCreateSession(sessionId);

  // Step 4: Build user message with article context
  const userMessageWithContext = articleContext
    ? `Here are relevant FG Funnels knowledge base articles for context:\n\n${articleContext}\n\n---\n\nUser question: ${question}`
    : `User question: ${question}\n\n(No relevant articles were found in the knowledge base for this query.)`;

  session.messages.push({ role: 'user', content: userMessageWithContext });

  // Keep conversation history manageable
  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-20);
  }

  // Step 5: Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send sources first
  res.write(`data: ${JSON.stringify({ type: 'sources', articles: sourceArticles })}\n\n`);

  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: session.messages
    });

    let fullResponse = '';

    stream.on('text', (text) => {
      fullResponse += text;
      res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
    });

    stream.on('end', () => {
      session.messages.push({ role: 'assistant', content: fullResponse });
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      console.error('Claude streaming error:', err.message);
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Error generating response. Please try again.' })}\n\n`);
      res.end();
    });

  } catch (err) {
    console.error('Claude API error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
});

app.post('/api/clear-chat', (req, res) => {
  const { sessionId = 'default' } = req.body;
  conversations.delete(sessionId);
  res.json({ success: true });
});

app.get('/api/stats', (req, res) => {
  loadData();
  res.json({
    totalArticles: Object.keys(articles).length,
    lastCrawl: meta.lastCrawl || 'Never',
    collections: meta.collections || [],
    crawlStats: meta.crawlStats || {}
  });
});

app.post('/api/update', (req, res) => {
  res.json({ status: 'started', message: 'Update crawl started...' });

  const crawlerPath = path.join(__dirname, 'crawler.js');
  execFile('node', [crawlerPath, '--update'], { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) {
      console.error('Update crawl error:', err.message);
      return;
    }
    console.log('Update crawl output:', stdout);
    if (stderr) console.error('Update crawl stderr:', stderr);
    loadData();
    searchIndex = buildSearchIndex();
    console.log('Data reloaded after update.');
  });
});

app.post('/api/full-crawl', (req, res) => {
  res.json({ status: 'started', message: 'Full crawl started...' });

  const crawlerPath = path.join(__dirname, 'crawler.js');
  execFile('node', [crawlerPath], { cwd: __dirname, timeout: 600000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Full crawl error:', err.message);
      return;
    }
    console.log('Full crawl complete');
    loadData();
    searchIndex = buildSearchIndex();
    console.log('Data reloaded after full crawl.');
  });
});

app.listen(PORT, () => {
  console.log(`FG Funnels AI Help running at http://localhost:${PORT}`);
  console.log(`Loaded ${Object.keys(articles).length} articles`);
  console.log(`Model: ${MODEL}`);
  console.log(`API Key: ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'NOT SET — create a .env file'}`);
});
