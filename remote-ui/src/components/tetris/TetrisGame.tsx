import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Game } from "../../lib/tetris/engine";
import { drawGame, drawQueue, drawSnapshot } from "../../lib/tetris/render";
import type { ClientMessage, TetrisEvent, TetrisStatus } from "../../lib/tetrisSocket";

/** The four on-screen controls. Hard drop is a double-tap on "down". */
export type PadKey = "left" | "right" | "down" | "cw";

const HIDDEN_FORFEIT_MS = 3000;
/** Second ▼ press within this window of the first is a hard drop. */
const DOUBLE_TAP_MS = 250;
const KEYS: Record<string, PadKey> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowDown: "down",
  ArrowUp: "cw",
};
/** Opponent board and next queue, relative to the main board's cell. */
const OPP_SCALE = 0.4;
const QUEUE_SCALE = 0.55;
/** Stage layout: side column (info + opponent) | gap | main board. */
const STAGE_PAD_X = 16;
const BOARD_GAP = 8;
/** Narrowest the side column can be: the Lvl / Lns / Snt readouts need this much. */
const SIDE_MIN = 96;

/** Largest cell (CSS px) for which `fit(width, height)` of the element holds; follows resizes. */
export function useFitCell(ref: RefObject<HTMLElement | null>, fit: (w: number, h: number) => number): number {
  const [cell, setCell] = useState(20);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const calc = () => setCell(Math.max(8, Math.min(32, Math.floor(fit(el.clientWidth, el.clientHeight)))));
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, fit]);
  return cell;
}

/**
 * Largest cell for which the main board (10 x 20 cells) and the side column fit the
 * stage. The side column is the opponent board (4 cells) but never narrower than
 * SIDE_MIN, and its stack (next queue, readouts, opponent board) must fit the height too.
 */
const fitPlayer = (w: number, h: number) => {
  const avail = w - STAGE_PAD_X - BOARD_GAP;
  let byW = avail / (10 + 10 * OPP_SCALE);
  if (10 * OPP_SCALE * byW < SIDE_MIN) byW = (avail - SIDE_MIN) / 10;
  const byBoardH = (h - 8) / 20;
  // next queue ~4.95c + opponent 8c, plus labels, readouts and gaps (~148px)
  const bySideH = (h - 148) / (9 * QUEUE_SCALE + 20 * OPP_SCALE);
  return Math.min(byW, byBoardH, bySideH);
};

/** Opponent cell and side-column width for a main cell size (floored so it never overflows). */
function sideLayout(cell: number) {
  const oppCell = Math.max(3, Math.floor(cell * OPP_SCALE));
  return { oppCell, sideW: Math.max(oppCell * 10, SIDE_MIN) };
}
/** Two snapshot boards side by side. */
const fitSpectator = (w: number, h: number) => Math.min((w - 40) / 20, (h - 30) / 20);

/**
 * Walnut control panel with four Moog panel caps. Presses act on pointerdown
 * with pointer capture, so response is immediate, several keys can be held at
 * once, and sliding a finger off a key still releases it.
 */
export function TouchPad({
  onPress,
  onRelease,
  disabled = false,
}: {
  onPress?: (k: PadKey) => void;
  onRelease?: (k: PadKey) => void;
  disabled?: boolean;
}) {
  const down = (k: PadKey) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (disabled) return;
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    el.classList.add("is-pressed");
    navigator.vibrate?.(8);
    onPress?.(k);
  };
  const up = (k: PadKey) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    if (!el.classList.contains("is-pressed")) return;
    el.classList.remove("is-pressed");
    onRelease?.(k);
  };
  const key = (k: PadKey, glyph: string, label: string, accent = false) => (
    <button
      type="button"
      className={`pretzel-btn-icon-wide tetris-key${accent ? " pretzel-key--accent" : ""}`}
      aria-label={label}
      data-key={k}
      disabled={disabled}
      onPointerDown={down(k)}
      onPointerUp={up(k)}
      onPointerCancel={up(k)}
      onLostPointerCapture={up(k)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {glyph}
    </button>
  );
  // Left thumb: ◀ ▶ on top with ▼ between and below them (a triangle).
  // Right thumb: a larger rotate key on its own.
  return (
    <div className="tetris-pad pretzel-nav-gradient">
      <div className="tetris-dpad">
        {key("left", "◀", "Move left")}
        {key("right", "▶", "Move right")}
        {key("down", "▼", "Soft drop (double-tap to hard drop)")}
      </div>
      {key("cw", "⟳", "Rotate", true)}
    </div>
  );
}

