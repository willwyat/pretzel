/**
 * Single-port entry for guests: Vite-built UI in dist/ + /tv/* → tv-relay
 * + /pretzel/* and /lifx/* → pretzel-server. Run `npm run build` before start.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

process.on("uncaughtException", (err) => {
  console.error("remote-ui uncaughtException:", err);
  process.exit(1);
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

const app = express();

// Express strips the mount path before the proxy sees it, so we put the prefix
// back — upstream expects /tv/*, /pretzel/*, /lifx/*, not bare paths.
app.use(
  "/tv",
  createProxyMiddleware({
    target: TV_RELAY,
    changeOrigin: true,
    pathRewrite: (p) => "/tv" + p,
  }),
);

app.use(
  "/pretzel",
  createProxyMiddleware({
    target: PRETZEL_SERVER,
    changeOrigin: true,
    pathRewrite: (p) => "/pretzel" + p,
  }),
);

app.use(
  "/lifx",
  createProxyMiddleware({
    target: PRETZEL_SERVER,
    changeOrigin: true,
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

app.use(express.static(distDir, { maxAge: "1h" }));

const server = app.listen(PORT, "0.0.0.0", () => {
  const addr = server.address();
  console.log(
    `Pretzel remote UI + proxy listening ${JSON.stringify(addr)} → TV ${TV_RELAY} | pretzel+LIFX ${PRETZEL_SERVER}`,
  );
});

server.on("error", (err) => {
  console.error("remote-ui listen error:", err.message);
  process.exit(1);
});
