// ====== Playwright（高信頼・Mercari強化版：完全差し替え用） ======
async function scrapeWithPlaywright(url, type = 'mercari') {
  // 依存：getBrowser(), NAV_TIMEOUT_MS（既存のものを使用）
  const browser = await getBrowser();

  // --- 関数内ユーティリティ（外部に依存しないよう内蔵） ---
  const sanitize = (v) => (v == null ? null : (String(v).replace(/\s+/g, ' ').trim() || null));
  const toNumberLike = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  const formatJPY = (n) => (typeof n === 'number' && Number.isFinite(n) ? `¥ ${n.toLocaleString('ja-JP')}` : null);
  const isGenericMercariTitle = (t) => /メルカリ\s*-\s*日本最大のフリマサービス|Mercari/i.test(String(t || ''));
  const waitALittle = async (page, ms = 1200) => page.waitForTimeout(ms);

  // __NEXT_DATA__（Next.jsの埋め込みJSON）から商品情報らしきノードを広く探索
  const pickFromNext = async (page) => {
    return await page.evaluate(() => {
      const bfsPick = (root) => {
        const q = [root];
        let best = null;
        const toNum = (v) => {
          if (v == null) return null;
          const n = Number(String(v).replace(/[^\d.]/g, ''));
          return Number.isFinite(n) ? Math.round(n) : null;
        };
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
      };

      const el = document.querySelector('#__NEXT_DATA__');
      if (!el) return null;
      try {
        const json = JSON.parse(el.textContent || '{}');
        return bfsPick(json) || null;
      } catch { return null; }
    });
  };

  // ld+json（Product）を最優先で抽出
  const pickProductLd = async (page) => {
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
      } catch { /* JSON崩れは無視 */ }
    }
    return null;
  };

  // 「商品詳細に到達したか」を緩めに判定（URLとタイトルの双方）
  const ensureArrived = async (page) => {
    const u = page.url();
    const t = (await page.title()) || '';
    const onItem = /\/item\//.test(u);
    return onItem && !isGenericMercariTitle(t);
  };

  // メタから価格やタイトルの補助取得
  const getMetaContent = async (page, prop) =>
    (await page.locator(`meta[property="${prop}"]`).getAttribute('content')) || null;

  // --- ブラウザコンテキスト作成（画像だけブロック。CSS/JSは通す） ---
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1366, height: 900 },
  });

  await context.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image') return route.abort();
    return route.continue();
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
  });

  try {
    // 1) まず読み込み（早めに返るイベントで）→ 少し待つ → 代表要素待ち（失敗しても続行）
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await waitALittle(page, 1200);
    await page.waitForSelector('[data-testid="item-description"], h1, article', { timeout: 8000 }).catch(() => {});

    // 2) まだ到達していなければ、networkidle待ち → それでもならreload
    if (!(await ensureArrived(page))) {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await waitALittle(page, 600);
    }
    if (!(await ensureArrived(page))) {
      await page.reload({ waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS }).catch(() => {});
      await waitALittle(page, 800);
    }

    // 3) データ抽出：ld+json → og:meta → __NEXT_DATA__ → DOM
    const product = await pickProductLd(page);
    const nextPick = await pickFromNext(page);

    const ogTitle = await getMetaContent(page, 'og:title');
    const pageTitle = await page.title();

    const title =
      sanitize(product?.name) ||
      sanitize(ogTitle) ||
      sanitize(nextPick?.title) ||
      sanitize(pageTitle);

    const brand =
      sanitize(product?.brand?.name || product?.brand) ||
      sanitize(nextPick?.brand) ||
      null;

    // 価格（数値を最優先）
    let priceNumber = null;
    if (product?.offers) {
      const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
      priceNumber = toNumberLike(offers?.price);
    }
    if (!priceNumber) {
      const ogAmt = await getMetaContent(page, 'product:price:amount')
        || await getMetaContent(page, 'og:price:amount');
      priceNumber = toNumberLike(ogAmt);
    }
    if (!priceNumber && nextPick?.priceNumber) {
      priceNumber = toNumberLike(nextPick.priceNumber);
    }
    const price = formatJPY(priceNumber);
    const currency =
      (product?.offers && (Array.isArray(product.offers) ? product.offers[0]?.priceCurrency : product.offers?.priceCurrency))
      || 'JPY';

    // 説明：data-testid優先→article/main/section→NEXT_DATAの長文
    const description = await page.evaluate(() => {
      const chunks = [];
      const a = document.querySelector('[data-testid="item-description"]');
      if (a) chunks.push(a.innerText || a.textContent || '');

      document.querySelectorAll('article, main, section').forEach((el) => {
        const t = el.innerText || el.textContent || '';
        if (t && t.length > 80) chunks.push(t);
      });

      const elND = document.querySelector('#__NEXT_DATA__');
      if (elND) {
        try {
          const nd = JSON.parse(elND.textContent || '{}');
          const dig = (o) => {
            if (!o || typeof o !== 'object') return null;
            for (const k in o) {
              const v = o[k];
              if (typeof v === 'string' && v.length > 120) return v;
              if (v && typeof v === 'object') {
                const r = dig(v);
                if (r) return r;
              }
            }
            return null;
          };
          const d = dig(nd);
          if (d) chunks.push(d);
        } catch {}
      }

      const joined = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      return joined || null;
    });

    const data = {
      title,
      brand,
      price,
      priceNumber: priceNumber ?? null,
      currency,
      description,
    };

    // 4) 品質ゲート：完全欠落 or 汎用タイトルなら不合格（呼び出し側でフォールバック判断しやすく）
    const incomplete = !sanitize(title) && !Number.isFinite(priceNumber) && !sanitize(description);
    if (incomplete || isGenericMercariTitle(title)) {
      return { ok: false, via: 'playwright', error: 'playwright_incomplete', data };
    }

    // OK
    return { ok: true, via: 'playwright', data };
  } finally {
    // ブラウザは共有、コンテキストだけ閉じる
    await context.close().catch(() => {});
  }
}
