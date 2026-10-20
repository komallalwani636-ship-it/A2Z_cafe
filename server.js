// A2Z Food Corner – billing server
// Serves the billing page and stores the menu + orders.
// Uses Postgres when DATABASE_URL is set (Railway), otherwise a local JSON file.

const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const PIN = String(process.env.APP_PIN || "1234");
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("a2z-salt:" + PIN).digest("hex");
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.RAILWAY_ENVIRONMENT;

if (!process.env.APP_PIN) console.warn("⚠  APP_PIN not set – using default PIN 1234. Set APP_PIN before going live.");

/* ---------------- Storage ---------------- */
function fileStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, "data", "db.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data = { menu: null, orders: {} };
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  const save = () => { fs.writeFileSync(file + ".tmp", JSON.stringify(data)); fs.renameSync(file + ".tmp", file); };
  return {
    kind: "file",
    async init() {},
    async getMenu() { return data.menu; },
    async setMenu(items) { data.menu = items; save(); },
    async getDay(day) { return Object.values(data.orders).filter(o => o.day === day); },
    async putOrder(o) { data.orders[o.id] = o; save(); },
    async getOrder(id) { return data.orders[id] || null; },
  };
}

function pgStore() {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(url) ? false : { rejectUnauthorized: false },
  });
  return {
    kind: "postgres",
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS menu (id INT PRIMARY KEY, items JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, day DATE NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
      await pool.query(`CREATE INDEX IF NOT EXISTS orders_day_idx ON orders(day)`);
    },
    async getMenu() { const r = await pool.query("SELECT items FROM menu WHERE id=1"); return r.rows[0] ? r.rows[0].items : null; },
    async setMenu(items) {
      await pool.query(`INSERT INTO menu (id, items, updated_at) VALUES (1, $1, now())
        ON CONFLICT (id) DO UPDATE SET items=EXCLUDED.items, updated_at=now()`, [JSON.stringify(items)]);
    },
    async getDay(day) { const r = await pool.query("SELECT data FROM orders WHERE day=$1", [day]); return r.rows.map(x => x.data); },
    async putOrder(o) {
      await pool.query(`INSERT INTO orders (id, day, data, updated_at) VALUES ($1, $2, $3, now())
        ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [o.id, o.day, JSON.stringify(o)]);
    },
    async getOrder(id) { const r = await pool.query("SELECT data FROM orders WHERE id=$1", [id]); return r.rows[0] ? r.rows[0].data : null; },
  };
}

const store = process.env.DATABASE_URL ? pgStore() : fileStore();

/* ---------------- Auth (shop PIN → signed cookie) ---------------- */
const TOKEN = crypto.createHmac("sha256", SECRET).update("a2z-session:" + PIN).digest("hex");
function readCookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function authed(req) {
  const t = readCookie(req, "a2z_session");
  return t && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}
const attempts = new Map(); // ip -> {n, until}

/* ---/* ---------------- HTTP server (no framework) ---------------- */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", c => { size += c.length; if (size > 1e6) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { resolve(null); } });
    req.on("error", reject);
  });
}
function clientIp(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress; }
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) return send(res, 400, { error: "Bad path" });
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) file = path.join(PUBLIC, "index.html");
    fs.readFile(file, (e, buf) => {
      if (e) return send(res, 404, { error: "Not found" });
      const ext = path.extname(file);
      res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600" });
      res.end(buf);
    });
  });
}
function validOrder(o) {
  return o && typeof o.id === "string" && /^[\w-]{4,40}$/.test(o.id) && DAY_RE.test(o.day || "") &&
    Array.isArray(o.lines) && o.lines.length > 0 && o.lines.length < 200 && Number.isFinite(+o.total);
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, "http://x");
  const m = req.method;
  if (pathname === "/healthz") return send(res, 200, { ok: true, storage: store.kind });
  if (!pathname.startsWith("/api/")) return serveStatic(req, res, pathname);

  if (pathname === "/api/login" && m === "POST") {
    const ip = clientIp(req), a = attempts.get(ip) || { n: 0, until: 0 };
    if (a.until > Date.now()) return send(res, 429, { error: "Too many wrong PINs. Wait a minute and try again." });
    const body = await readBody(req) || {};
    if (String(body.pin || "") !== PIN) {
      a.n++; if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; }
      attempts.set(ip, a);
      return send(res, 401, { error: "Wrong PIN." });
    }
    attempts.delete(ip);
    return send(res, 200, { ok: true }, { "Set-Cookie": `a2z_session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 180}${IS_PROD ? "; Secure" : ""}` });
  }
  if (pathname === "/api/logout" && m === "POST")
    return send(res, 200, { ok: true }, { "Set-Cookie": "a2z_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });

  if (!authed(req)) return send(res, 401, { error: "Please log in." });

  if (pathname === "/api/session") return send(res, 200, { ok: true, storage: store.kind });

  if (pathname === "/api/menu" && m === "GET") return send(res, 200, { items: await store.getMenu() });
  if (pathname === "/api/menu" && m === "PUT") {
    const items = (await readBody(req) || {}).items;
    if (!Array.isArray(items) || items.length > 1000) return send(res, 400, { error: "Menu must be a list of items." });
    const clean = items.map(i => ({
      id: String(i.id || "").slice(0, 40), cat: String(i.cat || "Other").slice(0, 60),
      name: String(i.name || "").slice(0, 120), price: Math.max(0, Number(i.price) || 0), desc: String(i.desc || "").slice(0, 200),
    })).filter(i => i.id && i.name);
    await store.setMenu(clean);
    return send(res, 200, { ok: true, items: clean });
  }

  let mm;
  if ((mm = pathname.match(/^\/api\/days\/([\d-]+)$/)) && m === "GET") {
    if (!DAY_RE.test(mm[1])) return send(res, 400, { error: "Bad date." });
    return send(res, 200, { day: mm[1], orders: await store.getDay(mm[1]) });
  }

  if (pathname === "/api/orders" && m === "POST") {
    const o = await readBody(req);
    if (!validOrder(o)) return send(res, 400, { error: "Order is missing items or details." });
    const existing = await store.getOrder(o.id);           // safe to retry
    if (existing) return send(res, 200, { ok: true, order: existing });
    const dayOrders = await store.getDay(o.day);           // server gives the bill number
    o.no = dayOrders.reduce((mx, x) => Math.max(mx, x.no || 0), 0) + 1;
    o.status = "paid";
    await store.putOrder(o);
    return send(res, 200, { ok: true, order: o });
  }
  if ((mm = pathname.match(/^\/api\/orders\/([\w-]+)$/)) && m === "PATCH") {
    const o = await store.getOrder(mm[1]);
    if (!o) return send(res, 404, { error: "Bill not found." });
    const status = (await readBody(req) || {}).status;
    if (!["paid", "void"].includes(status)) return send(res, 400, { error: "Status must be paid or void." });
    o.status = status;
    await store.putOrder(o);
    return send(res, 200, { ok: true, order: o });
  }
  send(res, 404, { error: "Not found" });
}

// One request at a time touches the store, so bill numbers never collide.
let queue = Promise.resolve();
const server = http.createServer((req, res) => {
  const job = queue.then(() => handle(req, res)).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { error: "Server error. Try again." }); });
  queue = job;
});

store.init().then(() => {
  server.listen(PORT, () => console.log(`A2Z billing running on :${PORT} (storage: ${store.kind})`));
}).catch(e => { console.error("Database setup failed:", e); process.exit(1); });
