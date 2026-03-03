// State
let sessionId = 'session-' + Math.random().toString(36).substring(2, 10);
let isStreaming = false;

// DOM refs
const messagesEl = document.getElementById('messages');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const welcomeScreen = document.getElementById('welcome-screen');
const updateBanner = document.getElementById('update-banner');
const updateMessage = document.getElementById('update-message');
const statsPanel = document.getElementById('stats-panel');

// Configure marked for markdown rendering
marked.setOptions({
  breaks: true,
  gfm: true,
  headerIds: false,
  mangle: false
});

// --- Chat Logic ---

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || isStreaming) return;

  // Hide welcome screen on first message
  if (welcomeScreen) {
    welcomeScreen.remove();
  }

  // Add user message
  appendUserMessage(text);

  // Clear input
  chatInput.value = '';
  autoResizeInput();

  // Send to API
  streamResponse(text);
}

function appendUserMessage(text) {
  const div = document.createElement('div');
  div.className = 'message message-user';
  div.innerHTML = `<div class="message-bubble">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function appendAIMessage() {
  const wrapper = document.createElement('div');
  wrapper.className = 'message message-ai';

  wrapper.innerHTML = `
    <div class="ai-avatar">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M7 10c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="9.5" cy="11" r="1" fill="#fff"/>
        <circle cx="14.5" cy="11" r="1" fill="#fff"/>
        <path d="M9 15c0 0 1.5 1.5 3 1.5s3-1.5 3-1.5" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>
      </svg>
    </div>
    <div class="message-content">
      <div class="message-bubble">
        <div class="md-content">
          <div class="typing-indicator"><span></span><span></span><span></span></div>
        </div>
      </div>
      <div class="sources-container"></div>
    </div>
  `;

  messagesEl.appendChild(wrapper);
  scrollToBottom();

  return {
    contentEl: wrapper.querySelector('.md-content'),
    sourcesEl: wrapper.querySelector('.sources-container'),
    bubbleEl: wrapper.querySelector('.message-bubble')
  };
}

function appendErrorMessage(text) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message message-ai message-error';
  wrapper.innerHTML = `
    <div class="ai-avatar" style="background: var(--danger)">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
    </div>
    <div class="message-bubble">${escapeHtml(text)}</div>
  `;
  messagesEl.appendChild(wrapper);
  scrollToBottom();
}

async function streamResponse(question) {
  isStreaming = true;
  btnSend.disabled = true;

  const { contentEl, sourcesEl } = appendAIMessage();
  let fullText = '';
  let sourceArticles = [];

  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, sessionId })
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.substring(6).trim();
        if (!jsonStr) continue;

        try {
          const data = JSON.parse(jsonStr);

          if (data.type === 'sources') {
            sourceArticles = data.articles || [];
          } else if (data.type === 'delta') {
            fullText += data.text;
            renderMarkdown(contentEl, fullText);
            scrollToBottom();
          } else if (data.type === 'done') {
            // Render final markdown
            renderMarkdown(contentEl, fullText);
            // Show source articles
            if (sourceArticles.length > 0) {
              renderSources(sourcesEl, sourceArticles);
            }
          } else if (data.type === 'error') {
            contentEl.innerHTML = `<p style="color:var(--danger)">${escapeHtml(data.message)}</p>`;
          }
        } catch (e) {
          // Skip malformed JSON
        }
      }
    }

    // Final render if stream ended without 'done' event
    if (fullText && !contentEl.querySelector('.typing-indicator')) {
      renderMarkdown(contentEl, fullText);
    }

  } catch (err) {
    contentEl.innerHTML = '';
    appendErrorMessage('Failed to connect to the server. Make sure the server is running and try again.');
    console.error('Stream error:', err);
  } finally {
    isStreaming = false;
    btnSend.disabled = false;
    chatInput.focus();
    scrollToBottom();
  }
}

function renderMarkdown(el, text) {
  el.innerHTML = marked.parse(text);
}

function renderSources(el, articles) {
  if (!articles || articles.length === 0) return;

  let html = `<div class="source-articles">
    <div class="source-articles-label">Sources</div>`;

  for (const article of articles) {
    html += `<a class="source-link" href="${escapeAttr(article.url)}" target="_blank" title="${escapeAttr(article.title)}">${escapeHtml(article.title)}</a>`;
  }

  html += '</div>';
  el.innerHTML = html;
}

// --- Utility Functions ---

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function autoResizeInput() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- Chat Actions ---

function askSuggestion(question) {
  chatInput.value = question;
  sendMessage();
}

async function clearChat() {
  // Reset the session
  try {
    await fetch('/api/clear-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
  } catch (e) {
    // Ignore error
  }

  // Generate new session
  sessionId = 'session-' + Math.random().toString(36).substring(2, 10);

  // Clear messages and show welcome
  messagesEl.innerHTML = '';
  const welcome = createWelcomeScreen();
  messagesEl.appendChild(welcome);
  chatInput.value = '';
  autoResizeInput();
}

function createWelcomeScreen() {
  const div = document.createElement('div');
  div.id = 'welcome-screen';
  div.className = 'welcome-screen';
  div.innerHTML = `
    <div class="welcome-avatar">
      <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="48" height="48" rx="12" fill="#6366f1"/>
        <path d="M14 20c0-5.5 4.5-10 10-10s10 4.5 10 10" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="19" cy="22" r="2" fill="#fff"/>
        <circle cx="29" cy="22" r="2" fill="#fff"/>
        <path d="M18 30c0 0 3 3 6 3s6-3 6-3" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </div>
    <h2>How can I help you with FG Funnels?</h2>
    <p class="welcome-desc">Ask me anything about FG Funnels and I'll create a custom tutorial for you.</p>
    <div class="suggestion-grid">
      <button class="suggestion-card" onclick="askSuggestion('How do I set up Stripe payments?')">
        <span class="suggestion-icon">&#128179;</span>
        <span>Set up Stripe payments</span>
      </button>
      <button class="suggestion-card" onclick="askSuggestion('How do I connect my Google Calendar?')">
        <span class="suggestion-icon">&#128197;</span>
        <span>Connect Google Calendar</span>
      </button>
      <button class="suggestion-card" onclick="askSuggestion('How do I create an email campaign?')">
        <span class="suggestion-icon">&#128232;</span>
        <span>Create email campaigns</span>
      </button>
      <button class="suggestion-card" onclick="askSuggestion('How do I build a funnel?')">
        <span class="suggestion-icon">&#127760;</span>
        <span>Build a funnel</span>
      </button>
      <button class="suggestion-card" onclick="askSuggestion('How do I set up workflow automations?')">
        <span class="suggestion-icon">&#9889;</span>
        <span>Workflow automations</span>
      </button>
      <button class="suggestion-card" onclick="askSuggestion('How do I import contacts?')">
        <span class="suggestion-icon">&#128101;</span>
        <span>Import contacts</span>
      </button>
      <button class="suggestion-card" onclick="askSuggestion('How do I set up a membership site?')">
        <span class="suggestion-icon">&#127891;</span>
        <span>Membership sites</span>
      </button>
      <button class="suggestion-card" onclick="askSuggestion('How do I set up SMS messaging?')">
        <span class="suggestion-icon">&#128172;</span>
        <span>SMS messaging</span>
      </button>
    </div>
  `;
  return div;
}

// --- Stats / Updates (kept from v1) ---

async function checkForUpdates() {
  const btn = document.getElementById('btn-update');
  btn.textContent = 'Checking...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/update', { method: 'POST' });
    const data = await res.json();
    updateMessage.textContent = 'Update started! The crawler is checking for new articles in the background. This may take a few minutes.';
    updateBanner.classList.remove('hidden');
  } catch (err) {
    updateMessage.textContent = 'Error starting update. Check server logs.';
    updateBanner.classList.remove('hidden');
  } finally {
    btn.textContent = 'Check for Updates';
    btn.disabled = false;
  }
}

function hideUpdateBanner() {
  updateBanner.classList.add('hidden');
}

async function showStats() {
  statsPanel.classList.remove('hidden');
  const body = document.getElementById('stats-body');
  body.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-dim)"><div class="spinner"></div> Loading...</div>';

  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();

    const lastCrawl = stats.lastCrawl !== 'Never'
      ? new Date(stats.lastCrawl).toLocaleString()
      : 'Never';

    body.innerHTML = `
      <div class="stat-item">
        <div class="label">Total Articles</div>
        <div class="value">${stats.totalArticles}</div>
      </div>
      <div class="stat-item">
        <div class="label">Last Updated</div>
        <div class="value" style="font-size:1rem">${lastCrawl}</div>
      </div>
      ${stats.crawlStats && stats.crawlStats.attempted ? `
        <div class="stat-item">
          <div class="label">Last Crawl Stats</div>
          <div class="value" style="font-size:0.95rem">
            ${stats.crawlStats.succeeded} succeeded, ${stats.crawlStats.failed} failed
          </div>
        </div>
      ` : ''}
      <div style="margin-top:1rem">
        <button class="btn-secondary" onclick="runFullCrawl()" style="width:100%;padding:0.6rem">
          Run Full Recrawl
        </button>
        <p style="color:var(--text-dim);font-size:0.8rem;margin-top:0.5rem;text-align:center">
          Full recrawl will re-download all articles. May take several minutes.
        </p>
      </div>
    `;
  } catch (err) {
    body.innerHTML = '<p style="color:var(--danger)">Error loading stats.</p>';
  }
}

function hideStats() {
  statsPanel.classList.add('hidden');
}

async function runFullCrawl() {
  try {
    await fetch('/api/full-crawl', { method: 'POST' });
    updateMessage.textContent = 'Full recrawl started! This will take several minutes. New articles will appear automatically.';
    updateBanner.classList.remove('hidden');
    hideStats();
  } catch (err) {
    alert('Error starting full crawl.');
  }
}

// --- Input Handling ---

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

chatInput.addEventListener('input', autoResizeInput);

// Spinner CSS (inline since we reference it in stats)
const style = document.createElement('style');
style.textContent = `.spinner{display:inline-block;width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 0.8s linear infinite;vertical-align:middle;}@keyframes spin{to{transform:rotate(360deg)}}`;
document.head.appendChild(style);
