// Vercel serverless entry. The page calls /api/index?route=<path>, e.g. route=login or route=days/2026-10-20.
const { safeHandle } = require("../lib/app");

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://x");
  const route = (req.query && req.query.route) || url.searchParams.get("route");
  let pathname = url.pathname;
  if (route === "healthz") pathname = "/healthz";
  else if (route) pathname = "/api/" + String(route).replace(/^\/+/, "");
  await safeHandle(req, res, pathname);
};
