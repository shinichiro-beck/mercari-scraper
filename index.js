// ================================
// mercari-scraper 完全版（Render / GPT Actions 対応）
// Playwright ステルス対応 + HTML保存 + DOM解析強化
// ================================

import express from "express";
import { chromium } from "playwright";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// -------------------------------
// 🔐 簡易API鍵（任意）
//   - 環境変数 API_KEY を設定した場合のみ有効
//   - リクエストヘッダ x-api-key と照合
// -------------------------------
const API_KEY = process.env.API_KEY || "";
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const provided = req.get("x-api-key");
  if (provided !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

// --------------------------------
// ✅ Health check
// --------------------------------
app.get("/health", (_, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);

// --------------------------------
// ✅ Probe（HTMLサイズテスト）
// --------------------------------
app.get("/probe", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "Missing URL" });

  try {
    const html = await fetch(url).then((r) => r.text());
    res.json({ ok: true, url, textLen: html.length });
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err) });
  }
});

// --------------------------------
// ✅ /scrape（メルカリ or メーカー単体スクレイプ）
// --------------------------------
app.post("/scrape", async (req, res) => {
  const { url, type } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "URL required" });

  try {
    // --------------------------------
    // 🧠 Playwright 起動（Render本番はヘッドレス推奨）
    //   - HEADLESS=0 を付与するとローカルで可視ブラウザ起動
    // --------------------------------
    const browser = await chromium.launch({
      headless: process.env.HEADLESS !== "0",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1280,800",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: "https://www.google.com/",
      },
    });

    const page = await context.newPage();

    // ✅ ステルス対策: webdriver検知を回避
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // --------------------------------
    // 🔄 ページ読み込み + HTML保存（デバッグ用）
    // --------------------------------
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

    try {
      await page.waitForSelector("h1, [data-testid='item-name']", {
        timeout: 15000,
      });
      await page.waitForTimeout(1500);
    } catch {
      // ページ構造変化などで描画が遅い場合もあるので続行
    }

    // HTMLダンプ（Renderの一時FSにも保存可。不要なら削除OK）
    try {
      const htmlDump = await page.content();
      fs.writeFileSync(path.join(__dirname, "last_mercari.html"), htmlDump);
    } catch {
      // 書き込み失敗は無視
    }

    // --------------------------------
    // 🔍 抽出
    // --------------------------------
    const data = {};

    if (type === "mercari") {
      // タイトル
      data.title =
        (await page.locator("h1").first().textContent().catch(() => "")) ||
        (await page
          .locator("div[data-testid='item-name']")
          .first()
          .textContent()
          .catch(() => "")) ||
        "";

      // 価格（厳しめセレクタ + 正規表現でクリーン）
      const priceText =
        (await page
          .locator(
            [
              '[data-testid="item-price"]',
              '[class*="Price"]',
              "text=/¥\\s*[0-9,.]+/",
            ].join(", ")
          )
          .first()
          .textContent()
          .catch(() => "")) ||
        (await page
          .locator("text=/¥\\s*[0-9,.]+/")
          .first()
          .textContent()
          .catch(() => ""));

      const m = (priceText || "").match(/¥\s*[\d,.]+/);
      data.price = m ? m[0].replace(/\s+/g, "") : "";

      // ブランド
      data.brand =
        (await page
          .locator("dt:has-text('ブランド') + dd, a[href*='/brand/']")
          .first()
          .textContent()
          .catch(() => "")) || "";

      // コンディション
      data.condition =
        (await page
          .locator("dt:has-text('商品の状態') + dd")
          .first()
          .textContent()
          .catch(() => "")) || "";

      // 商品説明
      data.description =
        (await page
          .locator('[data-testid="item-description"]')
          .first()
          .textContent()
          .catch(() => "")) ||
        (await page.locator("section:has(p)").first().textContent().catch(() => "")) ||
        "";
    } else {
      // 🏭 メーカー公式ページ（汎用）
      const html = await page.content();
      data.title = await page.title();
      data.htmlLen = html.length;
      try {
        const meta = await page
          .locator("meta[name='description']")
          .first()
          .getAttribute("content");
        if (meta) data.description = meta;
      } catch {}
    }

    await browser.close();
    res.json({ ok: true, url, type, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// --------------------------------
// ✅ /scrapeBoth（メルカリ＋メーカー統合）
// --------------------------------
app.post("/scrapeBoth", async (req, res) => {
  const { mercariUrl, makerUrl } = req.body || {};
  if (!mercariUrl && !makerUrl)
    return res
      .status(400)
      .json({ ok: false, error: "mercariUrl または makerUrl は必須です" });

  const base = process.env.INTERNAL_BASE || "http://127.0.0.1:10000";
  const headers = {
    "Content-Type": "application/json",
    ...(API_KEY ? { "x-api-key": API_KEY } : {}),
  };

  const call = (u, type) =>
    fetch(`${base}/scrape`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: u, type }),
    }).then((r) => r.json());

  try {
    const [mercari, maker] = await Promise.all([
      mercariUrl ? call(mercariUrl, "mercari") : { data: {} },
      makerUrl ? call(makerUrl, "maker") : { data: {} },
    ]);

    const m = mercari.data || {};
    const k = maker.data || {};

    const merged = {
      brand: m.brand || "",
      productName: m.title || k.title || "",
      price: m.price || "",
      condition: m.condition || "",
      description_user: m.description || "",
      specs_official: k.specs || [],
      features_official: k.features || [],
    };

    res.json({ ok: true, data: { mercari: m, maker: k, merged } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --------------------------------
// ✅ サーバー起動（Render は 0.0.0.0 で listen 推奨）
// --------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on ${PORT}`));
