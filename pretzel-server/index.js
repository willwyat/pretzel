const express = require("express");
const { execFile, spawn } = require("child_process");
const {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  statSync,
} = require("fs");
const { join, dirname } = require("path");
const weather = require("./lib/weather");
const { ChoresManager } = require("./lib/chores");
const { RemindersScheduler } = require("./lib/reminders");
const { ChessManager } = require("./lib/chess");
const { Bulletin } = require("./lib/bulletin");
const { listDevices } = require("./lib/devices");
const { WebSocketServer } = require("ws");

const PORT =
  Number(process.env.PORT) && Number.isFinite(Number(process.env.PORT))
    ? Number(process.env.PORT)
    : 3001;
const SPEAK_SCRIPT = "/home/william/pretzel/scripts/speak.sh";

const REMINDER_BEEP_MP3 = join(__dirname, "beep.mp3");
/** ALSA output for mpg123; default matches scripts/speak.sh `-a hw:2,0`. */
const MPG123_DEVICE =
  typeof process.env.PRETZEL_MPG123_DEVICE === "string" &&
  process.env.PRETZEL_MPG123_DEVICE.trim() !== ""
    ? process.env.PRETZEL_MPG123_DEVICE.trim()
    : "hw:2,0";

const PRETZEL_SETTINGS_PASSCODE =
  typeof process.env.PRETZEL_SETTINGS_PASSCODE === "string" &&
  process.env.PRETZEL_SETTINGS_PASSCODE !== ""
    ? process.env.PRETZEL_SETTINGS_PASSCODE
    : "Asdf1234";

const PRETZEL_REPO_ROOT =
  typeof process.env.PRETZEL_REPO_ROOT === "string" &&
  process.env.PRETZEL_REPO_ROOT.trim() !== ""
    ? process.env.PRETZEL_REPO_ROOT.trim()
    : join(__dirname, "..");

const dataDir = join(__dirname, "data");

const envCard = process.env.PRETZEL_AMIXER_CARD;
const envControl = process.env.PRETZEL_AMIXER_CONTROL;
const parsedPreferred =
  envCard !== undefined && envCard !== "" ? Number(envCard) : 2;
const PREFERRED_CARD = Number.isFinite(parsedPreferred) ? parsedPreferred : 2;
const PREFERRED_CONTROL =
  typeof envControl === "string" && envControl.trim() !== ""
    ? envControl.trim()
    : "Speaker";

/** First successful sget output (has [n%]) wins; reused for later requests. */
let resolvedTarget = null;

