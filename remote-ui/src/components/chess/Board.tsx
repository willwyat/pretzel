import { Piece } from "./Piece";
import type { PieceType } from "./sprites";

const FILES = "abcdefgh";

export type PieceOn = { t: PieceType; c: "w" | "b" };

export function parseFen(fen: string): Record<string, PieceOn> {
  const out: Record<string, PieceOn> = {};
  fen
    .split(" ")[0]
    .split("/")
    .forEach((row, i) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += Number(ch);
        else {
          out[`${FILES[f]}${8 - i}`] = {
            t: ch.toLowerCase() as PieceType,
            c: ch === ch.toLowerCase() ? "b" : "w",
          };
          f += 1;
        }
      }
    });
  return out;
}

/** Square of the given side's king (used to flag check). */
export function kingSquare(fen: string, color: "white" | "black"): string | null {
  const want = color === "white" ? "w" : "b";
  const pos = parseFen(fen);
  return Object.keys(pos).find((s) => pos[s].t === "k" && pos[s].c === want) ?? null;
}

export type BoardProps = {
  fen: string;
  flipped: boolean;
  selected?: string | null;
  targets?: Set<string>;
  lastMove: { from: string; to: string } | null;
  checkSquare?: string | null;
  coords?: boolean;
  onSquare?: (sq: string) => void;
};

export function Board({
  fen,
  flipped,
  selected = null,
  targets,
  lastMove,
  checkSquare = null,
  coords = true,
  onSquare,
}: BoardProps) {
  const pos = parseFen(fen);
  const ranks = flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = flipped ? [...FILES].reverse() : [...FILES];
  return (
    <div className={`win-board${onSquare ? " win-board--live" : ""}`} role="grid" aria-label="Chess board">
      {ranks.map((r, ri) =>
        files.map((f, fi) => {
          const sq = `${f}${r}`;
          const dark = (FILES.indexOf(f) + r) % 2 === 1; // a1 is dark
          const p = pos[sq];
          const cls = [
            "win-sq",
            dark ? "win-sq--dark" : "win-sq--light",
            selected === sq ? "win-sq--selected" : "",
            lastMove && (lastMove.from === sq || lastMove.to === sq) ? "win-sq--last" : "",
            checkSquare === sq ? "win-sq--check" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={sq}
              type="button"
              className={cls}
              onClick={onSquare ? () => onSquare(sq) : undefined}
              aria-label={`${sq}${p ? ` ${p.c === "w" ? "white" : "black"} ${PIECE_NAMES[p.t]}` : ""}`}
              tabIndex={-1}
            >
              {p ? <Piece type={p.t} color={p.c} /> : null}
              {targets?.has(sq) ? <span className={p ? "win-ring" : "win-dot"} /> : null}
              {coords && fi === 0 ? <span className="win-coord win-coord--rank">{r}</span> : null}
              {coords && ri === 7 ? <span className="win-coord win-coord--file">{f}</span> : null}
            </button>
          );
        }),
      )}
    </div>
  );
}

export const PIECE_NAMES: Record<PieceType, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};
