// =========================
// mercari-scraper 完全版（直取り＋品質ゲート＋Playwrightフォールバック）
// =========================
import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs/promises';

// ---------- 環境変数 ----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const API_KEY = process.env.API_KEY || '';
const HEADLESS = process.env.HEADLESS !== '0';          // Render 等は基本 true
const DIRECT_FIRST = process.env.DIRECT_FIRST !== '0';  // true: 直取りを先に試す
const DIRECT_ONLY_ENV = process.env.DIRECT_ONLY === '1';// 直取りだけで返す高速スイッチ
const FETCH_TIMEOUT_MS = process.env.FETCH_TIMEOUT_MS ? Number(process.env.FETCH_TIMEOUT_MS) : 7000;
const NAV_TIMEOUT_MS   = process.env.NAV_TIMEOUT_MS   ? Number(process.env.NAV_TIMEOUT_MS)   : 25000;

// ---------- Express 基本 ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  next();
});

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'Server missing API_KEY' });
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

function nowISO() { return new Date().toISOString(); }
async function writeDebugHTML(html, tag = 'mercari') {
  try { await fs.writeFile(`/tmp/last_${tag}.html`, html ?? '', 'utf8'); } catch {}
}
function withTimeout(promise, ms, message = 'Timeout') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${message} ${ms}ms exceeded`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// ---------- HTML メタ抽出（直取り用の軽量パーサ） ----------
function pickMetaContent(html, attr, value) {
  // 例: (property, 'og:title'), (name,'description'), (itemprop,'price')
  const re = new RegExp(
    `<meta[^>]*\\b${attr}\\s*=\\s*["']${value}["'][^>]*\\bcontent\\s*=\\s*["']([^"']+)["'][^>]*>`,
    'i'
  );
  const m = re.exec(html);
  return m ? m[1].trim() : '';
}
function pickFirstMeta(html, list) {
  for (const [attr, val] of list) {
    const v = pickMetaContent(html, attr, val);
    if (v) return v;
  }
  return '';
}
function pickPriceFromText(txt) {
  const m = /¥\s*([0-9][0-9,\.]*)/.exec(txt.replace(/\s+/g,' '));
  return m ? { priceText: `¥ ${m[1]}`, priceNumber: Number(m[1].replace(/,/g,'')) } : null;
}

// ---------- 直取り（JSON-LD + meta + 本文スキャン） ----------
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

    // ---- JSON-LD Product を探す
    const ldBlocks = Array.from(html.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )).map(m => m[1]);

    let product = null;
    for (const block of ldBlocks) {
      try {
        const json = JSON.parse(block.trim());
        const arr = Array.isArray(json) ? json : [json];
        for (const it of arr) {
          const graph = Array.isArray(it?.['@graph']) ? it['@graph'] : [it];
          for (const g of graph) {
            const t = g?.['@type'];
            if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) { product = g; break; }
          }
          if (!product) {
            const t2 = it?.['@type'];
            if (t2 === 'Product' || (Array.isArray(t2) && t2.includes('Product'))) { product = it; }
          }
          if (product) break;
        }
        if (product) break;
      } catch {}
    }

    // ---- メタ
    const ogTitle = pickMetaContent(html, 'property', 'og:title');
    const metaPriceRaw = pickFirstMeta(html, [
      ['property','product:price:amount'],
      ['property','og:price:amount'],
      ['itemprop','price'],
      ['name','price'],
    ]);
    let priceFromMeta = null;
    if (metaPriceRaw) {
      const n = Number(String(metaPriceRaw).replace(/[^0-9.]/g,''));
      if (!Number.isNaN(n) && n > 0) priceFromMeta = { priceText: `¥ ${n.toLocaleString('ja-JP')}`, priceNumber: n };
    }

    // ---- 本文スキャン（fallback）
    const fromBody = pickPriceFromText(html);

    // ---- タイトル・ブランド・価格
    const title = product?.name || product?.title || ogTitle || '';
    const brand = typeof product?.brand === 'string' ? product?.brand : (product?.brand?.name || '');
    const price = priceFromMeta
      || (product?.offers?.price
            ? { priceText: `¥ ${Number(product.offers.price).toLocaleString('ja-JP')}`, priceNumber: Number(product.offers.price) }
            : null)
      || fromBody;

    // ---- 説明（取れる範囲で）
    const description =
      (typeof product?.description === 'string' ? product.description : '') ||
      pickFirstMeta(html, [['name','description'], ['property','og:description']]) ||
      '';

    // ---- 品質ゲート（直取りが変なら Playwright へ委譲）
    const sane =
      (title && title.replace(/\s+/g, '').length >= 5) &&
      (price && price.priceNumber && price.priceNumber >= 500);

    if (sane) {
      return {
        ok: true,
        via: 'direct',
        data: {
          title,
          brand,
          price: price.priceText,
          priceNumber: price.priceNumber,
          currency: 'JPY',
          description
        },
        raw: { source: product ? 'ld+json' : (priceFromMeta ? 'meta' : 'body') }
      };
    }

    return { ok: false, reason: 'direct_incomplete' };
  } finally {
    clearTimeout(id);
  }
}

