// server.js — GHN Relay (Render)
// Node 20 + Playwright (Chromium). ESM.
// ENV cần có: SHARED_SECRET (bắt buộc), GHN_TOKEN (tuỳ chọn), PORT, BROWSERLESS_WS (tuỳ chọn)

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { chromium } from "playwright";

const PORT = process.env.PORT || 8787;
const SHARED_SECRET = process.env.SHARED_SECRET || null;
const GHN_TOKEN_ENV = process.env.GHN_TOKEN || null;
const BROWSERLESS_WS = process.env.BROWSERLESS_WS || null;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const REFERRER = "https://tracuunoibo.ghn.vn/";
const ORIGIN   = "https://tracuunoibo.ghn.vn";

const GHN = {
  CHECK:  "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/check-warehouse-ownership",
  UPDATE: "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/update-orders-warehouse",
  LOG:    "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/activity-logs/create",
};

let browser, context;

// --- khởi tạo / làm mới trình duyệt ---
async function initBrowser() {
  if (browser) return;
  if (BROWSERLESS_WS) {
    // dùng Browserless nếu có, tiết kiệm thời gian cài Chromium
    browser = await chromium.connectOverCDP(BROWSERLESS_WS);
  } else {
    browser = await chromium.launch({ headless: true });
  }
  context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  // đi qua các trang để Cloudflare cấp cookie cf_clearance
  for (const u of [REFERRER + "internal/revert", "https://fe-online-gateway.ghn.vn/"]) {
    try { await page.goto(u, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(3500); } catch {}
  }
  await page.close();
}

async function refreshContext() {
  try { await context?.close(); } catch {}
  context = await browser.newContext({ userAgent: UA });
}

// --- gọi API bình thường, có retry ---
async function doPost(url, token, data) {
  await initBrowser();
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    referer: REFERRER,
    origin: ORIGIN,
    "user-agent": UA,
    token,
  };

  let resp = await context.request.post(url, {
    headers, data, timeout: 45000, failOnStatusCode: false,
  });
  let status = resp.status();
  let text = "", json = null;
  try { json = await resp.json(); } catch { text = await resp.text(); }

  // Nếu Cloudflare chặn hoặc 403 → fallback sang fetch trong "page"
  if (status === 403 || /Just a moment/i.test(text)) {
    await refreshContext();
    const b = await browserFetch(url, headers, data, token);
    status = b.status; json = b.json; text = b.text;
  }

  return { status, json, text };
}

// --- fetch "bên trong trình duyệt" (tránh CF/CORS) ---
async function browserFetch(url, headers, data, token) {
  await initBrowser();
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  try {
    await page.goto(REFERRER + "internal/revert", { waitUntil: "domcontentloaded" });
    await page.evaluate(t => localStorage.setItem("token", t || ""), token || "");

    // ⬇️ QUAN TRỌNG: truyền 1 object duy nhất vào evaluate
    const out = await page.evaluate(async ({ u, h, d }) => {
      const res = await fetch(u, {
        method: "POST",
        headers: h,
        body: JSON.stringify(d),
        credentials: "include",
        mode: "cors"
      });
      const text = await res.text();
      return { status: res.status, text };
    }, { u: url, h: headers, d: data });

    let json = null; try { json = JSON.parse(out.text); } catch {}
    return { status: out.status, json, text: out.text };
  } finally {
    try { await page.close(); } catch {}
  }
}


// --- express app ---
const app = express();
app.use(cors({ origin: "*"}));
app.use(bodyParser.json({ limit: "1mb" }));

// /health không cần secret để test nhanh
app.get("/health", async (_req, res) => {
  try { await initBrowser(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// middleware xác thực (áp cho tất cả route còn lại)
app.use((req, res, next) => {
  if (!SHARED_SECRET) return next(); // nếu không cấu hình secret thì mở
  const provided =
    req.headers["x-secret"] ||
    req.headers["x-proxy-key"] ||
    req.query.secret ||
    (req.body && (req.body.secret || req.body.SHARED_SECRET));
  if (provided !== SHARED_SECRET) return res.status(401).json({ error: "unauthorized" });
  next();
});

// --- ROUTE TƯƠNG THÍCH CODE CŨ: /forward ---
app.post("/forward", async (req, res) => {
  try {
    const { url, method = "POST", data = {}, headers = {}, token } = req.body || {};
    if (!url) return res.status(400).json({ error: "missing url" });

    // ép các header quan trọng
    const h = {
      accept: "application/json",
      "content-type": "application/json",
      referer: REFERRER,
      origin: ORIGIN,
      "user-agent": UA,
      token: headers.token || token || GHN_TOKEN_ENV || "",
    };

    const out = await doPost(url, h.token, data);
    res.status(out.status).json(out.json ?? { text: out.text });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- ROUTE CHUYÊN DỤNG ---
app.post("/check", async (req, res) => {
  try {
    const token = req.body.token || GHN_TOKEN_ENV;
    if (!token) return res.status(400).json({ error: "missing token" });
    const payload = { warehouse_id: Number(req.body.warehouse_id) };
    const out = await doPost(GHN.CHECK, token, payload);
    res.status(out.status).json(out.json ?? { text: out.text });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/update", async (req, res) => {
  try {
    const token = req.body.token || GHN_TOKEN_ENV;
    if (!token) return res.status(400).json({ error: "missing token" });
    const payload = {
      order_codes: req.body.order_codes || [],
      warehouse_id: Number(req.body.warehouse_id),
      reason: req.body.reason ?? "",
      type: Number(req.body.type ?? 3),
    };
    const out = await doPost(GHN.UPDATE, token, payload);
    res.status(out.status).json(out.json ?? { text: out.text });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/log", async (req, res) => {
  try {
    const token = req.body.token || GHN_TOKEN_ENV;
    if (!token) return res.status(400).json({ error: "missing token" });
    const fieldByType = { 1:"pickup_warehouse_id", 2:"current_warehouse_id", 3:"deliver_warehouse_id", 4:"return_warehouse_id" };
    const field = fieldByType[Number(req.body.type ?? 3)] || "deliver_warehouse_id";
    const payload = {
      order_code: String(req.body.order_code || ""),
      action: "revert_warehouse",
      description: req.body.description || "Thao tác đơn hàng",
      info: { old: {}, new: { [field]: Number(req.body.warehouse_id) } },
    };
    const out = await doPost(GHN.LOG, token, payload);
    res.status(out.status).json(out.json ?? { text: out.text });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// --- graceful shutdown ---
async function teardown() {
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
}
process.on("SIGINT",  async () => { await teardown(); process.exit(0); });
process.on("SIGTERM", async () => { await teardown(); process.exit(0); });

app.listen(PORT, () => console.log("GHN Relay listening on :" + PORT));
