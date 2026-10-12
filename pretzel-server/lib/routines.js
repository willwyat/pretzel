"use strict";

// Household routines: the daily cycle of lights and spoken reminders run by the Pi.
//
// A routine has an anchor (a wall-clock time, or sunrise/sunset ± minutes) on
// selected weekdays, and steps at minute offsets from that anchor. Days are
// counted in cycles that run 04:00 → 04:00, so a 00:00 or 01:00 routine belongs
// to the evening before: Sunday's cycle ends with Monday's 01:00 Sleep.
//
// The engine ticks every 30 s. Each due step is written to the run log before it
// runs (key: routine | cycle date | step), so a restart never fires it twice, and
// a step missed by up to 5 minutes (restart, slow tick) still runs. One-off
// changes (skip, or a different time) are kept per cycle date and never edit the
// routine itself.

const { existsSync, readFileSync, writeFileSync, renameSync } = require("fs");
const { join } = require("path");
const { sunTimes } = require("./sun");
const { wallParts, localToUtc, addDays, weekdayMon0, hmInTz, parseHm } = require("./tztime");

/** Anchors before this wall time belong to the previous day's cycle. */
const CYCLE_START_MIN = 4 * 60;
const CATCH_UP_MS = 5 * 60_000;
const TICK_MS = 30_000;
const MAX_RUNS = 400;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const TARGET_RE = /^(all|room:[^,]{1,40}|light:[A-Za-z0-9.:_-]{1,64})$/;

const DEFAULT_ROUTINES = [
  {
    id: "wake-up",
    name: "Wake Up",
    enabled: true,
    days: ALL_DAYS,
    anchor: { type: "time", time: "09:00" },
    steps: [
      {
        offsetMin: 0,
        action: { type: "lights", targets: ["room:Bedroom"], power: "on", brightness: 0.5, kelvin: 4000, fadeS: 60 },
      },
    ],
  },
  {
    id: "noon",
    name: "Noon",
    enabled: true,
    days: ALL_DAYS,
    anchor: { type: "time", time: "12:00" },
    steps: [
      {
        offsetMin: 0,
        action: {
          type: "speak",
          text: "It's noon! Time to take your supplements, drink a glass of water, and feed the cats.",
          style: "cheerful",
        },
      },
    ],
  },
  {
    id: "afternoon",
    name: "Afternoon",
    enabled: true,
    days: ALL_DAYS,
    anchor: { type: "time", time: "15:00" },
    steps: [
      {
        offsetMin: 0,
        action: { type: "speak", text: "It's three o'clock. Time to drink some water!", style: "cheerful" },
      },
    ],
  },
  {
    id: "sunset",
    name: "Sunset",
    enabled: true,
    days: ALL_DAYS,
    anchor: { type: "sun", event: "sunset", offsetMin: -60 },
    steps: [
      {
        offsetMin: 0,
        action: {
          type: "lights",
          targets: ["room:Lounge"],
          power: "on",
          brightness: 1,
          kelvin: 4000,
          fadeS: 300,
          onlyIfOff: true,
        },
      },
    ],
  },
  {
    id: "wind-down",
    name: "Wind Down",
    enabled: true,
    days: ALL_DAYS,
    anchor: { type: "time", time: "00:00" },
    steps: [
      {
        offsetMin: 0,
        // No `power`: lights that are off stay off.
        action: { type: "lights", targets: ["all"], brightness: 0.1, kelvin: 2200, fadeS: 600 },
      },
    ],
  },
  {
    id: "sleep",
    name: "Sleep",
    enabled: true,
    days: ALL_DAYS,
    anchor: { type: "time", time: "01:00" },
    steps: [{ offsetMin: 0, action: { type: "lights", targets: ["all"], power: "off", fadeS: 60 } }],
  },
];

// ── Validation ─────────────────────────────────────────────────

const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const isNum = (n, lo, hi) => typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;

