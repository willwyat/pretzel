const express = require("express");
const { execFile, spawn } = require("child_process");
const { join } = require("path");
const cron = require("node-cron");

const PORT = 3001;
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

// ── Weather config ─────────────────────────────────────────────
const LAT = 40.71;
const LON = -74.01;
const TZ = "America/New_York";

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

// ── Weather fetch ──────────────────────────────────────────────
async function fetchWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${LAT}&longitude=${LON}` +
    `&current=temperature_2m,weathercode` +
    `&hourly=temperature_2m,precipitation_probability` +
    `&daily=sunrise,sunset,precipitation_probability_max` +
    `&temperature_unit=celsius` +
    `&timezone=${encodeURIComponent(TZ)}` +
    `&forecast_days=2`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather fetch failed: ${res.status}`);
  return res.json();
}

// WMO weather code → natural language
function describeWeather(code) {
  if (code === 0) return "clear and sunny";
  if (code === 1) return "mostly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if ([45, 48].includes(code)) return "foggy";
  if ([51, 53, 55].includes(code)) return "drizzly";
  if ([61, 63, 65].includes(code)) return "rainy";
  if ([71, 73, 75].includes(code)) return "snowy";
  if ([80, 81, 82].includes(code)) return "showery";
  if ([95, 96, 99].includes(code)) return "stormy";
  return "mixed";
}

// "2026-04-14T19:34" → "7:34 PM"
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TZ,
  });
}

// "2026-04-14T19:34" → { hour: 19, minute: 34 }
function isoToHM(iso) {
  const t = iso.includes("T") ? iso.split("T")[1] : iso;
  const [h, m] = t.split(":").map(Number);
  return { hour: h, minute: m };
}

/** Calendar date YYYY-MM-DD for `date` in TZ (matches Open-Meteo hourly date prefixes). */
function ymdInTz(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function datePrefixFromHourlyIso(iso) {
  return iso.split("T")[0];
}

function hourFromHourlyIso(iso) {
  const afterT = iso.includes("T") ? iso.split("T")[1] : "0";
  return parseInt(afterT.split(":")[0], 10);
}

// Get hourly temp for a given local hour on "today" in TZ
function tempAtHour(hourly, targetHour) {
  const todayYmd = ymdInTz(new Date(), TZ);
  const idx = hourly.time.findIndex((t) => {
    if (datePrefixFromHourlyIso(t) !== todayYmd) return false;
    return hourFromHourlyIso(t) === targetHour;
  });
  return idx !== -1 ? Math.round(hourly.temperature_2m[idx]) : null;
}

// Minutes between now and a future ISO time string (may be negative)
function minutesUntil(iso) {
  const target = new Date(iso);
  const now = new Date();
  return Math.round((target - now) / 60000);
}

/** For TTS: total minutes rounded to nearest `step`, then "x hours and y minutes". */
function formatDurationHoursMinutesRounded(totalMinutes, step = 5) {
  const rounded = Math.max(0, Math.round(totalMinutes / step) * step);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h === 0 && m === 0) return "less than 5 minutes";
  const hourPart = h > 0 ? `${h} ${h === 1 ? "hour" : "hours"}` : null;
  const minPart = m > 0 ? `${m} ${m === 1 ? "minute" : "minutes"}` : null;
  if (hourPart && minPart) return `${hourPart} and ${minPart}`;
  return hourPart || minPart;
}

/** Next `wx.daily.sunrise` instant strictly after `now` (Open-Meteo daily order). */
function nextSunriseIsoAfterNow(wx) {
  for (const iso of wx.daily.sunrise) {
    if (minutesUntil(iso) > 0) return iso;
  }
  return wx.daily.sunrise[wx.daily.sunrise.length - 1];
}

/**
 * After local midnight, before today's sunrise: both are still ahead, but sunrise is sooner
 * than today's evening sunset (e.g. 3am — next sun event is dawn, not "tonight's sunset").
 */
function isPreDawnBeforeTodaySunrise(wx) {
  const rise0 = wx.daily.sunrise[0];
  const set0 = wx.daily.sunset[0];
  const mR = minutesUntil(rise0);
  const mS = minutesUntil(set0);
  return mR > 0 && mS > 0 && mR < mS;
}

function speakWeatherSunriseDurationClause(wx) {
  const rise = nextSunriseIsoAfterNow(wx);
  return (
    ` Sunrise is ${fmtTime(rise)}, which is in about ` +
    `${formatDurationHoursMinutesRounded(minutesUntil(rise))}.`
  );
}

