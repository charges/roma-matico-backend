// server.js - Rome-O-Matic Backend
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const axiosRetry = require('axios-retry');

const app = express();

/**
 * =========================
 * Wikipedia topic presets
 * =========================
 */
const WIKI_CATEGORY_TOPICS = {
  "rome-churches-early": [
    "Category:Churches in Rome",
    "Category:Roman Catholic churches in Rome",
    "Category:Titular churches in Rome",
    "Category:Basilicas in Rome"
  ],

  "rome-churches-renaissance": [
    "Category:Renaissance churches in Rome",
    "Category:Baroque church buildings in Rome"
  ],

  "rome-ancient-sites": [
    "Category:Ancient Roman sites in Rome",
    "Category:Roman ruins in Rome",
    "Category:Archaeological sites in Rome"
  ],

  "rome-museums": [
    "Category:Museums in Rome",
    "Category:Art museums and galleries in Rome",
    "Category:History museums in Rome"
  ],
  "rome-palazzi": [
    "Category:Palaces in Rome",
    "Category:Historic buildings in Rome"
  ],
  "rome-monuments": [
    "Category:Fountains in Rome",
    "Category:Statues in Rome",
    "Category:Monuments and memorials in Rome"
  ],
  "rome-public-places": [
    "Category:Public markets in Rome",
    "Category:Piazzas in Rome",
    "Category:Tourist attractions in Rome"
  ],
  "rome-architecture": [
    "Category:Architecture in Rome",
    "Category:Buildings and structures in Rome"
  ]
};

const WIKI_TOPICS = {
  "rome-churches-early": [
    'deepcat:"Churches in Rome"',
    'deepcat:"Roman Catholic churches in Rome"',
    'deepcat:"Titular churches in Rome"',
    'deepcat:"Basilicas in Rome"'
  ],

  "rome-churches-renaissance": [
    'deepcat:"Renaissance churches in Rome"',
    'deepcat:"Baroque church buildings in Rome"'
  ],

  "rome-ancient-sites": [
    'deepcat:"Ancient Roman sites in Rome"',
    'deepcat:"Roman ruins in Rome"',
    'deepcat:"Archaeological sites in Rome"'
  ],

  "rome-museums": [
    'deepcat:"Museums in Rome"',
    'deepcat:"Art museums and galleries in Rome"',
    'deepcat:"History museums in Rome"'
  ],
  "rome-palazzi": [
    'deepcat:"Palaces in Rome"',
    'deepcat:"Historic buildings in Rome"'
  ],
  "rome-monuments": [
    'deepcat:"Fountains in Rome"',
    'deepcat:"Statues in Rome"',
    'deepcat:"Monuments and memorials in Rome"'
  ],
  "rome-public-places": [
    'deepcat:"Public markets in Rome"',
    'deepcat:"Piazzas in Rome"',
    'deepcat:"Tourist attractions in Rome"'
  ],
  "rome-architecture": [
    'deepcat:"Architecture in Rome"',
    'deepcat:"Buildings and structures in Rome"'
  ]
};

/**
 * =========================
 * Crash logging
 * =========================
 */
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('[FATAL] Unhandled Rejection at:', p, 'reason:', reason);
});

const PORT = process.env.PORT || 3000;

/**
 * =========================
 * Axios retry/backoff
 * =========================
 */
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount, error) => {
    const retryAfter = Number(error?.response?.headers?.['retry-after']);
    if (!Number.isNaN(retryAfter)) return retryAfter * 1000;
    return Math.min(1000 * 2 ** (retryCount - 1), 8000); // 1s,2s,4s, cap 8s
  },
  retryCondition: (error) => {
    if (error.code === 'ECONNABORTED') return true;
    const s = error?.response?.status;
    return s === 429 || s === 503 || s === 502 || s === 504;
  },
});

/**
 * =========================
 * Middleware
 * =========================
 */
app.use(cors()); // consider: cors({ origin: ['https://charges.github.io', 'http://localhost:8080'] })
app.use(express.json());

/**
 * =========================
 * In-memory cache
 * =========================
 */
let articleCache = [];
let lastRefresh = 0;
const CACHE_DURATION = 3600000; // 1 hour

