// =========================
// mercari-scraper 完全版
// =========================
import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs/promises';

// ---------- 環境変数 ----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const API_KEY = process.env.API_KEY || '';
const HEADLESS = process.env.HEADLESS !== '0';
const DIRECT_FIRST = process.env.DIRECT_FIRST !== '0'; // true: HTTP直取りを先に試す
const FETCH_TIMEOUT_MS = process.env.FETCH_TIMEOUT_MS ? Number(process.env.FETCH_TIMEOUT_MS) : 8000;
const NAV_TIMEOUT_MS = process.env.NAV_TIMEOUT_MS ? Number(process.env.NAV_TIMEOUT_MS) : 180000;

// ---------- サーバ初期化 ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS（任意）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  next();
});

// API Key 認証ミドルウェア
function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'Server missing API_KEY' });
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ---------- ユーティリティ ----------
function nowISO() { return new Date().toISOString(); }

async function writeDebugHTML(html, tag = 'mercari') {
  try {
    await fs.writeFile(`/tmp/last_${tag}.html`, html ?? '', 'utf8');
  } catch (_) {}
}

function withTimeout(promise, ms, message = 'Timeout') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${message} ${ms}ms exceeded`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// ---------- 1) HTTP直取り（JSON-LD優先） ----------
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
      },
    });
    const html = await res.text();
    // JSON-LD を抽出
    const ldBlocks = Array.from(html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)).map(m => m[1]);
    let product = null;
    for (const block of ldBlocks) {
      try {
        const json = JSON.parse(block.trim());
        const items = Array.isArray(json) ? json : [json];
        for (const it of items) {
          if (it && (it['@type'] === 'Product' || (Array.isArray(it['@type']) && it['@type'].includes('Product')))) {
            product = it; break;
          }
        }
        if (product) break;
      } catch (_) { /* JSON.parse 失敗は無視 */ }
    }

    // JSON-LDから整形
    if (product) {
      const title = product.name || product.title || '';
      const brand = typeof product.brand === 'string' ? product.brand : (product.brand?.name || '');
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      const priceNumber = offers?.price ? Number(String(offers.price).replace(/[^0-9.]/g, '')) : undefined;
      const currency = offers?.priceCurrency || 'JPY';
      // ページ上の¥をフォールバック抽出
      const priceMatch = html.match(/¥\s*([0-9,]+)/);
      const priceText = priceMatch ? `¥${priceMatch[1]}` : (offers?.price ? `¥${Number(offers.price).toLocaleString('ja-JP')}` : '');

      if (title && (priceText || priceNumber)) {
        return {
          ok: true,
          via: 'direct',
          data: {
            title,
            brand: brand || '',
            price: priceText || (priceNumber ? `¥${priceNumber.toLocaleString('ja-JP')}` : ''),
            priceNumber: priceNumber ?? (priceMatch ? Number(priceMatch[1].replace(/,/g, '')) : undefined),
            currency,
            description: '',
          },
          raw: { source: 'ld+json' }
        };
      }
    }

    // タイトル/価格が見つからなければ失敗扱い（Playwrightへフォールバック）
    return { ok: false, reason: 'direct_incomplete' };
  } finally {
    clearTimeout(id);
  }
}

// ---------- 2) Playwright（シングルトン起動＋軽量化） ----------
let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      // playwright v1.48+ doesn't have isConnected on Browser; if not present, assume alive
      if (!('isConnected' in b) || b.isConnected()) return b;
    } catch (_) { /* fallthrough to re-launch */ }
  }
  browserPromise = chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--lang=ja-JP',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800',
      '--no-zygote',
      '--single-process',
      '--disable-features=NetworkService',
    ],
  });
  return browserPromise;
}

async function scrapeWithPlaywright(url) {
  const browser = await withTimeout(getBrowser(), 60_000, 'browserType.launch: Timeout');
  const context = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // 重いリソース遮断
  await context.route('**/*', route => {
    const t = route.request().resourceType();
    if (['image', 'font', 'media'].includes(t)) return route.abort();
    route.continue();
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  // ナビゲーション（フォールバック1回）
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  } catch (_) {
    await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  }

  // まず JSON-LD を読む
  const ld = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent || ''));
  let fromLd = null;
  for (const block of ld) {
    try {
      const json = JSON.parse(block.trim());
      const items = Array.isArray(json) ? json : [json];
      for (const it of items) {
        if (it && (it['@type'] === 'Product' || (Array.isArray(it['@type']) && it['@type'].includes('Product')))) {
          fromLd = it; break;
        }
      }
      if (fromLd) break;
    } catch (_) {}
  }

  // DOMからもフォールバック抽出（セレクタは汎用）
  const domData = await page.evaluate(() => {
    const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
    const title = getText('h1, h1[aria-label], [data-testid="item-title"], [class*="ItemHeader_title"]');
    // 価格は「¥12,345」形式を優先抽出
    const priceCand = [
      '[data-testid="item-price"]',
      '[class*="Price_price"], [class*="ItemPrice_price"]',
      'span, div'
    ];
    let price = '';
    for (const sel of priceCand) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const n of nodes) {
        const t = n.textContent || '';
        if (/¥\s*[0-9,.]+/.test(t)) { price = t.match(/¥\s*[0-9,.]+/)[0]; break; }
      }
      if (price) break;
    }
    return { title, price };
  });

  // 最終整形
  const title = fromLd?.name || fromLd?.title || domData.title || '';
  const brand = typeof fromLd?.brand === 'string' ? fromLd.brand : (fromLd?.brand?.name || '');
  const offers = Array.isArray(fromLd?.offers) ? fromLd.offers[0] : fromLd?.offers;
  const currency = offers?.priceCurrency || 'JPY';
  const priceNumber = (() => {
    if (offers?.price) return Number(String(offers.price).replace(/[^0-9.]/g, ''));
    const m = domData.price?.match(/([0-9,.]+)/);
    return m ? Number(m[1].replace(/,/g, '')) : undefined;
  })();
  const priceText = domData.price || (priceNumber ? `¥${priceNumber.toLocaleString('ja-JP')}` : '');

  const html = await page.content();
  await writeDebugHTML(html, 'mercari');
  await context.close();

  if (!title || !priceText) {
    return { ok: false, reason: 'playwright_incomplete' };
  }

  return {
    ok: true,
    via: 'playwright',
    data: {
      title,
      brand,
      price: priceText,
      priceNumber,
      currency,
      description: '',
    }
  };
}

// ---------- ルート ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: nowISO() });
});

// 認証不要のプリウォーム（必要なら requireApiKey を噛ませる）
app.get('/warmup', async (_req, res) => {
  try {
    await getBrowser();
    res.json({ ok: true, warmed: true, ts: nowISO() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/scrape', requireApiKey, async (req, res) => {
  const { url, type = 'mercari', quick = true } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url is required' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'url must be http/https' });

  try {
    // 1) まずはHTTP直取り（ON & quick時優先）
    if (DIRECT_FIRST && quick !== false) {
      const r = await directFetchMercari(url);
      if (r.ok) return res.json({ ok: true, url, type, ...r });
    }

    // 2) Playwright フォールバック
    const r2 = await scrapeWithPlaywright(url);
    if (r2.ok) return res.json({ ok: true, url, type, ...r2 });

    return res.status(500).json({ ok: false, error: r2.reason || 'unknown_error' });
  } catch (e) {
    const msg = e?.message || String(e);
    return res.status(500).json({ ok: false, error: msg });
  }
});

// ルート（任意）
app.get('/', (_req, res) => res.json({ ok: true, service: 'mercari-scraper', ts: nowISO() }));

// ---------- 終了時クリーンアップ ----------
async function shutdown() {
  try { const b = await browserPromise; await b?.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------- 起動 ----------
app.listen(PORT, () => {
  console.log(`[mercari-scraper] listening on :${PORT} HEADLESS=${HEADLESS} DIRECT_FIRST=${DIRECT_FIRST}`);
});