/** For speak-weather: sunset + duration, or next sunrise + duration after today's sunset. */
function speakWeatherSunEventSentence(wx) {
  const sunset0 = wx.daily.sunset[0];
  if (isPreDawnBeforeTodaySunrise(wx)) {
    return speakWeatherSunriseDurationClause(wx);
  }
  if (minutesUntil(sunset0) > 0) {
    return (
      ` Sunset is ${fmtTime(sunset0)}, which is in about ` +
      `${formatDurationHoursMinutesRounded(minutesUntil(sunset0))}.`
    );
  }
  return speakWeatherSunriseDurationClause(wx);
}

/** 3pm reminder: sunset this evening, or post-sunset sunrise line. */
function reminderAfternoonSunClause(wx) {
  const sunset0 = wx.daily.sunset[0];
  if (isPreDawnBeforeTodaySunrise(wx)) {
    const rise = nextSunriseIsoAfterNow(wx);
    return (
      `The next sunrise is at around ${fmtTime(rise)}, in about ` +
      `${formatDurationHoursMinutesRounded(minutesUntil(rise))}.`
    );
  }
  if (minutesUntil(sunset0) > 0) {
    return `The sun will set at around ${fmtTime(sunset0)} this evening.`;
  }
  const rise = nextSunriseIsoAfterNow(wx);
  return (
    `The sun has set. The next sunrise is at around ${fmtTime(rise)}, in about ` +
    `${formatDurationHoursMinutesRounded(minutesUntil(rise))}.`
  );
}

/** 6pm reminder: sunset countdown, or sunrise countdown if sunset already passed. */
function reminderSixPmSunClause(wx) {
  const sunset = wx.daily.sunset[0];
  const minsLeftRaw = minutesUntil(sunset);
  const fmtCountdown = (mins, atStr) => {
    if (mins <= 0) return `around ${atStr}`;
    const hoursLeft = Math.floor(mins / 60);
    const minsRem = mins % 60;
    if (hoursLeft > 0 && minsRem > 0) {
      return `in about ${hoursLeft} hour${hoursLeft > 1 ? "s" : ""} and ${minsRem} minutes, at ${atStr}`;
    }
    if (hoursLeft > 0) {
      return `in about ${hoursLeft} hour${hoursLeft > 1 ? "s" : ""}, at ${atStr}`;
    }
    return `in about ${mins} minutes, at ${atStr}`;
  };

  if (isPreDawnBeforeTodaySunrise(wx)) {
    const rise = nextSunriseIsoAfterNow(wx);
    const riseStr = fmtTime(rise);
    const minsToRise = minutesUntil(rise);
    return `The next sunrise is ${fmtCountdown(minsToRise, riseStr)}.`;
  }
  if (minsLeftRaw > 0) {
    const sunsetStr = fmtTime(sunset);
    return `The sun will set ${fmtCountdown(minsLeftRaw, sunsetStr)}.`;
  }
  const rise = nextSunriseIsoAfterNow(wx);
  const riseStr = fmtTime(rise);
  const minsToRise = minutesUntil(rise);
  return `The sun has set. The next sunrise is ${fmtCountdown(minsToRise, riseStr)}.`;
}

// Today's full date string: "Tuesday, April 14th" (calendar day in TZ)
function todayLabel() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "weekday").value;
  const month = parts.find((p) => p.type === "month").value;
  const date = parseInt(parts.find((p) => p.type === "day").value, 10);
  const suffix =
    date % 10 === 1 && date !== 11
      ? "st"
      : date % 10 === 2 && date !== 12
        ? "nd"
        : date % 10 === 3 && date !== 13
          ? "rd"
          : "th";
  return `${day}, ${month} ${date}${suffix}`;
}

/**
 * One paragraph for TTS from Open-Meteo (always calls {@link fetchWeather} first).
 */
async function buildSpeakWeatherUtterance() {
  const wx = await fetchWeather();
  const now = new Date();
  const localTime = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TZ,
  });
  const temp = Math.round(wx.current.temperature_2m);
  const condition = describeWeather(wx.current.weathercode);
  const precip = wx.daily.precipitation_probability_max[0];

  let s =
    `Here's the weather for ${todayLabel()} ${localTime}. ` +
    `Currently ${temp} degrees celsius and ${condition}.`;
  if (precip >= 40) {
    s += ` There is a ${precip} percent chance of rain today.`;
  }
  s += speakWeatherSunEventSentence(wx);
  return s;
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