/**
 * =========================
 * Tiny concurrency limiter
 * =========================
 */
async function mapWithLimit(items, limit, mapper) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await mapper(items[idx], idx);
      } catch (e) {
        results[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

/**
 * =========================
 * Petrarch (Project Gutenberg) sonnets (English translation)
 * =========================
 * Source: "Fifteen Sonnets of Petrarch" (PG #50307)
 * HTML: https://www.gutenberg.org/cache/epub/50307/pg50307-images.html
 */
const PETRARCH_SOURCE_URL = 'https://www.gutenberg.org/cache/epub/50307/pg50307-images.html';

function normalizeSonnetText(s) {
  return (s || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function normalizeSonnetText(s) {
  return (s || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// ADD THIS RIGHT HERE (below normalizeSonnetText)
function stripGutenbergTail(s) {
  if (!s) return s;
  const markers = [
    '*** END OF THE PROJECT GUTENBERG EBOOK',
    'START: FULL LICENSE',
    'THE FULL PROJECT GUTENBERG LICENSE',
    "Transcriber’s Note:",
    "Transcriber's Note:"
  ];
  let cut = s.length;
  for (const m of markers) {
    const i = s.indexOf(m);
    if (i >= 0) cut = Math.min(cut, i);
  }
  return s.slice(0, cut).trim();
}
/**
 * =========================
 * Wikipedia fetchers
 * =========================
 */
function categorizeArticle(title, text) {
  const content = (title + ' ' + text).toLowerCase();

  if (content.match(/\bancient\b|\begypt\b|\begyptian\b|\bgreek\b|\bmesopotamia\b|\bbc\b|\bbce\b|\broman republic\b|\broman empire\b/)) {
    return 'ancient';
  }

  if (content.match(/medieval|middle ages|feudal|crusade|viking/)) return 'medieval';
  if (content.match(/renaissance|reformation|enlightenment|1400|1500|1600|1700/)) return 'early-modern';
  if (content.match(/industrial|revolution|1800|1900|20th century|war|modern/)) return 'modern';
  if (content.match(/technology|invention|computer|press|printing/)) return 'technology';

  return 'ancient';
}

async function fetchWikipediaArticles(count = 6, concurrency = 4) {
  const requests = Array.from({ length: count }, () => ({
    url: 'https://en.wikipedia.org/api/rest_v1/page/random/summary'
  }));

  const responses = await mapWithLimit(requests, concurrency, async (r) => {
    const resp = await axios.get(r.url, {
      timeout: 5000,
      headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' }
    });
    const d = resp.data;
    if (!d?.extract) return null;
    return {
      id: `wiki-${d.pageid || encodeURIComponent(d.title)}`,
      title: d.title,
      extract: d.extract,
      thumbnail: d.thumbnail?.source || d.originalimage?.source || null,
      url: d.content_urls?.desktop?.page,
      type: d.description || 'Article',
      readTime: Math.max(1, Math.ceil((d.extract.split(' ').length || 120) / 200)),
      category: categorizeArticle(d.title, d.extract),
      source: 'Wikipedia'
    };
  });

  return responses;
}

async function wikiSearchTitles(srsearch, limit = 50) {
  const resp = await axios.get('https://en.wikipedia.org/w/api.php', {
    timeout: 8000,
    headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' },
    params: {
      action: 'query',
      list: 'search',
      srsearch,
      srlimit: Math.min(limit, 50),
      srnamespace: 0,
      format: 'json'
    }
  });
  const hits = resp?.data?.query?.search || [];
  return hits
    .map(h => h.title)
    .filter(t => !t.toLowerCase().includes('(disambiguation)'))
    .filter(t => !t.startsWith('Category:'));
}

async function wikiSummariesForTitles(titles, concurrency = 4) {
  const safeTitles = (titles || []).filter(t => t && !t.startsWith('Category:'));
  const requests = safeTitles.map(title => ({
    url: `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
  }));

  const results = await mapWithLimit(requests, concurrency, async (r) => {
    const resp = await axios.get(r.url, {
      timeout: 6000,
      headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' }
    });
    const d = resp.data;
    if (!d?.title) return null;

    return {
      id: `wiki-${d.pageid || encodeURIComponent(d.title)}`,
      title: d.title,
      extract: d.extract || '',
      thumbnail: d.thumbnail?.source || d.originalimage?.source || null,
      url: d.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(d.title)}`,
      type: d.description || 'Article',
      readTime: Math.max(1, Math.ceil(((d.extract || '').split(' ').length || 120) / 200)),
      category: categorizeArticle(d.title, d.extract || ''),
      source: 'Wikipedia'
    };
  });

  return results.filter(Boolean);
}

async function getCategoryMembers(cmtitle, cmtype = 'page|subcat', cmlimit = 200, cmcontinue) {
  const resp = await axios.get('https://en.wikipedia.org/w/api.php', {
    timeout: 10000,
    headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' },
    params: {
      action: 'query',
      list: 'categorymembers',
      cmtitle,
      cmtype,
      cmlimit: Math.min(cmlimit, 500),
      continue: '',
      cmcontinue,
      format: 'json'
    }
  });
  return resp.data;
}

async function crawlCategories(seedCategories, { maxDepth = 1, maxPages = 400 } = {}) {
  const seenCats = new Set();
  const pages = new Set();
  let queue = seedCategories.slice().map(c => ({ title: c, depth: 0 }));

  while (queue.length > 0 && pages.size < maxPages) {
    const { title, depth } = queue.shift();
    if (seenCats.has(title)) continue;
    seenCats.add(title);

    let cmcontinue;
    do {
      const data = await getCategoryMembers(title, 'page|subcat', 200, cmcontinue);
      const members = data?.query?.categorymembers || [];
      for (const m of members) {
        if (m.ns === 14) {
          if (depth < maxDepth) {
            queue.push({ title: `Category:${m.title.replace(/^Category:/, '')}`, depth: depth + 1 });
          }
        } else {
          pages.add(m.title);
          if (pages.size >= maxPages) break;
        }
      }
      cmcontinue = data?.continue?.cmcontinue;
    } while (cmcontinue && pages.size < maxPages);
  }

  return Array.from(pages);
}

async function fetchWikipediaByCategoryTopic(topicKey, count = 6) {
  const seedCats = WIKI_CATEGORY_TOPICS[topicKey];
  if (!seedCats) return null;

  const titles = await crawlCategories(seedCats, { maxDepth: 1, maxPages: 500 });
  if (!titles.length) return [];

  const pool = titles.slice();
  const sample = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length);
    sample.push(pool.splice(idx, 1)[0]);
  }
  return wikiSummariesForTitles(sample);
}

async function fetchWikipediaByTopic(topicKey, count = 6) {
  // Prefer category crawl
  try {
    const catResult = await fetchWikipediaByCategoryTopic(topicKey, count);
    if (Array.isArray(catResult) && catResult.length) return catResult;
  } catch (e) {
    console.error('Category crawl failed:', e?.message || e);
  }

  // Fallback: deepcat search
  const queries = WIKI_TOPICS[topicKey];
  if (queries && queries.length) {
    let pool = new Set();
    for (const q of queries) {
      try {
        const titles = await wikiSearchTitles(q, 50);
        titles.forEach(t => pool.add(t));
        if (pool.size > 300) break;
      } catch (e) {
        console.error('wikiSearchTitles error for', q, e.message);
      }
    }
    const list = Array.from(pool);
    if (list.length) {
      const sample = [];
      for (let i = 0; i < Math.min(count, list.length); i++) {
        const idx = Math.floor(Math.random() * list.length);
        sample.push(list.splice(idx, 1)[0]);
      }
      return wikiSummariesForTitles(sample);
    }
  }

  const isKnownTopic =
    Boolean(WIKI_CATEGORY_TOPICS?.[topicKey]) || Boolean(WIKI_TOPICS?.[topicKey]);

  if (isKnownTopic) {
    console.warn('No titles found for known topic', topicKey, '—returning empty');
    return [];
  }

  console.warn('No titles found for topic', topicKey, '—falling back to random');
  return fetchWikipediaArticles(count);
}

/**
 * =========================
 * SEP helpers
 * =========================
 */
async function sepListAllEntries() {
  const url = 'https://plato.stanford.edu/contents.html';
  const resp = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' }
  });
  const $ = cheerio.load(resp.data);

  const entries = [];
  $('a').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().trim();

    if ((href.startsWith('/entries/') || href.startsWith('entries/')) && text) {
      const absolute = new URL(href, 'https://plato.stanford.edu').toString();
      entries.push({ title: text, url: absolute });
    }
  });

  const seen = new Set();
  return entries.filter(e => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });
}