type Props = {
  matchId: string;
  seed: number;
  status: TetrisStatus;
  startsAt: number;
  /** serverNow - Date.now() */
  clockOffset: number;
  you: 0 | 1;
  opponentName: string;
  send: (m: ClientMessage) => void;
  subscribe: (fn: (e: TetrisEvent) => void) => () => void;
};

/**
 * Local player's game: the board stage plus the touch pad (two rows of the
 * full-screen shell). Runs the engine in a rAF loop and syncs sparse events with the Pi.
 */
export function TetrisGame(props: Props) {
  const { matchId, seed, you, send, subscribe } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLCanvasElement>(null);
  const queueRef = useRef<HTMLCanvasElement>(null);
  const oppRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const lastDownRef = useRef(0);
  const cell = useFitCell(stageRef, fitPlayer);
  const { sideW } = sideLayout(cell);
  const [stats, setStats] = useState({ level: 1, lines: 0, sent: 0 });

  // Latest props for the animation loop without restarting it.
  const live = useRef({ ...props, cell });
  live.current = { ...props, cell };

  useEffect(() => {
    // Mounting into a match that is already live means this page was reloaded
    // mid-game: the old board is gone, so concede rather than restart fresh.
    if (live.current.status === "active") send({ type: "forfeit", matchId, reason: "disconnected" });

    const game = new Game(seed, {
      onBoard: (cells) => send({ type: "board", matchId, cells }),
      onAttack: (lines) => send({ type: "attack", matchId, lines }),
      onTopOut: () => send({ type: "topout", matchId }),
    });
    gameRef.current = game;
    let oppCells: string | null = null;

    const unsub = subscribe((e) => {
      if (e.matchId !== matchId) return;
      if (e.type === "garbage") game.receiveGarbage(e.lines);
      else if (e.seat !== you) oppCells = e.cells;
    });

    let raf = 0;
    let last = performance.now();
    let shown = { level: 1, lines: 0, sent: 0 };
    const frame = (t: number) => {
      const L = live.current;
      const dt = t - last;
      last = t;
      const serverNow = Date.now() + L.clockOffset;
      if (L.status === "over") game.stop();
      else if (!game.started && serverNow >= L.startsAt) game.start();
      game.update(dt);

      const countdown =
        L.status !== "over" && !game.started ? String(Math.max(1, Math.ceil((L.startsAt - serverNow) / 1000))) : null;
      if (mainRef.current) drawGame(mainRef.current, game, L.cell, countdown);
      if (queueRef.current) drawQueue(queueRef.current, game.nextPieces(3), Math.round(L.cell * QUEUE_SCALE));
      if (oppRef.current) drawSnapshot(oppRef.current, oppCells, sideLayout(L.cell).oppCell);

      if (game.level !== shown.level || game.linesCleared !== shown.lines || game.linesSent !== shown.sent) {
        shown = { level: game.level, lines: game.linesCleared, sent: game.linesSent };
        setStats(shown);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      unsub();
      // Navigating away mid-match concedes it.
      if (game.started && !game.over && live.current.status === "active") {
        send({ type: "forfeit", matchId, reason: "left the game" });
      }
      gameRef.current = null;
    };
  }, [matchId, seed, you, send, subscribe]);

  const press = useCallback((k: PadKey) => {
    const g = gameRef.current;
    if (!g) return;
    if (k !== "down") {
      g.press(k);
      return;
    }
    const now = performance.now();
    if (now - lastDownRef.current < DOUBLE_TAP_MS) {
      lastDownRef.current = 0;
      g.release("soft");
      g.press("hard");
    } else {
      lastDownRef.current = now;
      g.press("soft");
    }
  }, []);

  const release = useCallback((k: PadKey) => {
    const g = gameRef.current;
    if (!g) return;
    if (k === "left" || k === "right") g.release(k);
    else if (k === "down") g.release("soft");
  }, []);

  // Arrow keys mirror the four pad keys (handy when testing on a laptop).
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      const k = KEYS[e.code];
      if (!k) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      if (!e.repeat) press(k);
    };
    const ku = (e: KeyboardEvent) => {
      const k = KEYS[e.code];
      if (k) release(k);
    };
    const blur = () => {
      for (const k of ["left", "right", "down"] as const) release(k);
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", blur);
    };
  }, [press, release]);

  // A hidden tab stops requestAnimationFrame; after a short grace, concede.
  useEffect(() => {
    let timer: number | undefined;
    const onVis = () => {
      window.clearTimeout(timer);
      if (document.visibilityState !== "hidden") return;
      timer = window.setTimeout(() => {
        const g = gameRef.current;
        if (g && g.started && !g.over && live.current.status === "active") {
          send({ type: "forfeit", matchId: live.current.matchId, reason: "tab hidden" });
        }
      }, HIDDEN_FORFEIT_MS);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [send]);

  return (
    <>
      <div ref={stageRef} className="tetris-stage">
        <div className="tetris-boards">
          <div className="tetris-side" style={{ width: sideW }}>
            <div className="pretzel-text-group-label">Next</div>
            <canvas ref={queueRef} className="tetris-canvas" aria-label="Next pieces" />
            <dl className="tetris-stats">
              <dt className="pretzel-text-group-label">Lvl</dt>
              <dd className="pretzel-readout">{String(stats.level).padStart(2, "0")}</dd>
              <dt className="pretzel-text-group-label">Lns</dt>
              <dd className="pretzel-readout">{String(stats.lines).padStart(3, "0")}</dd>
              <dt className="pretzel-text-group-label">Snt</dt>
              <dd className="pretzel-readout">{String(stats.sent).padStart(3, "0")}</dd>
            </dl>
            <div className="pretzel-text-group-label tetris-label--opp" title={props.opponentName}>
              {props.opponentName}
            </div>
            <canvas ref={oppRef} className="tetris-canvas" aria-label="Opponent board" />
          </div>
          <canvas ref={mainRef} className="tetris-canvas" aria-label="Your board" />
        </div>
      </div>
      <TouchPad onPress={press} onRelease={release} />
    </>
  );
}

/** Empty board behind the lobby / waiting overlays, so the shell keeps its shape. */
export function IdleStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLCanvasElement>(null);
  const cell = useFitCell(stageRef, fitPlayer);
  useEffect(() => {
    if (mainRef.current) drawSnapshot(mainRef.current, null, cell);
  }, [cell]);
  return (
    <>
      <div ref={stageRef} className="tetris-stage">
        <div className="tetris-boards">
          <div className="tetris-side" style={{ width: sideLayout(cell).sideW }} />
          <canvas ref={mainRef} className="tetris-canvas" aria-hidden />
        </div>
      </div>
      <TouchPad disabled />
    </>
  );
}