// ── Sunset reminder (single task, refreshed at 6 AM + on boot) ─
let sunsetReminderTask = null;

async function refreshSunsetReminder() {
  const wx = await fetchWeather();
  const sunset = wx.daily.sunset[0];
  const { hour, minute } = isoToHM(sunset);
  const sunsetTimeStr = fmtTime(sunset);

  if (sunsetReminderTask) {
    sunsetReminderTask.stop();
    sunsetReminderTask = null;
  }

  console.log(
    `Scheduling sunset reminder for ${hour}:${minute < 10 ? "0" + minute : minute}`,
  );

  sunsetReminderTask = cron.schedule(
    `${minute} ${hour} * * *`,
    async () => {
      await speakWithReminderSfx(
        `Good evening! Time is now ${sunsetTimeStr}. ` +
          `The sun is setting now. Take a look outside for the amazing sunset view!`,
      );
    },
    { timezone: TZ },
  );
}

// ── Scheduled reminders ────────────────────────────────────────

// 9:30 AM — morning greeting + weather + cats
cron.schedule(
  "30 9 * * *",
  async () => {
    try {
      const wx = await fetchWeather();
      const code = wx.current.weathercode;
      const temp =
        tempAtHour(wx.hourly, 9) ?? Math.round(wx.current.temperature_2m);
      const precip = wx.daily.precipitation_probability_max[0];
      const condition = describeWeather(code);
      const rainNote =
        precip >= 40
          ? ` There's a ${precip} percent chance of rain today, so keep an umbrella handy.`
          : "";

      await speakWithReminderSfx(
        `Good morning! Today is ${todayLabel()}. Time is now 9:30 AM. ` +
          `Today's weather is ${condition}, with temperatures around ${temp} degrees celsius.${rainNote} ` +
          `Oh and also — it's mealtime for Sugar and Spice. Feed them everything nice!!!`,
      );
    } catch (e) {
      console.error("9:30 reminder error:", e.message);
      await speakWithReminderSfx(
        "Good morning! Time is now 9:30 AM. Oh and also — it's mealtime for Sugar and Spice. Feed them everything nice!!!",
      );
    }
  },
  { timezone: TZ },
);

// 12:00 PM — midday + weather + water
cron.schedule(
  "0 12 * * *",
  async () => {
    try {
      const wx = await fetchWeather();
      const code = wx.current.weathercode;
      const temp =
        tempAtHour(wx.hourly, 12) ?? Math.round(wx.current.temperature_2m);
      const precip = wx.daily.precipitation_probability_max[0];
      const condition = describeWeather(code);
      const rainNote =
        precip >= 40
          ? ` There's a ${precip} percent chance of rain this afternoon.`
          : " Low chance of rain today.";

      await speakWithReminderSfx(
        `Good day! Time is now 12 o'clock at noon. ` +
          `Today's weather is ${condition}. It's about ${temp} degrees out.${rainNote} ` +
          `Please drink more water.`,
      );
    } catch (e) {
      console.error("12pm reminder error:", e.message);
      await speakWithReminderSfx(
        "Good day! Time is now 12 o'clock at noon. Please drink more water.",
      );
    }
  },
  { timezone: TZ },
);

// 3:00 PM — afternoon + sunset preview + cats
cron.schedule(
  "0 15 * * *",
  async () => {
    try {
      const wx = await fetchWeather();
      const temp =
        tempAtHour(wx.hourly, 15) ?? Math.round(wx.current.temperature_2m);

      await speakWithReminderSfx(
        `Good afternoon! Time is now 3 o'clock. ${reminderAfternoonSunClause(wx)} ` +
          `It's ${temp} degrees out. ` +
          `Oh and also — mealtime for Sugar and Spice. Feed them everything nice!!!`,
      );
    } catch (e) {
      console.error("3pm reminder error:", e.message);
      await speakWithReminderSfx(
        "Good afternoon! Time is now 3 o'clock. Oh and also — mealtime for Sugar and Spice. Feed them everything nice!!!",
      );
    }
  },
  { timezone: TZ },
);

