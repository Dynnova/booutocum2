require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { upsertCosplay, getStats } = require('./database');

const BASE_URL = 'https://mitaku.net';
const LISTING_URL = `${BASE_URL}/category/ero-cosplay`;
const THREADS = parseInt(process.env.THREADS) || 8;
const PROGRESS_FILE = path.join(__dirname, '../data/scrape_progress.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const headers = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.6',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Sec-Gpc': '1',
  'Cache-Control': 'max-age=0',
  'Sec-Ch-Ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Brave";v="146"',
  'Sec-Ch-Ua-Mobile': '?1',
  'Sec-Ch-Ua-Platform': '"Android"',
  ...(process.env.MITAKU_COOKIE ? { 'Cookie': process.env.MITAKU_COOKIE } : {}),
};

// ─── Progress tracking ───────────────────────────────────────────────────────

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE))
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {}
  return { completed: [], failed: [] };
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ─── Page queue ──────────────────────────────────────────────────────────────

class PageQueue {
  constructor(pages) { this.queue = [...pages]; }
  next() { return this.queue.shift() ?? null; }
  get remaining() { return this.queue.length; }
}

// ─── Fetcher ─────────────────────────────────────────────────────────────────

async function fetchHtml(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, { headers, timeout: 15000 });
      return res.data;
    } catch (e) {
      console.error(`\n❌ [${url}] ${e.message} (status: ${e.response?.status})`);
      if (i < retries - 1) await sleep(1000 * (i + 1));
    }
  }
  return null;
}

// ─── Detect max page ─────────────────────────────────────────────────────────

async function detectMaxPage() {
  const html = await fetchHtml(`${LISTING_URL}/`);
  if (!html) return 1;
  const $ = cheerio.load(html);
  const nums = [];

  // .wp-pagenavi a.page → angka halaman
  $('a.page').each((_, el) => {
    const n = parseInt($(el).text().trim());
    if (!isNaN(n)) nums.push(n);
  });

  // a.last → href="...page/742/"
  const lastHref = $('a.last').attr('href') || '';
  const match = lastHref.match(/\/page\/(\d+)\//);
  if (match) nums.push(parseInt(match[1]));

  const max = nums.length ? Math.max(...nums) : 1;
  console.log(`🔍 Detected max page: ${max}`);
  return max;
}

// ─── Parse listing page ───────────────────────────────────────────────────────

function parseListingPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $('div.featured-image').each((_, div) => {
    const $a   = $(div).find('a').first();
    const $img = $(div).find('img').first();

    const postUrl  = $a.attr('href');
    const title    = $a.attr('title') || $img.attr('title') || $img.attr('alt') || '';
    const coverUrl = $img.attr('src') || '';

    if (!postUrl || seen.has(postUrl)) return;
    seen.add(postUrl);
    items.push({ title: title.trim(), cover_url: coverUrl, page_url: postUrl });
  });

  return items;
}

// ─── Fetch post images (logika script console kamu) ───────────────────────────

async function fetchPostImages(postUrl) {
  const html = await fetchHtml(postUrl);
  if (!html) return [];

  const $ = cheerio.load(html);
  const links = new Set();

  // 1. data-mfp-src (magnificPopup)
  $('[data-mfp-src]').each((_, el) => {
    const src = $(el).attr('data-mfp-src');
    if (src) links.add(src);
  });

  // 2. a[href] → gambar asli, bukan thumbnail
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (
      /\.(jpg|jpeg|png|webp)/i.test(href) &&
      !/-\d+x\d+\.(jpg|jpeg|png|webp)/i.test(href)
    ) links.add(href);
  });

  // 3. gallery selectors
  $('.gallery-item a, .mfp-gallery a, [class*="gallery"] a').each((_, el) => {
    const href = $(el).attr('href');
    if (href) links.add(href);
  });

  return [...links];
}

// ─── Status display ──────────────────────────────────────────────────────────

