// A2Z Food Corner – run the billing app on your own computer (or any Node host).
// On Vercel this file isn't used: Vercel serves public/ and runs api/index.js.
const http = require("http");
const path = require("path");
const fs = require("fs");
const { safeHandle, send, store, init } = require("./lib/app");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };

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

// One request at a time, so the file store never races.
let queue = Promise.resolve();
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const route = u.searchParams.get("route");
  const pathname = u.pathname === "/api/index" && route ? (route === "healthz" ? "/healthz" : "/api/" + route) : u.pathname;
  if (pathname !== "/healthz" && !pathname.startsWith("/api/")) return serveStatic(req, res, pathname);
  queue = queue.then(() => safeHandle(req, res, pathname));
}).listen(PORT, () => console.log(`A2Z billing running on http://localhost:${PORT} (storage: ${store.kind})`));

init().catch(e => console.error("Database setup failed:", e.message));