function validateAction(a) {
  if (!a || typeof a !== "object") return "action is required";
  if (a.type === "lights") {
    if (!Array.isArray(a.targets) || a.targets.length === 0 || a.targets.length > 20) {
      return "lights: targets must list 1–20 of all, room:<name> or light:<id>";
    }
    if (!a.targets.every((t) => typeof t === "string" && TARGET_RE.test(t))) {
      return "lights: each target is all, room:<name> or light:<id>";
    }
    if (a.power !== undefined && a.power !== "on" && a.power !== "off") return "lights: power is on or off";
    if (a.brightness !== undefined && !isNum(a.brightness, 0, 1)) return "lights: brightness is 0–1";
    if (a.kelvin !== undefined && !isInt(a.kelvin, 1500, 9000)) return "lights: kelvin is 1500–9000";
    if (a.fadeS !== undefined && !isNum(a.fadeS, 0, 3600)) return "lights: fadeS is 0–3600";
    if (a.onlyIfOff !== undefined && typeof a.onlyIfOff !== "boolean") return "lights: onlyIfOff is a boolean";
    if (a.power === undefined && a.brightness === undefined && a.kelvin === undefined) {
      return "lights: set power, brightness or kelvin";
    }
    return null;
  }
  if (a.type === "speak") {
    if (typeof a.text !== "string" || a.text.trim() === "" || a.text.length > 1000) {
      return "speak: text is 1–1000 characters";
    }
    if (a.style !== undefined && a.style !== "cheerful" && a.style !== "plain") return "speak: style is cheerful or plain";
    return null;
  }
  return "action type is lights or speak";
}

/** Returns an error message, or null when `r` is a valid routine. */
function validateRoutine(r) {
  if (!r || typeof r !== "object") return "routine must be an object";
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) return "id is lowercase letters, digits and dashes";
  if (typeof r.name !== "string" || r.name.trim() === "" || r.name.length > 40) return "name is 1–40 characters";
  if (typeof r.enabled !== "boolean") return "enabled is a boolean";
  if (
    !Array.isArray(r.days) ||
    !r.days.every((d) => isInt(d, 0, 6)) ||
    new Set(r.days).size !== r.days.length
  ) {
    return "days lists weekdays 0 (Mon) – 6 (Sun)";
  }
  const an = r.anchor;
  if (!an || typeof an !== "object") return "anchor is required";
  if (an.type === "time") {
    if (parseHm(an.time) === null) return "anchor.time is HH:MM";
  } else if (an.type === "sun") {
    if (an.event !== "sunrise" && an.event !== "sunset") return "anchor.event is sunrise or sunset";
    if (!isInt(an.offsetMin, -180, 180)) return "anchor.offsetMin is -180–180";
  } else {
    return "anchor.type is time or sun";
  }
  if (!Array.isArray(r.steps) || r.steps.length === 0 || r.steps.length > 10) return "steps lists 1–10 steps";
  for (const s of r.steps) {
    if (!s || !isInt(s.offsetMin, -240, 240)) return "step offsetMin is -240–240";
    const err = validateAction(s.action);
    if (err) return err;
  }
  return null;
}

/** Keep only known fields, so stored routines never carry stray input. */
function cleanRoutine(r) {
  const anchor =
    r.anchor.type === "time"
      ? { type: "time", time: r.anchor.time }
      : { type: "sun", event: r.anchor.event, offsetMin: r.anchor.offsetMin };
  const steps = r.steps.map((s) => {
    const a = s.action;
    const action =
      a.type === "lights"
        ? Object.fromEntries(
            Object.entries({
              type: "lights",
              targets: [...a.targets],
              power: a.power,
              brightness: a.brightness,
              kelvin: a.kelvin,
              fadeS: a.fadeS,
              onlyIfOff: a.onlyIfOff,
            }).filter(([, v]) => v !== undefined),
          )
        : { type: "speak", text: a.text.trim(), style: a.style ?? "cheerful" };
    return { offsetMin: s.offsetMin, action };
  });
  return {
    id: r.id,
    name: r.name.trim(),
    enabled: r.enabled,
    days: [...r.days].sort((x, y) => x - y),
    anchor,
    steps,
    updatedAt: r.updatedAt ?? null,
  };
}