function printStatus(stats, queue) {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(0);
  const rate = (stats.saved / (elapsed || 1)).toFixed(1);
  process.stdout.write(
    `\r💾 Saved: ${String(stats.saved).padStart(5)} | 🖼️  Images: ${String(stats.images).padStart(6)} | ❌ Failed: ${stats.failed} | 📃 Queue: ${String(queue.remaining).padStart(4)} | ⏱️  ${elapsed}s | ${rate}/s    `
  );
}

// ─── Worker ──────────────────────────────────────────────────────────────────

async function worker(workerId, queue, progress, stats) {
  while (true) {
    const page = queue.next();
    if (page === null) break;

    // URL: /category/ero-cosplay/ atau /category/ero-cosplay/page/2/
    const pageUrl = page === 1
      ? `${LISTING_URL}/`
      : `${LISTING_URL}/page/${page}/`;

    const html = await fetchHtml(pageUrl);

    if (!html) {
      progress.failed.push(page);
      stats.failed++;
      printStatus(stats, queue);
      continue;
    }

    const items = parseListingPage(html);

    if (!items.length) {
      progress.failed.push(page);
      stats.failed++;
      printStatus(stats, queue);
      continue;
    }

    for (const item of items) {
      try {
        const imgUrls = await fetchPostImages(item.page_url);
        await sleep(300);

        upsertCosplay({
          title:      item.title,
          cover_url:  item.cover_url,
          page_url:   item.page_url,
          image_urls: imgUrls.length ? JSON.stringify(imgUrls) : null,
          created_at: new Date().toISOString(),
        });

        stats.saved++;
        if (imgUrls.length) stats.images += imgUrls.length;
      } catch {
        stats.failed++;
      }

      printStatus(stats, queue);
    }

    progress.completed.push(page);
    saveProgress(progress);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function scrapeAll(startPage, endPage, threads) {
  console.log('🚀 Starting mitaku.net scraper...');
  console.log(`🧵 Threads: ${threads}`);
  console.log(`📂 Listing: ${LISTING_URL}`);

  const maxPage = endPage || await detectMaxPage();
  console.log(`📄 Range: page ${startPage} → ${maxPage}`);

  const progress = loadProgress();
  const completedSet = new Set(progress.completed);

  const todo = [];
  for (let p = startPage; p <= maxPage; p++) {
    if (!completedSet.has(p)) todo.push(p);
  }

  if (!todo.length) {
    console.log('✅ Semua halaman sudah selesai!');
    return;
  }

  console.log(`⏭️  Skip: ${completedSet.size} halaman`);
  console.log(`📋 Todo: ${todo.length} halaman\n`);

  const queue = new PageQueue(todo);
  const stats = { saved: 0, failed: 0, images: 0, startTime: Date.now() };

  await Promise.all(
    Array.from({ length: threads }, (_, i) => worker(i + 1, queue, progress, stats))
  );

  console.log('\n\n' + '─'.repeat(60));
  console.log(`✅ Selesai! Total di DB: ${getStats().total}`);
  console.log(`🖼️  Total images: ${stats.images}`);
  console.log(`📃 Pages selesai: ${progress.completed.length}/${maxPage}`);
  if (progress.failed.length > 0) {
    console.log(`❌ Pages gagal (${progress.failed.length}): ${progress.failed.slice(0, 20).join(', ')}`);
  }
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--reset')) {
  if (fs.existsSync(PROGRESS_FILE)) {
    fs.unlinkSync(PROGRESS_FILE);
    console.log('🔄 Progress di-reset!\n');
  }
}

const numArgs = args.filter(a => !a.startsWith('--'));
const startPage = parseInt(numArgs[0]) || 1;
const endPage   = parseInt(numArgs[1]) || null;
const threads   = parseInt(numArgs[2]) || THREADS;

scrapeAll(startPage, endPage, threads).catch(console.error);