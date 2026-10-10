import type { ChessState, Color } from "./chessSocket";

/**
 * Status line under each player's name. Read from the viewer's side:
 *
 *   tone   LED     meaning
 *   turn   green   it is this player's move ("Your turn", "Thinking…", "To move")
 *   alert  amber   needs attention: check, a draw offer, low on time
 *   off    red     player is offline (their clock still runs)
 *   wait   dim     not this player's move ("Waiting on you", "Waiting on Bob")
 *   done   dim     game over line ("Won by checkmate", "Checkmated", "Draw · stalemate")
 *   idle   dim     empty seat / not started
 *
 * First matching rule wins: empty seat → game over → offline → draw offer →
 * check → whose turn.
 */
export type Tone = "turn" | "alert" | "off" | "wait" | "done" | "idle";
export type SeatStatus = { text: string; tone: Tone };

const REASON_WIN: Record<string, string> = {
  checkmate: "by checkmate",
  resignation: "by resignation",
  timeout: "on time",
};

export function seatStatus(s: ChessState, color: Color): SeatStatus {
  const p = s.players[color];
  const other: Color = color === "white" ? "black" : "white";
  const mine = s.you === color;
  const watching = s.you === null;
  const opp = s.players[other];

  if (!p) {
    if (s.status === "over") return { text: "Left the game", tone: "idle" };
    return { text: s.you ? "Waiting for someone to join" : "Open seat", tone: "idle" };
  }

  if (s.status === "over") {
    if (s.result === "*") return { text: "Game abandoned", tone: "done" };
    if (s.result === "1/2-1/2") return { text: `Draw · ${s.reason ?? "agreed"}`, tone: "done" };
    const won = (s.result === "1-0") === (color === "white");
    const reason = s.reason ?? "";
    if (won) return { text: `${mine ? "You won" : "Won"} ${REASON_WIN[reason] ?? ""}`.trim(), tone: "done" };
    if (reason === "checkmate") return { text: "Checkmated", tone: "done" };
    if (reason === "resignation") return { text: mine ? "You resigned" : "Resigned", tone: "done" };
    if (reason === "timeout") return { text: "Out of time", tone: "done" };
    return { text: "Lost", tone: "done" };
  }

  const theirMove = s.status === "active" && s.turn === color;

  if (!p.connected) {
    return { text: theirMove && s.timeControl !== "untimed" ? "Offline · clock running" : "Offline", tone: "off" };
  }

  if (s.status === "waiting") {
    return { text: mine ? "Waiting for an opponent" : "Ready", tone: "idle" };
  }

  if (s.drawOffer === color) return { text: mine ? "You offered a draw" : "Offers a draw", tone: "alert" };

  if (theirMove) {
    if (s.inCheck) return { text: mine ? "Your turn · Check!" : "In check · thinking…", tone: "alert" };
    if (mine) return { text: s.moves.length === 0 ? "Your turn · you start" : "Your turn", tone: "turn" };
    return { text: watching ? "To move" : "Thinking…", tone: "turn" };
  }

  if (mine) return { text: `Waiting on ${opp?.name ?? "opponent"}`, tone: "wait" };
  return { text: watching ? "Waiting" : "Waiting on you", tone: "wait" };
}

export const TONE_LED: Record<Tone, string> = {
  turn: "pretzel-led pretzel-led--ok",
  alert: "pretzel-led pretzel-led--warn",
  off: "pretzel-led pretzel-led--off",
  wait: "pretzel-led",
  done: "pretzel-led",
  idle: "pretzel-led",
};

/** Short amber readout for the top bar. */
export function topReadout(s: ChessState | null, connected: boolean): string {
  if (!s) return connected ? "LOADING" : "CONNECTING";
  if (s.status === "over") return "GAME OVER";
  if (s.status === "waiting") return "WAITING";
  const move = Math.floor(s.moves.length / 2) + 1;
  return s.you ? `MOVE ${move}` : `WATCHING · ${move}`;
}

/** One-line result for overlays and the history list. */
export function resultLine(result: string | null, reason: string | null): string {
  if (result === "*") return "Game abandoned";
  if (result === "1/2-1/2") return `Draw · ${reason ?? "agreed"}`;
  const who = result === "1-0" ? "White" : "Black";
  return `${who} wins ${REASON_WIN[reason ?? ""] ?? (reason ? `· ${reason}` : "")}`.trim();
}
