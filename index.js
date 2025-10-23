// ================================
// mercari-scraper 完全版（Render / GPT Actions 対応）
// Playwright ステルス対応 + HTML保存 + DOM解析強化
// 追加: 価格数値化・通貨/JPY, ブランド推定, 状態フォールバック,
//       chromium.executablePath() 明示, GET /scrape の 405
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

// ---- Utils ----
const clean = (v) =>
  (v || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
const toYenNumber = (s) => {
  if (!s) return null;
  const num = String(s).replace(/[^\d]/g, "");
  return num ? Number(num) : null;
};

// ---- API Key (optional) ----
const API_KEY = process.env.API_KEY || "";
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const provided = req.get("x-api-key");
  if (provided !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

// ---- Health ----
app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ---- Probe (HTML size) ----
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

// ---- Scrape (mercari / maker) ----
app.post("/scrape", async (req, res) => {
  const { url, type } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "URL required" });

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: chromium.executablePath(), // ← 同梱/キャッシュ両対応
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

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

    try {
      await page.waitForSelector("h1, [data-testid='item-name']", { timeout: 15000 });
      await page.waitForTimeout(1500);
    } catch {}

    try {
      const htmlDump = await page.content();
      fs.writeFileSync(path.join(__dirname, "last_mercari.html"), htmlDump);
    } catch {}

    const data = {};

    if (type === "mercari") {
      // タイトル
      data.title = clean(
        (await page.locator("h1").first().textContent().catch(() => "")) ||
        (await page.locator("div[data-testid='item-name']").first().textContent().catch(() => "")) ||
        ""
      );

      // 価格
      const priceText =
        (await page.locator(
          [
            '[data-testid="item-price"]',
            '[class*="Price"]',
            "text=/¥\\s*[0-9,.]+/",
          ].join(", ")
        ).first().textContent().catch(() => "")) ||
        (await page.locator("text=/¥\\s*[0-9,.]+/").first().textContent().catch(() => ""));

      const m = (priceText || "").match(/¥\s*[\d,.]+/);
      data.price = m ? clean(m[0]) : "";
      data.priceNumber = toYenNumber(data.price);
      data.currency = data.price ? "JPY" : undefined;

      // ブランド
      data.brand = clean(
        (await page
          .locator("dt:has-text('ブランド') + dd, a[href*='/brand/']")
          .first()
          .textContent()
          .catch(() => "")) || ""
      );
      // 空ならタイトルから推定
      if (!data.brand && data.title) {
        const t = data.title.toLowerCase();
        if (t.includes("kinujo") || t.includes("絹女") || t.includes("キヌージョ")) {
          data.brand = "KINUJO";
        }
      }

      // コンディション
      data.condition = clean(
        (await page.locator("dt:has-text('商品の状態') + dd").first().textContent().catch(() => "")) || ""
      );
      if (!data.condition) {
        const raw = await page
          .locator(
            [
              "dt:has-text('状態') + dd",
              "[data-testid*='condition']",
              "[class*='Condition']",
              "text=/未使用に近い|新品|やや傷や汚れあり|傷や汚れあり|全体的に状態が悪い/",
            ].join(", ")
          )
          .first()
          .textContent()
          .catch(() => "");
        data.condition = clean(raw);
      }

      // 商品説明
      data.description = clean(
        (await page.locator('[data-testid="item-description"]').first().textContent().catch(() => "")) ||
        (await page.locator("section:has(p)").first().textContent().catch(() => "")) ||
        ""
      );
    } else {
      // メーカー汎用
      const html = await page.content();
      data.title = clean(await page.title());
      data.htmlLen = html.length;
      try {
        const meta = await page.locator("meta[name='description']").first().getAttribute("content");
        if (meta) data.description = clean(meta);
      } catch {}
      data.specs = data.specs || [];
      data.features = data.features || [];
    }

    res.json({ ok: true, url, type, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// GET /scrape → 405（完全版のサイン）
app.get("/scrape", (_, res) => {
  res.status(405).json({ ok: false, error: "Method Not Allowed. Use POST /scrape" });
});

// ---- /scrapeBoth ----
app.post("/scrapeBoth", async (req, res) => {
  const { mercariUrl, makerUrl } = req.body || {};
  if (!mercariUrl && !makerUrl) {
    return res.status(400).json({ ok: false, error: "mercariUrl または makerUrl は必須です" });
  }

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
      priceNumber: m.priceNumber ?? toYenNumber(m.price),
      currency: m.currency || (m.price ? "JPY" : undefined),
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

// ---- Server ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Server running on ${PORT}`));