async function sepFetchArticleCard(entryUrl) {
  const resp = await axios.get(entryUrl, {
    timeout: 10000,
    headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' }
  });
  const $ = cheerio.load(resp.data);

  const title =
    $('#aueditable h1').first().text().trim() ||
    $('h1').first().text().trim() ||
    'Stanford Encyclopedia Entry';

  const paras = $('#aueditable p')
    .slice(0, 3)
    .map((i, el) => $(el).text().trim())
    .get();

  const extract = (paras.join(' ') || '').substring(0, 600) + (paras.length ? '…' : '');

  return {
    id: `stanford-${encodeURIComponent(entryUrl)}`,
    title,
    extract,
    thumbnail: 'https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=400&h=300&fit=crop',
    url: entryUrl,
    type: 'Philosophy',
    readTime: Math.max(3, Math.ceil((extract.split(' ').length || 400) / 200)),
    category: 'early-modern',
    source: 'Stanford Encyclopedia'
  };
}

async function fetchStanfordArticles(count = 3) {
  try {
    const all = await sepListAllEntries();
    if (!all.length) {
      console.warn('[SEP] No entries found on contents page');
      return [];
    }

    const pool = all.slice();
    const chosen = [];
    for (let i = 0; i < Math.min(count, pool.length); i++) {
      const idx = Math.floor(Math.random() * pool.length);
      chosen.push(pool.splice(idx, 1)[0]);
    }

    const cards = await mapWithLimit(chosen, 3, async (entry) => {
      try {
        return await sepFetchArticleCard(entry.url);
      } catch (err) {
        console.error('[SEP] fetch error for', entry.url, err.message);
        return null;
      }
    });

    return cards.filter(Boolean);
  } catch (err) {
    console.error('[SEP] Failed to fetch random entries:', err.message);
    return [];
  }
}

