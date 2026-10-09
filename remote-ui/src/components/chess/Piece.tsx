import { memo, type ReactElement } from "react";
import { SPRITES, type PieceType } from "./sprites";

/** Renders a pixel map (one string per row) as crisp SVG rects, merging horizontal runs. */
export function Pixels({
  rows,
  palette,
  className,
}: {
  rows: string[];
  palette: Record<string, string>;
  className?: string;
}) {
  const rects: ReactElement[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end += 1;
      if (palette[ch]) {
        rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={end - x} height={1} fill={palette[ch]} />);
      }
      x = end;
    }
  });
  return (
    <svg
      viewBox={`0 0 ${rows[0].length} ${rows.length}`}
      shapeRendering="crispEdges"
      className={className}
      aria-hidden
    >
      {rects}
    </svg>
  );
}

/**
 * Outline pixels not touching the transparent background are inner detail
 * lines ('i'): black on white pieces, light on black pieces so collars and
 * crowns stay readable on a solid black body.
 */
function withInnerLines(rows: string[]): string[] {
  const at = (x: number, y: number) => rows[y]?.[x] ?? ".";
  return rows.map((row, y) =>
    [...row]
      .map((ch, x) =>
        ch === "#" && [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].every((n) => n !== ".") ? "i" : ch,
      )
      .join(""),
  );
}

const SHAPES = Object.fromEntries(
  Object.entries(SPRITES).map(([k, rows]) => [k, withInnerLines(rows)]),
) as Record<PieceType, string[]>;

const PALETTE = {
  w: { "#": "#000000", i: "#000000", o: "#ffffff", w: "#c0c0c0" },
  b: { "#": "#000000", i: "#a0a0a0", o: "#000000", w: "#ffffff" },
} as const;

export const Piece = memo(function Piece({
  type,
  color,
  className = "win-piece",
}: {
  type: PieceType;
  color: "w" | "b";
  className?: string;
}) {
  return <Pixels rows={SHAPES[type]} palette={PALETTE[color]} className={className} />;
});
