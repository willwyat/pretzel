/**
 * Versus Tetris rules, no DOM. Both players build a Game from the same seed,
 * so they get the same 7-bag piece sequence; everything else (moves, line
 * clears, garbage holes) is local. Time only advances through update(dtMs),
 * which runs fixed 1/60 s steps, so speed does not depend on screen refresh.
 */

export const COLS = 10;
export const ROWS = 20;
/** Rows above the visible field. Pieces spawn partly in here. */
export const HIDDEN = 2;
export const TOTAL_ROWS = ROWS + HIDDEN;
export const GARBAGE = 8;

const STEP_MS = 1000 / 60;
const LOCK_DELAY_MS = 500;
const MAX_LOCK_RESETS = 15;
const DAS_MS = 170;
const ARR_MS = 50;
const SOFT_DROP_FACTOR = 20;
const LEVEL_EVERY_MS = 30_000;
const MAX_LEVEL = 15;
const MAX_PENDING = 20;
/** Lines cleared at once → garbage rows sent. */
const ATTACK = [0, 0, 1, 2, 4];

/** Piece ids 1..7 = I J L O S T Z (also their colour index). */
export type PieceId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Action = "left" | "right" | "soft" | "cw" | "hard";
type Cell = readonly [number, number];

/** Spawn orientation, (x, y) with y pointing down, inside an n×n box. */
const BASE: Record<PieceId, { n: number; cells: Cell[] }> = {
  1: { n: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  2: { n: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  3: { n: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
  4: { n: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  5: { n: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  6: { n: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  7: { n: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
};

/** SHAPES[piece][rotation] — rotating the box clockwise matches SRS states 0, R, 2, L. */
export const SHAPES: Record<PieceId, Cell[][]> = Object.fromEntries(
  (Object.entries(BASE) as unknown as [string, { n: number; cells: Cell[] }][]).map(([id, { n, cells }]) => {
    const rots: Cell[][] = [cells];
    for (let r = 1; r < 4; r++) rots.push(rots[r - 1].map(([x, y]) => [n - 1 - y, x] as const));
    return [id, rots];
  }),
) as Record<PieceId, Cell[][]>;

/** SRS kick tests in (x, y-up) as published; converted to y-down when used. */
const KICKS_JLSTZ: Record<string, Cell[]> = {
  "01": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "10": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "12": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "21": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "23": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "32": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "30": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "03": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const KICKS_I: Record<string, Cell[]> = {
  "01": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "10": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "12": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  "21": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "23": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "32": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "30": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "03": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

/** Small, fast 32-bit PRNG; identical output in every browser for a given seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard 7-bag: every run of 7 pieces holds each piece once. */
export class Bag {
  private rng: () => number;
  private queue: PieceId[] = [];
  constructor(seed: number) {
    this.rng = mulberry32(seed);
  }
  private refill() {
    const bag: PieceId[] = [1, 2, 3, 4, 5, 6, 7];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    this.queue.push(...bag);
  }
  peek(n: number): PieceId[] {
    while (this.queue.length < n) this.refill();
    return this.queue.slice(0, n);
  }
  next(): PieceId {
    if (this.queue.length === 0) this.refill();
    return this.queue.shift()!;
  }
}

export type ActivePiece = { id: PieceId; rot: number; x: number; y: number };

export type GameEvents = {
  /** Board changed (piece locked, garbage added): visible 200-char string. */
  onBoard?: (cells: string) => void;
  /** Lines to send to the opponent after cancelling queued garbage. */
  onAttack?: (lines: number) => void;
  /** Lines cleared by one lock (1..4), before garbage cancelling. */
  onClear?: (lines: number) => void;
  onTopOut?: () => void;
};

/** Gravity in ms per row: guideline curve (0.8 - (L-1)·0.007)^(L-1) s. */
export function msPerRow(level: number): number {
  return Math.pow(0.8 - (level - 1) * 0.007, level - 1) * 1000;
}

export class Game {
  readonly board = new Uint8Array(COLS * TOTAL_ROWS);
  piece: ActivePiece | null = null;
  started = false;
  over = false;
  elapsedMs = 0;
  linesCleared = 0;
  linesSent = 0;
  /** Incoming garbage not yet added; each entry shares one hole column. */
  pending: number[] = [];

  private bag: Bag;
  private events: GameEvents;
  private rand: () => number;
  private acc = 0;
  private gravityAcc = 0;
  private lockTimer = 0;
  private lockResets = 0;
  private lowestY = 0;
  private held = { left: false, right: false, soft: false };
  /** Last horizontal direction pressed; wins while both are held. */
  private hDir: -1 | 0 | 1 = 0;
  private dasTimer = 0;
  private arrTimer = 0;

  /** @param holeRandom garbage hole picker; deliberately separate from the shared bag RNG. */
  constructor(seed: number, events: GameEvents = {}, holeRandom: () => number = Math.random) {
    this.bag = new Bag(seed);
    this.events = events;
    this.rand = holeRandom;
  }

  get level(): number {
    return Math.min(MAX_LEVEL, 1 + Math.floor(this.elapsedMs / LEVEL_EVERY_MS));
  }

  get pendingTotal(): number {
    return this.pending.reduce((a, b) => a + b, 0);
  }

  nextPieces(n: number): PieceId[] {
    return this.bag.peek(n);
  }

  start() {
    if (this.started || this.over) return;
    this.started = true;
    this.spawn();
  }

  /** Freeze the game (the match ended elsewhere). */
  stop() {
    this.over = true;
  }

  // ── geometry ───────────────────────────────────────────────────
  cellsOf(p: ActivePiece): Cell[] {
    return SHAPES[p.id][p.rot].map(([x, y]) => [x + p.x, y + p.y] as const);
  }

  private fits(p: ActivePiece): boolean {
    for (const [x, y] of this.cellsOf(p)) {
      if (x < 0 || x >= COLS || y >= TOTAL_ROWS) return false;
      if (y >= 0 && this.board[y * COLS + x] !== 0) return false;
    }
    return true;
  }

  ghostY(): number | null {
    if (!this.piece) return null;
    const g = { ...this.piece };
    while (this.fits({ ...g, y: g.y + 1 })) g.y++;
    return g.y;
  }

  visibleCells(): string {
    let s = "";
    for (let i = HIDDEN * COLS; i < this.board.length; i++) s += this.board[i];
    return s;
  }

  // ── input ──────────────────────────────────────────────────────
  press(a: Action) {
    if (!this.piece || this.over) {
      if (a === "left" || a === "right" || a === "soft") this.held[a] = true;
      return;
    }
    switch (a) {
      case "left":
      case "right": {
        this.held[a] = true;
        this.hDir = a === "left" ? -1 : 1;
        this.dasTimer = 0;
        this.arrTimer = 0;
        this.shift(this.hDir);
        break;
      }
      case "soft":
        this.held.soft = true;
        break;
      case "cw":
        this.rotate();
        break;
      case "hard":
        this.hardDrop();
        break;
    }
  }

  release(a: Action) {
    if (a !== "left" && a !== "right" && a !== "soft") return;
    this.held[a] = false;
    if (a === "soft") return;
    // Fall back to the other direction if it is still held.
    const other = a === "left" ? "right" : "left";
    if (this.held[other]) {
      this.hDir = other === "left" ? -1 : 1;
      this.dasTimer = 0;
      this.arrTimer = 0;
    } else {
      this.hDir = 0;
    }
  }

  private afterMove() {
    if (!this.piece) return;
    if (!this.fits({ ...this.piece, y: this.piece.y + 1 }) && this.lockResets < MAX_LOCK_RESETS) {
      this.lockTimer = 0;
      this.lockResets++;
    }
  }

  private shift(dx: number): boolean {
    if (!this.piece) return false;
    const p = { ...this.piece, x: this.piece.x + dx };
    if (!this.fits(p)) return false;
    this.piece = p;
    this.afterMove();
    return true;
  }

  /** Clockwise only (the pad has a single rotate key). */
  private rotate() {
    if (!this.piece || this.piece.id === 4) return;
    const from = this.piece.rot;
    const to = (from + 1) % 4;
    const table = this.piece.id === 1 ? KICKS_I : KICKS_JLSTZ;
    for (const [kx, ky] of table[`${from}${to}`]) {
      const p = { ...this.piece, rot: to, x: this.piece.x + kx, y: this.piece.y - ky };
      if (this.fits(p)) {
        this.piece = p;
        this.afterMove();
        return;
      }
    }
  }

  private hardDrop() {
    if (!this.piece) return;
    this.piece = { ...this.piece, y: this.ghostY()! };
    this.lock();
  }

  // ── garbage ────────────────────────────────────────────────────
  receiveGarbage(lines: number) {
    if (this.over || !Number.isInteger(lines) || lines < 1) return;
    const room = MAX_PENDING - this.pendingTotal;
    if (room > 0) this.pending.push(Math.min(lines, room));
  }

  /** Push queued garbage up from the bottom. Returns false on top-out. */
  private applyGarbage(): boolean {
    for (const count of this.pending) {
      for (let i = 0; i < count * COLS; i++) {
        if (this.board[i] !== 0) {
          this.pending = [];
          return false; // blocks would be pushed off the top
        }
      }
      this.board.copyWithin(0, count * COLS);
      const hole = Math.floor(this.rand() * COLS);
      for (let r = TOTAL_ROWS - count; r < TOTAL_ROWS; r++) {
        for (let c = 0; c < COLS; c++) this.board[r * COLS + c] = c === hole ? 0 : GARBAGE;
      }
    }
    this.pending = [];
    return true;
  }

  // ── lifecycle ──────────────────────────────────────────────────
  private spawn() {
    const id = this.bag.next();
    const n = BASE[id].n;
    const p: ActivePiece = { id, rot: 0, x: n === 2 ? 4 : 3, y: HIDDEN - 1 };
    this.gravityAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.lowestY = p.y;
    if (!this.fits(p)) {
      this.piece = p;
      this.topOut();
      return;
    }
    this.piece = p;
    // Keys held through the spawn keep auto-repeating; restart the delay.
    this.dasTimer = 0;
    this.arrTimer = 0;
  }

  private topOut() {
    if (this.over) return;
    this.over = true;
    this.events.onTopOut?.();
  }

  private lock() {
    const p = this.piece;
    if (!p) return;
    const cells = this.cellsOf(p);
    for (const [x, y] of cells) if (y >= 0) this.board[y * COLS + x] = p.id;
    this.piece = null;
    if (cells.every(([, y]) => y < HIDDEN)) {
      this.events.onBoard?.(this.visibleCells());
      this.topOut(); // locked entirely above the visible field
      return;
    }

    let cleared = 0;
    for (let r = TOTAL_ROWS - 1; r >= 0; ) {
      let full = true;
      for (let c = 0; c < COLS; c++) if (this.board[r * COLS + c] === 0) full = false;
      if (!full) {
        r--;
        continue;
      }
      this.board.copyWithin(COLS, 0, r * COLS);
      this.board.fill(0, 0, COLS);
      cleared++;
    }
    this.linesCleared += cleared;
    if (cleared > 0) this.events.onClear?.(cleared);

    let ok = true;
    if (cleared > 0) {
      let attack = ATTACK[cleared];
      while (attack > 0 && this.pending.length) {
        const take = Math.min(attack, this.pending[0]);
        attack -= take;
        this.pending[0] -= take;
        if (this.pending[0] === 0) this.pending.shift();
      }
      if (attack > 0) {
        this.linesSent += attack;
        this.events.onAttack?.(attack);
      }
    } else if (this.pending.length) {
      ok = this.applyGarbage();
    }
    this.events.onBoard?.(this.visibleCells());
    if (!ok) {
      this.topOut();
      return;
    }
    this.spawn();
  }

  /** Advance by real elapsed time (clamped by the caller). */
  update(dtMs: number) {
    if (!this.started || this.over) return;
    this.acc += Math.min(dtMs, 250);
    while (this.acc >= STEP_MS && !this.over) {
      this.acc -= STEP_MS;
      this.step();
    }
  }

  private step() {
    this.elapsedMs += STEP_MS;
    if (!this.piece) return;

    // Auto-repeat for held left/right.
    if (this.hDir !== 0) {
      this.dasTimer += STEP_MS;
      if (this.dasTimer >= DAS_MS) {
        this.arrTimer += STEP_MS;
        while (this.arrTimer >= ARR_MS) {
          this.arrTimer -= ARR_MS;
          if (!this.shift(this.hDir)) {
            this.arrTimer = 0;
            break;
          }
        }
      }
    }

    // Gravity (faster while soft-dropping).
    let p: ActivePiece = this.piece!;
    const rowMs = msPerRow(this.level) / (this.held.soft ? SOFT_DROP_FACTOR : 1);
    this.gravityAcc += STEP_MS;
    while (this.gravityAcc >= rowMs) {
      this.gravityAcc -= rowMs;
      const down: ActivePiece = { ...p, y: p.y + 1 };
      if (!this.fits(down)) {
        this.gravityAcc = 0;
        break;
      }
      p = this.piece = down;
      if (down.y > this.lowestY) {
        this.lowestY = down.y;
        this.lockTimer = 0;
        this.lockResets = 0;
      }
    }

    // Lock delay once resting on something.
    if (!this.fits({ ...p, y: p.y + 1 })) {
      this.lockTimer += STEP_MS;
      if (this.lockTimer >= LOCK_DELAY_MS) this.lock();
    } else {
      this.lockTimer = 0;
    }
  }
}