// 6:00 PM — evening + sunset countdown + rain warning + cats
cron.schedule(
  "0 18 * * *",
  async () => {
    try {
      const wx = await fetchWeather();
      const temp =
        tempAtHour(wx.hourly, 18) ?? Math.round(wx.current.temperature_2m);

      const todayYmd = ymdInTz(new Date(), TZ);
      const upcomingPrecip = [18, 19, 20, 21, 22].map((h) => {
        const idx = wx.hourly.time.findIndex((t) => {
          if (datePrefixFromHourlyIso(t) !== todayYmd) return false;
          return hourFromHourlyIso(t) === h;
        });
        return idx !== -1 ? wx.hourly.precipitation_probability[idx] : 0;
      });
      const maxPrecip = Math.max(...upcomingPrecip);
      const rainNote =
        maxPrecip >= 40
          ? ` And there might be showers later tonight, around ${maxPrecip} percent chance.`
          : "";

      await speakWithReminderSfx(
        `Good afternoon! Time is now 6 o'clock. ` +
          `${reminderSixPmSunClause(wx)} ` +
          `It's ${temp} degrees out.${rainNote} ` +
          `Oh and also — it's mealtime for Sugar and Spice. Feed them everything nice!!!`,
      );
    } catch (e) {
      console.error("6pm reminder error:", e.message);
      await speakWithReminderSfx(
        "Good afternoon! Time is now 6 o'clock. Oh and also — it's mealtime for Sugar and Spice. Feed them everything nice!!!",
      );
    }
  },
  { timezone: TZ },
);

// Sunset reminder — reschedule each morning at 6 AM
cron.schedule(
  "0 6 * * *",
  async () => {
    try {
      await refreshSunsetReminder();
    } catch (e) {
      console.error("Sunset scheduler error:", e.message);
    }
  },
  { timezone: TZ },
);

// 9:00 PM — wind down + supplements + cats
cron.schedule(
  "0 21 * * *",
  async () => {
    await speakWithReminderSfx(
      `Good evening! Time is now 9 o'clock. ` +
        `Remember to take your supplements and feed the cats. ` +
        `And then wind down for bedtime in a couple of hours. ` +
        `Enjoy your night!`,
    );
  },
  { timezone: TZ },
);

// 12:00 AM — midnight + tomorrow's sunrise
cron.schedule(
  "0 0 * * *",
  async () => {
    try {
      const wx = await fetchWeather();
      const sunriseIso = nextSunriseIsoAfterNow(wx);
      const tomorrowSunrise = fmtTime(sunriseIso);
      const sunriseMs = new Date(sunriseIso).getTime();
      const now = Date.now();
      let deltaMin = Math.round((sunriseMs - now) / 60000);
      if (deltaMin < 0) deltaMin = 0;
      const hInt = Math.floor(deltaMin / 60);
      const mInt = deltaMin % 60;

      await speakWithReminderSfx(
        `Good evening! Time is now 12 o'clock. ` +
          `Tomorrow, the sun will rise at around ${tomorrowSunrise}. ` +
          `That's in ${hInt} hours${mInt > 0 ? ` and ${mInt} minutes` : ""}. ` +
          `Let's wind down and prepare for sleep soon!`,
      );
    } catch (e) {
      console.error("Midnight reminder error:", e.message);
      await speakWithReminderSfx(
        "Good evening! Time is now 12 o'clock. Let's wind down and prepare for sleep soon!",
      );
    }
  },
  { timezone: TZ },
);

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
  const time = {
    timezone: TZ,
    utc: now.toISOString(),
    epochMs: now.getTime(),
    localDate: ymdInTz(now, TZ),
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
    const wx = await fetchWeather();
    const code = wx.current.weathercode;
    res.json({
      ok: true,
      time,
      location: { latitude: LAT, longitude: LON },
      current: {
        temperatureC: Math.round(wx.current.temperature_2m),
        weathercode: code,
        condition: describeWeather(code),
        reportedTime: wx.current.time,
      },
      today: {
        sunrise: wx.daily.sunrise[0],
        sunset: wx.daily.sunset[0],
        precipitationProbabilityMax: wx.daily.precipitation_probability_max[0],
      },
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
    const text = await buildSpeakWeatherUtterance();
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
    res.json({
      ok: true,
      services: { pretzelServer, tvRelay },
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Pretzel server listening on ${PORT}`);
  refreshSunsetReminder().catch((e) =>
    console.error("Initial sunset scheduler error:", e.message),
  );
});