/**
 * =========================
 * Smithsonian
 * =========================
 */
const SMITHSONIAN_CATEGORY_URLS = [
  'https://www.smithsonianmag.com/category/archaeology/',
  'https://www.smithsonianmag.com/category/us-history/',
  'https://www.smithsonianmag.com/category/world-history/',
  'https://www.smithsonianmag.com/category/arts-culture/',
  'https://www.smithsonianmag.com/category/history/'
];

let smithsonianDebug = [];

async function smithsonianListHistoryArticles() {
  const results = [];
  smithsonianDebug = [];

  for (const url of SMITHSONIAN_CATEGORY_URLS) {
    try {
      const resp = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      const html = resp.data || '';
      const $ = cheerio.load(html);

      const itemsForUrl = [];

      $('h2 a, h3 a').each((_, el) => {
        const title = $(el).text().trim();
        let href = $(el).attr('href') || '';
        if (!title || !href) return;

        const fullUrl = new URL(href, url).toString();
        if (fullUrl.includes('/category/') || fullUrl.includes('/tag/')) return;

        const summary =
          $(el).closest('h2, h3').next('p').text().trim() ||
          $(el).parent().next('p').text().trim();

        itemsForUrl.push({
          title,
          url: fullUrl,
          summary,
          thumbnail: null
        });
      });

      smithsonianDebug.push({
        url,
        ok: true,
        status: resp.status,
        length: html.length,
        itemsFound: itemsForUrl.length
      });

      console.log(`[Smithsonian] ${url} -> status ${resp.status}, itemsFound=${itemsForUrl.length}`);
      results.push(...itemsForUrl);
    } catch (err) {
      const msg = err.message || String(err);
      smithsonianDebug.push({ url, ok: false, error: msg });
      console.error(`[Smithsonian] Error fetching ${url}:`, msg);
    }
  }

  const seen = new Set();
  const deduped = results.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });

  console.log(`[Smithsonian] Total parsed items across categories: ${deduped.length}`);
  return deduped;
}