// ---------- Playwright（起動短縮＋不要リソース遮断） ----------
let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    try { const b = await browserPromise; if (!('isConnected' in b) || b.isConnected()) return b; } catch {}
  }
  browserPromise = chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--lang=ja-JP','--disable-blink-features=AutomationControlled',
      '--window-size=1280,800','--no-zygote','--single-process','--disable-features=NetworkService'
    ],
  });
  return browserPromise;
}

async function scrapeWithPlaywright(url) {
  const browser = await withTimeout(getBrowser(), 45_000, 'browserType.launch: Timeout');
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

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); }
  catch { await page.goto(url, { waitUntil: 'commit', timeout: Math.min(15000, NAV_TIMEOUT_MS) }).catch(() => {}); }

  // 価格は本文に現れるので軽く待つ
  await page.waitForFunction(() => /¥\s*[0-9,.]+/.test(document.body?.innerText || ''), { timeout: 5000 }).catch(() => {});

  // DOM 抽出
  const domData = await page.evaluate(() => {
    const getText = sel => document.querySelector(sel)?.textContent?.trim() || '';
    const meta = p => document.querySelector(`meta[property="${p}"]`)?.content || '';

    const title =
      getText('h1, h1[aria-label], [data-testid="item-title"], [class*="ItemHeader_title"]') ||
      meta('og:title') ||
      document.title ||
      '';

    // 価格（本文→専用要素）
    const body = (document.body?.innerText || '').replace(/\s+/g,' ');
    const m = body.match(/¥\s*[0-9,.]+/);
    const priceGuess = m ? m[0] : '';

    const priceNode =
      getText('[data-testid="item-price"]') ||
      getText('[class*="Price_price"], [class*="ItemPrice_price"]') ||
      '';

    // 説明
    const desc =
      getText('[data-testid="item-description"]') ||
      getText('[data-testid="description"]') ||
      getText('[class*="Description"], [class*="item-description"], section[data-testid="description"]') ||
      meta('og:description') || '';

    return { title, price: priceNode || priceGuess, description: desc };
  });

  // JSON-LD
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

  let priceNumber = offers?.price ? Number(String(offers.price).replace(/[^0-9.]/g, '')) : undefined;
  if (!priceNumber && domData.price) {
    const mm = domData.price.match(/([0-9,.]+)/);
    if (mm) priceNumber = Number(mm[1].replace(/,/g, ''));
  }

  // 価格表示は priceNumber を最優先（誤検出対策）
  const priceText = (priceNumber ? `¥ ${priceNumber.toLocaleString('ja-JP')}` : (domData.price || ''));

  const title = fromLd?.name || fromLd?.title || domData.title || '';
  const description =
    (typeof fromLd?.description === 'string' ? fromLd.description : '') ||
    domData.description || '';

  const html = await page.content();
  await writeDebugHTML(html, 'mercari');
  await context.close();

  if (!title && !priceText) return { ok: false, reason: 'playwright_incomplete' };
  return {
    ok: true,
    via: 'playwright',
    data: { title: title || '', brand, price: priceText || '', priceNumber, currency, description: description || '' }
  };
}

// ---------- ルート ----------
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
    // 直取りのみモード
    if (DIRECT_ONLY_ENV || directOnly === true) {
      const r0 = await directFetchMercari(url);
      return r0.ok ? res.json({ ok: true, url, type, ...r0 }) : res.status(503).json({ ok: false, error: 'direct_only_miss' });
    }

   // 直取り → 品質チェック → OKなら返す / NGならフォールバック
if (DIRECT_FIRST && quick !== false) {
  const r = await directFetchMercari(url);
  if (r?.ok) {
    const d = r.data || {};
    const badTitle = !d.title || d.title === 'メルカリ';
    const badPrice = !d.priceNumber || d.priceNumber < 1000; // 送料/手数料等のノイズ対策
    const looksBad = badTitle || badPrice || r?.raw?.source === 'body';

    if (!looksBad) {
      return res.json({ ok: true, url, type, ...r });
    }
    // ここを通ると Playwright にフォールバック
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

// ---------- シャットダウン ----------
async function shutdown() { try { const b = await browserPromise; await b?.close(); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, () => {
  console.log(`[mercari-scraper] listening on :${PORT} HEADLESS=${HEADLESS} DIRECT_FIRST=${DIRECT_FIRST}`);
});
