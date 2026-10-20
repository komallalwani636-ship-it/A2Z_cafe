// A2Z Food Corner – shared API logic, used by both the Vercel function (api/index.js)
// and the local server (server.js).
// Storage: Postgres when DATABASE_URL / POSTGRES_URL is set, otherwise a local JSON file.

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PIN = String(process.env.APP_PIN || "1234");
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("a2z-salt:" + PIN).digest("hex");
const IS_PROD = process.env.NODE_ENV === "production" || !!process.env.VERCEL || !!process.env.RAILWAY_ENVIRONMENT;
const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

if (!process.env.APP_PIN) console.warn("APP_PIN not set – using default PIN 1234. Set APP_PIN before going live.");

/* ---------------- Storage ---------------- */
function fileStore() {
  const file = process.env.DATA_FILE || path.join(__dirname, "..", "data", "db.json");
  let data = { menu: null, orders: {} };
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(data)); fs.renameSync(file + ".tmp", file);
  };
  return {
    kind: "file",
    async init() {},
    async getMenu() { return data.menu; },
    async setMenu(items) { data.menu = items; save(); },
    async getDay(day) { return Object.values(data.orders).filter(o => o.day === day); },
    async getOrder(id) { return data.orders[id] || null; },
    async createOrder(o) {
      if (data.orders[o.id]) return data.orders[o.id];
      o.no = Object.values(data.orders).filter(x => x.day === o.day).reduce((m, x) => Math.max(m, x.no || 0), 0) + 1;
      data.orders[o.id] = o; save(); return o;
    },
    async updateOrder(o) { data.orders[o.id] = o; save(); },
    async getImage(id) {
      const f = path.join(path.dirname(file), "img", id);
      try { return { mime: fs.readFileSync(f + ".type", "utf8"), data: fs.readFileSync(f) }; } catch (e) { return null; }
    },
    async setImage(id, mime, buf) {
      const d = path.join(path.dirname(file), "img"); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, id), buf); fs.writeFileSync(path.join(d, id + ".type"), mime);
    },
    async delImage(id) { const f = path.join(path.dirname(file), "img", id); try { fs.unlinkSync(f); fs.unlinkSync(f + ".type"); } catch (e) {} },
  };
}

function pgStore() {
  const { Pool } = require("pg");
  const local = /localhost|127\.0\.0\.1/.test(DB_URL);
  const pool = new Pool({ connectionString: DB_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 3 });
  return {
    kind: "postgres",
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS a2z_menu (id INT PRIMARY KEY, items JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS a2z_orders (
        id TEXT PRIMARY KEY, day DATE NOT NULL, no INT NOT NULL, data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE (day, no))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS a2z_images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
    },
    async getMenu() { const r = await pool.query("SELECT items FROM a2z_menu WHERE id=1"); return r.rows[0] ? r.rows[0].items : null; },
    async setMenu(items) {
      await pool.query(`INSERT INTO a2z_menu (id, items, updated_at) VALUES (1, $1, now())
        ON CONFLICT (id) DO UPDATE SET items=EXCLUDED.items, updated_at=now()`, [JSON.stringify(items)]);
    },
    async getDay(day) { const r = await pool.query("SELECT data FROM a2z_orders WHERE day=$1 ORDER BY no", [day]); return r.rows.map(x => x.data); },
    async getOrder(id) { const r = await pool.query("SELECT data FROM a2z_orders WHERE id=$1", [id]); return r.rows[0] ? r.rows[0].data : null; },
    // Bill number is picked inside the INSERT; UNIQUE(day,no) makes two phones saving at once safe.
    async createOrder(o) {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const r = await pool.query(`
            INSERT INTO a2z_orders (id, day, no, data)
            SELECT $1, $2::date, n, jsonb_set($3::jsonb, '{no}', to_jsonb(n))
            FROM (SELECT COALESCE(MAX(no), 0) + 1 AS n FROM a2z_orders WHERE day = $2::date) t
            ON CONFLICT (id) DO NOTHING
            RETURNING data`, [o.id, o.day, JSON.stringify(o)]);
          if (r.rows[0]) return r.rows[0].data;
          return await this.getOrder(o.id); // already saved (retry from the phone)
        } catch (e) {
          if (e.code !== "23505") throw e;   // unique (day,no) clash → try the next number
          await new Promise(res => setTimeout(res, 30 + Math.random() * 70));
        }
      }
      throw new Error("Could not assign a bill number");
    },
    async updateOrder(o) { await pool.query("UPDATE a2z_orders SET data=$2, updated_at=now() WHERE id=$1", [o.id, JSON.stringify(o)]); },
    async getImage(id) { const r = await pool.query("SELECT mime, data FROM a2z_images WHERE id=$1", [id]); return r.rows[0] || null; },
    async setImage(id, mime, buf) {
      await pool.query(`INSERT INTO a2z_images (id, mime, data) VALUES ($1,$2,$3)
        ON CONFLICT (id) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()`, [id, mime, buf]);
    },
    async delImage(id) { await pool.query("DELETE FROM a2z_images WHERE id=$1", [id]); },
  };
}

