/**
 * Single-port entry for guests: static UI + /tv/* → tv-relay + /pretzel/* → pretzel-server.
 */
const path = require("path");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const PORT = Number(process.env.REMOTE_UI_PORT || 8080, 10);
const TV_RELAY = process.env.TV_RELAY_URL || "http://127.0.0.1:3000";
const PRETZEL_SERVER =
  process.env.PRETZEL_SERVER_URL || "http://127.0.0.1:3001";

const app = express();

app.use(
  "/tv",
  createProxyMiddleware({
    target: TV_RELAY,
    changeOrigin: true,
  }),
);

app.use(
  "/pretzel",
  createProxyMiddleware({
    target: PRETZEL_SERVER,
    changeOrigin: true,
  }),
);

app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Pretzel remote UI + proxy on ${PORT} → TV ${TV_RELAY} | pretzel ${PRETZEL_SERVER}`,
  );
});
