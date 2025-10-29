/**
 * mercari-scraper — 完全版 index.js
 * - Express API
 * - 認証: x-api-key
 * - 直取り + Playwright(ステルス & プロキシ対応)
 * - /scrape, /scrapeBoth, /warmup, /ip, /health
 * - Render 環境変数に優しく: NAV_TIMEOUT_OVERRIDE_MS で上書き可能
 */

/* ========================
 *  Imports & Polyfills
 * ======================*/
const express = require('express');
const { chromium } = require('playwright');

// Node18未満で fetch が無い環境に対応（Renderは18+が多いが保険）
if (typeof fetch !== 'function') {
  global.fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

/* ========================
 *  Env & Config
 * ======================*/
const PORT = parseInt(process.env.PORT || '10000', 10);

// API鍵（必須）
const API_KEY = process.env.API_KEY || process.env.MERCARI_API_KEY || '';

// 真偽系ヘルパ
const toBool = (v, def = false) => {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(s);
};

const HEADLESS = toBool(process.env.HEADLESS, true);
const DIRECT_FIRST = toBool(process.env.DIRECT_FIRST, true);
const DIRECT_ONLY_SWITCH = toBool(process.env.DIRECT_ONLY, false);

// タイムアウトは「OVERRIDE > NAV_TIMEOUT_MS > 既定」の優先
const NAV_TIMEOUT_MS = (() => {
  const raw = process.env.NAV_TIMEOUT_OVERRIDE_MS ?? process.env.NAV_TIMEOUT_MS ?? '25000';
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v >= 1000 && v <= 120000 ? v : 25000;
})();
const FETCH_TIMEOUT_MS = (() => {
  const raw = process.env.FETCH_TIMEOUT_MS ?? '7000';
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v >= 1000 && v <= 60000 ? v : 7000;
})();

// プロキシ（ローテーション対応）
const PROXY_SERVER = process.env.PROXY_SERVER || ''; // 例: http://USER:PASS@host:port?session={session}&country=jp
const PROXY_ROTATE_MS = Number(process.env.PROXY_ROTATE_MS || 10 * 60 * 1000); // 10分

/* ========================
 *  Utils (pure)
 * ======================*/
const sanitize = (v) => (v == null ? null : (String(v).replace(/\s+/g, ' ').trim() || null));
const toNumberLike = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
};
const formatJPY = (n) => (typeof n === 'number' && Number.isFinite(n) ? `¥ ${n.toLocaleString('ja-JP')}` : null);
const isGenericMercariTitle = (t) => /メルカリ\s*-\s*日本最大のフリマサービス|Mercari/i.test(String(t || ''));
const isIncomplete = (d) => {
  if (!d) return true;
  const { title, priceNumber, description } = d;
  return !sanitize(title) && !Number.isFinite(priceNumber) && !sanitize(description);
};
const isSuspiciousPrice = (n) => Number.isFinite(n) && n < 1000; // 誤検出対策（必要に応じ調整）

// HTMLユーティリティ（依存なし）
const extractBetween = (html, re, map = (x) => x) => {
  const m = re.exec(html);
  if (!m) return null;
  try {
    return map(m[1]);
  } catch {
    return null;
  }
};

const parseAllLdJson = (html) => {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const txt = m[1].trim();
    try {
      const json = JSON.parse(txt);
      if (Array.isArray(json)) out.push(...json);
      else out.push(json);
    } catch {
      // JSON崩れは無視
    }
  }
  return out;
};

const firstProductFromLd = (html) => {
  const list = parseAllLdJson(html);
  for (const obj of list) {
    if (!obj) continue;
    const t = String(obj['@type'] || '').toLowerCase();
    if (t.includes('product')) return obj;
  }
  return null;
};

const getMeta = (html, prop) =>
  extractBetween(
    html,
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    (s) => sanitize(s)
  );

/* ========================
 *  Playwright Browser (proxy rotation)
 * ======================*/
let sharedBrowser = null;
let launchedAt = 0;

const expandProxyServer = (template) => {
  if (!template) return '';
  const session = Math.random().toString(36).slice(2, 10);
  return template.replaceAll('{session}', session);
};

async function getBrowser(forceRotate = false) {
  const now = Date.now();
  const needRotate =
    forceRotate ||
    !sharedBrowser ||
    !sharedBrowser.isConnected() ||
    (PROXY_SERVER && now - launchedAt > PROXY_ROTATE_MS);

  if (!needRotate) return sharedBrowser;

  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch {}
    sharedBrowser = null;
  }

  const launchOpts = { headless: HEADLESS };
  if (PROXY_SERVER) {
    launchOpts.proxy = { server: expandProxyServer(PROXY_SERVER) };
  }

  sharedBrowser = await chromium.launch(launchOpts);
  launchedAt = now;

  sharedBrowser.on('disconnected', () => {
    sharedBrowser = null;
  });

  return sharedBrowser;
}

