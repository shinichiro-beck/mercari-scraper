// =========================
// mercari-scraper 完全版（直取り → 品質ゲート → 自動フォールバック / 安定化リトライ）
// =========================
import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs/promises';

// ---------- 環境変数 ----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const API_KEY = process.env.API_KEY || '';
const HEADLESS = process.env.HEADLESS !== '0';
const DIRECT_FIRST = process.env.DIRECT_FIRST !== '0';     // true: 直取りを先に試す
const DIRECT_ONLY_ENV = process.env.DIRECT_ONLY === '1';   // true: 直取りだけで返す
const FETCH_TIMEOUT_MS = process.env.FETCH_TIMEOUT_MS ? Number(process.env.FETCH_TIMEOUT_MS) : 7000;
const NAV_TIMEOUT_MS   = process.env.NAV_TIMEOUT_MS   ? Number(process.env.NAV_TIMEOUT_MS)   : 25000;

// 「直取りの最低品質」しきい値（必要に応じて調整）
const DIRECT_MIN_TITLE_LEN = 6;
const DIRECT_MIN_PRICE     = 500;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  next();
});

// ---------- 共通ユーティリティ ----------
function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'Server missing API_KEY' });
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}
function nowISO() { return new Date().toISOString(); }
async function writeDebugHTML(html, tag = 'mercari') { try { await fs.writeFile(`/tmp/last_${tag}.html`, html ?? '', 'utf8'); } catch {} }
function withTimeout(promise, ms, message = 'Timeout') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${message} ${ms}ms exceeded`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// ---------- 直取り（JSON-LD / meta / 本文 最大値ピック） ----------
function pickMeta(html, key) {
  // property または name に key を持つ <meta ... content="...">
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    'i'
  );
  const m = re.exec(html);
  return m ? m[1].trim() : '';
}

function pickMaxYen(text) {
  const matches = [...String(text || '').matchAll(/¥\s*([0-9][0-9,\.]*)/g)];
  if (matches.length === 0) return null;
  let max = 0;
  for (const m of matches) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max > 0 ? { priceText: `¥ ${max.toLocaleString('ja-JP')}`, priceNumber: max } : null;
}

async function directFetchMercari(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://www.google.com/'
      },
    });
    const html = await res.text();

    // 1) JSON-LD から Product を探す
    const ldBlocks = Array.from(html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)).map(m => m[1]);
    let product = null;
    for (const block of ldBlocks) {
      try {
        const json = JSON.parse(block.trim());
        const items = Array.isArray(json) ? json : [json];
        for (const it of items) {
          const graph = Array.isArray(it?.['@graph']) ? it['@graph'] : [it];
          for (const g of graph) {
            const t = g?.['@type'];
            if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) { product = g; break; }
          }
          if (!product) {
            const t = it?.['@type'];
            if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) { product = it; }
          }
          if (product) break;
        }
        if (product) break;
      } catch {}
    }

    // 2) meta から拾う
    const ogTitle   = pickMeta(html, 'og:title');
    const metaPrice = pickMeta(html, 'product:price:amount') || pickMeta(html, 'og:price:amount') || pickMeta(html, 'price') || pickMeta(html, 'itemprop=price'); // 多少甘め
    let priceFromMeta = null;
    if (metaPrice) {
      const n = Number(String(metaPrice).replace(/[^0-9.]/g,''));
      if (!Number.isNaN(n) && n > 0) priceFromMeta = { priceText: `¥ ${n.toLocaleString('ja-JP')}`, priceNumber: n };
    }

    // 3) 本文から「¥XXXX」を全部拾って最大値を採用（300円等ノイズ対策）
    const priceFromBody = pickMaxYen(html);

    const title = (product?.name || product?.title || ogTitle || '').trim();
    const brand = (typeof product?.brand === 'string') ? product.brand : (product?.brand?.name || '');
    let priceNumberDirect = undefined;

    if (product?.offers?.price) {
      const n = Number(String(product.offers.price).replace(/[^0-9.]/g, ''));
      if (!Number.isNaN(n) && n > 0) priceNumberDirect = n;
    } else if (priceFromMeta?.priceNumber) {
      priceNumberDirect = priceFromMeta.priceNumber;
    } else if (priceFromBody?.priceNumber) {
      priceNumberDirect = priceFromBody.priceNumber;
    }

    const priceText = priceNumberDirect ? `¥ ${priceNumberDirect.toLocaleString('ja-JP')}` :
                     (priceFromMeta?.priceText || priceFromBody?.priceText || '');

    if (priceText) {
      return {
        ok: true,
        via: 'direct',
        data: {
          title,
          brand,
          price: priceText,
          priceNumber: priceNumberDirect ?? (priceFromMeta?.priceNumber || priceFromBody?.priceNumber),
          currency: 'JPY',
          description: ''  // 直取りでは説明は取りづらい（動的要素が多いため）
        },
        raw: { source: product ? 'ld+json' : (priceFromMeta ? 'meta' : 'body-max') }
      };
    }
    return { ok: false, reason: 'direct_incomplete' };
  } finally { clearTimeout(id); }
}

// ---------- Playwright（安定化・リトライ付き） ----------
let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (!('isConnected' in b) || b.isConnected()) return b;
    } catch {}
  }
  browserPromise = chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--lang=ja-JP','--disable-blink-features=AutomationControlled',
      '--window-size=1280,800','--no-zygote',
      // NOTE: '--single-process' は不安定化するので入れない
      '--disable-features=NetworkService'
    ],
  });
  return browserPromise;
}

async function relaunchBrowser() {
  try { const b = await browserPromise; await b?.close?.(); } catch {}
  browserPromise = null;
  return await getBrowser();
}

async function scrapeWithPlaywright(url) {
  let browser = await withTimeout(getBrowser(), 45_000, 'browserType.launch: Timeout');

  async function makeContext() {
    const context = await browser.newContext({
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Referer': 'https://www.google.com/', 'Accept-Language':'ja,en;q=0.8' }
    });
    await context.addInitScript(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {} });
    await context.route('**/*', route => {
      const req = route.request(); const t = req.resourceType(); const u = req.url();
      if (['image','font','media','stylesheet'].includes(t)) return route.abort();
      if (/(googletagmanager|google-analytics|doubleclick|facebook|ads|criteo)\./i.test(u)) return route.abort();
      route.continue();
    });
    return context;
  }

  let context;
  try {
    context = await makeContext();
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('Target page, context or browser has been closed') || msg.includes('browser has been closed')) {
      browser = await relaunchBrowser();
      context = await makeContext();
    } else {
      throw e;
    }
  }

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); }
  catch { await page.goto(url, { waitUntil: 'commit', timeout: Math.min(15000, NAV_TIMEOUT_MS) }).catch(() => {}); }

  // ざっくり本文に価格が現れるのを少し待つ
  await page.waitForFunction(() => /¥\s*[0-9,.]+/.test(document.body?.innerText || ''), { timeout: 5000 }).catch(() => {});

  // DOM から候補を取得
  const domData = await page.evaluate(() => {
    const get = sel => document.querySelector(sel)?.textContent?.trim() || '';
    const meta = p => document.querySelector(`meta[property="${p}"]`)?.content || '';
    const title =
      get('h1, h1[aria-label], [data-testid="item-title"], [class*="ItemHeader_title"]') ||
      meta('og:title') || document.title || '';
    // メルカリのUI差分を吸収しつつ、候補だけ拾う
    const priceCandidate =
      get('[data-testid="item-price"]') ||
      get('[class*="Price_price"], [class*="ItemPrice_price"]') ||
      '';
    const desc =
      get('[data-testid="description"]') ||
      get('[class*="Description_text"], [class*="ItemDetail_description"], section[aria-label="商品の説明"]') ||
      get('article, .content, [class*="markdown"]') || '';
    const bodyText = (document.body?.innerText || '').replace(/\s+/g,' ');
    return { title, priceCandidate, desc, bodyText };
  });

  // JSON-LD から Product
  const ld = await page.$$eval('script[type="application/ld+json"]', ns => ns.map(n => n.textContent || ''));
  let fromLd = null;
  for (const block of ld) {
    try {
      const json = JSON.parse(block.trim());
      const list = Array.isArray(json) ? json : [json];
      for (const it of list) {
        const graph = Array.isArray(it?.['@graph']) ? it['@graph'] : [it];
        for (const g of graph) {
          const t = g?.['@type'];
          if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) { fromLd = g; break; }
        }
        if (!fromLd) {
          const t = it?.['@type'];
          if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) { fromLd = it; }
        }
        if (fromLd) break;
      }
      if (fromLd) break;
    } catch {}
  }

  const brand = typeof fromLd?.brand === 'string' ? fromLd?.brand : (fromLd?.brand?.name || '');
  const offers = Array.isArray(fromLd?.offers) ? fromLd.offers[0] : fromLd?.offers;
  const currency = offers?.priceCurrency || 'JPY';

  // 価格は (1) offers.price → (2) 本文最大値 → (3) dom候補 の順に
  let priceNumber = offers?.price ? Number(String(offers.price).replace(/[^0-9.]/g, '')) : undefined;
  if (!priceNumber) {
    const maxFromBody = pickMaxYen(domData.bodyText);
    if (maxFromBody?.priceNumber) priceNumber = maxFromBody.priceNumber;
  }
  if (!priceNumber && domData.priceCandidate) {
    const m = domData.priceCandidate.match(/([0-9,.]+)/);
    if (m) priceNumber = Number(m[1].replace(/,/g, ''));
  }
  const priceText = priceNumber ? `¥ ${priceNumber.toLocaleString('ja-JP')}` : (domData.priceCandidate || '');

  const title = (fromLd?.name || fromLd?.title || domData.title || '').trim();
  const description = (fromLd?.description || domData.desc || '').trim();

  const html = await page.content();
  await writeDebugHTML(html, 'mercari');
  await context.close();

  if (!title && !priceText) return { ok: false, reason: 'playwright_incomplete' };
  return { ok: true, via: 'playwright', data: { title, brand, price: priceText, priceNumber, currency, description } };
}

// ---------- ルーティング ----------
app.get('/health', (_req, res) => res.json({ ok: true, ts: nowISO() }));
app.get('/warmup', async (_req, res) => {
  try { await getBrowser(); res.json({ ok: true, warmed: true, ts: nowISO() }); }
  catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
});

app.post('/scrape', requireApiKey, async (req, res) => {
  const { url, type = 'mercari', quick = true, directOnly = false } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url is required' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'url must be http/https' });

  try {
    // 直取りだけで返すフラグ
    if (DIRECT_ONLY_ENV || directOnly === true) {
      const r0 = await directFetchMercari(url);
      return r0.ok ? res.json({ ok: true, url, type, ...r0 }) : res.status(503).json({ ok: false, error: 'direct_only_miss' });
    }

    // quick:true なら 直取り → 品質ゲート → NG なら Playwright
    if (DIRECT_FIRST && quick !== false) {
      const r = await directFetchMercari(url);
      if (r.ok) {
        const t = (r.data?.title || '').trim();
        const p = Number(r.data?.priceNumber || 0);
        const qualityOK = (t.length >= DIRECT_MIN_TITLE_LEN) && (p >= DIRECT_MIN_PRICE);
        if (qualityOK) return res.json({ ok: true, url, type, ...r });
        // 品質不足 → フォールバック続行
      }
    }

    // Playwright
    const r2 = await scrapeWithPlaywright(url);
    if (r2.ok) return res.json({ ok: true, url, type, ...r2 });
    return res.status(500).json({ ok: false, error: r2.reason || 'unknown_error' });
  } catch (e) {
    const msg = e?.message || String(e);
    return res.status(500).json({ ok: false, error: msg });
  }
});

app.get('/', (_req, res) => res.json({ ok: true, service: 'mercari-scraper', ts: nowISO() }));

async function shutdown() { try { const b = await browserPromise; await b?.close?.(); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, () => {
  console.log(`[mercari-scraper] listening on :${PORT} HEADLESS=${HEADLESS} DIRECT_FIRST=${DIRECT_FIRST}`);
});
