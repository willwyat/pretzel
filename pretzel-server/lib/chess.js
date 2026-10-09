"use strict";

const { Chess } = require("chess.js");
const { randomUUID } = require("crypto");
const { readFileSync, writeFileSync, renameSync, existsSync } = require("fs");
const { join } = require("path");

/** Time control presets: base minutes + increment seconds (0/0 = untimed). */
const TIME_CONTROLS = {
  untimed: { id: "untimed", label: "Untimed", baseMs: 0, incMs: 0 },
  "5+0": { id: "5+0", label: "5 min", baseMs: 300_000, incMs: 0 },
  "10+0": { id: "10+0", label: "10 min", baseMs: 600_000, incMs: 0 },
  "15+10": { id: "15+10", label: "15 min + 10 s", baseMs: 900_000, incMs: 10_000 },
};

const MAX_NAME = 20;
const MAX_ARCHIVE = 200;

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

/**
 * Authoritative chess referee. One live game, two seats, any number of
 * spectators. Rules come from chess.js; clocks are server-side (remaining ms
 * + timestamp of the last switch), clients only render a countdown.
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
    if (saved && saved.moves && Array.isArray(saved.moves)) {
      try {
        const chess = new Chess();
        for (const m of saved.moves) chess.move(m.san);
        this.chess = chess;
        this.game = saved;
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
      /** ms timestamp when the side to move's clock started running; null = not running */
      clockStartedAt: null,
      moves: [],
      drawOffer: null,
      status: "waiting", // waiting | active | over
      result: null, // "1-0" | "0-1" | "1/2-1/2"
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
    const g = this.game;
    if (g.status !== "active" || g.clockStartedAt == null) return;
    const side = this._turn();
    const left = this.clocksNow()[side];
    this.flagTimer = setTimeout(() => this._checkFlag(), left + 20);
  }

  _checkFlag() {
    const g = this.game;
    if (g.status !== "active" || g.clockStartedAt == null) return;
    const side = this._turn();
    if (this.clocksNow()[side] > 0) return this._armFlagTimer();
    g.clocks[side] = 0;
    g.clockStartedAt = null;
    this._finish(side === "white" ? "0-1" : "1-0", "timeout");
  }

  _finish(result, reason) {
    const g = this.game;
    if (g.status === "over") return;
    if (g.clockStartedAt != null) {
      const side = this._turn();
      g.clocks[side] = this.clocksNow()[side];
      g.clockStartedAt = null;
    }
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
    games.push({
      id: g.id,
      white: g.players.white && g.players.white.name,
      black: g.players.black && g.players.black.name,
      whiteIp: g.players.white && g.players.white.ip,
      blackIp: g.players.black && g.players.black.ip,
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
    const date = new Date(g.startedAt || g.createdAt)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, ".");
    this.chess.setHeader("Event", "Pretzel casual game");
    this.chess.setHeader("Site", "Pretzel Pi");
    this.chess.setHeader("Date", date);
    this.chess.setHeader("White", (g.players.white && g.players.white.name) || "?");
    this.chess.setHeader("Black", (g.players.black && g.players.black.name) || "?");
    this.chess.setHeader("Result", g.result || "*");
    return this.chess.pgn();
  }

  // ── public queries ─────────────────────────────────────────────
  listGames() {
    return readJson(this.gamesPath, [])
      .map(({ id, white, black, result, reason, timeControl, startedAt, endedAt, moves }) => ({
        id, white, black, result, reason, timeControl, startedAt, endedAt,
        moveCount: Array.isArray(moves) ? moves.length : 0,
      }))
      .reverse();
  }

  /** Archived game plus `fens[i]` = position after i moves (fens[0] = start), for replay. */
  getGame(id) {
    const g = readJson(this.gamesPath, []).find((x) => x.id === id);
    if (!g) return null;
    const c = new Chess();
    const fens = [c.fen()];
    for (const m of g.moves) {
      c.move(m.san);
      fens.push(c.fen());
    }
    return { ...g, fens };
  }

  /** Public snapshot for broadcasting. `clientId` marks which seat is "you". */
  snapshot(clientId) {
    const g = this.game;
    const you = clientId ? this._colorOf(clientId) : null;
    const legal =
      g.status === "active"
        ? this.chess.moves({ verbose: true }).map((m) => ({
            from: m.from,
            to: m.to,
            promotion: m.promotion || null,
            san: m.san,
          }))
        : [];
    const hist = g.moves;
    return {
      id: g.id,
      status: g.status,
      result: g.result,
      reason: g.reason,
      fen: this.chess.fen(),
      turn: this._turn(),
      inCheck: this.chess.inCheck(),
      legalMoves: legal,
      moves: hist,
      lastMove: hist.length ? { from: hist[hist.length - 1].from, to: hist[hist.length - 1].to } : null,
      players: {
        white: g.players.white && { name: g.players.white.name, connected: !!g.players.white.connected },
        black: g.players.black && { name: g.players.black.name, connected: !!g.players.black.connected },
      },
      you,
      timeControl: g.timeControl,
      timeControls: Object.values(TIME_CONTROLS),
      clocks: this.clocksNow(),
      clockRunning: g.status === "active" && g.clockStartedAt != null,
      serverNow: this.now(),
      drawOffer: g.drawOffer,
    };
  }

  // ── presence ───────────────────────────────────────────────────
  setConnected(clientId, connected) {
    const color = this._colorOf(clientId);
    if (!color) return;
    this.game.players[color].connected = connected;
    this._emit();
  }

  // ── actions (each returns { ok } or { ok:false, error }) ───────
  sit({ clientId, name, color, ip }) {
    const g = this.game;
    const n = cleanName(name);
    if (!clientId) return { ok: false, error: "clientId required" };
    if (!n) return { ok: false, error: "Enter a name first." };
    if (g.status === "over") return { ok: false, error: "Game is over; start a new game." };
    const existing = this._colorOf(clientId);
    if (existing) {
      g.players[existing].name = n;
      g.players[existing].ip = ip;
      this._save();
      this._emit();
      return { ok: true };
    }
    if (g.moves.length > 0) return { ok: false, error: "Game already in progress." };
    const order = color === "black" ? ["black", "white"] : ["white", "black"];
    const free = order.find((c) => !g.players[c]);
    if (!free) return { ok: false, error: "Both seats are taken." };
    g.players[free] = { clientId, name: n, ip, connected: true };
    this._refreshStatus();
    this._save();
    this._emit();
    return { ok: true };
  }

  stand({ clientId }) {
    const g = this.game;
    const color = this._colorOf(clientId);
    if (!color) return { ok: false, error: "You are not seated." };
    if (g.status === "active" && g.moves.length > 0) {
      return { ok: false, error: "Use Resign to leave a game in progress." };
    }
    g.players[color] = null;
    this._refreshStatus();
    this._save();
    this._emit();
    return { ok: true };
  }

  setTimeControl({ clientId, id }) {
    const g = this.game;
    if (!this._colorOf(clientId)) return { ok: false, error: "Only players can set the clock." };
    if (g.moves.length > 0) return { ok: false, error: "Clock can only change before the first move." };
    const tc = TIME_CONTROLS[id];
    if (!tc) return { ok: false, error: "Unknown time control." };
    g.timeControl = tc.id;
    g.clocks = { white: tc.baseMs, black: tc.baseMs };
    this._save();
    this._emit();
    return { ok: true };
  }

  move({ clientId, from, to, promotion }) {
    const g = this.game;
    if (g.status !== "active") return { ok: false, error: "No game in progress." };
    const color = this._colorOf(clientId);
    if (!color) return { ok: false, error: "You are not a player." };
    if (color !== this._turn()) return { ok: false, error: "Not your turn." };

    const t = this.now();
    // Flag may have fallen between timer ticks.
    if (g.clockStartedAt != null && this.clocksNow()[color] <= 0) {
      this._checkFlag();
      this._emit();
      return { ok: false, error: "Time is up." };
    }

    let m;
    try {
      m = this.chess.move({ from, to, promotion: promotion || undefined });
    } catch {
      return { ok: false, error: "Illegal move." };
    }

    // Clock bookkeeping: clock starts after White's first move, then switches.
    const tc = TIME_CONTROLS[g.timeControl] || TIME_CONTROLS.untimed;
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
    g.drawOffer = null;

    if (this.chess.isCheckmate()) {
      this._finish(color === "white" ? "1-0" : "0-1", "checkmate");
    } else if (this.chess.isStalemate()) {
      this._finish("1/2-1/2", "stalemate");
    } else if (this.chess.isInsufficientMaterial()) {
      this._finish("1/2-1/2", "insufficient material");
    } else if (this.chess.isThreefoldRepetition()) {
      this._finish("1/2-1/2", "threefold repetition");
    } else if (this.chess.isDrawByFiftyMoves()) {
      this._finish("1/2-1/2", "fifty-move rule");
    } else {
      this._save();
      this._armFlagTimer();
    }
    this._emit();
    return { ok: true };
  }

  resign({ clientId }) {
    const g = this.game;
    const color = this._colorOf(clientId);
    if (!color || g.status !== "active") return { ok: false, error: "Nothing to resign." };
    this._finish(color === "white" ? "0-1" : "1-0", "resignation");
    this._emit();
    return { ok: true };
  }

  offerDraw({ clientId }) {
    const g = this.game;
    const color = this._colorOf(clientId);
    if (!color || g.status !== "active") return { ok: false, error: "No game in progress." };
    if (g.drawOffer) return { ok: false, error: "A draw offer is already pending." };
    g.drawOffer = color;
    this._save();
    this._emit();
    return { ok: true };
  }

  respondDraw({ clientId, accept }) {
    const g = this.game;
    const color = this._colorOf(clientId);
    if (!color || !g.drawOffer) return { ok: false, error: "No draw offer to answer." };
    if (g.drawOffer === color) return { ok: false, error: "Waiting for your opponent." };
    if (accept) this._finish("1/2-1/2", "draw agreed");
    else g.drawOffer = null;
    this._save();
    this._emit();
    return { ok: true };
  }

  /** Rematch with colors swapped. Only allowed once the game is over (or not yet started). */
  newGame({ clientId }) {
    const g = this.game;
    if (!this._colorOf(clientId)) return { ok: false, error: "Only players can start a game." };
    if (g.status === "active" && g.moves.length > 0) {
      return { ok: false, error: "Finish or resign the current game first." };
    }
    const { white, black } = g.players;
    this._fresh({ white: black, black: white, timeControl: g.timeControl });
    this._emit();
    return { ok: true };
  }
}

module.exports = { ChessManager, TIME_CONTROLS };
