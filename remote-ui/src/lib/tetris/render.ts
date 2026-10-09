import { COLS, HIDDEN, ROWS, SHAPES, type Game, type PieceId } from "./engine";

/** Index = cell value: 0 empty, 1..7 I J L O S T Z, 8 garbage. */
export const COLORS = ["", "#22d3ee", "#3b82f6", "#f97316", "#facc15", "#22c55e", "#a855f7", "#ef4444", "#6b7280"];
const BG = "#05060a";
const GRID = "#12151f";

/** Size a canvas for crisp drawing at devicePixelRatio; returns its 2D context in CSS pixels. */
export function fitCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number): CanvasRenderingContext2D {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function block(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, v: number) {
  ctx.fillStyle = COLORS[v];
  ctx.fillRect(x * s, y * s, s, s);
  if (s >= 8) {
    // Simple bevel for the arcade look.
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fillRect(x * s, y * s, s, Math.max(1, s * 0.12));
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(x * s, (y + 1) * s - Math.max(1, s * 0.12), s, Math.max(1, s * 0.12));
  }
  ctx.strokeStyle = BG;
  ctx.lineWidth = 1;
  ctx.strokeRect(x * s + 0.5, y * s + 0.5, s - 1, s - 1);
}

function grid(ctx: CanvasRenderingContext2D, s: number) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, COLS * s, ROWS * s);
  if (s < 10) return;
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < COLS; c++) {
    ctx.moveTo(c * s + 0.5, 0);
    ctx.lineTo(c * s + 0.5, ROWS * s);
  }
  for (let r = 1; r < ROWS; r++) {
    ctx.moveTo(0, r * s + 0.5);
    ctx.lineTo(COLS * s, r * s + 0.5);
  }
  ctx.stroke();
}

/** Opponent / spectator board from a relayed 200-char snapshot. */
export function drawSnapshot(canvas: HTMLCanvasElement, cells: string | null, s: number) {
  const ctx = fitCanvas(canvas, COLS * s, ROWS * s);
  grid(ctx, s);
  if (!cells) return;
  for (let i = 0; i < cells.length; i++) {
    const v = cells.charCodeAt(i) - 48;
    if (v > 0) block(ctx, i % COLS, Math.floor(i / COLS), s, v);
  }
}

/** Local board: settled cells, ghost, active piece, incoming-garbage meter and an optional overlay. */
export function drawGame(canvas: HTMLCanvasElement, game: Game, s: number, overlay: string | null) {
  const ctx = fitCanvas(canvas, COLS * s, ROWS * s);
  grid(ctx, s);
  for (let r = HIDDEN; r < HIDDEN + ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = game.board[r * COLS + c];
      if (v) block(ctx, c, r - HIDDEN, s, v);
    }
  }
  const p = game.piece;
  if (p && !game.over) {
    const gy = game.ghostY();
    if (gy !== null && gy !== p.y) {
      ctx.strokeStyle = COLORS[p.id];
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      for (const [x, y] of game.cellsOf({ ...p, y: gy })) {
        if (y >= HIDDEN) ctx.strokeRect(x * s + 2, (y - HIDDEN) * s + 2, s - 4, s - 4);
      }
      ctx.globalAlpha = 1;
    }
    for (const [x, y] of game.cellsOf(p)) if (y >= HIDDEN) block(ctx, x, y - HIDDEN, s, p.id);
  }
  const pending = Math.min(ROWS, game.pendingTotal);
  if (pending > 0) {
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(0, (ROWS - pending) * s, Math.max(3, s * 0.15), pending * s);
  }
  if (overlay) {
    ctx.fillStyle = "rgba(5,6,10,0.72)";
    ctx.fillRect(0, 0, COLS * s, ROWS * s);
    ctx.fillStyle = "#facc15";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `bold ${Math.round(s * (overlay.length <= 2 ? 3 : 1.1))}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.fillText(overlay, (COLS * s) / 2, (ROWS * s) / 2);
  }
}

/** Next-piece queue, stacked vertically, each in a 4×3 slot. */
export function drawQueue(canvas: HTMLCanvasElement, pieces: PieceId[], s: number) {
  const ctx = fitCanvas(canvas, 4 * s, 3 * s * pieces.length);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, 4 * s, 3 * s * pieces.length);
  pieces.forEach((id, i) => {
    const cells = SHAPES[id][0];
    const xs = cells.map(([x]) => x);
    const ys = cells.map(([, y]) => y);
    const w = Math.max(...xs) - Math.min(...xs) + 1;
    const h = Math.max(...ys) - Math.min(...ys) + 1;
    const ox = (4 - w) / 2 - Math.min(...xs);
    const oy = i * 3 + (3 - h) / 2 - Math.min(...ys);
    for (const [x, y] of cells) block(ctx, x + ox, y + oy, s, id);
  });
}
