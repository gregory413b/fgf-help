const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://support.fgfunnels.com';
const DATA_DIR = path.join(__dirname, 'data');
const ARTICLES_FILE = path.join(DATA_DIR, 'articles.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const DELAY_MS = 300;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadExistingData() {
  if (fs.existsSync(ARTICLES_FILE)) {
    return JSON.parse(fs.readFileSync(ARTICLES_FILE, 'utf8'));
  }
  return {};
}

function loadMeta() {
  if (fs.existsSync(META_FILE)) {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  }
  return { lastCrawl: null, totalArticles: 0, collections: [] };
}

function saveMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

function saveArticles(articles) {
  fs.writeFileSync(ARTICLES_FILE, JSON.stringify(articles, null, 2));
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FGFHelpBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!res.ok) {
      console.log(`  [SKIP] ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.log(`  [ERROR] ${err.message} for ${url}`);
    return null;
  }
}

async function discoverSitemap() {
  console.log('Fetching sitemap...');
  const html = await fetchPage(`${BASE_URL}/sitemap.xml`);
  if (!html) return { collections: [], categories: [], articles: [] };

  const $ = cheerio.load(html, { xmlMode: true });
  const urls = { collections: [], categories: [], articles: [] };

  $('url loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (loc.includes('/article/')) urls.articles.push(loc);
    else if (loc.includes('/collection/')) urls.collections.push(loc);
    else if (loc.includes('/category/')) urls.categories.push(loc);
  });

  console.log(`Found: ${urls.collections.length} collections, ${urls.categories.length} categories, ${urls.articles.length} articles`);
  return urls;
}

async function discoverFromHomepage() {
  console.log('Discovering from homepage...');
  const html = await fetchPage(BASE_URL);
  if (!html) return [];

  const $ = cheerio.load(html);
  const collectionLinks = [];

  $('a[href*="/collection/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      if (!collectionLinks.includes(fullUrl)) collectionLinks.push(fullUrl);
    }
  });

  console.log(`Found ${collectionLinks.length} collection links from homepage`);
  return collectionLinks;
}

async function discoverArticlesFromCollection(url) {
  const html = await fetchPage(url);
  if (!html) return [];

  const $ = cheerio.load(html);
  const articleLinks = [];

  $('a[href*="/article/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      if (!articleLinks.includes(fullUrl)) articleLinks.push(fullUrl);
    }
  });

  $('a[href*="/category/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      if (!articleLinks.includes(fullUrl)) articleLinks.push(fullUrl);
    }
  });

  return articleLinks;
}

async function crawlArticle(url) {
  const html = await fetchPage(url);
  if (!html) return null;

  const $ = cheerio.load(html);

  const title = $('h1').first().text().trim() ||
                $('article h1, .article-title, .paper__title').first().text().trim() ||
                $('title').text().trim().replace(' - FG Funnels', '').replace(' | FG Funnels', '');

  // Get breadcrumb for category info
  const breadcrumbs = [];
  $('.breadcrumbs a, .breadcrumb a, nav[aria-label="breadcrumb"] a').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text !== 'Home' && text !== 'All Collections') breadcrumbs.push(text);
  });

  // Get article content
  const contentSelectors = [
    'article',
    '.article-content',
    '.paper__content',
    '.intercom-interblocks-paragraph',
    '[data-article-content]',
    '.article__body',
    'main'
  ];

  let contentEl = null;
  for (const sel of contentSelectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 50) {
      contentEl = el;
      break;
    }
  }

  if (!contentEl) {
    contentEl = $('body');
  }

  // Extract structured content
  const sections = [];
  let currentSection = { heading: '', content: [] };

  contentEl.find('h1, h2, h3, h4, p, li, ol, ul, blockquote, .intercom-interblocks-paragraph').each((_, el) => {
    const tag = $(el).prop('tagName')?.toLowerCase();
    const text = $(el).text().trim();
    if (!text) return;

    if (['h1', 'h2', 'h3', 'h4'].includes(tag)) {
      if (currentSection.content.length > 0) {
        sections.push({ ...currentSection });
      }
      currentSection = { heading: text, content: [] };
    } else {
      currentSection.content.push(text);
    }
  });

  if (currentSection.content.length > 0 || currentSection.heading) {
    sections.push(currentSection);
  }

  // Build plain text from all readable content
  const plainText = contentEl.text()
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 10000);

  // Extract step-by-step instructions
  const steps = [];
  contentEl.find('ol li, .step, [class*="step"]').each((_, el) => {
    const text = $(el).text().trim();
    if (text) steps.push(text);
  });

  const slug = url.replace(BASE_URL, '').replace(/^\/article\//, '');

  return {
    url,
    slug,
    title: title || 'Untitled',
    categories: breadcrumbs,
    sections,
    steps,
    plainText,
    lastUpdated: new Date().toISOString()
  };
}

async function crawlAll(isUpdate = false) {
  console.log(`\n=== FG Funnels Support Crawler ${isUpdate ? '(UPDATE MODE)' : '(FULL CRAWL)'} ===\n`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const existing = isUpdate ? loadExistingData() : {};
  const existingUrls = new Set(Object.keys(existing));

  // Step 1: Discover all article URLs
  const sitemap = await discoverSitemap();
  let allArticleUrls = [...sitemap.articles];

  // Also discover from homepage and collections
  const collectionUrls = await discoverFromHomepage();
  for (const cUrl of [...sitemap.collections, ...collectionUrls]) {
    await sleep(DELAY_MS);
    const found = await discoverArticlesFromCollection(cUrl);
    for (const u of found) {
      if (u.includes('/article/') && !allArticleUrls.includes(u)) {
        allArticleUrls.push(u);
      }
    }
  }

  // Also follow categories
  for (const catUrl of sitemap.categories) {
    await sleep(DELAY_MS);
    const found = await discoverArticlesFromCollection(catUrl);
    for (const u of found) {
      if (u.includes('/article/') && !allArticleUrls.includes(u)) {
        allArticleUrls.push(u);
      }
    }
  }

  // Deduplicate
  allArticleUrls = [...new Set(allArticleUrls)];
  console.log(`\nTotal unique articles to crawl: ${allArticleUrls.length}`);

  if (isUpdate) {
    const newUrls = allArticleUrls.filter(u => !existingUrls.has(u));
    console.log(`New articles since last crawl: ${newUrls.length}`);
    if (newUrls.length === 0) {
      console.log('No new articles found. Database is up to date.');
      saveMeta({ ...loadMeta(), lastCrawl: new Date().toISOString() });
      return;
    }
    allArticleUrls = newUrls;
  }

  // Step 2: Crawl each article
  const articles = { ...existing };
  let crawled = 0;
  let failed = 0;

  for (const url of allArticleUrls) {
    crawled++;
    process.stdout.write(`\r  Crawling ${crawled}/${allArticleUrls.length}...`);

    await sleep(DELAY_MS);
    const article = await crawlArticle(url);
    if (article && article.plainText.length > 20) {
      articles[url] = article;
    } else {
      failed++;
    }

    // Save every 50 articles
    if (crawled % 50 === 0) {
      saveArticles(articles);
      console.log(` (saved ${Object.keys(articles).length} articles)`);
    }
  }

  // Final save
  saveArticles(articles);

  const meta = {
    lastCrawl: new Date().toISOString(),
    totalArticles: Object.keys(articles).length,
    collections: [...new Set(Object.values(articles).flatMap(a => a.categories))],
    crawlStats: { attempted: crawled, failed, succeeded: crawled - failed }
  };
  saveMeta(meta);

  console.log(`\n\nCrawl complete!`);
  console.log(`  Total articles: ${meta.totalArticles}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Saved to: ${ARTICLES_FILE}`);
}

// Run
const isUpdate = process.argv.includes('--update');
crawlAll(isUpdate).catch(console.error);