/* ========================
 *  Direct Fetchers
 * ======================*/
async function fetchText(url) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
      },
    });
    return await res.text();
  } finally {
    clearTimeout(to);
  }
}

async function directFetchMercari(url) {
  try {
    const html = await fetchText(url);
    const product = firstProductFromLd(html);

    const title =
      sanitize(product?.name) ||
      getMeta(html, 'og:title') ||
      extractBetween(html, /<title>([\s\S]*?)<\/title>/i, (s) => sanitize(s));

    const brand = sanitize(product?.brand?.name || product?.brand) || null;

    let priceNumber = null;
    if (product?.offers) {
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      priceNumber = toNumberLike(offers?.price);
    }
    if (!priceNumber) {
      const ogAmt = getMeta(html, 'product:price:amount') || getMeta(html, 'og:price:amount');
      priceNumber = toNumberLike(ogAmt);
    }
    if (!priceNumber) {
      // 保険：本文から最大の金額を拾う
      const txt = html.replace(/<[^>]+>/g, ' ');
      const re = /¥\s?([\d,]{2,})/g;
      let best = 0,
        m;
      while ((m = re.exec(txt))) {
        const n = Number(String(m[1]).replace(/[^\d]/g, ''));
        if (n > best) best = n;
      }
      priceNumber = best || null;
    }
    const price = formatJPY(priceNumber);
    const currency =
      (product?.offers && (Array.isArray(product.offers) ? product.offers[0]?.priceCurrency : product.offers?.priceCurrency)) ||
      'JPY';

    // description は難しいので最長っぽい段落を採用
    let description = null;
    {
      const plain = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
      const paras = plain.split(/(?:\r?\n|\s){2,}/).map((s) => s.trim()).filter(Boolean);
      description = paras.sort((a, b) => b.length - a.length)[0] || null;
      if (description && description.length < 80) description = null;
    }

    return {
      ok: true,
      via: 'direct',
      data: { title, brand, price, priceNumber: priceNumber ?? null, currency, description },
    };
  } catch (e) {
    return { ok: false, via: 'direct', error: String(e && e.message ? e.message : e) };
  }
}

async function directFetchMaker(url) {
  try {
    const html = await fetchText(url);
    const product = firstProductFromLd(html);

    const title =
      sanitize(product?.name) ||
      getMeta(html, 'og:title') ||
      extractBetween(html, /<title>([\s\S]*?)<\/title>/i, (s) => sanitize(s));

    const brand = sanitize(product?.brand?.name || product?.brand) || null;

    let priceNumber = null;
    if (product?.offers) {
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      priceNumber = toNumberLike(offers?.price);
    }
    const price = formatJPY(priceNumber);
    const currency =
      (product?.offers && (Array.isArray(product.offers) ? product.offers[0]?.priceCurrency : product.offers?.priceCurrency)) ||
      'JPY';

    let description = null;
    {
      const plain = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
      const paras = plain.split(/(?:\r?\n|\s){2,}/).map((s) => s.trim()).filter(Boolean);
      description = paras.sort((a, b) => b.length - a.length)[0] || null;
      if (description && description.length < 80) description = null;
    }

    return {
      ok: true,
      via: 'direct',
      data: { title, brand, price, priceNumber: priceNumber ?? null, currency, description },
    };
  } catch (e) {
    return { ok: false, via: 'direct', error: String(e && e.message ? e.message : e) };
  }
}

/* ========================
 *  Playwright Scraper (stealth + proxy)
 * ======================*/
