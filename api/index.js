// Vercel serverless entry. vercel.json sends /api/* and /healthz here as ?route=...
const { safeHandle } = require("../lib/app");

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://x");
  const route = url.searchParams.get("route");
  const pathname = route === "healthz" ? "/healthz" : route ? "/api/" + route : url.pathname;
  await safeHandle(req, res, pathname);
};