async function fetchSmithsonianArticles(count = 2) {
  try {
    const all = await smithsonianListHistoryArticles();
    if (!all.length) {
      console.warn('[Smithsonian] No articles parsed from any category');
      return [];
    }

    const pool = all.slice();
    const chosen = [];
    for (let i = 0; i < Math.min(count, pool.length); i++) {
      const idx = Math.floor(Math.random() * pool.length);
      chosen.push(pool.splice(idx, 1)[0]);
    }

    return chosen.map((item, idx) => ({
      id: `smith-${idx}-${encodeURIComponent(item.url)}`,
      title: item.title,
      extract: item.summary || 'From Smithsonian magazine’s history and culture sections.',
      thumbnail: null,
      url: item.url,
      type: 'History',
      readTime: 6,
      category: 'modern',
      source: 'Smithsonian'
    }));
  } catch (err) {
    console.error('[Smithsonian] Fetch error:', err.message || err);
    return [];
  }
}

/**
 * =========================
 * Main collector
 * =========================
 */
async function fetchAllArticles(topicKey) {
  const label = topicKey ? `(topic=${topicKey})` : '(all wiki topics)';
  console.log('Fetching fresh articles...', label);

  let wikiPromise;
  if (!topicKey) {
    const topicKeys = Object.keys(WIKI_CATEGORY_TOPICS);
    const PER_TOPIC = 3;
    wikiPromise = Promise.all(topicKeys.map(k => fetchWikipediaByTopic(k, PER_TOPIC)))
      .then(arrays => arrays.flat());
  } else {
    wikiPromise = fetchWikipediaByTopic(topicKey, 6);
  }

  const wikiArticles = await wikiPromise;
  return [...wikiArticles];
}

/**
 * =========================
 * Routes
 * =========================
 */

// --- Petrarch Sonnet (random English translation) ---
app.get('/api/sonnet', async (req, res) => {
  try {
    const resp = await axios.get(PETRARCH_SOURCE_URL, {
      timeout: 15000,
      headers: { 'User-Agent': 'RomeOMatic/1.0 (contact: you@example.com)' }
    });

    const $ = cheerio.load(resp.data || '');

    // Gutenberg structure for PG #50307:
    // Repeated <h3> blocks with Roman numerals.
    // First block after a numeral is Italian, second is English.
    const byRoman = new Map();

// Only <h3> nodes that are pure Roman numerals
const romanHeaders = $('h3').filter((_, el) => {
  const t = $(el).text().trim();
  return /^[IVXLCDM]+$/i.test(t);
});

romanHeaders.each((idx, el) => {
  const roman = $(el).text().trim().toUpperCase();
  const nextRomanEl = romanHeaders.get(idx + 1);

  let chunk;

  if (nextRomanEl) {
    // bounded by next roman numeral header
    chunk = $(el).nextUntil(nextRomanEl).text();
  } else {
    // last sonnet: try to stop before Gutenberg footer/license
    const allAfter = $(el).nextAll();
    const stopAt = allAfter.filter((_, node) => {
      const txt = $(node).text ? $(node).text() : '';
      return txt.includes('*** END OF THE PROJECT GUTENBERG EBOOK');
    }).first();

    chunk = stopAt.length ? $(el).nextUntil(stopAt).text() : $(el).nextAll().text();
  }

  const text = normalizeSonnetText(chunk);
  if (!text) return;

  if (!byRoman.has(roman)) byRoman.set(roman, []);
  byRoman.get(roman).push(text);
});

    const romans = Array.from(byRoman.entries())
      .filter(([, blocks]) => Array.isArray(blocks) && blocks.length >= 2)
      .map(([r]) => r);

    if (!romans.length) {
      return res.status(500).json({ error: 'No Petrarch sonnets parsed from Project Gutenberg source' });
    }

    const pickRoman = romans[Math.floor(Math.random() * romans.length)];
    const blocks = byRoman.get(pickRoman);

   // English translation is the second occurrence; Italian is the first
const italianText = stripGutenbergTail(blocks[0]);
const englishText = stripGutenbergTail(blocks[1]);

return res.json({
  source: 'Petrarch (Project Gutenberg)',
  number: pickRoman,
  title: `Sonnet ${pickRoman}`,

  // New fields
  text_it: italianText,
  text_en: englishText,

  // Backward compatibility (current frontend expects `text`)
  text: englishText,

  url: PETRARCH_SOURCE_URL
});
  } catch (err) {
    console.error('[PETRARCH] Error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to fetch Petrarch sonnet' });
  }
});