const store = DB_URL ? pgStore() : fileStore();
let ready = null;
const init = () => (ready = ready || store.init().catch(e => { ready = null; throw e; }));

/* ---------------- Auth (shop PIN → signed cookie) ---------------- */
const TOKEN = crypto.createHmac("sha256", SECRET).update("a2z-session:" + PIN).digest("hex");
function readCookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function authed(req) {
  const t = readCookie(req, "a2z_session");
  return !!t && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}
const attempts = new Map(); // ip -> {n, until}

/* ---------------- Helpers ---------------- */
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  if (req.body !== undefined) {                       // Vercel may have parsed it already
    const b = req.body;
    if (b && typeof b === "object" && !Buffer.isBuffer(b)) return Promise.resolve(b);
    try { return Promise.resolve(b ? JSON.parse(b.toString()) : {}); } catch (e) { return Promise.resolve(null); }
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 1e6) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { resolve(null); } });
    req.on("error", reject);
  });
}
function clientIp(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "?"; }
function validOrder(o) {
  return o && typeof o.id === "string" && /^[\w-]{4,40}$/.test(o.id) && DAY_RE.test(o.day || "") &&
    Array.isArray(o.lines) && o.lines.length > 0 && o.lines.length < 200 && Number.isFinite(+o.total);
}

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname) {
  const m = req.method;
  if (pathname === "/healthz") {
    try { await init(); return send(res, 200, { ok: true, storage: store.kind }); }
    catch (e) { return send(res, 500, { ok: false, storage: store.kind, error: "Database not reachable: " + e.message }); }
  }
  if (process.env.VERCEL && store.kind === "file")
    return send(res, 500, { error: "No database connected. In Vercel, add a Postgres (Neon) database to this project and redeploy." });
  await init();

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
      img: String(i.img || "").slice(0, 30),
    })).filter(i => i.id && i.name);
    await store.setMenu(clean);
    return send(res, 200, { ok: true, items: clean });
  }

  let mm;
  if ((mm = pathname.match(/^\/api\/img\/([\w-]{1,40})$/))) {
    const id = mm[1];
    if (m === "GET") {
      const img = await store.getImage(id);
      if (!img) return send(res, 404, { error: "No photo" });
      res.writeHead(200, { "Content-Type": img.mime, "Cache-Control": "private, max-age=31536000, immutable" });
      return res.end(img.data);
    }
    if (m === "PUT") {
      const body = await readBody(req) || {};
      const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ""));
      if (!match) return send(res, 400, { error: "Photo must be a JPG, PNG or WebP image." });
      const buf = Buffer.from(match[2], "base64");
      if (buf.length > 600 * 1024) return send(res, 400, { error: "Photo is too large. Pick a smaller one." });
      await store.setImage(id, match[1], buf);
      return send(res, 200, { ok: true });
    }
    if (m === "DELETE") { await store.delImage(id); return send(res, 200, { ok: true }); }
  }
  if ((mm = pathname.match(/^\/api\/days\/([\d-]+)$/)) && m === "GET") {
    if (!DAY_RE.test(mm[1])) return send(res, 400, { error: "Bad date." });
    return send(res, 200, { day: mm[1], orders: await store.getDay(mm[1]) });
  }
  if (pathname === "/api/orders" && m === "POST") {
    const o = await readBody(req);
    if (!validOrder(o)) return send(res, 400, { error: "Order is missing items or details." });
    o.status = "paid";
    return send(res, 200, { ok: true, order: await store.createOrder(o) });
  }
  if ((mm = pathname.match(/^\/api\/orders\/([\w-]+)$/)) && m === "PATCH") {
    const o = await store.getOrder(mm[1]);
    if (!o) return send(res, 404, { error: "Bill not found." });
    const status = (await readBody(req) || {}).status;
    if (!["paid", "void"].includes(status)) return send(res, 400, { error: "Status must be paid or void." });
    o.status = status;
    await store.updateOrder(o);
    return send(res, 200, { ok: true, order: o });
  }
  send(res, 404, { error: "Not found" });
}

async function safeHandle(req, res, pathname) {
  try { await handleApi(req, res, pathname); }
  catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: "Server error. Try again." }); }
}

module.exports = { safeHandle, send, store, init };
