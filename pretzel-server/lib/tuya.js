"use strict";

// Tuya smart switches through the Tuya Cloud Open API (signed requests, same
// scheme as wyat-ai's services/tuya.rs). Switches are returned in the LIFX
// light shape so the UI's LightCard renders them; they have no brightness or
// colour, so the card shows only the rocker.

const crypto = require("crypto");

const DEFAULT_API_BASE = "https://openapi.tuyaus.com";
/** SHA-256 of an empty body (Tuya `Content-SHA256` for GET). */
const EMPTY_BODY_SHA256 = crypto.createHash("sha256").update("").digest("hex");
/** Status codes that carry the on/off state, in preference order. */
const SWITCH_CODES = ["switch_1", "switch", "switch_led"];

/**
 * `TUYA_SWITCHES` is a comma-separated list of `deviceId:label:room[:ip]`
 * (room matches the UI's room tabs; ip only labels it in the device list).
 */
function parseTuyaSwitches(raw) {
  const out = [];
  for (const entry of String(raw ?? "").split(",")) {
    const [id, label, room, ip] = entry.split(":").map((s) => s.trim());
    if (!id || !/^[A-Za-z0-9]+$/.test(id)) continue;
    out.push({
      id,
      label: label || id,
      room: room || "",
      ip: ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null,
    });
  }
  return out;
}

function loadTuyaConfig(env = process.env) {
  const clientId = (env.TUYA_CLIENT_ID || "").trim();
  const clientSecret = (env.TUYA_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return null;
  const apiBase = ((env.TUYA_API_BASE || "").trim() || DEFAULT_API_BASE).replace(
    /\/+$/,
    "",
  );
  return { clientId, clientSecret, apiBase };
}

/**
 * Tuya HMAC-SHA256 signature (uppercase hex) over
 * `clientId + accessToken + t + nonce + stringToSign`, where stringToSign is
 * `METHOD\nContent-SHA256\n\nURL` (no Signature-Headers). The token request
 * signs with an empty access token.
 */
function signRequest({ clientId, clientSecret, accessToken = "", t, nonce, method, body = "", path }) {
  const contentSha = body
    ? crypto.createHash("sha256").update(body).digest("hex")
    : EMPTY_BODY_SHA256;
  const stringToSign = `${method}\n${contentSha}\n\n${path}`;
  return crypto
    .createHmac("sha256", clientSecret)
    .update(`${clientId}${accessToken}${t}${nonce}${stringToSign}`)
    .digest("hex")
    .toUpperCase();
}

function createTuyaClient(cfg, { fetchImpl = fetch, now = Date.now } = {}) {
  /** { accessToken, expiresAt } */
  let token = null;

  async function call(method, path, { body, accessToken = "" } = {}) {
    const t = String(now());
    const nonce = crypto.randomBytes(16).toString("hex");
    const sign = signRequest({ ...cfg, accessToken, t, nonce, method, body, path });
    const res = await fetchImpl(`${cfg.apiBase}${path}`, {
      method,
      headers: {
        client_id: cfg.clientId,
        sign,
        sign_method: "HMAC-SHA256",
        t,
        nonce,
        access_token: accessToken,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body || undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`Tuya API ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    if (data.success === false) {
      throw new Error(`Tuya: ${data.msg || `code ${data.code}`}`);
    }
    return data.result;
  }

  async function accessToken() {
    if (token && token.expiresAt > now()) return token.accessToken;
    const result = await call("GET", "/v1.0/token?grant_type=1");
    const ttlMs = (Number(result.expire_time) || 3600) * 1000;
    // Refresh two minutes early.
    token = { accessToken: result.access_token, expiresAt: now() + ttlMs - 120_000 };
    return token.accessToken;
  }

  async function authed(method, path, body) {
    try {
      return await call(method, path, { body, accessToken: await accessToken() });
    } catch (e) {
      // Token revoked or expired early: fetch a new one once.
      if (/token invalid|1010/.test(e.message)) {
        token = null;
        return call(method, path, { body, accessToken: await accessToken() });
      }
      throw e;
    }
  }

  return {
    getStatus: (id) => authed("GET", `/v1.0/devices/${id}/status`),
    sendCommands: (id, commands) =>
      authed("POST", `/v1.0/devices/${id}/commands`, JSON.stringify({ commands })),
  };
}

/** Tuya status rows → { code, on } for the first switch datapoint, or null. */
function switchFromStatus(rows) {
  if (!Array.isArray(rows)) return null;
  for (const code of SWITCH_CODES) {
    const row = rows.find((r) => r && r.code === code);
    if (row && typeof row.value === "boolean") return { code, on: row.value };
  }
  return null;
}

/** Switch config + status rows (null when unreachable) → LIFX-shaped light. */
function switchToLight(cfg, rows) {
  const group = { id: cfg.room.toLowerCase(), name: cfg.room };
  const sw = switchFromStatus(rows);
  return {
    id: cfg.id,
    provider: "tuya",
    label: cfg.label,
    connected: sw !== null,
    power: sw?.on ? "on" : "off",
    group,
    location: group,
    product: {
      name: "Tuya switch",
      identifier: "tuya_switch",
      company: "Tuya",
      capabilities: {
        has_color: false,
        has_variable_color_temp: false,
        has_brightness: false,
        min_kelvin: 0,
        max_kelvin: 0,
      },
    },
  };
}

async function getTuyaSwitch(client, cfg) {
  try {
    return switchToLight(cfg, await client.getStatus(cfg.id));
  } catch (e) {
    console.warn(`[tuya] ${cfg.label}: ${e.message}`);
    return switchToLight(cfg, null);
  }
}

/**
 * LIFX-style body with `power: "on" | "off"` → switch command. The datapoint
 * code comes from the device's status (most plugs use switch_1). Returns null
 * when the body has no power change.
 */
async function setTuyaSwitch(client, cfg, body) {
  if (!body || (body.power !== "on" && body.power !== "off")) return null;
  let code = "switch_1";
  try {
    code = switchFromStatus(await client.getStatus(cfg.id))?.code ?? code;
  } catch {
    /* fall back to switch_1; the command call reports real failures */
  }
  const value = body.power === "on";
  await client.sendCommands(cfg.id, [{ code, value }]);
  return { code, value };
}

module.exports = {
  parseTuyaSwitches,
  loadTuyaConfig,
  signRequest,
  createTuyaClient,
  switchFromStatus,
  switchToLight,
  getTuyaSwitch,
  setTuyaSwitch,
};