// --- Articles ---
app.get('/api/articles', async (req, res) => {
  try {
    const now = Date.now();
    const force = String(req.query.force || '').toLowerCase();
    const bypass = force === '1' || force === 'true';
    const topicKey = String(req.query.topic || '').toLowerCase();

    // ✅ Reject unknown topic keys
    if (topicKey && !WIKI_CATEGORY_TOPICS[topicKey] && !WIKI_TOPICS[topicKey]) {
      return res.status(400).json({
        error: `Unknown topic: ${topicKey}`,
        knownTopics: Object.keys(WIKI_CATEGORY_TOPICS)
      });
    }

    if (!bypass && !topicKey && articleCache.length > 0 && (now - lastRefresh) < CACHE_DURATION) {
      console.log('Returning cached articles');
      return res.json({ articles: articleCache, cached: true });
    }

    const articles = await fetchAllArticles(topicKey || undefined);

    if (!topicKey) {
      articleCache = articles;
      lastRefresh = now;
    }

    res.json({ articles, cached: false, topic: topicKey || null });
  } catch (error) {
    console.error('Error fetching articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// --- Debugger for Stanford Content ---
app.get('/debug/stanford', async (req, res) => {
  try {
    const cards = await fetchStanfordArticles(3);
    res.json({ count: cards.length, cards });
  } catch (err) {
    console.error('[DEBUG /debug/stanford] error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// --- Debugger for Smithsonian Content ---
app.get('/debug/smithsonian', async (req, res) => {
  try {
    const raw = await smithsonianListHistoryArticles();
    const cards = await fetchSmithsonianArticles(3);
    res.json({
      rawCount: raw.length,
      cardCount: cards.length,
      perUrl: smithsonianDebug,
      rawSample: raw.slice(0, 5),
      cards
    });
  } catch (err) {
    console.error('[DEBUG /debug/smithsonian] error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// --- health & root ---
app.get('/health', (req, res) => {
  const lastRefreshIso = lastRefresh ? new Date(lastRefresh).toISOString() : null;

  res.json({
    status: 'ok',
    cacheSize: articleCache.length,
    lastRefresh,
    lastRefreshIso,
    build: process.env.BUILD_ID || null
  });
});

// --- List available topic keys (for UI + debugging) ---
app.get('/api/topics', (req, res) => {
  const keys = Array.from(
    new Set([
      ...Object.keys(WIKI_CATEGORY_TOPICS || {}),
      ...Object.keys(WIKI_TOPICS || {})
    ])
  ).sort();

  res.json({
    topics: keys.map(k => ({
      key: k,
      seedCategories: WIKI_CATEGORY_TOPICS?.[k] || [],
      deepcatQueries: WIKI_TOPICS?.[k] || []
    }))
  });
});

/**
 * =========================
 * Start server
 * =========================
 */
console.log(`[BOOT] Starting Historical Feed API... (node ${process.version})`);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] Listening on 0.0.0.0:${PORT}`);
  if (String(process.env.PREFETCH_ON_START).toLowerCase() === 'true') {
    console.log('[BOOT] Prefetching initial articles...');
    fetchAllArticles()
      .then(articles => {
        articleCache = articles;
        lastRefresh = Date.now();
        console.log(`[BOOT] Prefetch loaded ${articles.length} articles`);
      })
      .catch(err => {
        console.error('[BOOT] Prefetch failed:', err?.message || err);
      });
  } else {
    console.log('[BOOT] Skipping prefetch (PREFETCH_ON_START not true)');
  }
});
