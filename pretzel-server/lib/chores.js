const { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } = require("fs");
const { join } = require("path");

const TZ = "America/New_York";

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

/**
 * Find UTC ms where local wall clock in `tz` equals ymd + hh:mm (minute scan).
 */
function utcForWallClock(ymd, hh, mm, tz) {
  const [Y, Mo, Da] = ymd.split("-").map(Number);
  let anchor = Date.UTC(Y, Mo - 1, Da, 10, 0, 0);
  for (let add = 0; add < 48 * 60; add++) {
    const ms = anchor + add * 60_000;
    const p = wallParts(ms, tz);
    if (p.ymd === ymd && p.h === hh && p.m === mm) return ms;
  }
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

  slotsExpected(chore, now = new Date()) {
    if (chore.schedule === "every-reminder") {
      return this.state.reminderFires || 0;
    }
    const createdMs = new Date(chore.createdAt).getTime();
    const nowMs = now.getTime();
    if (nowMs < createdMs) return 0;
    return this._countSlotActivationsBetween(chore, createdMs, nowMs);
  }

  missedCount(chore, now = new Date()) {
    const expected = this.slotsExpected(chore, now);
    const { count } = this.completionRecord(chore.id);
    return Math.max(0, expected - count);
  }

  _collectActivationsInRange(chore, fromMs, toMs) {
    if (chore.schedule === "every-reminder") return [];
    const createdMs = new Date(chore.createdAt).getTime();
    const start = Math.max(fromMs, createdMs);
    if (toMs < start) return [];
    const out = [];
    let ymd = ymdInTz(new Date(start), TZ);
    const endYmd = ymdInTz(new Date(toMs), TZ);
    let guard = 0;
    while (guard++ < 800 && ymd <= endYmd) {
      const wd = weekdayLong(new Date(utcForWallClock(ymd, 12, 0, TZ)), TZ);
      for (const line of chore.schedule) {
        const days = (line.days || []).map((d) => String(d).toLowerCase());
        if (!days.includes(wd)) continue;
        const [hh, mm] = String(line.time || "0:0").split(":").map(Number);
        const inst = utcForWallClock(ymd, hh, mm, TZ);
        if (inst >= createdMs && inst >= fromMs && inst <= toMs) {
          out.push(inst);
        }
      }
      ymd = addOneCalendarDayYmd(ymd, TZ);
    }
    return out.sort((a, b) => a - b);
  }

  _countSlotActivationsBetween(chore, fromMs, toMs) {
    return this._collectActivationsInRange(chore, fromMs, toMs).length;
  }

  _activeAndNextSlot(chore, now = new Date()) {
    if (chore.schedule === "every-reminder") {
      return { activeSlot: null, nextSlot: null };
    }
    const nowMs = now.getTime();
    const createdMs = new Date(chore.createdAt).getTime();
    const past = this._collectActivationsInRange(chore, createdMs, nowMs);
    const future = this._collectActivationsInRange(
      chore,
      nowMs + 1000,
      nowMs + 400 * 86400000,
    );
    const activeSlot =
      past.length > 0 ? new Date(past[past.length - 1]).toISOString() : null;
    const nextSlot =
      future.length > 0 ? new Date(future[0]).toISOString() : null;
    return { activeSlot, nextSlot };
  }

  _pendingSlotOrEveryReminder(chore, now = new Date()) {
    const missed = this.missedCount(chore, now);
    if (chore.schedule === "every-reminder") {
      if (missed >= 1) return true;
      const { lastCompletedAt } = this.completionRecord(chore.id);
      if (!lastCompletedAt) return true;
      const age = now.getTime() - new Date(lastCompletedAt).getTime();
      return age > 30 * 60 * 1000;
    }
    return missed >= 1;
  }

  pending(now = new Date()) {
    return this.chores.filter((c) => this._pendingSlotOrEveryReminder(c, now));
  }

  listWithStatus(now = new Date()) {
    return this.chores.map((c) => {
      const { count, lastCompletedAt } = this.completionRecord(c.id);
      const missed = this.missedCount(c, now);
      const { activeSlot, nextSlot } = this._activeAndNextSlot(c, now);
      const pending = this._pendingSlotOrEveryReminder(c, now);
      return {
        ...c,
        missed,
        pending,
        lastCompletedAt,
        completionCount: count,
        activeSlot,
        nextSlot,
      };
    });
  }

  buildChoresSummary(now = new Date()) {
    const pending = this.pending(now);
    if (pending.length === 0) return "";
    let sec = 0;
    for (const c of pending) {
      sec += choreDurationSeconds(c) * Math.max(1, this.missedCount(c, now));
    }
    const mins = Math.max(1, Math.round(sec / 60));
    const done = new Date(now.getTime() + sec * 1000);
    const endStr = done.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: TZ,
    });
    return `These tasks take about ${mins} minute${mins === 1 ? "" : "s"}. If you start now, you'll be done by ${endStr}. `;
  }

  pendingSummaryShort(now = new Date()) {
    const pending = this.pending(now);
    if (pending.length === 0) return null;
    const n = pending.reduce((acc, c) => acc + Math.max(1, this.missedCount(c, now)), 0);
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
