const { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } = require("fs");
const { join } = require("path");

const TZ = "America/New_York";

/** Cap wall-clock resolution cache (hot: noon probe per calendar day). */
const UTC_WALL_CACHE_MAX = 2500;
const utcWallCache = new Map();

function weekdayLong(date, tz) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: tz,
  })
    .format(date)
    .toLowerCase();
}

function ymdInTz(date, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Wall-clock parts for instant `ms` in `tz`. */
function wallParts(ms, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    h: parseInt(parts.hour, 10),
    m: parseInt(parts.minute, 10),
  };
}

function wallTargetCompare(p, ymd, hh, mm) {
  if (p.ymd !== ymd) return p.ymd < ymd ? -1 : 1;
  if (p.h !== hh) return p.h < hh ? -1 : p.h > hh ? 1 : 0;
  if (p.m !== mm) return p.m < mm ? -1 : p.m > mm ? 1 : 0;
  return 0;
}

function utcWallCacheSet(key, val) {
  utcWallCache.set(key, val);
  while (utcWallCache.size > UTC_WALL_CACHE_MAX) {
    const first = utcWallCache.keys().next().value;
    utcWallCache.delete(first);
  }
}

/**
 * Find UTC ms where local wall clock in `tz` equals ymd + hh:mm.
 * Binary search on UTC range, then minute scan on the last interval (DST-safe fallback).
 */
function utcForWallClock(ymd, hh, mm, tz) {
  const key = `${tz}\t${ymd}\t${hh}\t${mm}`;
  if (utcWallCache.has(key)) return utcWallCache.get(key);

  const [Y, Mo, Da] = ymd.split("-").map(Number);
  const anchor = Date.UTC(Y, Mo - 1, Da, 10, 0, 0);
  let lo = anchor - 16 * 3600000;
  let hi = anchor + 40 * 3600000;
  while (hi - lo > 120000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const cmp = wallTargetCompare(wallParts(mid, tz), ymd, hh, mm);
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  for (let t = lo; t <= hi; t += 60_000) {
    const p = wallParts(t, tz);
    if (p.ymd === ymd && p.h === hh && p.m === mm) {
      utcWallCacheSet(key, t);
      return t;
    }
  }
  for (let add = 0; add < 48 * 60; add++) {
    const ms = anchor + add * 60_000;
    const p = wallParts(ms, tz);
    if (p.ymd === ymd && p.h === hh && p.m === mm) {
      utcWallCacheSet(key, ms);
      return ms;
    }
  }
  utcWallCacheSet(key, anchor);
  return anchor;
}

function addOneCalendarDayYmd(ymd, tz) {
  const noon = utcForWallClock(ymd, 12, 0, tz);
  return ymdInTz(new Date(noon + 36 * 60 * 60 * 1000), tz);
}

function choreDurationSeconds(chore) {
  if (typeof chore.durationSeconds === "number") return chore.durationSeconds;
  if (typeof chore.durationMinutes === "number") return chore.durationMinutes * 60;
  return 0;
}

function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, filePath);
}

class ChoresManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.choresPath = join(dataDir, "chores.json");
    this.statePath = join(dataDir, "chores-state.json");
    this.bakPath = join(dataDir, "chores-state.bak.json");
    /** @type {any[]} */
    this.chores = [];
    /** @type {{ completions: Record<string, { count: number, lastCompletedAt: string | null }>, reminderFires: number, lastReminderFireAt?: string | null }} */
    this.state = { completions: {}, reminderFires: 0, lastReminderFireAt: null };
  }

  reload() {
    const rawChores = JSON.parse(readFileSync(this.choresPath, "utf8"));
    let dirtyChores = false;
    this.chores = (rawChores.chores || []).map((c) => {
      const copy = { ...c };
      if (!copy.createdAt) {
        copy.createdAt = new Date().toISOString();
        dirtyChores = true;
      }
      return copy;
    });
    if (dirtyChores) {
      atomicWriteJson(this.choresPath, { chores: this.chores });
    }

    if (!existsSync(this.statePath)) {
      this.state = { completions: {}, reminderFires: 0, lastReminderFireAt: null };
      atomicWriteJson(this.statePath, this.state);
    } else {
      this.state = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (!this.state.completions || typeof this.state.completions !== "object") {
        this.state.completions = {};
      }
      if (typeof this.state.reminderFires !== "number") {
        this.state.reminderFires = 0;
      }
    }
  }

  backupState() {
    if (existsSync(this.statePath)) {
      copyFileSync(this.statePath, this.bakPath);
    }
  }

  writeState() {
    atomicWriteJson(this.statePath, this.state);
  }

  /** Incremented by RemindersScheduler after each reminder speaks. */
  onReminderFired(now = new Date()) {
    this.state.reminderFires = (this.state.reminderFires || 0) + 1;
    this.state.lastReminderFireAt = now.toISOString();
    this.writeState();
  }

  completionRecord(choreId) {
    const r = this.state.completions[choreId];
    if (!r) return { count: 0, lastCompletedAt: null };
    return { count: r.count || 0, lastCompletedAt: r.lastCompletedAt || null };
  }

  /**
   * One calendar walk for slot chores: slots expected through now, last active, next activation.
   * Past days are only scanned through local `ymd(now)` (same work as old created→now range).
   * Future horizon matches `_collectActivationsInRange(chore, now+1s, now+400d)`.
   */
  _slotPass(chore, nowMs) {
    if (chore.schedule === "every-reminder") {
      return null;
    }
    const createdMs = new Date(chore.createdAt).getTime();
    const horizonMs = nowMs + 400 * 86400000;
    const futureThreshold = nowMs + 1000;
    const futureFloor = Math.max(createdMs, futureThreshold);

    let countToNow = 0;
    let lastPastTs = null;
    let firstFutureTs = null;

    const processDay = (ymd) => {
      const noonMs = utcForWallClock(ymd, 12, 0, TZ);
      const wd = weekdayLong(new Date(noonMs), TZ);
      const instants = [];
      for (const line of chore.schedule) {
        const days = (line.days || []).map((d) => String(d).toLowerCase());
        if (!days.includes(wd)) continue;
        const [hh, mm] = String(line.time || "0:0").split(":").map(Number);
        const inst = utcForWallClock(ymd, hh, mm, TZ);
        if (inst >= createdMs && inst <= horizonMs) {
          instants.push(inst);
        }
      }
      instants.sort((a, b) => a - b);
      for (const inst of instants) {
        if (inst <= nowMs) {
          countToNow += 1;
          lastPastTs = inst;
        } else if (inst >= futureFloor) {
          if (firstFutureTs === null || inst < firstFutureTs) {
            firstFutureTs = inst;
          }
        }
      }
    };

    const ymdStart = ymdInTz(new Date(Math.max(createdMs, 0)), TZ);
    const ymdNow = ymdInTz(new Date(nowMs), TZ);
    const horizonYmd = ymdInTz(new Date(horizonMs), TZ);

    let ymd = ymdStart;
    let guard = 0;
    const beforeChore = nowMs < createdMs;

    if (ymdStart <= ymdNow) {
      while (guard++ < 800 && ymd <= ymdNow) {
        processDay(ymd);
        ymd = addOneCalendarDayYmd(ymd, TZ);
      }
    }

    if (firstFutureTs === null) {
      if (ymdStart > ymdNow) {
        ymd = ymdStart;
      }
      while (guard++ < 800 && ymd <= horizonYmd && firstFutureTs === null) {
        processDay(ymd);
        ymd = addOneCalendarDayYmd(ymd, TZ);
      }
    }

    if (beforeChore) {
      return { countToNow: 0, lastPastTs: null, firstFutureTs, createdMs };
    }

    return { countToNow, lastPastTs, firstFutureTs, createdMs };
  }

  _deriveChoreRow(chore, nowMs) {
    const { count, lastCompletedAt } = this.completionRecord(chore.id);

    if (chore.schedule === "every-reminder") {
      const slotsExpected = this.state.reminderFires || 0;
      const missed = Math.max(0, slotsExpected - count);
      let pending = missed >= 1;
      if (!pending) {
        if (!lastCompletedAt) pending = true;
        else {
          const age = nowMs - new Date(lastCompletedAt).getTime();
          pending = age > 30 * 60 * 1000;
        }
      }
      return {
        missed,
        pending,
        lastCompletedAt,
        completionCount: count,
        activeSlot: null,
        nextSlot: null,
      };
    }

    const pass = this._slotPass(chore, nowMs);
    if (!pass) {
      return {
        missed: 0,
        pending: false,
        lastCompletedAt,
        completionCount: count,
        activeSlot: null,
        nextSlot: null,
      };
    }

    const missed = Math.max(0, pass.countToNow - count);
    const pending = missed >= 1;
    const activeSlot =
      pass.lastPastTs != null ? new Date(pass.lastPastTs).toISOString() : null;
    const nextSlot =
      pass.firstFutureTs != null ? new Date(pass.firstFutureTs).toISOString() : null;

    return {
      missed,
      pending,
      lastCompletedAt,
      completionCount: count,
      activeSlot,
      nextSlot,
    };
  }

  slotsExpected(chore, now = new Date()) {
    if (chore.schedule === "every-reminder") {
      return this.state.reminderFires || 0;
    }
    const nowMs = now.getTime();
    const createdMs = new Date(chore.createdAt).getTime();
    if (nowMs < createdMs) return 0;
    const pass = this._slotPass(chore, nowMs);
    return pass ? pass.countToNow : 0;
  }

  missedCount(chore, now = new Date()) {
    return this._deriveChoreRow(chore, now.getTime()).missed;
  }

  _pendingSlotOrEveryReminder(chore, now = new Date()) {
    return this._deriveChoreRow(chore, now.getTime()).pending;
  }

  pending(now = new Date()) {
    const nowMs = now.getTime();
    return this.chores.filter((c) => this._deriveChoreRow(c, nowMs).pending);
  }

  listWithStatus(now = new Date()) {
    const nowMs = now.getTime();
    return this.chores.map((c) => {
      const row = this._deriveChoreRow(c, nowMs);
      return {
        ...c,
        missed: row.missed,
        pending: row.pending,
        lastCompletedAt: row.lastCompletedAt,
        completionCount: row.completionCount,
        activeSlot: row.activeSlot,
        nextSlot: row.nextSlot,
      };
    });
  }

  buildChoresSummary(now = new Date()) {
    const nowMs = now.getTime();
    let sec = 0;
    for (const c of this.chores) {
      const row = this._deriveChoreRow(c, nowMs);
      if (!row.pending) continue;
      sec += choreDurationSeconds(c) * Math.max(1, row.missed);
    }
    if (sec === 0) return "";
    const mins = Math.max(1, Math.round(sec / 60));
    const done = new Date(nowMs + sec * 1000);
    const endStr = done.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: TZ,
    });
    return `These tasks take about ${mins} minute${mins === 1 ? "" : "s"}. If you start now, you'll be done by ${endStr}. `;
  }

  pendingSummaryShort(now = new Date()) {
    const nowMs = now.getTime();
    let n = 0;
    for (const c of this.chores) {
      const row = this._deriveChoreRow(c, nowMs);
      if (!row.pending) continue;
      n += Math.max(1, row.missed);
    }
    if (n === 0) return null;
    return `You have ${n} pending chore${n === 1 ? "" : "s"}. `;
  }

  complete(choreId, now = new Date()) {
    const chore = this.chores.find((c) => c.id === choreId);
    if (!chore) return { ok: false, error: "not_found" };
    const cur = this.completionRecord(choreId);
    const next = {
      count: cur.count + 1,
      lastCompletedAt: now.toISOString(),
    };
    this.state.completions[choreId] = next;
    this.writeState();
    return { ok: true, choreId, completedAt: next.lastCompletedAt };
  }

  uncomplete(choreId) {
    const chore = this.chores.find((c) => c.id === choreId);
    if (!chore) return { ok: false, error: "not_found" };
    const cur = this.completionRecord(choreId);
    const nextCount = Math.max(0, cur.count - 1);
    if (nextCount === 0) {
      delete this.state.completions[choreId];
    } else {
      this.state.completions[choreId] = {
        count: nextCount,
        lastCompletedAt: null,
      };
    }
    this.writeState();
    return { ok: true, choreId };
  }
}

module.exports = { ChoresManager, choreDurationSeconds, TZ };
