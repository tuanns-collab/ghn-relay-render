// Relay vượt Cloudflare cho GHN bằng Playwright
// API:
//   GET  /health
//   POST /check  { warehouse_id, token? }
//   POST /update { order_codes[], warehouse_id, type, reason?, token? }
//   POST /log    { order_code, warehouse_id, type, description?, token? }
// ENV: PORT, GHN_TOKEN (optional), SHARED_SECRET (optional), BROWSERLESS_WS (optional)

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { chromium } from "playwright";

const PORT = process.env.PORT || 8787;
const GHN_TOKEN_ENV = process.env.GHN_TOKEN || null;
const BROWSERLESS_WS = process.env.BROWSERLESS_WS || null;
const SHARED_SECRET = process.env.SHARED_SECRET || null;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const REFERRER = "https://tracuunoibo.ghn.vn/";

let browser, context;

async function initBrowser() {
  if (browser) return;

  if (BROWSERLESS_WS) {
    browser = await chromium.connectOverCDP(BROWSERLESS_WS);
  } else {
    browser = await chromium.launch({ headless: true });
  }
  context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  // “Khởi động” cookie cf_clearance
  for (const host of [
    "https://tracuunoibo.ghn.vn/",
    "https://fe-online-gateway.ghn.vn/",
  ]) {
    try {
      await page.goto(host, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(4000);
    } catch {}
  }
  await page.close();
}

async function teardown() {
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
}
process.on("SIGINT", async () => { await teardown(); process.exit(0); });
process.on("SIGTERM", async () => { await teardown(); process.exit(0); });

async function doPost(url, token, data) {
  await initBrowser();
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    referer: REFERRER,
    "user-agent": UA,
    token,
  };
  const resp = await context.request.post(url, {
    headers,
    data,
    timeout: 45000,
    failOnStatusCode: false,
  });
  const status = resp.status();
  let json = null, text = "";
  try { json = await resp.json(); } catch { text = await resp.text(); }
  return { status, json, text };
}

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// Secret (nên bật để chỉ GAS mới gọi được)
app.use((req, res, next) => {
  if (SHARED_SECRET && req.headers["x-secret"] !== SHARED_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", async (_req, res) => {
  try { await initBrowser(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.post("/check", async (req, res) => {
  try {
    const token = req.body.token || GHN_TOKEN_ENV;
    if (!token) return res.status(400).json({ error: "missing token" });
    const payload = { warehouse_id: Number(req.body.warehouse_id) };
    const out = await doPost(
      "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/check-warehouse-ownership",
      token, payload
    );
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
    const out = await doPost(
      "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/update-orders-warehouse",
      token, payload
    );
    res.status(out.status).json(out.json ?? { text: out.text });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/log", async (req, res) => {
  try {
    const token = req.body.token || GHN_TOKEN_ENV;
    if (!token) return res.status(400).json({ error: "missing token" });
    const fieldByType = {1:"pickup_warehouse_id",2:"current_warehouse_id",3:"deliver_warehouse_id",4:"return_warehouse_id"};
    const field = fieldByType[Number(req.body.type ?? 3)] || "deliver_warehouse_id";
    const payload = {
      order_code: String(req.body.order_code || ""),
      action: "revert_warehouse",
      description: req.body.description || "Thao tác đơn hàng",
      info: { old: {}, new: { [field]: Number(req.body.warehouse_id) } },
    };
    const out = await doPost(
      "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/activity-logs/create",
      token, payload
    );
    res.status(out.status).json(out.json ?? { text: out.text });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(PORT, () => console.log("Relay listening on :" + PORT));
