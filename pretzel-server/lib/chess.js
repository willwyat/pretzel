"use strict";

const { Chess } = require("chess.js");
const { randomUUID } = require("crypto");
const { readFileSync, writeFileSync, renameSync, existsSync } = require("fs");
const { join } = require("path");

/** Time control presets: base + increment (0/0 = untimed). */
const TIME_CONTROLS = {
  untimed: { id: "untimed", label: "Untimed", baseMs: 0, incMs: 0 },
  "5+0": { id: "5+0", label: "5 min", baseMs: 300_000, incMs: 0 },
  "10+0": { id: "10+0", label: "10 min", baseMs: 600_000, incMs: 0 },
  "15+10": { id: "15+10", label: "15 | 10", baseMs: 900_000, incMs: 10_000 },
};

const MAX_NAME = 20;
const MAX_ARCHIVE = 200;
/** A game in progress whose players have all been offline this long may be cleared by anyone. */
const ABANDON_MS = 10 * 60_000;
const SQUARE = /^[a-h][1-8]$/;
const PROMOTIONS = new Set(["q", "r", "b", "n"]);
const COLORS = ["white", "black"];

function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, filePath);
}

function readJson(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`chess: could not read ${filePath}:`, e.message);
    return fallback;
  }
}

function cleanName(raw) {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f<>]/g, "").trim() : "";
  return s.slice(0, MAX_NAME);
}

const other = (color) => (color === "white" ? "black" : "white");
const winFor = (color) => (color === "white" ? "1-0" : "0-1");

/**
 * True when `color` cannot possibly mate (lone king, or king + one minor piece
 * against a lone king). Used to score a flag fall as a draw, per FIDE 6.9.
 */
function cannotMate(chess, color) {
  const c = color === "white" ? "w" : "b";
  const mine = [];
  const theirs = [];
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq || sq.type === "k") continue;
      (sq.color === c ? mine : theirs).push(sq.type);
    }
  }
  if (mine.length === 0) return true;
  return mine.length === 1 && (mine[0] === "b" || mine[0] === "n") && theirs.length === 0;
}

/**
 * Authoritative chess referee. One live game, two seats, any number of
 * spectators. Rules come from chess.js; clocks are server-side (remaining ms
 * plus the timestamp the running clock started), clients only render them.
 *
 * Every action returns `{ ok: true }` or `{ ok: false, error }` and notifies
 * subscribers on success, so the socket layer just broadcasts snapshots.
 */
class ChessManager {
  /** @param {{ dataDir: string, now?: () => number }} opts */
  constructor({ dataDir, now = Date.now }) {
    this.now = now;
    this.statePath = join(dataDir, "chess-state.json");
    this.gamesPath = join(dataDir, "chess-games.json");
    this.listeners = new Set();
    this.flagTimer = null;
    this.game = null;
    this.chess = new Chess();
    this._load();
  }

  // ── persistence ────────────────────────────────────────────────
  _load() {
    const saved = readJson(this.statePath, null);
    if (saved && Array.isArray(saved.moves) && saved.players) {
      try {
        const chess = new Chess();
        for (const m of saved.moves) chess.move(m.san);
        this.chess = chess;
        this.game = saved;
        const t = this.now();
        // Nobody is connected right after a restart.
        for (const c of COLORS) {
          const p = saved.players[c];
          if (p) Object.assign(p, { connected: false, lastSeenAt: t });
        }
        // Time spent while the Pi was down is not charged to the player on move.
        if (saved.clockStartedAt != null) saved.clockStartedAt = t;
        this._armFlagTimer();
        return;
      } catch (e) {
        console.error("chess: saved game invalid, starting fresh:", e.message);
      }
    }
    this._fresh({});
  }

  _save() {
    try {
      atomicWriteJson(this.statePath, this.game);
    } catch (e) {
      console.error("chess: save failed:", e.message);
    }
  }