async function scrapeWithPlaywright(url, type = 'mercari') {
  // 起動（必要ならローテーション）
  const browser = await getBrowser(false);

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1366, height: 900 },
  });

  // ステルス初期化
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    window.chrome = { runtime: {} };
    const origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = (p) => {
        if (p && p.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return origQuery(p);
      };
    }
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.apply(this, [p]);
    };
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
  });

  const ensureArrived = async () => {
    const u = page.url();
    const t = (await page.title()) || '';
    const onItem = /\/item\//.test(u);
    return onItem && !isGenericMercariTitle(t);
  };

  const getMetaInPage = async (prop) =>
    (await page.locator(`meta[property="${prop}"]`).getAttribute('content')) || null;

  const pickProductLdInPage = async () => {
    const handles = await page.locator('script[type="application/ld+json"]').all();
    for (const h of handles) {
      const txt = (await h.textContent())?.trim();
      if (!txt) continue;
      try {
        const json = JSON.parse(txt);
        const arr = Array.isArray(json) ? json : [json];
        for (const obj of arr) {
          if (!obj) continue;
          const t = String(obj['@type'] || '').toLowerCase();
          if (t.includes('product')) return obj;
        }
      } catch {}
    }
    return null;
  };

  const pickFromNext = async () => {
    const root = await page.evaluate(() => {
      try {
        const dom = document.querySelector('#__NEXT_DATA__');
        if (dom) return JSON.parse(dom.textContent || '{}');
      } catch {}
      try {
        return window.__NEXT_DATA__ || null;
      } catch {}
      return null;
    });
    if (!root) return null;
    return await page.evaluate((r) => {
      const toNum = (v) => {
        if (v == null) return null;
        const n = Number(String(v).replace(/[^\d.]/g, ''));
        return Number.isFinite(n) ? Math.round(n) : null;
      };
      const q = [r];
      let best = null;
      while (q.length) {
        const cur = q.shift();
        if (!cur || typeof cur !== 'object') continue;
        const name = cur.name || cur.title || cur.productName;
        const brand = (cur.brand && (cur.brand.name || cur.brand)) || null;
        const price = cur.price || (cur.offers && (Array.isArray(cur.offers) ? cur.offers[0]?.price : cur.offers?.price));
        const desc = cur.description || cur.body || cur.summary;
        if (name || brand || price || desc) {
          best = {
            title: typeof name === 'string' ? name : null,
            brand: typeof brand === 'string' ? brand : null,
            priceNumber: toNum(price),
            description: typeof desc === 'string' ? desc : null,
          };
        }
        for (const k in cur) {
          const v = cur[k];
          if (v && typeof v === 'object') q.push(v);
        }
      }
      return best;
    }, root);
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);

    if (!(await ensureArrived())) {
      await page.reload({ waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(800);
    }

    const product = await pickProductLdInPage();
    const ogTitle = await getMetaInPage('og:title');
    const pageTitle = await page.title();
    const nextPick = await pickFromNext();

    const title =
      sanitize(product?.name) || sanitize(ogTitle) || sanitize(nextPick?.title) || sanitize(pageTitle);

    const brand = sanitize(product?.brand?.name || product?.brand) || sanitize(nextPick?.brand) || null;

    let priceNumber = null;
    if (product?.offers) {
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      priceNumber = toNumberLike(offers?.price);
    }
    if (!priceNumber) {
      const ogAmt = (await getMetaInPage('product:price:amount')) || (await getMetaInPage('og:price:amount'));
      priceNumber = toNumberLike(ogAmt);
    }
    if (!priceNumber && nextPick?.priceNumber) {
      priceNumber = toNumberLike(nextPick.priceNumber);
    }
    if (!priceNumber) {
      const biggest = await page.evaluate(() => {
        const txt = document.body?.innerText || '';
        const re = /¥\s?([\d,]{2,})/g;
        let best = 0,
          m;
        while ((m = re.exec(txt))) {
          const n = Number(String(m[1]).replace(/[^\d]/g, ''));
          if (n > best) best = n;
        }
        return best || null;
      });
      if (biggest) priceNumber = biggest;
    }
    const price = formatJPY(priceNumber);
    const currency =
      (product?.offers && (Array.isArray(product.offers) ? product.offers[0]?.priceCurrency : product.offers?.priceCurrency)) ||
      'JPY';

    const description = await page.evaluate(() => {
      const chunks = [];
      const a = document.querySelector('[data-testid="item-description"]');
      if (a) chunks.push(a.innerText || a.textContent || '');
      document.querySelectorAll('article, main, section').forEach((el) => {
        const t = el.innerText || el.textContent || '';
        if (t && t.length > 80) chunks.push(t);
      });
      const joined = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      return joined || null;
    });

    const data = { title, brand, price, priceNumber: priceNumber ?? null, currency, description };

    const incomplete = isIncomplete(data) || isGenericMercariTitle(title);
    if (incomplete) {
      const htmlLen = (await page.content()).length;
      data.htmlLen = htmlLen;
      data.finalUrl = page.url();
      return { ok: false, via: 'playwright', error: 'playwright_incomplete', data };
    }
    return { ok: true, via: 'playwright', data };
  } finally {
    await context.close().catch(() => {});
  }
}

/* ========================
 *  Express App
 * ======================*/