function volumeCandidates() {
  const names = ["PCM", "Headphone", "Speaker", "Master", "Digital"];
  const cards = [0, 1, 2, 3, 4];
  const out = [[PREFERRED_CARD, PREFERRED_CONTROL]];
  for (const c of cards) {
    for (const n of names) {
      out.push([c, n]);
    }
  }
  const seen = new Set();
  return out.filter(([c, n]) => {
    const k = `${c}:${n}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * @param {(err: Error|null, target: {card:number,control:string}|null, probeStdout: string|null) => void} done
 */
function resolveTarget(done) {
  if (resolvedTarget) {
    return done(null, resolvedTarget, null);
  }
  const tries = volumeCandidates();
  let i = 0;
  function next() {
    if (i >= tries.length) {
      const err = new Error(
        "No ALSA simple volume control found (exhausted env preferred + common controls on cards 0–4)",
      );
      return done(err, null, null);
    }
    const [card, control] = tries[i++];
    execFile(
      "amixer",
      ["-c", String(card), "sget", control],
      { encoding: "utf8" },
      (err, stdout) => {
        if (!err && stdout && /\[\d+%\]/.test(stdout)) {
          resolvedTarget = { card, control };
          return done(null, resolvedTarget, stdout);
        }
        next();
      },
    );
  }
  next();
}

const app = express();
app.use(express.json());

const SPEAK_BODY_LIMIT = 256 * 1024;
const SPEAK_QUERY_LIMIT = 4096;

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** NBSP / narrow NBSP (common from web paste); BOM strip. */
function normalizeSpeakText(s) {
  return s
    .replace(/\ufeff/g, "")
    .replace(/[\u00a0\u202f]/g, " ")
    .trim();
}

/** Passed to `speak.sh` for scheduled reminders + speak-weather (gpt-4o-mini-tts + `instructions`). */
const SPEAK_INSTRUCTIONS_REMINDERS =
  "Personality/affect: a high-energy cheerleader helping with administrative tasks.\n\n" +
  "Voice: Enthusiastic, and bubbly, with an uplifting and motivational quality.\n\n" +
  "Tone: Encouraging and playful, making even simple tasks feel exciting and fun.\n\n" +
  "Dialect: Casual and upbeat, using informal phrasing and pep talk-style expressions. Use a very strong New York Jewish accent.\n\n" +
  "Pronunciation: Crisp and lively, with exaggerated emphasis on positive words to keep the energy high.\n\n" +
  "Features: Uses motivational phrases, cheerful exclamations, and an energetic rhythm to create a sense of excitement and engagement.";

function speakScriptArgs(text, instructions) {
  return typeof instructions === "string" && instructions.trim() !== ""
    ? [text, instructions]
    : [text];
}

// ── speak() ────────────────────────────────────────────────────
/** @param {string} [instructions] — non-empty → `speak.sh` uses gpt-4o-mini-tts + OpenAI `instructions`. */
function speak(text, instructions) {
  execFile(SPEAK_SCRIPT, speakScriptArgs(text, instructions), (err) => {
    if (err) console.error("speak error:", err.message);
  });
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

function playReminderSfx(mp3Path) {
  return execFileAsync("mpg123", ["-q", "-a", MPG123_DEVICE, mp3Path], {
    timeout: 60_000,
  });
}

/** @param {string} [instructions] — see {@link speak}. */
function speakAsync(text, instructions) {
  return new Promise((resolve) => {
    execFile(SPEAK_SCRIPT, speakScriptArgs(text, instructions), (err) => {
      if (err) console.error("speak error:", err.message);
      resolve();
    });
  });
}

/**
 * Short beep before TTS for scheduled reminders and speak-weather.
 * @param {string} [instructions] — defaults to {@link SPEAK_INSTRUCTIONS_REMINDERS}; pass `""` for neutral tts-1.
 */
async function speakWithReminderSfx(
  text,
  instructions = SPEAK_INSTRUCTIONS_REMINDERS,
) {
  try {
    await playReminderSfx(REMINDER_BEEP_MP3);
  } catch (e) {
    console.error("reminder beep:", e.message);
  }
  await speakAsync(text, instructions);
}

const choresManager = new ChoresManager(dataDir);
choresManager.reload();

const bulletin = new Bulletin(dataDir);
bulletin.load();

const scheduler = new RemindersScheduler({
  dataDir,
  tz: weather.TZ,
  speakWithSfx: speakWithReminderSfx,
  fetchWeather: weather.fetchWeather,
  buildWeatherContext: weather.buildWeatherContext,
  choresManager,
});

function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, filePath);
}

const speakHint =
  "Apostrophe in I'm breaks shell single quotes around -d '...'. Easiest: GET with curl -G and --data-urlencode (see below), or repo scripts/curl-speak.sh \"...\", or POST text/plain with double-quoted body.";

async function extractSpeakTextFromPost(req) {
  const ct = (req.headers["content-type"] || "").toLowerCase();
  let text = "";
  if (ct.includes("text/plain")) {
    text = normalizeSpeakText(await readRawBody(req, SPEAK_BODY_LIMIT));
  } else if (typeof req.body?.text === "string") {
    text = normalizeSpeakText(req.body.text);
  }
  if (!text && typeof req.query.text === "string") {
    text = normalizeSpeakText(req.query.text.slice(0, SPEAK_QUERY_LIMIT));
  }
  return text;
}

// ── LIFX Cloud API proxy ─────────────────────────────────────
const lifxUrlEnv = process.env.LIFX_API_URL;
const LIFX_API_BASE = (
  typeof lifxUrlEnv === "string" && lifxUrlEnv.trim() !== ""
    ? lifxUrlEnv.trim()
    : "https://api.lifx.com/v1"
).replace(/\/$/, "");

/** Re-encode for URL path; keep `:` and `,` (wyat-ai lifx::encode_selector). */
function encodeLifxSelector(selector) {
  return String(selector)
    .replace(/ /g, "%20")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F")
    .replace(/\[/g, "%5B")
    .replace(/\]/g, "%5D");
}

function lifxBearerToken(res) {
  const t = process.env.LIFX_API_TOKEN;
  if (typeof t === "string" && t.trim() !== "") return t.trim();
  res.status(500).json({ error: "LIFX_API_TOKEN not configured" });
  return null;
}

const LIFX_STATE_KEYS = [
  "power",
  "color",
  "brightness",
  "duration",
  "infrared",
  "fast",
];

function lifxPickStateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const out = {};
  for (const k of LIFX_STATE_KEYS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

async function lifxForwardJson(res, upstream) {
  if (!upstream.ok) {
    const body = await upstream.text();
    return res
      .status(502)
      .json({ error: `LIFX API ${upstream.status}: ${body}` });
  }
  try {
    const data = await upstream.json();
    return res.json(data);
  } catch (e) {
    return res.status(502).json({ error: `Parse error: ${e.message}` });
  }
}

// ── Routes ─────────────────────────────────────────────────────

// Register `/lifx/lights/states` before `/lifx/lights/:selector/state` (Express order).
app.put("/lifx/lights/states", async (req, res) => {
  const token = lifxBearerToken(res);
  if (!token) return;
  const states = req.body?.states;
  if (Array.isArray(states) && states.length > 50) {
    return res.status(400).json({ error: "Maximum 50 state entries allowed" });
  }
  try {
    const upstream = await fetch(`${LIFX_API_BASE}/lights/states`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body ?? {}),
    });
    await lifxForwardJson(res, upstream);
  } catch (e) {
    res.status(502).json({ error: `Request failed: ${e.message}` });
  }
});

app.get("/lifx/scenes", async (req, res) => {
  const token = lifxBearerToken(res);
  if (!token) return;
  try {
    const upstream = await fetch(`${LIFX_API_BASE}/scenes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await lifxForwardJson(res, upstream);
  } catch (e) {
    res.status(502).json({ error: `Request failed: ${e.message}` });
  }
});