  _fresh({ white = null, black = null, timeControl = "untimed" }) {
    clearTimeout(this.flagTimer);
    this.chess = new Chess();
    const tc = TIME_CONTROLS[timeControl] || TIME_CONTROLS.untimed;
    this.game = {
      id: randomUUID(),
      players: { white, black },
      timeControl: tc.id,
      clocks: { white: tc.baseMs, black: tc.baseMs },
      /** ms timestamp when the side to move's clock started running; null = stopped */
      clockStartedAt: null,
      moves: [],
      /** color that offered a draw, or null */
      drawOffer: null,
      status: "waiting", // waiting | active | over
      result: null, // "1-0" | "0-1" | "1/2-1/2" | "*"
      reason: null,
      startedAt: null,
      endedAt: null,
      createdAt: this.now(),
    };
    this._refreshStatus();
    this._save();
  }

  // ── subscriptions ──────────────────────────────────────────────
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        console.error("chess listener error:", e.message);
      }
    }
  }

  /** Persist + broadcast after a successful action. */
  _commit() {
    this._save();
    this._emit();
    return { ok: true };
  }

  // ── helpers ────────────────────────────────────────────────────
  _colorOf(clientId) {
    const p = this.game.players;
    if (p.white && p.white.clientId === clientId) return "white";
    if (p.black && p.black.clientId === clientId) return "black";
    return null;
  }

  _turn() {
    return this.chess.turn() === "w" ? "white" : "black";
  }

  _tc() {
    return TIME_CONTROLS[this.game.timeControl] || TIME_CONTROLS.untimed;
  }

  /** No moves played yet, or the game is finished: seats and settings may change. */
  _betweenGames() {
    return this.game.moves.length === 0 || this.game.status === "over";
  }

  _inProgress() {
    return this.game.status === "active" && this.game.moves.length > 0;
  }

  /** Before the first move, a seat is open if empty or its holder went offline. */
  _seatOpen(color) {
    const p = this.game.players[color];
    return !p || !p.connected;
  }

  _abandoned() {
    if (!this._inProgress()) return false;
    const t = this.now();
    return COLORS.every((c) => {
      const p = this.game.players[c];
      return !p || (!p.connected && t - (p.lastSeenAt || 0) >= ABANDON_MS);
    });
  }

  _refreshStatus() {
    const g = this.game;
    if (g.status === "over") return;
    g.status = g.players.white && g.players.black ? "active" : "waiting";
  }

  /** Remaining ms for each side as of now (running clock deducted). */
  clocksNow() {
    const g = this.game;
    const c = { ...g.clocks };
    if (g.status === "active" && g.clockStartedAt != null) {
      const side = this._turn();
      c[side] = Math.max(0, c[side] - (this.now() - g.clockStartedAt));
    }
    return c;
  }

  _armFlagTimer() {
    clearTimeout(this.flagTimer);
    this.flagTimer = null;
    const g = this.game;
    if (g.status !== "active" || g.clockStartedAt == null) return;
    const left = this.clocksNow()[this._turn()];
    this.flagTimer = setTimeout(() => {
      if (this._checkFlag()) this._emit();
    }, left + 20);
    this.flagTimer.unref?.();
  }

  /** Ends the game if the running clock has hit zero. Returns true if it did. */
  _checkFlag() {
    const g = this.game;
    if (g.status !== "active" || g.clockStartedAt == null) return false;
    const side = this._turn();
    if (this.clocksNow()[side] > 0) {
      this._armFlagTimer();
      return false;
    }
    if (cannotMate(this.chess, other(side))) {
      this._finish("1/2-1/2", "timeout vs insufficient material");
    } else {
      this._finish(winFor(other(side)), "timeout");
    }
    return true;
  }

  _finish(result, reason) {
    const g = this.game;
    if (g.status === "over") return;
    g.clocks = this.clocksNow();
    g.clockStartedAt = null;
    clearTimeout(this.flagTimer);
    g.status = "over";
    g.result = result;
    g.reason = reason;
    g.drawOffer = null;
    g.endedAt = this.now();
    this._archive();
    this._save();
  }

  _archive() {
    const g = this.game;
    if (g.moves.length === 0) return; // nothing worth recording
    const games = readJson(this.gamesPath, []);
    const p = g.players;
    games.push({
      id: g.id,
      white: p.white ? p.white.name : null,
      black: p.black ? p.black.name : null,
      whiteIp: p.white ? p.white.ip : null,
      blackIp: p.black ? p.black.ip : null,
      timeControl: g.timeControl,
      result: g.result,
      reason: g.reason,
      startedAt: g.startedAt,
      endedAt: g.endedAt,
      moves: g.moves,
      pgn: this.pgn(),
    });
    try {
      atomicWriteJson(this.gamesPath, games.slice(-MAX_ARCHIVE));
    } catch (e) {
      console.error("chess: archive failed:", e.message);
    }
  }

  pgn() {
    const g = this.game;
    const date = new Date(g.startedAt || g.createdAt).toISOString().slice(0, 10).replace(/-/g, ".");
    const c = this.chess;
    c.setHeader("Event", "Pretzel casual game");
    c.setHeader("Site", "Pretzel");
    c.setHeader("Date", date);
    c.setHeader("White", (g.players.white && g.players.white.name) || "?");
    c.setHeader("Black", (g.players.black && g.players.black.name) || "?");
    c.setHeader("Result", g.result || "*");
    const tc = this._tc();
    if (tc.baseMs > 0) c.setHeader("TimeControl", `${tc.baseMs / 1000}+${tc.incMs / 1000}`);
    if (g.reason) c.setHeader("Termination", g.reason);
    return c.pgn();
  }

  // ── public queries ─────────────────────────────────────────────
  listGames() {
    return readJson(this.gamesPath, [])
      .map(({ id, white, black, result, reason, timeControl, startedAt, endedAt, moves }) => ({
        id,
        white,
        black,
        result,
        reason,
        timeControl,
        startedAt,
        endedAt,
        moveCount: Array.isArray(moves) ? moves.length : 0,
      }))
      .reverse();
  }

  /** Archived game (without player IPs) plus `fens[i]` = position after i plies, for replay. */
  getGame(id) {
    const g = readJson(this.gamesPath, []).find((x) => x.id === id);
    if (!g) return null;
    const { whiteIp, blackIp, ...pub } = g;
    const c = new Chess();
    const fens = [c.fen()];
    for (const m of g.moves) {
      c.move(m.san);
      fens.push(c.fen());
    }
    return { ...pub, fens };
  }

  /** IP → "Name (White)" for players currently seated; used to label the LAN device list. */
  playerIps() {
    const out = {};
    for (const c of COLORS) {
      const p = this.game.players[c];
      if (p && p.ip) out[p.ip] = `Chess: ${p.name} (${c === "white" ? "White" : "Black"})`;
    }
    return out;
  }

  /**
   * Snapshot for one client. Includes which actions that client may take right
   * now, so the UI never re-implements seat or game-state rules.
   */
  snapshot(clientId) {
    const g = this.game;
    const you = clientId ? this._colorOf(clientId) : null;
    const yourTurn = g.status === "active" && you === this._turn();
    const legalMoves = yourTurn
      ? this.chess.moves({ verbose: true }).map((m) => ({
          from: m.from,
          to: m.to,
          promotion: m.promotion || null,
        }))
      : [];
    const last = g.moves[g.moves.length - 1];
    const seat = (c) => {
      const p = g.players[c];
      return p ? { name: p.name, connected: !!p.connected } : null;
    };
    const live = g.status === "active";
    return {
      id: g.id,
      status: g.status,
      result: g.result,
      reason: g.reason,
      fen: this.chess.fen(),
      turn: this._turn(),
      inCheck: this.chess.inCheck(),
      legalMoves,
      moves: g.moves.map(({ san, from, to, color, at, clock }) => ({ san, from, to, color, at, clock })),
      lastMove: last ? { from: last.from, to: last.to } : null,
      players: { white: seat("white"), black: seat("black") },
      you,
      timeControl: g.timeControl,
      timeControls: Object.values(TIME_CONTROLS),
      clocks: this.clocksNow(),
      clockRunning: live && g.clockStartedAt != null,
      drawOffer: g.drawOffer,
      can: {
        sit: {
          white: !you && g.status !== "over" && g.moves.length === 0 && this._seatOpen("white"),
          black: !you && g.status !== "over" && g.moves.length === 0 && this._seatOpen("black"),
        },
        stand: !!you && this._betweenGames() && g.status !== "over",
        setTimeControl: !!you && g.moves.length === 0 && g.status !== "over",
        resign: !!you && live,
        offerDraw: !!you && live && g.moves.length > 0 && !g.drawOffer,
        newGame: this._canNewGame(you),
      },
    };
  }

  _canNewGame(you) {
    const g = this.game;
    if (g.status === "over") return true; // anyone, so an abandoned finished game never blocks the board
    if (g.moves.length === 0) return !!you; // players may swap colours before starting
    return this._abandoned();
  }

  // ── presence ───────────────────────────────────────────────────
  setConnected(clientId, connected) {
    const color = this._colorOf(clientId);
    if (!color) return;
    const p = this.game.players[color];
    if (p.connected === connected) return;
    p.connected = connected;
    p.lastSeenAt = this.now();
    this._commit();
  }

  // ── actions ────────────────────────────────────────────────────
  sit({ clientId, name, color, ip }) {
    const g = this.game;
    const n = cleanName(name);
    if (!clientId) return { ok: false, error: "clientId required" };
    if (!n) return { ok: false, error: "Enter a name first." };
    const existing = this._colorOf(clientId);
    if (existing) {
      // Re-sitting just renames / refreshes the address.
      Object.assign(g.players[existing], { name: n, ip, connected: true });
      return this._commit();
    }
    if (g.status === "over") return { ok: false, error: "This game is over. Start a new game first." };
    if (g.moves.length > 0) return { ok: false, error: "A game is already in progress." };
    const want = COLORS.includes(color) ? color : null;
    const free = (want ? [want] : COLORS).find((c) => this._seatOpen(c));
    if (!free) return { ok: false, error: want ? `The ${want} seat is taken.` : "Both seats are taken." };
    g.players[free] = { clientId, name: n, ip, connected: true, lastSeenAt: this.now() };
    this._refreshStatus();
    return this._commit();
  }

  stand({ clientId }) {
    const g = this.game;
    const color = this._colorOf(clientId);
    if (!color) return { ok: false, error: "You are not seated." };
    if (!this._betweenGames() || g.status === "over") {
      return { ok: false, error: "Use Resign to leave a game in progress." };
    }
    g.players[color] = null;
    this._refreshStatus();
    return this._commit();
  }

  setTimeControl({ clientId, id }) {
    const g = this.game;
    if (!this._colorOf(clientId)) return { ok: false, error: "Only players can set the clock." };
    if (g.moves.length > 0 || g.status === "over") {
      return { ok: false, error: "The clock can only change before the first move." };
    }
    const tc = typeof id === "string" && Object.hasOwn(TIME_CONTROLS, id) ? TIME_CONTROLS[id] : null;
    if (!tc) return { ok: false, error: "Unknown time control." };
    g.timeControl = tc.id;
    g.clocks = { white: tc.baseMs, black: tc.baseMs };
    return this._commit();
  }

  move({ clientId, from, to, promotion }) {
    const g = this.game;
    if (g.status !== "active") return { ok: false, error: "No game in progress." };
    const color = this._colorOf(clientId);
    if (!color) return { ok: false, error: "You are not a player." };
    if (color !== this._turn()) return { ok: false, error: "Not your turn." };
    if (!SQUARE.test(String(from)) || !SQUARE.test(String(to))) return { ok: false, error: "Illegal move." };
    if (promotion != null && !PROMOTIONS.has(promotion)) return { ok: false, error: "Illegal move." };

    // The flag may have fallen between timer ticks.
    if (this._checkFlag()) {
      this._emit();
      return { ok: false, error: "Time is up." };
    }

    let m;
    try {
      m = this.chess.move({ from, to, promotion: promotion || undefined });
    } catch {
      return { ok: false, error: "Illegal move." };
    }

    // Clocks start after White's first move, then switch on every move.
    const t = this.now();
    const tc = this._tc();
    if (tc.baseMs > 0) {
      if (g.clockStartedAt != null) {
        g.clocks[color] = Math.max(0, g.clocks[color] - (t - g.clockStartedAt)) + tc.incMs;
      }
      g.clockStartedAt = t;
    }
    if (!g.startedAt) g.startedAt = t;
    g.moves.push({
      san: m.san,
      from: m.from,
      to: m.to,
      promotion: m.promotion || null,
      color,
      at: t,
      clock: tc.baseMs > 0 ? g.clocks[color] : null,
    });
    // Moving declines a pending offer from the opponent; your own offer stands.
    if (g.drawOffer && g.drawOffer !== color) g.drawOffer = null;

    const c = this.chess;
    if (c.isCheckmate()) this._finish(winFor(color), "checkmate");
    else if (c.isStalemate()) this._finish("1/2-1/2", "stalemate");
    else if (c.isInsufficientMaterial()) this._finish("1/2-1/2", "insufficient material");
    else if (c.isThreefoldRepetition()) this._finish("1/2-1/2", "threefold repetition");
    else if (c.isDrawByFiftyMoves()) this._finish("1/2-1/2", "fifty-move rule");
    else this._armFlagTimer();
    return this._commit();
  }

  resign({ clientId }) {
    const color = this._colorOf(clientId);
    if (!color || this.game.status !== "active") return { ok: false, error: "Nothing to resign." };
    // Resigning before any move is just leaving; there is no game to score.
    if (this.game.moves.length === 0) return this.stand({ clientId });
    this._finish(winFor(other(color)), "resignation");
    return this._commit();
  }

  offerDraw({ clientId }) {
    const g = this.game;
    const color = this._colorOf(clientId);
    if (!color || g.status !== "active" || g.moves.length === 0) return { ok: false, error: "No game in progress." };
    if (g.drawOffer) return { ok: false, error: "A draw offer is already pending." };
    g.drawOffer = color;
    return this._commit();
  }

  /** The opponent accepts/declines; the offering side may withdraw with accept=false. */
  respondDraw({ clientId, accept }) {
    const g = this.game;
    const color = this._colorOf(clientId);
    if (!color || !g.drawOffer || g.status !== "active") return { ok: false, error: "No draw offer to answer." };
    if (g.drawOffer === color && accept) return { ok: false, error: "Waiting for your opponent." };
    if (accept) this._finish("1/2-1/2", "draw agreed");
    else g.drawOffer = null;
    return this._commit();
  }

  /**
   * Fresh board. After a finished game anyone may start one (rematch: online
   * players keep their seats with colours swapped, offline players are
   * unseated). Before the first move players may use it to swap colours. A
   * game everyone abandoned is recorded with result "*" and cleared.
   */
  newGame({ clientId }) {
    const g = this.game;
    if (!this._canNewGame(this._colorOf(clientId))) {
      return { ok: false, error: this._inProgress() ? "Finish or resign the current game first." : "Only players can do that." };
    }
    if (this._inProgress()) this._finish("*", "abandoned");
    const keep = (p) => (p && p.connected ? p : null);
    this._fresh({ white: keep(g.players.black), black: keep(g.players.white), timeControl: g.timeControl });
    this._emit();
    return { ok: true };
  }
}

module.exports = { ChessManager, TIME_CONTROLS, ABANDON_MS };
