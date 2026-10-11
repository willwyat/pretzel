"use strict";

// WiZ (Philips) bulbs on the LAN: JSON over UDP port 38899, no cloud or token.
// The bulb must have "Allow local communication" on in the WiZ app.
// Lights are returned in the same shape as LIFX lights so the UI's LightCard
// renders them unchanged.

const dgram = require("dgram");

const WIZ_PORT = 38899;
/** WiZ won't dim below 10%. */
const MIN_DIMMING = 10;
/** Colour A19 white range; requests outside it are clamped. */
const MIN_KELVIN = 2200;
const MAX_KELVIN = 6500;

const DEFAULT_WIZ_LIGHTS = "192.168.1.182:Onion:Lounge";

/**
 * `WIZ_LIGHTS` is a comma-separated list of `ip:label:room` (room matches the
 * UI's room tabs, e.g. Lounge or Bedroom). Set it to an empty string to disable.
 */
function parseWizLights(raw) {
  const src = raw === undefined ? DEFAULT_WIZ_LIGHTS : String(raw);
  const out = [];
  for (const entry of src.split(",")) {
    const [ip, label, room] = entry.split(":").map((s) => s.trim());
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue;
    out.push({ ip, label: label || ip, room: room || "" });
  }
  return out;
}

/**
 * Send one message and wait for the bulb's reply. UDP drops packets, so retry;
 * the bulb answers to the sending port, so each request gets its own socket.
 */
function wizRequest(
  ip,
  message,
  { timeoutMs = 400, attempts = 3, port = WIZ_PORT } = {},
) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const payload = Buffer.from(JSON.stringify(message));
    let tries = 0;
    let timer = null;
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(value);
    };

    const send = () => {
      tries += 1;
      socket.send(payload, port, ip, (err) => {
        if (err) finish(err);
      });
      timer = setTimeout(() => {
        if (tries < attempts) send();
        else finish(new Error(`No reply from WiZ bulb at ${ip}`));
      }, timeoutMs);
    };

    socket.on("message", (msg, rinfo) => {
      if (rinfo.address !== ip) return;
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }
      if (data.method !== message.method) return;
      if (data.error) {
        finish(new Error(`WiZ ${data.method}: ${JSON.stringify(data.error)}`));
      } else {
        finish(null, data.result ?? {});
      }
    });
    socket.on("error", (err) => finish(err));
    send();
  });
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

/** hue 0–360, saturation 0–1 at full value → r, g, b 0–255. */
function hsToRgb(hue, saturation) {
  const h = (((hue % 360) + 360) % 360) / 60;
  const s = clamp(saturation, 0, 1);
  const f = (n) => {
    const k = (n + h) % 6;
    return Math.round(255 * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return { r: f(5), g: f(3), b: f(1) };
}

/** r, g, b 0–255 → hue 0–360 and saturation 0–1 (brightness is `dimming`). */
function rgbToHs(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (max === 0 || d === 0) return { hue: 0, saturation: 0 };
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = Math.round(((hue * 60) + 360) % 360);
  return { hue, saturation: d / max };
}

/** getPilot result (or null when unreachable) → LIFX-shaped light. */
function pilotToLight(cfg, pilot) {
  const group = { id: cfg.room.toLowerCase(), name: cfg.room };
  const light = {
    id: cfg.ip,
    provider: "wiz",
    label: cfg.label,
    connected: pilot !== null,
    power: pilot?.state ? "on" : "off",
    group,
    location: group,
    product: {
      name: "WiZ",
      identifier: "wiz",
      company: "WiZ",
      capabilities: {
        has_color: true,
        has_variable_color_temp: true,
        min_kelvin: MIN_KELVIN,
        max_kelvin: MAX_KELVIN,
      },
    },
  };
  if (!pilot) return light;
  if (pilot.mac) light.uuid = pilot.mac;
  if (typeof pilot.dimming === "number") light.brightness = pilot.dimming / 100;
  if (typeof pilot.temp === "number" && pilot.temp > 0) {
    light.color = { hue: 0, saturation: 0, kelvin: pilot.temp };
  } else if (["r", "g", "b"].every((k) => typeof pilot[k] === "number")) {
    light.color = { ...rgbToHs(pilot.r, pilot.g, pilot.b), kelvin: 3500 };
  }
  return light;
}

/**
 * LIFX-style state body (`power`, `brightness` 0–1, `color` like `kelvin:2700`
 * or `hue:120 saturation:1`) → setPilot params. `duration` is ignored: WiZ
 * fades are set in the app. Returns null when there is nothing to send.
 */
function stateToPilot(body) {
  if (!body || typeof body !== "object") return null;
  const params = {};

  if (body.power === "on" || body.power === "off") {
    params.state = body.power === "on";
    if (!params.state) return params;
  }

  const brightness = Number(body.brightness);
  if (body.brightness !== undefined && Number.isFinite(brightness)) {
    params.dimming = clamp(Math.round(brightness * 100), MIN_DIMMING, 100);
  }

  if (typeof body.color === "string") {
    const kelvin = body.color.match(/kelvin:(\d+)/);
    const hue = body.color.match(/hue:([\d.]+)/);
    const sat = body.color.match(/saturation:([\d.]+)/);
    if (hue) {
      Object.assign(
        params,
        hsToRgb(Number(hue[1]), sat ? Number(sat[1]) : 1),
      );
    } else if (kelvin) {
      params.temp = clamp(Number(kelvin[1]), MIN_KELVIN, MAX_KELVIN);
    }
  }

  return Object.keys(params).length > 0 ? params : null;
}

async function getWizLight(cfg) {
  try {
    const pilot = await wizRequest(cfg.ip, { method: "getPilot", params: {} });
    return pilotToLight(cfg, pilot);
  } catch {
    return pilotToLight(cfg, null);
  }
}

async function setWizState(cfg, body) {
  const params = stateToPilot(body);
  if (!params) return null;
  await wizRequest(cfg.ip, { method: "setPilot", params });
  return params;
}

module.exports = {
  parseWizLights,
  wizRequest,
  hsToRgb,
  rgbToHs,
  pilotToLight,
  stateToPilot,
  getWizLight,
  setWizState,
};