const app = express();
app.use(express.json({ limit: '1mb' }));

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'Server API_KEY not configured' });
  if (!key || key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'mercari-scraper', ts: new Date().toISOString() });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/warmup', async (_req, res) => {
  try {
    const browser = await getBrowser(true); // 起動を確実に
    // 軽く1コンテキスト作って閉じる
    const ctx = await browser.newContext();
    await ctx.close().catch(() => {});
    res.json({ ok: true, warmed: true, ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// デバッグ: Playwright 経由の出口IP確認
app.get('/ip', async (_req, res) => {
  try {
    const browser = await getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const txt = await page.evaluate(() => document.body.innerText || '');
    await context.close().catch(() => {});
    res.json({ ok: true, ip: JSON.parse(txt).ip });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// 誤用ガード
app.get('/scrape', (_req, res) => {
  res.status(405).json({ ok: false, error: 'Method Not Allowed. Use POST /scrape' });
});

// メイン：/scrape
app.post('/scrape', requireApiKey, async (req, res) => {
  try {
    const { url, type = 'mercari', quick = true, directOnly = false } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' });

    const enforceDirectOnly = directOnly || DIRECT_ONLY_SWITCH;

    // 直取り
    const doDirect = async () => {
      return type === 'maker' ? await directFetchMaker(url) : await directFetchMercari(url);
    };

    // Playwright
    const doPlaywright = async () => {
      return await scrapeWithPlaywright(url, type);
    };

    let result = null;

    if (quick || DIRECT_FIRST) {
      const d = await doDirect();
      if (d.ok && !isIncomplete(d.data) && !isSuspiciousPrice(d.data.priceNumber)) {
        return res.json({ ok: true, url, type, via: d.via, data: d.data });
      }
      if (enforceDirectOnly) {
        return res.json({
          ok: Boolean(d.ok),
          url,
          type,
          via: 'direct',
          data: d.data || null,
          error: d.error || 'direct_incomplete',
        });
      }
      // フォールバック
      result = await doPlaywright();
      if (!result.ok) {
        // 直取り結果を添えて返す（デバッグしやすく）
        return res.json({ ok: false, url, type, via: 'playwright', error: result.error || 'playwright_failed', data: result.data || d.data || null });
      }
      return res.json({ ok: true, url, type, via: result.via, data: result.data });
    } else {
      // quick:false → まずPlaywright
      result = await doPlaywright();
      if (result.ok) {
        return res.json({ ok: true, url, type, via: result.via, data: result.data });
      }
      if (!enforceDirectOnly) {
        const d = await doDirect();
        const data = d.data || result.data || null;
        const ok = d.ok && !isIncomplete(data);
        return res.json({ ok, url, type, via: ok ? 'direct' : 'playwright', data, error: ok ? undefined : (d.error || result.error || 'incomplete') });
      }
      return res.json({ ok: false, url, type, via: 'playwright', error: result.error || 'playwright_failed', data: result.data || null });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// 拡張：/scrapeBoth（並列 + タイムアウト）
const BOTH_JOB_TIMEOUT_MS = Number(process.env.BOTH_JOB_TIMEOUT_MS || 18000);
const BOTH_TOTAL_TIMEOUT_MS = Number(process.env.BOTH_TOTAL_TIMEOUT_MS || 30000);

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout:${label}`)), ms))]);

app.post('/scrapeBoth', requireApiKey, async (req, res) => {
  try {
    const { mercariUrl, makerUrl } = req.body || {};
    if (!mercariUrl && !makerUrl) {
      return res.status(400).json({ ok: false, error: 'mercariUrl or makerUrl is required' });
    }

    const mercariJob = mercariUrl
      ? (async () => {
          const d = await directFetchMercari(mercariUrl);
          if (d.ok && !isIncomplete(d.data) && !isSuspiciousPrice(d.data.priceNumber)) return d.data;
          const r = await scrapeWithPlaywright(mercariUrl, 'mercari');
          return r.ok ? r.data : d.data || null;
        })()
      : Promise.resolve(null);

    const makerJob = makerUrl
      ? (async () => {
          const d2 = await directFetchMaker(makerUrl);
          return d2.data || null;
        })()
      : Promise.resolve(null);

    const all = Promise.allSettled([
      withTimeout(mercariJob, BOTH_JOB_TIMEOUT_MS, 'mercari'),
      withTimeout(makerJob, BOTH_JOB_TIMEOUT_MS, 'maker'),
    ]);

    const [mRes, kRes] = await withTimeout(all, BOTH_TOTAL_TIMEOUT_MS, 'scrapeBoth_total');

    const mercari = mRes.status === 'fulfilled' ? mRes.value : null;
    const maker = kRes.status === 'fulfilled' ? kRes.value : null;

    const merged = (() => {
      const m = mercari || {};
      const k = maker || {};
      const brand = sanitize(m.brand || k.brand);
      const productName = sanitize((k.title || '').replace(/\s+/g, ' ')) || sanitize(m.title);
      const priceNumber = Number.isFinite(m.priceNumber) ? m.priceNumber : (Number.isFinite(k.priceNumber) ? k.priceNumber : null);
      const price = Number.isFinite(priceNumber) ? formatJPY(priceNumber) : null;
      const currency = m.currency || k.currency || 'JPY';
      const condition = sanitize(m.condition || null) || null;
      const description_user = sanitize(m.description || null) || null;
      const specs_official = Array.isArray(k.specs_official) ? k.specs_official : [];
      const features_official = Array.isArray(k.features_official) ? k.features_official : [];
      return { brand, productName, price, priceNumber, currency, condition, description_user, specs_official, features_official };
    })();

    const sourceStatus = {
      mercari: mRes.status === 'fulfilled' ? 'ok' : (mRes.reason?.message || 'error'),
      maker: kRes.status === 'fulfilled' ? 'ok' : (kRes.reason?.message || 'error'),
    };

    return re
cd ~/Desktop/mercari-scraper
cp -a index.js index.js.bak.$(date +%Y%m%d%H%M%S)

# ここで index.js の末尾に追記
cat >> index.js <<'JS'

// --- Added routes: /ip (JSON保証) ---
app.get('/ip', async (_req, res) => {
  try {
    const browser = await getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const txt = await page.evaluate(() => document.body.innerText || '');
    await context.close().catch(()=>{});
    try {
      const obj = JSON.parse(txt);
      return res.json({ ok: true, ip: obj.ip });
    } catch {
      return res.json({ ok: true, ipRaw: (txt || '').slice(0, 500) });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// --- Added route: /scrapeBoth（自己完結版・常にJSON返却） ---
app.post('/scrapeBoth', requireApiKey, async (req, res) => {
  const safeJson = (status, payload) => {
    try { res.status(status).json(payload); }
    catch { try { res.status(500).end('{"ok":false,"error":"serialize_error"}'); } catch {}
    }
  };

  try {
    const { mercariUrl, makerUrl } = req.body || {};
    if (!mercariUrl && !makerUrl) {
      return safeJson(400, { ok: false, error: 'mercariUrl or makerUrl is required' });
    }

    const withTimeout = (p, ms, label) =>
      Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + label)), ms))]);

    const jobTimeout   = Number(process.env.BOTH_JOB_TIMEOUT_MS   || 18000);
    const totalTimeout = Number(process.env.BOTH_TOTAL_TIMEOUT_MS || 30000);

    const mercariJob = mercariUrl ? (async () => {
      const d = await directFetchMercari(mercariUrl);
      if (d.ok && !isIncomplete(d.data) && !isSuspiciousPrice(d.data.priceNumber)) return d.data;
      const r = await scrapeWithPlaywright(mercariUrl, 'mercari');
      return r.ok ? r.data : (d.data || null);
    })() : Promise.resolve(null);

    const makerJob = makerUrl ? (async () => {
      const d2 = await directFetchMaker(makerUrl);
      return d2.data || null;
    })() : Promise.resolve(null);

    const all = Promise.allSettled([
      withTimeout(mercariJob, jobTimeout, 'mercari'),
      withTimeout(makerJob,   jobTimeout, 'maker'),
    ]);

    const [mRes, kRes] = await withTimeout(all, totalTimeout, 'scrapeBoth_total');
    const mercari = mRes.status === 'fulfilled' ? mRes.value : null;
    const maker   = kRes.status === 'fulfilled' ? kRes.value : null;

    const merged = (() => {
      const m = mercari || {}, k = maker || {};
      const brand = (m.brand || k.brand) || null;
      const productName = (k.title ? String(k.title).replace(/\s+/g,' ') : null) || (m.title || null);
      const pn = Number.isFinite(m.priceNumber) ? m.priceNumber : (Number.isFinite(k.priceNumber) ? k.priceNumber : null);
      const price = Number.isFinite(pn) ? `¥ ${pn.toLocaleString('ja-JP')}` : null;
      const currency = m.currency || k.currency || 'JPY';
      const condition = m.condition || null;
      const description_user = m.description || null;
      const specs_official = Array.isArray(k.specs_official) ? k.specs_official : [];
      const features_official = Array.isArray(k.features_official) ? k.features_official : [];
      return { brand, productName, price, priceNumber: pn ?? null, currency, condition, description_user, specs_offic
