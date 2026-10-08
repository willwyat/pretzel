/**
 * CommonJS entry (server.cjs) so Node always uses require(), even if package.json
 * gains "type": "module" for the Vite app. Run `npm run build` before start.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { bindAddr, envString } = require("../shared/auth");

// Log and keep the proxy up: one bad request must not take down the guest UI.
process.on("uncaughtException", (err) => {
  console.error("remote-ui uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("remote-ui unhandledRejection:", err);
});

const PORT = parseInt(
  String(process.env.REMOTE_UI_PORT || "8080").trim(),
  10,
);
if (!Number.isFinite(PORT) || PORT < 1 || PORT > 65535) {
  console.error(
    "remote-ui: invalid REMOTE_UI_PORT; expected 1–65535, got",
    process.env.REMOTE_UI_PORT,
  );
  process.exit(1);
}
const TV_RELAY = process.env.TV_RELAY_URL || "http://127.0.0.1:3000";
const PRETZEL_SERVER =
  process.env.PRETZEL_SERVER_URL || "http://127.0.0.1:3001";

/** Injected on every proxied request so the browser never holds the key. */
const PRETZEL_API_KEY = envString("PRETZEL_API_KEY");
const upstreamHeaders = PRETZEL_API_KEY
  ? { "X-Pretzel-Key": PRETZEL_API_KEY }
  : {};

const app = express();

// Express strips the mount path before the proxy sees it, so we put the prefix
// back — upstream expects /tv/*, /pretzel/*, /lifx/*, not bare paths.
app.use(
  "/tv",
  createProxyMiddleware({
    target: TV_RELAY,
    changeOrigin: true,
    headers: upstreamHeaders,
    pathRewrite: (p) => "/tv" + p,
  }),
);

app.use(
  "/pretzel",
  createProxyMiddleware({
    target: PRETZEL_SERVER,
    changeOrigin: true,
    headers: upstreamHeaders,
    pathRewrite: (p) => "/pretzel" + p,
  }),
);

app.use(
  "/lifx",
  createProxyMiddleware({
    target: PRETZEL_SERVER,
    changeOrigin: true,
    headers: upstreamHeaders,
    pathRewrite: (p) => "/lifx" + p,
  }),
);

const distDir = path.join(__dirname, "dist");
const distIndex = path.join(distDir, "index.html");
if (!fs.existsSync(distIndex)) {
  console.error(
    `remote-ui: missing ${distIndex} — run: cd ${__dirname} && npm run build`,
  );
  process.exit(1);
}

// SPA: serve React app for /settings (no static file on disk).
app.get(/^\/settings(\/.*)?$/, (req, res) => {
  res.sendFile(distIndex);
});

app.use(express.static(distDir, { maxAge: "1h" }));

const server = app.listen(PORT, bindAddr(), () => {
  const addr = server.address();
  console.log(
    `Pretzel remote UI + proxy listening ${JSON.stringify(addr)} → TV ${TV_RELAY} | pretzel+LIFX ${PRETZEL_SERVER}`,
  );
});

server.on("error", (err) => {
  console.error("remote-ui listen error:", err.message);
  process.exit(1);
});
