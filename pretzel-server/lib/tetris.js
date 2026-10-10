"use strict";

const { randomBytes, randomUUID } = require("crypto");

const MAX_NAME = 20;
const FORFEIT_REASONS = new Set(["left the game", "disconnected", "tab hidden"]);

function cleanName(raw) {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f<>]/g, "").trim() : "";
  return s.slice(0, MAX_NAME);
}

/**
 * Match-maker and referee for 2-player versus Tetris. Each browser runs its
 * own game from a shared seed; the server only seats players, issues the
 * seed, decides the winner (first top-out loses) and tells index.js where to
 * relay garbage. Nothing is persisted: a restart drops the current match.
 */
class TetrisManager {
  /**
   * @param {{ now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout,
   *           countdownMs?: number, graceMs?: number, newSeed?: () => number }} [opts]
   */
  constructor({
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    countdownMs = 3000,
    graceMs = 5000,
    newSeed = () => randomBytes(4).readUInt32LE(0),
  } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.countdownMs = countdownMs;
    this.graceMs = graceMs;
    this.newSeed = newSeed;
    this.listeners = new Set();
    /** @type {({ clientId: string, name: string, connected: boolean, ready: boolean } | null)[]} */
    this.seats = [null, null];
    this.status = "waiting"; // waiting | countdown | active | over
    this.matchId = null;
    this.seed = null;
    this.startsAt = null;
    this.winner = null;
    this.reason = null;
    /** Names as they were when the match started (a seat may empty before the result is read). */
    this.matchNames = null;
    /** Client ids seated when the current/last match started. */
    this.matchClients = null;
    this.countdownTimer = null;
    this.graceTimers = [null, null];
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        console.error("tetris listener error:", e.message);
      }
    }
  }

  seatOf(clientId) {
    if (!clientId) return null;
    const i = this.seats.findIndex((s) => s && s.clientId === clientId);
    return i === -1 ? null : i;
  }

  _inMatch() {
    return this.status === "countdown" || this.status === "active";
  }

  snapshot(clientId) {
    return {
      status: this.status,
      matchId: this.matchId,
      seed: this.seed,
      startsAt: this.startsAt,
      serverNow: this.now(),
      winner: this.winner,
      reason: this.reason,
      matchNames: this.matchNames,
      /** Whether this client played the current/last match (newcomers don't see its result). */
      playedLast: !!clientId && !!this.matchClients && this.matchClients.includes(clientId),
      players: this.seats.map((s) => (s ? { name: s.name, connected: s.connected, ready: s.ready } : null)),
      you: this.seatOf(clientId),
    };
  }

  // ── seating ────────────────────────────────────────────────────
  join({ clientId, name }) {
    const clean = cleanName(name);
    const mine = this.seatOf(clientId);
    if (mine !== null) {
      if (clean) this.seats[mine].name = clean;
      this._emit();
      return { ok: true };
    }
    if (this._inMatch()) return { ok: false, error: "A match is in progress" };
    const free = this.seats.indexOf(null);
    if (free === -1) return { ok: false, error: "Both seats are taken" };
    this.seats[free] = { clientId, name: clean || `Player ${free + 1}`, connected: true, ready: true };
    this._maybeStart();
    this._emit();
    return { ok: true };
  }

  leave({ clientId }) {
    const s = this.seatOf(clientId);
    if (s === null) return { ok: false, error: "You are not seated" };
    if (this._inMatch()) this._finish(1 - s, "left the game");
    this._freeSeat(s);
    this._emit();
    return { ok: true };
  }

  /** Rematch handshake: both seated players must be ready. */
  ready({ clientId }) {
    const s = this.seatOf(clientId);
    if (s === null) return { ok: false, error: "You are not seated" };
    if (this._inMatch()) return { ok: false, error: "A match is in progress" };
    this.seats[s].ready = true;
    this._maybeStart();
    this._emit();
    return { ok: true };
  }

  setConnected(clientId, connected) {
    const s = this.seatOf(clientId);
    if (s === null) return;
    this.seats[s].connected = connected;
    this._clearGrace(s);
    if (!connected) {
      this.graceTimers[s] = this.setTimer(() => {
        this.graceTimers[s] = null;
        const seat = this.seats[s];
        if (!seat || seat.clientId !== clientId || seat.connected) return;
        if (this._inMatch()) this._finish(1 - s, "disconnected");
        this._freeSeat(s);
        this._emit();
      }, this.graceMs);
    }
    this._emit();
  }

  /** Empty a seat; once nobody from a finished match is left, the lobby starts fresh. */
  _freeSeat(s) {
    this._clearGrace(s);
    this.seats[s] = null;
    const stillHere = this.seats.some((x) => x && this.matchClients && this.matchClients.includes(x.clientId));
    if (this.status === "over" && !stillHere) this._reset();
  }

  _reset() {
    this.status = "waiting";
    this.matchId = null;
    this.seed = null;
    this.startsAt = null;
    this.winner = null;
    this.reason = null;
    this.matchNames = null;
    this.matchClients = null;
    // A newcomer who sat down while the old result was showing is ready to play.
    for (const x of this.seats) if (x) x.ready = true;
    this._maybeStart();
  }

  _clearGrace(s) {
    if (this.graceTimers[s]) this.clearTimer(this.graceTimers[s]);
    this.graceTimers[s] = null;
  }

  // ── match lifecycle ────────────────────────────────────────────
  _maybeStart() {
    if (this._inMatch()) return;
    if (this.seats.every((s) => s && s.ready)) this._start();
  }

  _start() {
    this.matchId = randomUUID().slice(0, 8);
    this.seed = this.newSeed() >>> 0;
    this.status = "countdown";
    this.startsAt = this.now() + this.countdownMs;
    this.winner = null;
    this.reason = null;
    this.matchNames = this.seats.map((s) => s.name);
    this.matchClients = this.seats.map((s) => s.clientId);
    if (this.countdownTimer) this.clearTimer(this.countdownTimer);
    this.countdownTimer = this.setTimer(() => {
      this.countdownTimer = null;
      if (this.status !== "countdown") return;
      this.status = "active";
      this._emit();
    }, this.countdownMs);
  }

  _finish(winnerSeat, reason) {
    if (this.countdownTimer) this.clearTimer(this.countdownTimer);
    this.countdownTimer = null;
    this.status = "over";
    this.winner = winnerSeat;
    this.reason = reason;
    for (const s of this.seats) if (s) s.ready = false;
  }

  _matchSeat(clientId, matchId) {
    const s = this.seatOf(clientId);
    if (s === null || !this.matchId || matchId !== this.matchId) return null;
    if (!this.matchClients || !this.matchClients.includes(clientId)) return null;
    return s;
  }

  /** First valid top-out ends the match; later ones (or stale matchIds) are ignored. */
  topOut({ clientId, matchId }) {
    const s = this._matchSeat(clientId, matchId);
    if (s === null || this.status !== "active") return { ok: false, error: "Not in this match" };
    this._finish(1 - s, "topped out");
    this._emit();
    return { ok: true };
  }

  forfeit({ clientId, matchId, reason }) {
    const s = this._matchSeat(clientId, matchId);
    if (s === null || !this._inMatch()) return { ok: false, error: "Not in this match" };
    this._finish(1 - s, FORFEIT_REASONS.has(reason) ? reason : "left the game");
    this._emit();
    return { ok: true };
  }

  /** @returns {{ ok: true, toClientId: string } | { ok: false, error: string }} */
  attack({ clientId, matchId, lines }) {
    const s = this._matchSeat(clientId, matchId);
    if (s === null || this.status !== "active") return { ok: false, error: "Not in this match" };
    if (!Number.isInteger(lines) || lines < 1 || lines > 10) return { ok: false, error: "Bad garbage count" };
    const opp = this.seats[1 - s];
    if (!opp) return { ok: false, error: "No opponent" };
    return { ok: true, toClientId: opp.clientId };
  }

  /** Board snapshots are relayed for the current match only (including the final board). */
  boardSeat({ clientId, matchId }) {
    return this._matchSeat(clientId, matchId);
  }
}

module.exports = { TetrisManager };
