import type { ChessState, Color } from "./chessSocket";

/**
 * Player portraits. Each avatar is one 62×62-per-frame strip in
 * public/avatars/chess/<id>.png, frames in EXPRESSIONS order (built by
 * scripts/chess-avatars.py; keep the two in sync).
 */
export const EXPRESSIONS = ["neutral", "thinking", "shocked", "smug", "victorious", "loss"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const AVATARS: { id: number; name: string }[] = [
  { id: 1, name: "Lady" },
  { id: 2, name: "Squire" },
  { id: 3, name: "Witch" },
  { id: 4, name: "Elder" },
  { id: 5, name: "Knight" },
];

export const avatarSrc = (id: number) => `/avatars/chess/${id}.png`;

/** Captures worth a reaction: anything but a pawn. */
const BIG_CAPTURE = new Set(["n", "b", "r", "q"]);

/**
 * Face for one seat, read from the last move only, so it survives reloads and
 * looks the same to both players and spectators:
 *
 *   game over      winner victorious, loser loss; draw or abandoned neutral
 *   last move      gave check, took a piece (not a pawn) or promoted:
 *                  mover smug, the other side shocked (until the next move)
 *   otherwise      side to move thinking, the other neutral
 */
export function expressionFor(s: ChessState, color: Color): Expression {
  if (s.status === "over") {
    if (s.result === "1-0" || s.result === "0-1") return (s.result === "1-0") === (color === "white") ? "victorious" : "loss";
    return "neutral";
  }
  if (s.status !== "active") return "neutral";
  const last = s.moves[s.moves.length - 1];
  if (last && (/[+#]$/.test(last.san) || BIG_CAPTURE.has(last.captured ?? "") || last.promotion)) {
    return last.color === color ? "smug" : "shocked";
  }
  return s.turn === color ? "thinking" : "neutral";
}
