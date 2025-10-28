// =========================
// mercari-scraper 完全版
// =========================
import express from 'express';
import { chromium } from 'playwright';
import fs from 'fs/promises';

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const API_KEY = process.env.API_KEY || '';
const HEADLESS = process.env.HEADLESS !== '0';
const DIRECT_FIRST = process.env.DIRECT_FIRST !== '0';
const DIRECT_ONLY = process.env.DIRECT_ONLY === '1';
const FETCH_TIMEOUT_MS = process.env.FETCH_TIMEOUT_MS ? Number(process.env.FETCH_TIMEOUT_MS) : 8000;
const NAV_TIMEOUT_MS = process.env.NAV_TIMEOUT_MS ? Number(process.env.NAV_TIMEOUT_MS) : 180000;

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
async function writeDebugHTML(html, tag = 'mercari') { try { await fs.writeFile(`/tmp/last_${tag}.html`, html ?? '', 'utf8'); } catch {} }
function withTimeout(promise, ms, message = 'Timeout') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${message} ${ms}ms exceeded`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
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
      },
    });
    const html = await res.text();
    const ldBlocks = Array.from(html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)).map(m => m[1]);
    let product = null;
    for (const block of ldBlocks) {
      try {
        const json = JSON.parse(block.trim());
        const items = Array.isArray(json) ? json : [json];
        for (const it of items) {
          const graph = Array.isArray(it?.['@graph']) ? it['@graph'] : [it];
          for (const g of graph) {
            if (!g) continue;
            const t = g['@type'];
            if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) { product = g; break; }
          }
          if (!product) {
            const t = it['@type'];
            if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) { product = it; }
          }
          if (product) break;
        }
        if (product) break;
      } catch {}
    }
    if (product) {
      const title = product.name || product.title || '';
      const brand = typeof product.brand === 'string' ? product.brand : (product.brand?.name || '');
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      const priceNumber = offers?.price ? Number(String(offers.price).replace(/[^0-9.]/g, '')) : undefined;
      const currency = offers?.priceCurrency || 'JPY';
      const priceMatch = html.match(/¥\s*([0-9,]+)/);
      const priceText = priceMatch ? `¥${priceMatch[1]}` : (priceNumber ? `¥${priceNumber.toLocaleString('ja-JP')}` : '');
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
    return { ok: false, reason: 'direct_incomplete' };
  } finally { clearTimeout(id); }
}

let browserPromise = null;
async function getBrowser() {
  if (browserPromise) { try { const b = await browserPromise; if (!('isConnected' in b) || b.isConnected()) return b; } catch {} }
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
  await context.route('**/*', route => {
    const t = route.request().resourceType();
    if (['image', 'font', 'media'].includes(t)) return route.abort();
    route.continue();
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); }
  catch { await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS }); }

  const ld = await page.$$eval('script[type="application/ld+json"]', ns => ns.map(n => n.textContent || ''));
  let fromLd = null;
  for (const block of ld) {
    try {
      const json = JSON.parse(block.trim());
      const list = Array.isArray(json) ? json : [json];
      for (const it of list) {
        const graph = Array.isArray(it?.['@graph']) ? it['@graph'] : [it];
        for (const g of graph) {
          if (!g) continue;
          const t = g['@type'];
          if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) { fromLd = g; break; }
        }
        if (!fromLd) {
          const t = it['@type'];
          if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) { fromLd = it; }
        }
        if (fromLd) break;
      }
      if (fromLd) break;
    } catch {}
  }

  await page.waitForFunction(() => /¥\s*[0-9,.]+/.test(document.body?.innerText || ''), { timeout: 5000 }).catch(() => {});
  const domData = await page.evaluate(() => {
    const get = sel => document.querySelector(sel)?.textContent?.trim() || '';
    const meta = p => document.querySelector(`meta[property="${p}"]`)?.content || '';
    const title = get('h1, h1[aria-label], [data-testid="item-title"], [class*="ItemHeader_title"]') || meta('og:title') || document.title || '';
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const m = body.match(/¥\s*[0-9,.]+/);
    const price = m ? m[0] : (get('[data-testid="item-price"]') || get('[class*="Price_price"], [class*="ItemPrice_price"]'));
    return { title, price };
  });

  const title = fromLd?.name || fromLd?.title || domData.title || '';
  const brand = typeof fromLd?.brand === 'string' ? fromLd.brand : (fromLd?.brand?.name || '');
  const offers = Array.isArray(fromLd?.offers) ? fromLd.offers[0] : fromLd?.offers;
  const currency = offers?.priceCurrency || 'JPY';
  let priceNumber = offers?.price ? Number(String(offers.price).replace(/[^0-9.]/g, '')) : undefined;
  if (!priceNumber && domData.price) {
    const mm = domData.price.match(/([0-9,.]+)/);
    if (mm) priceNumber = Number(mm[1].replace(/,/g, ''));
  }
  const priceText = domData.price || (priceNumber ? `¥${priceNumber.toLocaleString('ja-JP')}` : '');

  const html = await page.content();
  await writeDebugHTML(html, 'mercari');
  await context.close();

  if (!title && !priceText) return { ok: false, reason: 'playwright_incomplete' };
  return { ok: true, via: 'playwright', data: { title: title || '', brand, price: priceText || '', priceNumber, currency, description: '' } };
}

app.get('/health', (_req, res) => { res.json({ ok: true, ts: nowISO() }); });
app.get('/warmup', async (_req, res) => { try { await getBrowser(); res.json({ ok: true, warmed: true, ts: nowISO() }); } catch (e) { res.status(500).json({ ok: false, error: e?.message || String(e) }); } });

app.post('/scrape', requireApiKey, async (req, res) => {
  const { url, type = 'mercari', quick = true } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url is required' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'url must be http/https' });

  try {
    if (DIRECT_ONLY) {
      const r0 = await directFetchMercari(url);
      return r0.ok ? res.json({ ok: true, url, type, ...r0 }) : res.status(503).json({ ok: false, error: 'direct_only_miss' });
    }
    if (DIRECT_FIRST && quick !== false) {
      const r = await directFetchMercari(url);
      if (r.ok) return res.json({ ok: true, url, type, ...r });
    }
    const r2 = await scrapeWithPlaywright(url);
    if (r2.ok) return res.json({ ok: true, url, type, ...r2 });
    return res.status(500).json({ ok: false, error: r2.reason || 'unknown_error' });
  } catch (e) {
    const msg = e?.message || String(e);
    return res.status(500).json({ ok: false, error: msg });
  }
});

app.get('/', (_req, res) => res.json({ ok: true, service: 'mercari-scraper', ts: nowISO() }));

async function shutdown() { try { const b = await browserPromise; await b?.close(); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, () => { console.log(`[mercari-scraper] listening on :${PORT} HEADLESS=${HEADLESS} DIRECT_FIRST=${DIRECT_FIRST}`); });
