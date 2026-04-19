const LAT = 40.71;
const LON = -74.01;
const TZ = "America/New_York";

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

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TZ,
  });
}

function isoToHM(iso) {
  const t = iso.includes("T") ? iso.split("T")[1] : iso;
  const [h, m] = t.split(":").map(Number);
  return { hour: h, minute: m };
}

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

function tempAtHour(hourly, targetHour, now = new Date()) {
  const todayYmd = ymdInTz(now, TZ);
  const idx = hourly.time.findIndex((t) => {
    if (datePrefixFromHourlyIso(t) !== todayYmd) return false;
    return hourFromHourlyIso(t) === targetHour;
  });
  return idx !== -1 ? Math.round(hourly.temperature_2m[idx]) : null;
}

function minutesUntil(iso, now = new Date()) {
  const target = new Date(iso);
  return Math.round((target - now) / 60000);
}

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

function nextSunriseIsoAfterNow(wx, now = new Date()) {
  for (const iso of wx.daily.sunrise) {
    if (minutesUntil(iso, now) > 0) return iso;
  }
  return wx.daily.sunrise[wx.daily.sunrise.length - 1];
}

function isPreDawnBeforeTodaySunrise(wx, now = new Date()) {
  const rise0 = wx.daily.sunrise[0];
  const set0 = wx.daily.sunset[0];
  const mR = minutesUntil(rise0, now);
  const mS = minutesUntil(set0, now);
  return mR > 0 && mS > 0 && mR < mS;
}

function sunSummaryForHomeUi(wx, now = new Date()) {
  const rise0 = wx.daily.sunrise[0];
  const set0 = wx.daily.sunset[0];
  if (isPreDawnBeforeTodaySunrise(wx, now)) {
    return { mode: "sunrise", iso: nextSunriseIsoAfterNow(wx, now) };
  }
  if (minutesUntil(rise0, now) <= 0 && minutesUntil(set0, now) > 0) {
    return { mode: "sunset", iso: set0 };
  }
  return { mode: "sunrise", iso: nextSunriseIsoAfterNow(wx, now) };
}

function speakWeatherSunriseDurationClause(wx, now = new Date()) {
  const rise = nextSunriseIsoAfterNow(wx, now);
  return (
    ` Sunrise is ${fmtTime(rise)}, which is in about ` +
    `${formatDurationHoursMinutesRounded(minutesUntil(rise, now))}.`
  );
}

function speakWeatherSunEventSentence(wx, now = new Date()) {
  const sunset0 = wx.daily.sunset[0];
  if (isPreDawnBeforeTodaySunrise(wx, now)) {
    return speakWeatherSunriseDurationClause(wx, now);
  }
  if (minutesUntil(sunset0, now) > 0) {
    return (
      ` Sunset is ${fmtTime(sunset0)}, which is in about ` +
      `${formatDurationHoursMinutesRounded(minutesUntil(sunset0, now))}.`
    );
  }
  return speakWeatherSunriseDurationClause(wx, now);
}

function reminderAfternoonSunClause(wx, now = new Date()) {
  const sunset0 = wx.daily.sunset[0];
  if (isPreDawnBeforeTodaySunrise(wx, now)) {
    const rise = nextSunriseIsoAfterNow(wx, now);
    return (
      `The next sunrise is at around ${fmtTime(rise)}, in about ` +
      `${formatDurationHoursMinutesRounded(minutesUntil(rise, now))}.`
    );
  }
  if (minutesUntil(sunset0, now) > 0) {
    return `The sun will set at around ${fmtTime(sunset0)} this evening.`;
  }
  const rise = nextSunriseIsoAfterNow(wx, now);
  return (
    `The sun has set. The next sunrise is at around ${fmtTime(rise)}, in about ` +
    `${formatDurationHoursMinutesRounded(minutesUntil(rise, now))}.`
  );
}

function reminderSixPmSunClause(wx, now = new Date()) {
  const sunset = wx.daily.sunset[0];
  const minsLeftRaw = minutesUntil(sunset, now);
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

  if (isPreDawnBeforeTodaySunrise(wx, now)) {
    const rise = nextSunriseIsoAfterNow(wx, now);
    const riseStr = fmtTime(rise);
    const minsToRise = minutesUntil(rise, now);
    return `The next sunrise is ${fmtCountdown(minsToRise, riseStr)}.`;
  }
  if (minsLeftRaw > 0) {
    const sunsetStr = fmtTime(sunset);
    return `The sun will set ${fmtCountdown(minsLeftRaw, sunsetStr)}.`;
  }
  const rise = nextSunriseIsoAfterNow(wx, now);
  const riseStr = fmtTime(rise);
  const minsToRise = minutesUntil(rise, now);
  return `The sun has set. The next sunrise is ${fmtCountdown(minsToRise, riseStr)}.`;
}

