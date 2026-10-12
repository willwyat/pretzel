"use strict";

// Wall-clock helpers for one IANA time zone, built on Intl (no dependencies).

/** Wall-clock parts of instant `ms` in `tz`. */
function wallParts(ms, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(
    fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (New York in winter: -5 h). */
function tzOffsetMs(ms, tz) {
  const w = wallParts(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at wall time `hh:mm` on `ymd` in `tz`. A time skipped by a DST
 * jump (02:30 in spring) lands an hour later; a repeated one (01:30 in autumn)
 * resolves to its first occurrence.
 */
function localToUtc(ymd, hm, tz) {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const candidates = [];
  for (const probe of [guess - 864e5 / 2, guess + 864e5 / 2]) {
    const t = guess - tzOffsetMs(probe, tz);
    const w = wallParts(t, tz);
    if (w.ymd === ymd && w.hour === h && w.minute === mi) candidates.push(t);
  }
  if (candidates.length > 0) return Math.min(...candidates);
  // In a DST gap: the earlier offset puts the instant just after the jump.
  return guess - tzOffsetMs(guess - 864e5 / 2, tz);
}

/** `YYYY-MM-DD` plus `n` calendar days. */
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday for a calendar date. */
function weekdayMon0(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** `HH:MM` wall time of instant `ms` in `tz`. */
function hmInTz(ms, tz) {
  const w = wallParts(ms, tz);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

/** Parse strict `HH:MM` (00:00–23:59) into minutes after midnight, or null. */
function parseHm(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

module.exports = { wallParts, tzOffsetMs, localToUtc, addDays, weekdayMon0, hmInTz, parseHm };