/** Third-party view: both players' relayed boards side by side. */
export function SpectatorStage({
  matchId,
  names,
  subscribe,
}: {
  matchId: string;
  names: [string, string];
  subscribe: (fn: (e: TetrisEvent) => void) => () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const refs = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];
  const boards = useRef<[string | null, string | null]>([null, null]);
  const size = useFitCell(stageRef, fitSpectator);

  useEffect(() => {
    boards.current = [null, null];
  }, [matchId]);

  useEffect(() => {
    const draw = () => refs.forEach((r, i) => r.current && drawSnapshot(r.current, boards.current[i], size));
    draw();
    return subscribe((e) => {
      if (e.type !== "board" || e.matchId !== matchId) return;
      boards.current[e.seat] = e.cells;
      draw();
    });
    // refs are stable objects, so they are not listed as dependencies.
  }, [matchId, size, subscribe]);

  return (
    <>
      <div ref={stageRef} className="tetris-stage">
        <div className="tetris-spectate">
          {refs.map((r, i) => (
            <div key={i} className="tetris-spectate-board">
              <div className="pretzel-text-group-label">{names[i]}</div>
              <canvas ref={r} className="tetris-canvas" aria-label={`${names[i]} board`} />
            </div>
          ))}
        </div>
      </div>
      <div className="tetris-pad pretzel-nav-gradient tetris-pad--label">
        <span className="pretzel-readout">SPECTATING</span>
      </div>
    </>
  );
}