// ── Schedule math ──────────────────────────────────────────────

/** Cycle date (`YYYY-MM-DD`) that instant `ms` falls in. */
function cycleDateOf(ms, tz) {
  const w = wallParts(ms, tz);
  return w.hour * 60 + w.minute < CYCLE_START_MIN ? addDays(w.ymd, -1) : w.ymd;
}

/** Instant of wall time `hm` within the cycle that starts on `cycleDate`. */
function cycleTimeToUtc(cycleDate, hm, tz) {
  const date = parseHm(hm) < CYCLE_START_MIN ? addDays(cycleDate, 1) : cycleDate;
  return localToUtc(date, hm, tz);
}

/**
 * Where a routine's anchor lands in one cycle, or null when the routine doesn't
 * run on that weekday. `skipped` is set by a one-off skip.
 *
 * @returns {{ at: number, source: string, skipped: boolean, override: object|null } | null}
 */
function resolveAnchor(routine, cycleDate, { tz, lat, lon }, override = null) {
  if (!routine.days.includes(weekdayMon0(cycleDate))) return null;
  const an = routine.anchor;
  let at;
  let source;
  if (an.type === "time") {
    at = cycleTimeToUtc(cycleDate, an.time, tz);
    source = an.time;
  } else {
    const sun = sunTimes(cycleDate, lat, lon, tz)[an.event];
    if (sun === null) return null;
    at = sun + an.offsetMin * 60_000;
    const off = an.offsetMin === 0 ? "" : ` ${an.offsetMin < 0 ? "−" : "+"} ${Math.abs(an.offsetMin)} min`;
    source = `${an.event} ${hmInTz(sun, tz)}${off}`;
  }
  if (override?.time) {
    at = cycleTimeToUtc(cycleDate, override.time, tz);
    source = `moved to ${override.time} (usually ${source})`;
  }
  return { at, source, skipped: Boolean(override?.skip), override };
}

const runKey = (routineId, cycleDate, stepIdx) => `${routineId}|${cycleDate}|${stepIdx}`;

/** "Bedroom lights on · 50% · 4000K" style one-liner for the UI and logs. */
function describeAction(a) {
  if (a.type === "speak") return `Speak: “${a.text}”`;
  const who = a.targets
    .map((t) => (t === "all" ? "All" : t.startsWith("room:") ? t.slice(5) : t.slice(6)))
    .join(", ");
  const parts = [`${who} lights${a.power ? ` ${a.power}` : ""}`];
  if (a.power !== "off") {
    if (a.brightness !== undefined) parts.push(`${Math.round(a.brightness * 100)}%`);
    if (a.kelvin !== undefined) parts.push(`${a.kelvin}K`);
  }
  if (a.fadeS) parts.push(a.fadeS >= 60 ? `${Math.round(a.fadeS / 60)} min fade` : `${a.fadeS}s fade`);
  if (a.onlyIfOff) parts.push("only if off");
  return parts.join(" · ");
}

/** Does a lights target list include this light (`{ id, room }`)? */
function targetsLight(targets, light) {
  const room = String(light.room || "").toLowerCase();
  return targets.some(
    (t) =>
      t === "all" ||
      (t.startsWith("room:") && t.slice(5).toLowerCase() === room) ||
      (t.startsWith("light:") && t.slice(6) === light.id),
  );
}

// ── Persistence ────────────────────────────────────────────────

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`routines: can't read ${path}: ${e.message}`);
    return fallback;
  }
}

function writeJson(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, path);
}

/** Routines, one-off overrides and the run log, each in its own JSON file under `dataDir`. */
class RoutineStore {
  constructor(dataDir) {
    this.paths = {
      routines: join(dataDir, "routines.json"),
      overrides: join(dataDir, "routine-overrides.json"),
      runs: join(dataDir, "routine-runs.json"),
    };
    this.load();
  }

