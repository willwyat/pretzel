const express = require("express");
const { execFile } = require("child_process");
const cron = require("node-cron");

const PORT = 3001;
const SPEAK_SCRIPT = "/home/william/pretzel/scripts/speak.sh";

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

// ── speak() ────────────────────────────────────────────────────
function speak(text) {
  execFile(SPEAK_SCRIPT, [text], (err) => {
    if (err) console.error("speak error:", err.message);
  });
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
    () => {
      speak(
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

      speak(
        `Good morning! Today is ${todayLabel()}. Time is now 9:30 AM. ` +
          `Today's weather is ${condition}, with temperatures around ${temp} degrees celsius.${rainNote} ` +
          `Oh and also — it's mealtime for Sugar and Spice. Feed them everything nice!!!`,
      );
    } catch (e) {
      console.error("9:30 reminder error:", e.message);
      speak(
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

      speak(
        `Good day! Time is now 12 o'clock at noon. ` +
          `Today's weather is ${condition}. It's about ${temp} degrees out.${rainNote} ` +
          `Please drink more water.`,
      );
    } catch (e) {
      console.error("12pm reminder error:", e.message);
      speak(
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
      const sunsetStr = fmtTime(wx.daily.sunset[0]);

      speak(
        `Good afternoon! Time is now 3 o'clock. The sun will set at around ${sunsetStr} this evening. ` +
          `It's ${temp} degrees out. ` +
          `Oh and also — mealtime for Sugar and Spice. Feed them everything nice!!!`,
      );
    } catch (e) {
      console.error("3pm reminder error:", e.message);
      speak(
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
      const sunset = wx.daily.sunset[0];
      const sunsetStr = fmtTime(sunset);
      const minsLeftRaw = minutesUntil(sunset);

      let sunsetCountdown;
      if (minsLeftRaw <= 0) {
        sunsetCountdown = `around ${sunsetStr}`;
      } else {
        const hoursLeft = Math.floor(minsLeftRaw / 60);
        const minsRem = minsLeftRaw % 60;
        if (hoursLeft > 0 && minsRem > 0) {
          sunsetCountdown = `in about ${hoursLeft} hour${hoursLeft > 1 ? "s" : ""} and ${minsRem} minutes, at ${sunsetStr}`;
        } else if (hoursLeft > 0) {
          sunsetCountdown = `in about ${hoursLeft} hour${hoursLeft > 1 ? "s" : ""}, at ${sunsetStr}`;
        } else {
          sunsetCountdown = `in about ${minsLeftRaw} minutes, at ${sunsetStr}`;
        }
      }

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

      speak(
        `Good afternoon! Time is now 6 o'clock. Time is now 6 o'clock! ` +
          `The sun will set ${sunsetCountdown}. ` +
          `It's ${temp} degrees out.${rainNote} ` +
          `Oh and also — it's mealtime for Sugar and Spice. Feed them everything nice!!!`,
      );
    } catch (e) {
      console.error("6pm reminder error:", e.message);
      speak(
        "Good afternoon! Time is now 6 o'clock. Time is now 6 o'clock! Oh and also — it's mealtime for Sugar and Spice. Feed them everything nice!!!",
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
  () => {
    speak(
      `Good evening! Time is now 9 o'clock. Time is now 9 o'clock! ` +
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
      const sunriseIso = wx.daily.sunrise[1];
      const tomorrowSunrise = fmtTime(sunriseIso);
      const sunriseMs = new Date(sunriseIso).getTime();
      const now = Date.now();
      let deltaMin = Math.round((sunriseMs - now) / 60000);
      if (deltaMin < 0) deltaMin = 0;
      const hInt = Math.floor(deltaMin / 60);
      const mInt = deltaMin % 60;

      speak(
        `Good evening! Time is now 12 o'clock. ` +
          `Tomorrow, the sun will rise at around ${tomorrowSunrise}. ` +
          `That's in ${hInt} hours${mInt > 0 ? ` and ${mInt} minutes` : ""}. ` +
          `Let's wind down and prepare for sleep soon!`,
      );
    } catch (e) {
      console.error("Midnight reminder error:", e.message);
      speak(
        "Good evening! Time is now 12 o'clock. Let's wind down and prepare for sleep soon!",
      );
    }
  },
  { timezone: TZ },
);

// ── Routes ─────────────────────────────────────────────────────

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

app.get("/pretzel/speak", (req, res) => {
  const raw = typeof req.query.text === "string" ? req.query.text : "";
  const text = normalizeSpeakText(raw.slice(0, SPEAK_QUERY_LIMIT));
  if (!text) {
    return res.status(400).json({
      error: "text is required",
      example:
        "curl -sS -G http://pretzel.local:3001/pretzel/speak --data-urlencode \"text=How are you? I'm great\"",
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
        "curl -sS -G http://pretzel.local:3001/pretzel/speak --data-urlencode \"text=How are you? I'm great\"",
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Pretzel server listening on ${PORT}`);
  refreshSunsetReminder().catch((e) =>
    console.error("Initial sunset scheduler error:", e.message),
  );
});
