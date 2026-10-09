import { memo, type ReactElement } from "react";
import { SPRITES, type PieceType } from "./sprites";

const PALETTE = {
  w: { "#": "#000000", o: "#fffbe6", w: "#b8b090" },
  b: { "#": "#000000", o: "#222222", w: "#f2f2f2" },
} as const;

export const Piece = memo(function Piece({ type, color }: { type: PieceType; color: "w" | "b" }) {
  const pal = PALETTE[color];
  const rects: ReactElement[] = [];
  SPRITES[type].forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === "." ) {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === ch) end += 1;
      rects.push(
        <rect key={`${x}-${y}`} x={x} y={y} width={end - x} height={1} fill={pal[ch as "#" | "o" | "w"]} />,
      );
      x = end;
    }
  });
  return (
    <svg viewBox="0 0 16 16" shapeRendering="crispEdges" className="win-piece" aria-hidden>
      {rects}
    </svg>
  );
});
