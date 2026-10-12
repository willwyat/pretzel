"use strict";

// Tuya switches over the LAN, through tinytuya (Python) on the Pi. tinytuya
// speaks every Tuya protocol version (3.1–3.5) and its wizard already wrote
// devices.json with each device's local key, IP, version and DP-name mapping,
// so pretzel-server only runs scripts/tuya_local.py. The client has the same
// shape as the cloud client in tuya.js (getStatus rows, sendCommands).

const { execFile } = require("child_process");
const { existsSync, readFileSync } = require("fs");
const { homedir } = require("os");
const { join } = require("path");

const SCRIPT = join(__dirname, "..", "scripts", "tuya_local.py");

/**
 * `TUYA_LOCAL_DEVICES` (devices.json) and `TUYA_LOCAL_PYTHON` (a Python with
 * tinytuya) default to the wizard's ~/tuya folder and its venv. Null when
 * either is missing: local control is off.
 */
function loadTuyaLocalConfig(env = process.env, exists = existsSync) {
  const devicesFile =
    (env.TUYA_LOCAL_DEVICES || "").trim() || join(homedir(), "tuya", "devices.json");
  const python =
    (env.TUYA_LOCAL_PYTHON || "").trim() || join(homedir(), "tuya", "venv", "bin", "python");
  if (!exists(devicesFile) || !exists(python)) return null;
  return { devicesFile, python };
}

/** devices.json `mapping` ({"1": {"code": "switch_1"}}) → code by DP and DP by code. */
function dpMaps(device) {
  const byDp = {};
  const byCode = {};
  for (const [dp, m] of Object.entries(device?.mapping || {})) {
    if (m && typeof m.code === "string") {
      byDp[dp] = m.code;
      byCode[m.code] = dp;
    }
  }
  return { byDp, byCode };
}

/** Local dps ({"1": true}) → cloud-style status rows ({code, value}). */
function dpsToRows(dps, device) {
  const { byDp } = dpMaps(device);
  return Object.entries(dps || {}).map(([dp, value]) => ({
    code: byDp[dp] ?? (dp === "1" ? "switch_1" : `dp_${dp}`),
    value,
  }));
}

/** Cloud-style code → local DP number; switch_1 is DP 1 on Tuya plugs. */
function codeToDp(code, device) {
  return dpMaps(device).byCode[code] ?? (code === "switch_1" || code === "switch" ? "1" : null);
}

function createTuyaLocalClient(cfg, { run = execFile, ipFor = () => null } = {}) {
  const devices = () => {
    try {
      return JSON.parse(readFileSync(cfg.devicesFile, "utf8"));
    } catch {
      return [];
    }
  };
  const device = (id) => devices().find((d) => d.id === id && d.key);

  const runScript = (args) =>
    new Promise((resolve, reject) => {
      run(cfg.python, [SCRIPT, cfg.devicesFile, ...args], { timeout: 15000 }, (err, stdout) => {
        let out;
        try {
          out = JSON.parse(String(stdout).trim().split("\n").pop());
        } catch {
          return reject(new Error(err ? err.message : "tuya_local.py: bad output"));
        }
        if (out.error) reject(new Error(out.error));
        else resolve(out.dps);
      });
    });

  return {
    has: (id) => Boolean(device(id)),
    async getStatus(id) {
      const dev = device(id);
      const ip = ipFor(id);
      return dpsToRows(await runScript(["status", id, ...(ip ? [ip] : [])]), dev);
    },
    async sendCommands(id, commands) {
      const dev = device(id);
      const ip = ipFor(id);
      for (const { code, value } of commands) {
        const dp = codeToDp(code, dev);
        if (!dp) throw new Error(`No local DP for ${code}`);
        await runScript(["set", id, dp, value ? "true" : "false", ...(ip ? [ip] : [])]);
      }
      return true;
    },
  };
}

/**
 * Local first for devices in devices.json, cloud otherwise or when the LAN
 * call fails (e.g. the switch moved IP). Either side may be null.
 */
function createTuyaClientWithFallback(local, cloud) {
  const call = async (method, id, ...args) => {
    if (local?.has(id)) {
      try {
        return await local[method](id, ...args);
      } catch (e) {
        if (!cloud) throw e;
        console.warn(`[tuya] local ${method} ${id} failed, using cloud: ${e.message}`);
      }
    }
    if (!cloud) throw new Error("Tuya: device not in devices.json and cloud not configured");
    return cloud[method](id, ...args);
  };
  return {
    getStatus: (id) => call("getStatus", id),
    sendCommands: (id, commands) => call("sendCommands", id, commands),
  };
}

module.exports = {
  loadTuyaLocalConfig,
  dpsToRows,
  codeToDp,
  createTuyaLocalClient,
  createTuyaClientWithFallback,
};
