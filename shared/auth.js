"use strict";

const crypto = require("crypto");

const API_KEY_HEADER = "x-pretzel-key";

/** Constant-time string compare (false on length mismatch or non-strings). */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Trimmed env value, or "" when unset/blank. */
function envString(name, env = process.env) {
  const v = env[name];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Express middleware requiring `X-Pretzel-Key` to match `PRETZEL_API_KEY`.
 *
 * When the key is unset the middleware lets everything through (so existing
 * LAN-only deployments keep working after an upgrade) and logs one warning at
 * creation time. Set the key on every service and on `remote-ui` to enforce.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string[]} [opts.exemptPaths] exact paths that skip the check (liveness probes)
 * @param {string} [opts.service] name used in the startup warning
 */
function apiKeyMiddleware({ env = process.env, exemptPaths = [], service = "service" } = {}) {
  const key = envString("PRETZEL_API_KEY", env);
  if (!key) {
    console.warn(
      `${service}: PRETZEL_API_KEY is not set — control endpoints are unauthenticated (LAN-trust). Set it to require X-Pretzel-Key.`,
    );
  }
  const exempt = new Set(exemptPaths);
  return function requireApiKey(req, res, next) {
    if (!key || exempt.has(req.path)) return next();
    // OPTIONS carries no credentials in browsers; let CORS preflights through.
    if (req.method === "OPTIONS") return next();
    if (!safeEqual(req.headers[API_KEY_HEADER], key)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    next();
  };
}

/**
 * Interface to listen on. `BIND_ADDR` may be a single address (e.g. the
 * Tailscale IP, or 127.0.0.1) — default stays 0.0.0.0 for compatibility.
 */
function bindAddr(env = process.env) {
  return envString("BIND_ADDR", env) || "0.0.0.0";
}

module.exports = { API_KEY_HEADER, safeEqual, envString, apiKeyMiddleware, bindAddr };