app.get("/lifx/lights/:selector", async (req, res) => {
  const token = lifxBearerToken(res);
  if (!token) return;
  const enc = encodeLifxSelector(req.params.selector);
  try {
    const upstream = await fetch(`${LIFX_API_BASE}/lights/${enc}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await lifxForwardJson(res, upstream);
  } catch (e) {
    res.status(502).json({ error: `Request failed: ${e.message}` });
  }
});

app.put("/lifx/lights/:selector/state", async (req, res) => {
  const token = lifxBearerToken(res);
  if (!token) return;
  const enc = encodeLifxSelector(req.params.selector);
  const payload = lifxPickStateBody(req.body);
  try {
    const upstream = await fetch(`${LIFX_API_BASE}/lights/${enc}/state`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    await lifxForwardJson(res, upstream);
  } catch (e) {
    res.status(502).json({ error: `Request failed: ${e.message}` });
  }
});

app.post("/lifx/lights/:selector/state/delta", async (req, res) => {
  const token = lifxBearerToken(res);
  if (!token) return;
  const enc = encodeLifxSelector(req.params.selector);
  const payload = lifxPickStateBody(req.body);
  try {
    const upstream = await fetch(`${LIFX_API_BASE}/lights/${enc}/state/delta`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    await lifxForwardJson(res, upstream);
  } catch (e) {
    res.status(502).json({ error: `Request failed: ${e.message}` });
  }
});

app.get("/pretzel/weather", async (req, res) => {
  const now = new Date();
  const TZ = weather.TZ;
  const time = {
    timezone: TZ,
    utc: now.toISOString(),
    epochMs: now.getTime(),
    localDate: weather.ymdInTz(now, TZ),
    localTime: now.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZone: TZ,
    }),
    weekday: now.toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: TZ,
    }),
  };

  try {
    const wx = await weather.fetchWeather();
    const code = wx.current.weathercode;
    res.json({
      ok: true,
      time,
      location: { latitude: weather.LAT, longitude: weather.LON },
      current: {
        temperatureC: Math.round(wx.current.temperature_2m),
        weathercode: code,
        condition: weather.describeWeather(code),
        reportedTime: wx.current.time,
      },
      today: {
        sunrise: wx.daily.sunrise[0],
        sunset: wx.daily.sunset[0],
        precipitationProbabilityMax: wx.daily.precipitation_probability_max[0],
      },
      sun: weather.sunSummaryForHomeUi(wx, now),
    });
  } catch (e) {
    res.status(502).json({
      ok: false,
      error: e.message,
      time,
    });
  }
});

async function speakWeatherRoute(req, res) {
  try {
    const text = await weather.buildSpeakWeatherUtterance();
    void speakWithReminderSfx(text);
    res.json({ ok: true, spoken: text });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
}

app.get("/pretzel/speak-weather", speakWeatherRoute);
app.post("/pretzel/speak-weather", speakWeatherRoute);
// POST: same announce flow as speak-weather (on-demand from app / curl)
app.post("/pretzel/weather", speakWeatherRoute);

app.get("/pretzel/speak", (req, res) => {
  const raw = typeof req.query.text === "string" ? req.query.text : "";
  const text = normalizeSpeakText(raw.slice(0, SPEAK_QUERY_LIMIT));
  if (!text) {
    return res.status(400).json({
      error: "text is required",
      example:
        'curl -sS -G http://pretzel.local:3001/pretzel/speak --data-urlencode "text=How are you? I\'m great"',
      hint: speakHint,
    });
  }
  speak(text);
  res.json({ ok: true });
});

app.post("/pretzel/speak", async (req, res) => {
  let text = "";
  try {
    text = await extractSpeakTextFromPost(req);
  } catch (e) {
    const st = e.status || 500;
    return res.status(st).json({ error: e.message });
  }
  if (!text) {
    return res.status(400).json({
      error: "text is required",
      example:
        'curl -sS -G http://pretzel.local:3001/pretzel/speak --data-urlencode "text=How are you? I\'m great"',
      hint: speakHint,
    });
  }
  speak(text);
  res.json({ ok: true });
});

app.get("/pretzel/volume", (req, res) => {
  resolveTarget((err, target, probeStdout) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (probeStdout) {
      const match = probeStdout.match(/\[(\d+)%\]/);
      const volume = match ? parseInt(match[1], 10) : null;
      return res.json({ ok: true, volume });
    }
    execFile(
      "amixer",
      ["-c", String(target.card), "sget", target.control],
      { encoding: "utf8" },
      (e2, stdout) => {
        if (e2) {
          resolvedTarget = null;
          return res.status(500).json({ error: e2.message });
        }
        const match = stdout.match(/\[(\d+)%\]/);
        const volume = match ? parseInt(match[1], 10) : null;
        res.json({ ok: true, volume });
      },
    );
  });
});

app.post("/pretzel/volume", (req, res) => {
  const { volume, announce = true } = req.body;
  if (volume === undefined)
    return res.status(400).json({ error: "volume is required" });
  const clamped = Math.max(0, Math.min(100, volume));
  resolveTarget((err, target) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    execFile(
      "amixer",
      ["-c", String(target.card), "sset", target.control, `${clamped}%`],
      { encoding: "utf8" },
      (e2) => {
        if (e2) {
          resolvedTarget = null;
          return res.status(500).json({ error: e2.message });
        }
        if (announce) speak(`Changed my volume to ${clamped} percent`);
        res.json({ ok: true, volume: clamped });
      },
    );
  });
});

app.get("/pretzel/status", (req, res) => {
  res.json({ ok: true, host: "pretzel" });
});

app.get("/pretzel/bulletin", (_req, res) => {
  res.json({ ok: true, notes: bulletin.list() });
});

app.post("/pretzel/bulletin", (req, res) => {
  const result = bulletin.add(req.body?.message);
  if (!result.ok) return res.status(400).json(result);
  res.status(201).json(result);
});

app.post("/pretzel/bulletin/:id/seen", (req, res) => {
  if (typeof req.body?.isSeen !== "boolean") {
    return res.status(400).json({ ok: false, error: "isSeen must be a boolean" });
  }
  const result = bulletin.setSeen(req.params.id, req.body.isSeen);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.delete("/pretzel/bulletin/:id", (req, res) => {
  const result = bulletin.remove(req.params.id);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.get("/pretzel/chores", (req, res) => {
  try {
    res.json({ ok: true, chores: choresManager.listWithStatus() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/pretzel/chores/:id/complete", (req, res) => {
  const { id } = req.params;
  const r = choresManager.complete(id);
  if (!r.ok) {
    return res.status(404).json({ ok: false, error: "Unknown chore" });
  }
  res.json(r);
});

app.post("/pretzel/chores/:id/uncomplete", (req, res) => {
  const { id } = req.params;
  const r = choresManager.uncomplete(id);
  if (!r.ok) {
    return res.status(404).json({ ok: false, error: "Unknown chore" });
  }
  res.json(r);
});

app.get("/pretzel/reminders", (req, res) => {
  try {
    const raw = JSON.parse(
      readFileSync(join(dataDir, "reminders.json"), "utf8"),
    );
    res.json({ ok: true, ...raw });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Operator admin (LAN + header secret; not strong auth) ───────
function assertSettingsPass(req, res, next) {
  const got = req.headers["x-pretzel-settings-passcode"];
  if (typeof got !== "string" || got !== PRETZEL_SETTINGS_PASSCODE) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  next();
}

async function systemctlActiveEnterTimestamp(unit) {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["show", unit, "-p", "ActiveEnterTimestamp", "--value"],
      { encoding: "utf8", timeout: 15_000 },
    );
    const raw = stdout.trim();
    if (!raw || raw.toLowerCase() === "n/a") {
      return { activeEnterTimestamp: null, activeEnterTimestampIso: null };
    }
    const ms = Date.parse(raw);
    return {
      activeEnterTimestamp: raw,
      activeEnterTimestampIso: Number.isFinite(ms)
        ? new Date(ms).toISOString()
        : null,
    };
  } catch (e) {
    return {
      activeEnterTimestamp: null,
      activeEnterTimestampIso: null,
      error: e.message,
    };
  }
}

app.get("/pretzel/admin/status", assertSettingsPass, async (req, res) => {
  try {
    const pretzelServer = await systemctlActiveEnterTimestamp(
      "pretzel-server.service",
    );
    const tvRelay = await systemctlActiveEnterTimestamp("tv-relay.service");
    const remoteUi = await systemctlActiveEnterTimestamp("remote-ui.service");
    res.json({
      ok: true,
      services: { pretzelServer, tvRelay, remoteUi },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/pretzel/admin/git-pull", assertSettingsPass, async (req, res) => {
  try {
    await execFileAsync("git", ["-C", PRETZEL_REPO_ROOT, "pull"], {
      timeout: 120_000,
      encoding: "utf8",
    });
    const { stdout } = await execFileAsync(
      "git",
      ["-C", PRETZEL_REPO_ROOT, "rev-parse", "HEAD"],
      { encoding: "utf8", timeout: 30_000 },
    );
    const pulledAt = new Date().toISOString();
    res.json({ ok: true, commit: stdout.trim(), pulledAt });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post(
  "/pretzel/admin/restart/pretzel-server",
  assertSettingsPass,
  (req, res) => {
    res.json({
      ok: true,
      message:
        "Restart initiated; this connection will drop. Reload the page to see updated status.",
    });
    res.on("finish", () => {
      const child = spawn(
        "sudo",
        ["systemctl", "restart", "pretzel-server.service"],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
    });
  },
);

app.post(
  "/pretzel/admin/restart/tv-relay",
  assertSettingsPass,
  async (req, res) => {
    try {
      await execFileAsync(
        "sudo",
        ["systemctl", "restart", "tv-relay.service"],
        { timeout: 120_000 },
      );
      res.json({
        ok: true,
        message: "tv-relay restarted. Refresh status to see new start time.",
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  },
);

/**
 * remote-ui serves the page and proxies /pretzel/* to us, so restarting it
 * drops the connection carrying this request: respond first, then restart.
 */
function restartRemoteUiDetached() {
  const child = spawn("sudo", ["systemctl", "restart", "remote-ui.service"], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (e) =>
    console.error("remote-ui restart spawn error:", e.message),
  );
  child.unref();
}

app.post("/pretzel/admin/restart/remote-ui", assertSettingsPass, (req, res) => {
  res.json({
    ok: true,
    message:
      "Restart initiated; the page will reconnect when remote-ui is back.",
  });
  res.on("finish", restartRemoteUiDetached);
});

// ── remote-ui rebuild (background job; poll GET for progress) ───
const REMOTE_UI_DIR = join(PRETZEL_REPO_ROOT, "remote-ui");
const REBUILD_STEP_TIMEOUT_MS = 10 * 60_000;
const REBUILD_LOG_LINES = 40;

/** systemd's PATH may not include the Node that runs us (e.g. nvm). */
const NODE_BIN_DIR = dirname(process.execPath);
const NPM_CLI = join(NODE_BIN_DIR, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

let remoteUiRebuild = {
  state: "idle",
  step: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  logTail: [],
};

function appendRebuildLog(chunk) {
  const lines = String(chunk).split(/\r?\n/).filter((l) => l.trim() !== "");
  const tail = remoteUiRebuild.logTail.concat(lines);
  remoteUiRebuild.logTail = tail.slice(-REBUILD_LOG_LINES);
}

function runRebuildStep(file, args) {
  return new Promise((resolve, reject) => {
    appendRebuildLog(`$ ${[file, ...args].join(" ")}`);
    const child = spawn(file, args, {
      cwd: REMOTE_UI_DIR,
      env: {
        ...process.env,
        PATH: `${NODE_BIN_DIR}:${process.env.PATH || ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, REBUILD_STEP_TIMEOUT_MS);
    child.stdout.on("data", appendRebuildLog);
    child.stderr.on("data", appendRebuildLog);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            signal
              ? `${file} killed (${signal})`
              : `${file} exited with code ${code}`,
          ),
        );
    });
  });
}