function todayLabel(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).formatToParts(now);
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

function buildRainNote(wx, now, reminderId, reminderHour) {
  const precip = wx.daily.precipitation_probability_max[0];

  if (reminderId === "evening" || reminderHour >= 18) {
    const todayYmd = ymdInTz(now, TZ);
    const upcomingPrecip = [18, 19, 20, 21, 22].map((hour) => {
      const idx = wx.hourly.time.findIndex((t) => {
        if (datePrefixFromHourlyIso(t) !== todayYmd) return false;
        return hourFromHourlyIso(t) === hour;
      });
      return idx !== -1 ? wx.hourly.precipitation_probability[idx] : 0;
    });
    const maxPrecip = Math.max(...upcomingPrecip);
    if (maxPrecip >= 40) {
      return ` And there might be showers later tonight, around ${maxPrecip} percent chance.`;
    }
    return "";
  }

  if (precip >= 40) {
    if (reminderId === "morning") {
      return ` There's a ${precip} percent chance of rain today, so keep an umbrella handy.`;
    }
    if (reminderId === "midday") {
      return ` There's a ${precip} percent chance of rain this afternoon.`;
    }
    return ` There's a ${precip} percent chance of rain today.`;
  }

  if (reminderId === "midday") {
    return " Low chance of rain today.";
  }

  return "";
}

function buildSunClause(wx, now, reminderId, reminderHour) {
  if (reminderId === "sunset") {
    return "";
  }
  if (reminderId === "midnight") {
    const sunriseIso = nextSunriseIsoAfterNow(wx, now);
    const tomorrowSunrise = fmtTime(sunriseIso);
    const sunriseMs = new Date(sunriseIso).getTime();
    const t = now.getTime();
    let deltaMin = Math.round((sunriseMs - t) / 60000);
    if (deltaMin < 0) deltaMin = 0;
    const hInt = Math.floor(deltaMin / 60);
    const mInt = deltaMin % 60;
    return (
      `Tomorrow, the sun will rise at around ${tomorrowSunrise}. ` +
      `That's in ${hInt} hours${mInt > 0 ? ` and ${mInt} minutes` : ""}. `
    );
  }
  if (reminderId === "afternoon" || reminderHour === 15) {
    return reminderAfternoonSunClause(wx, now);
  }
  if (reminderId === "evening" || reminderHour === 18) {
    return reminderSixPmSunClause(wx, now);
  }
  return speakWeatherSunEventSentence(wx, now);
}

/**
 * @param {object} wx - Open-Meteo JSON
 * @param {number} reminderHour - local hour (0–23) for temp/rain context
 * @param {Date} [now]
 * @param {{ reminderId?: string }} [meta]
 */
function buildWeatherContext(wx, reminderHour, now = new Date(), meta = {}) {
  const reminderId = meta.reminderId ?? "";
  const localTime = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TZ,
  });
  const tempC =
    tempAtHour(wx.hourly, reminderHour, now) ??
    Math.round(wx.current.temperature_2m);
  const condition = describeWeather(wx.current.weathercode);
  const rainNote = buildRainNote(wx, now, reminderId, reminderHour);
  const sunClause = buildSunClause(wx, now, reminderId, reminderHour);

  return {
    date: todayLabel(now),
    time: localTime,
    tempC,
    condition,
    rainNote,
    sunClause,
  };
}

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
    `Here's the weather for ${todayLabel(now)} ${localTime}. ` +
    `Currently ${temp} degrees celsius and ${condition}.`;
  if (precip >= 40) {
    s += ` There is a ${precip} percent chance of rain today.`;
  }
  s += speakWeatherSunEventSentence(wx, now);
  return s;
}

module.exports = {
  LAT,
  LON,
  TZ,
  fetchWeather,
  describeWeather,
  fmtTime,
  isoToHM,
  ymdInTz,
  datePrefixFromHourlyIso,
  hourFromHourlyIso,
  tempAtHour,
  minutesUntil,
  formatDurationHoursMinutesRounded,
  nextSunriseIsoAfterNow,
  isPreDawnBeforeTodaySunrise,
  sunSummaryForHomeUi,
  speakWeatherSunEventSentence,
  reminderAfternoonSunClause,
  reminderSixPmSunClause,
  todayLabel,
  buildWeatherContext,
  buildSpeakWeatherUtterance,
};