  load() {
    const saved = readJson(this.paths.routines, null);
    const list = Array.isArray(saved?.routines) ? saved.routines : DEFAULT_ROUTINES;
    this.routines = [];
    for (const r of list) {
      const err = validateRoutine(r);
      if (err) console.error(`routines: ignoring "${r?.id}": ${err}`);
      else this.routines.push(cleanRoutine(r));
    }
    const o = readJson(this.paths.overrides, {});
    this.overrides = o && typeof o === "object" && !Array.isArray(o) ? o : {};
    const runs = readJson(this.paths.runs, []);
    this.runs = Array.isArray(runs) ? runs : [];
  }

  saveRoutines() {
    writeJson(this.paths.routines, { routines: this.routines });
  }

  saveOverrides() {
    writeJson(this.paths.overrides, this.overrides);
  }

  saveRuns() {
    if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(-MAX_RUNS);
    writeJson(this.paths.runs, this.runs);
  }
}

// ── Engine ─────────────────────────────────────────────────────

class RoutineEngine {
  /**
   * @param {{
   *   store: RoutineStore,
   *   tz: string, lat: number, lon: number,
   *   actions: { lights: (a: object) => Promise<string|void>, speak: (a: object, ctx: object) => Promise<string|void> },
   *   now?: () => number,
   * }} opts
   */
  constructor({ store, tz, lat, lon, actions, now = () => Date.now() }) {
    this.store = store;
    this.geo = { tz, lat, lon };
    this.actions = actions;
    this.now = now;
    this.timer = null;
    this.ticking = false;
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  get routines() {
    return this.store.routines;
  }

  getRoutine(id) {
    return this.store.routines.find((r) => r.id === id) ?? null;
  }

  overrideFor(routineId, cycleDate) {
    return this.store.overrides[cycleDate]?.[routineId] ?? null;
  }

  /** One routine in one cycle: anchor, steps with times, and run status. */
  occurrence(routine, cycleDate) {
    const ov = this.overrideFor(routine.id, cycleDate);
    const anchor = resolveAnchor(routine, cycleDate, this.geo, ov);
    if (!anchor) return null;
    const steps = routine.steps.map((s, idx) => {
      const run = this.store.runs.findLast((x) => x.key === runKey(routine.id, cycleDate, idx));
      return {
        idx,
        at: anchor.at + s.offsetMin * 60_000,
        action: s.action,
        summary: describeAction(s.action),
        run: run ? { ok: run.ok, error: run.error ?? null, finishedAt: run.finishedAt ?? null } : null,
      };
    });
    return { routine, cycleDate, ...anchor, steps };
  }

  /** Steps whose time has come, oldest first. */
  dueSteps() {
    const now = this.now();
    const cur = cycleDateOf(now, this.geo.tz);
    const claimed = new Set(this.store.runs.map((r) => r.key));
    const due = [];
    for (const cd of [addDays(cur, -1), cur, addDays(cur, 1)]) {
      for (const routine of this.routines) {
        if (!routine.enabled) continue;
        const occ = this.occurrence(routine, cd);
        if (!occ || occ.skipped) continue;
        // A save or a one-off change never fires steps that were already due.
        const editedAt = Math.max(
          routine.updatedAt ? Date.parse(routine.updatedAt) : 0,
          occ.override?.setAt ? Date.parse(occ.override.setAt) : 0,
        );
        for (const s of occ.steps) {
          if (s.at > now || s.at <= now - CATCH_UP_MS || s.at < editedAt) continue;
          const key = runKey(routine.id, cd, s.idx);
          if (claimed.has(key)) continue;
          due.push({ key, routine, cycleDate: cd, step: s });
        }
      }
    }
    return due.sort((a, b) => a.step.at - b.step.at || a.step.idx - b.step.idx);
  }

  async runStep(entry, { manual = false } = {}) {
    const record = {
      key: entry.key,
      routineId: entry.routine.id,
      cycleDate: entry.cycleDate,
      stepIdx: entry.step.idx,
      scheduledAt: new Date(entry.step.at).toISOString(),
      startedAt: new Date(this.now()).toISOString(),
      manual,
      ok: null,
    };
    // Claim before running: if the Pi restarts mid-step, the step isn't repeated.
    this.store.runs.push(record);
    this.store.saveRuns();
    const a = entry.step.action;
    try {
      const fn = this.actions[a.type];
      if (!fn) throw new Error(`no handler for ${a.type}`);
      const detail = await fn(a, { routine: entry.routine, at: entry.step.at });
      record.ok = true;
      if (detail) record.detail = String(detail);
      console.log(`⏰ ${entry.routine.name}: ${describeAction(a)}${detail ? ` (${detail})` : ""}`);
    } catch (e) {
      record.ok = false;
      record.error = e.message;
      console.error(`⚠️  ${entry.routine.name} step ${entry.step.idx} failed: ${e.message}`);
    }
    record.finishedAt = new Date(this.now()).toISOString();
    this.store.saveRuns();
    return record;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const entry of this.dueSteps()) await this.runStep(entry);
      this.pruneOverrides();
    } catch (e) {
      console.error("routines tick:", e.message);
    } finally {
      this.ticking = false;
    }
  }

  /** Run every step of a routine now, in order, ignoring offsets. */
  async runNow(id) {
    const routine = this.getRoutine(id);
    if (!routine) return null;
    const stamp = this.now();
    const results = [];
    for (const [idx, s] of routine.steps.entries()) {
      results.push(
        await this.runStep(
          {
            key: `manual|${routine.id}|${stamp}|${idx}`,
            routine,
            cycleDate: cycleDateOf(stamp, this.geo.tz),
            step: { idx, at: stamp, action: s.action },
          },
          { manual: true },
        ),
      );
    }
    return results;
  }

  /** The current and next cycle, each with its routines in time order. */
  upcoming() {
    const now = this.now();
    const cur = cycleDateOf(now, this.geo.tz);
    const cycles = [cur, addDays(cur, 1)].map((date) => {
      const sun = sunTimes(date, this.geo.lat, this.geo.lon, this.geo.tz);
      const items = this.routines
        .map((r) => this.occurrence(r, date))
        .filter(Boolean)
        .sort((a, b) => a.at - b.at)
        .map((o) => ({
          id: o.routine.id,
          name: o.routine.name,
          enabled: o.routine.enabled,
          at: new Date(o.at).toISOString(),
          time: hmInTz(o.at, this.geo.tz),
          source: o.source,
          skipped: o.skipped,
          override: o.override,
          past: o.steps.every((s) => s.at <= now),
          steps: o.steps.map((s) => ({
            idx: s.idx,
            at: new Date(s.at).toISOString(),
            time: hmInTz(s.at, this.geo.tz),
            type: s.action.type,
            power: s.action.power ?? null,
            summary: s.summary,
            run: s.run,
          })),
        }));
      return {
        date,
        start: new Date(cycleTimeToUtc(date, "04:00", this.geo.tz)).toISOString(),
        sunrise: sun.sunrise ? hmInTz(sun.sunrise, this.geo.tz) : null,
        sunset: sun.sunset ? hmInTz(sun.sunset, this.geo.tz) : null,
        routines: items,
      };
    });
    let next = null;
    for (const c of cycles) {
      const r = c.routines.find((x) => x.enabled && !x.skipped && Date.parse(x.at) > now);
      if (r) {
        next = { id: r.id, cycleDate: c.date, at: r.at };
        break;
      }
    }
    return { now: new Date(now).toISOString(), tz: this.geo.tz, cycleDate: cur, next, cycles };
  }

  /**
   * The next scheduled lights step for each light (`{ id, room, power? }`), from
   * now through the end of the next cycle. With `power` known, steps that won't
   * touch the light as it is now are passed over: dimming or turning off skips a
   * light that is off, and `onlyIfOff` skips one that is on.
   */
  nextForLights(lights) {
    const now = this.now();
    const cur = cycleDateOf(now, this.geo.tz);
    const steps = [];
    for (const cd of [cur, addDays(cur, 1)]) {
      for (const routine of this.routines) {
        if (!routine.enabled) continue;
        const occ = this.occurrence(routine, cd);
        if (!occ || occ.skipped) continue;
        for (const s of occ.steps) {
          if (s.action.type === "lights" && s.at > now) steps.push({ routine, s });
        }
      }
    }
    steps.sort((a, b) => a.s.at - b.s.at);
    const out = {};
    for (const light of lights) {
      const hit = steps.find(({ s }) => {
        const a = s.action;
        if (!targetsLight(a.targets, light)) return false;
        if (light.power === "off" && a.power !== "on") return false;
        if (light.power === "on" && a.onlyIfOff) return false;
        return true;
      });
      if (!hit) continue;
      const a = hit.s.action;
      out[light.id] = {
        at: new Date(hit.s.at).toISOString(),
        time: hmInTz(hit.s.at, this.geo.tz),
        routineId: hit.routine.id,
        routineName: hit.routine.name,
        power: a.power ?? null,
        brightness: a.brightness ?? null,
        kelvin: a.kelvin ?? null,
        onlyIfOff: Boolean(a.onlyIfOff),
        summary: describeAction(a),
      };
    }
    return out;
  }

  /** Create or replace a routine. Returns `{ ok, routine }` or `{ ok: false, error }`. */
  saveRoutine(input) {
    const err = validateRoutine(input);
    if (err) return { ok: false, error: err };
    const routine = cleanRoutine({ ...input, updatedAt: new Date(this.now()).toISOString() });
    const idx = this.store.routines.findIndex((r) => r.id === routine.id);
    if (idx === -1) this.store.routines.push(routine);
    else this.store.routines[idx] = routine;
    this.store.saveRoutines();
    return { ok: true, routine };
  }

  deleteRoutine(id) {
    const idx = this.store.routines.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this.store.routines.splice(idx, 1);
    this.store.saveRoutines();
    return true;
  }

  /**
   * One-off change for one cycle: `{ skip: true }` or `{ time: "HH:MM" }`.
   * Only the current cycle and the next seven can be changed.
   */
  setOverride(id, cycleDate, input) {
    if (!this.getRoutine(id)) return { ok: false, status: 404, error: "Unknown routine" };
    if (!YMD_RE.test(cycleDate)) return { ok: false, status: 400, error: "cycle date is YYYY-MM-DD" };
    const cur = cycleDateOf(this.now(), this.geo.tz);
    if (cycleDate < cur || cycleDate > addDays(cur, 7)) {
      return { ok: false, status: 400, error: "only the current cycle and the next 7 can be changed" };
    }
    let ov;
    if (input?.skip === true) ov = { skip: true };
    else if (parseHm(input?.time) !== null) ov = { time: input.time };
    else return { ok: false, status: 400, error: "send { skip: true } or { time: \"HH:MM\" }" };
    ov.setAt = new Date(this.now()).toISOString();
    this.store.overrides[cycleDate] = { ...this.store.overrides[cycleDate], [id]: ov };
    this.store.saveOverrides();
    return { ok: true, override: ov };
  }

  clearOverride(id, cycleDate) {
    const day = this.store.overrides[cycleDate];
    if (!day?.[id]) return false;
    delete day[id];
    if (Object.keys(day).length === 0) delete this.store.overrides[cycleDate];
    this.store.saveOverrides();
    return true;
  }

  pruneOverrides() {
    const keep = addDays(cycleDateOf(this.now(), this.geo.tz), -1);
    const stale = Object.keys(this.store.overrides).filter((d) => d < keep);
    if (stale.length === 0) return;
    for (const d of stale) delete this.store.overrides[d];
    this.store.saveOverrides();
  }
}

module.exports = {
  DEFAULT_ROUTINES,
  CYCLE_START_MIN,
  CATCH_UP_MS,
  validateRoutine,
  cleanRoutine,
  cycleDateOf,
  cycleTimeToUtc,
  resolveAnchor,
  describeAction,
  targetsLight,
  runKey,
  RoutineStore,
  RoutineEngine,
};