function npmCiNeeded() {
  try {
    const lock = statSync(join(REMOTE_UI_DIR, "package-lock.json")).mtimeMs;
    const installed = statSync(
      join(REMOTE_UI_DIR, "node_modules", ".package-lock.json"),
    ).mtimeMs;
    return lock > installed;
  } catch {
    return true;
  }
}

async function rebuildRemoteUi() {
  const setStep = (step) => {
    remoteUiRebuild.step = step;
  };
  const node = process.execPath;
  const nextDir = join(REMOTE_UI_DIR, "dist-next");
  const distDir = join(REMOTE_UI_DIR, "dist");
  const prevDir = join(REMOTE_UI_DIR, "dist-prev");
  try {
    if (npmCiNeeded()) {
      setStep("npm ci");
      if (existsSync(NPM_CLI)) await runRebuildStep(node, [NPM_CLI, "ci"]);
      else await runRebuildStep("npm", ["ci"]);
    }
    setStep("typecheck");
    await runRebuildStep(node, [
      join(REMOTE_UI_DIR, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
    ]);
    setStep("vite build");
    await runRebuildStep(node, [
      join(REMOTE_UI_DIR, "node_modules", "vite", "bin", "vite.js"),
      "build",
      "--outDir",
      "dist-next",
      "--emptyOutDir",
    ]);
    setStep("swap dist");
    rmSync(prevDir, { recursive: true, force: true });
    if (existsSync(distDir)) renameSync(distDir, prevDir);
    renameSync(nextDir, distDir);
    rmSync(prevDir, { recursive: true, force: true });
    // This job isn't tied to an HTTP request, so wait for the restart and
    // report sudo/systemctl failures instead of firing and forgetting.
    setStep("restart");
    await runRebuildStep("sudo", ["-n", "systemctl", "restart", "remote-ui.service"]);
    remoteUiRebuild.state = "done";
  } catch (e) {
    remoteUiRebuild.state = "failed";
    remoteUiRebuild.error = e.message;
    console.error("remote-ui rebuild failed:", e.message);
  } finally {
    remoteUiRebuild.finishedAt = new Date().toISOString();
  }
}

app.get("/pretzel/admin/rebuild/remote-ui", assertSettingsPass, (req, res) => {
  res.json({ ok: true, ...remoteUiRebuild });
});

app.post("/pretzel/admin/rebuild/remote-ui", assertSettingsPass, (req, res) => {
  if (remoteUiRebuild.state === "running") {
    return res
      .status(409)
      .json({ ...remoteUiRebuild, ok: false, error: "Rebuild already running" });
  }
  remoteUiRebuild = {
    state: "running",
    step: "starting",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    logTail: [],
  };
  void rebuildRemoteUi();
  res.status(202).json({ ok: true, ...remoteUiRebuild });
});

app.put("/pretzel/reminders/:id", assertSettingsPass, async (req, res) => {
  try {
    const { id } = req.params;
    const pathRem = join(dataDir, "reminders.json");
    const raw = JSON.parse(readFileSync(pathRem, "utf8"));
    const idx = (raw.reminders || []).findIndex((r) => r.id === id);
    if (idx === -1) {
      return res.status(404).json({ ok: false, error: "Unknown reminder" });
    }
    const allow = [
      "enabled",
      "time",
      "label",
      "template",
      "includeChores",
    ];
    for (const k of allow) {
      if (req.body[k] !== undefined) raw.reminders[idx][k] = req.body[k];
    }
    atomicWriteJson(pathRem, raw);
    await scheduler.reload();
    res.json({ ok: true, reminder: raw.reminders[idx] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post(
  "/pretzel/admin/reload-reminders",
  assertSettingsPass,
  async (req, res) => {
    try {
      await scheduler.reload();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  },
);

app.post("/pretzel/admin/reload-chores", assertSettingsPass, (req, res) => {
  try {
    choresManager.reload();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── LAN devices (operator) ──────────────────────────────────────
const TV_IP = process.env.TV_IP || "192.168.1.186";
app.get("/pretzel/admin/devices", assertSettingsPass, async (req, res) => {
  try {
    const result = await listDevices({
      knownLabels: { [TV_IP]: "LG TV" },
      force: req.query.refresh === "1",
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Chess (public on LAN; Pi is the referee) ────────────────────
const chessManager = new ChessManager({ dataDir });

app.get("/pretzel/chess/games", (req, res) => {
  res.json({ ok: true, games: chessManager.listGames() });
});

app.get("/pretzel/chess/games/:id", (req, res) => {
  const g = chessManager.getGame(req.params.id);
  if (!g) return res.status(404).json({ ok: false, error: "Not found" });
  const { whiteIp, blackIp, ...pub } = g;
  res.json({ ok: true, game: pub });
});

function clientIpOf(req) {
  const xff = req.headers["x-forwarded-for"];
  const first = typeof xff === "string" ? xff.split(",")[0].trim() : "";
  return (first || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

const chessWss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
/** ws -> { clientId } */
const chessClients = new Map();

function chessBroadcast() {
  for (const [ws, info] of chessClients) {
    if (ws.readyState === ws.OPEN && info.clientId) {
      ws.send(JSON.stringify({ type: "state", state: chessManager.snapshot(info.clientId) }));
    }
  }
}
chessManager.subscribe(chessBroadcast);
// Keep clocks honest on screens even if nothing happens: clients tick locally.

chessWss.on("connection", (ws, req) => {
  const ip = clientIpOf(req);
  const info = { clientId: null };
  chessClients.set(ws, info);
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "hello") {
      if (typeof msg.clientId !== "string" || msg.clientId.length < 8 || msg.clientId.length > 64) return;
      info.clientId = msg.clientId;
      chessManager.setConnected(info.clientId, true);
      ws.send(JSON.stringify({ type: "state", state: chessManager.snapshot(info.clientId) }));
      return;
    }
    if (!info.clientId) return;
    const id = info.clientId;
    let r;
    switch (msg.type) {
      case "sit": r = chessManager.sit({ clientId: id, name: msg.name, color: msg.color, ip }); break;
      case "stand": r = chessManager.stand({ clientId: id }); break;
      case "move": r = chessManager.move({ clientId: id, from: msg.from, to: msg.to, promotion: msg.promotion }); break;
      case "resign": r = chessManager.resign({ clientId: id }); break;
      case "offerDraw": r = chessManager.offerDraw({ clientId: id }); break;
      case "respondDraw": r = chessManager.respondDraw({ clientId: id, accept: !!msg.accept }); break;
      case "newGame": r = chessManager.newGame({ clientId: id }); break;
      case "setTimeControl": r = chessManager.setTimeControl({ clientId: id, id: msg.id }); break;
      default: return;
    }
    if (!r.ok) ws.send(JSON.stringify({ type: "error", error: r.error }));
  });

  ws.on("close", () => {
    chessClients.delete(ws);
    const id = info.clientId;
    if (id && ![...chessClients.values()].some((i) => i.clientId === id)) {
      chessManager.setConnected(id, false);
    }
  });
});

setInterval(() => {
  for (const ws of chessClients.keys()) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

(async () => {
  try {
    await scheduler.reload();
  } catch (e) {
    console.error("Reminder scheduler init error:", e.message);
  }
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Pretzel server listening on ${PORT}`);
  });
  server.on("upgrade", (req, socket, head) => {
    const path = (req.url || "").split("?")[0];
    if (path !== "/pretzel/chess/ws") return socket.destroy();
    chessWss.handleUpgrade(req, socket, head, (ws) => chessWss.emit("connection", ws, req));
  });
})();
