import type { CSSProperties } from "react";

export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

/** Column of each piece in /sprites/chess-pieces.svg (Cburnett set: K Q B N R P; white row, then black). */
const COLUMN: Record<PieceType, number> = { k: 0, q: 1, b: 2, n: 3, r: 4, p: 5 };

/** One piece cut from the sprite sheet; scales with its box. */
export function Piece({ type, color, className = "chess-piece" }: { type: PieceType; color: "w" | "b"; className?: string }) {
  const style: CSSProperties = {
    backgroundPosition: `${COLUMN[type] * 20}% ${color === "w" ? 0 : 100}%`,
  };
  return <span className={className} style={style} aria-hidden />;
}
