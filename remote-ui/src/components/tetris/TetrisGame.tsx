import { useEffect, useRef, useState, type RefObject } from "react";
import { Game, type Action } from "../../lib/tetris/engine";
import { drawGame, drawQueue, drawSnapshot } from "../../lib/tetris/render";
import type { ClientMessage, TetrisEvent, TetrisStatus } from "../../lib/tetrisSocket";

const KEYS: Record<string, Action> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowDown: "soft",
  ArrowUp: "cw",
  KeyX: "cw",
  KeyZ: "ccw",
  Space: "hard",
};
const HIDDEN_FORFEIT_MS = 3000;

/** Cell size in CSS px that fits the main board plus the side column in the container and viewport. */
export function useCellSize(ref: RefObject<HTMLElement | null>): number {
  const [cell, setCell] = useState(24);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const calc = () => {
      // Main board is 10 cells wide; the side column is 5 cells (opponent at half size).
      const byW = Math.floor((el.clientWidth - 12) / 15);
      const byH = Math.floor((window.innerHeight - 300) / 20);
      setCell(Math.max(12, Math.min(30, byW, byH)));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    window.addEventListener("resize", calc);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", calc);
    };
  }, [ref]);
  return cell;
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
  /** Shown over the board once the match is over. */
  resultText: string | null;
  send: (m: ClientMessage) => void;
  subscribe: (fn: (e: TetrisEvent) => void) => () => void;
};

/** Local player's game: runs the engine in a rAF loop and syncs sparse events with the Pi. */
export function TetrisGame(props: Props) {
  const { matchId, seed, you, send, subscribe } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLCanvasElement>(null);
  const queueRef = useRef<HTMLCanvasElement>(null);
  const oppRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const cell = useCellSize(wrapRef);
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

      let overlay: string | null = null;
      if (L.status === "over") overlay = L.resultText;
      else if (!game.started) overlay = String(Math.max(1, Math.ceil((L.startsAt - serverNow) / 1000)));

      if (mainRef.current) drawGame(mainRef.current, game, L.cell, overlay);
      if (queueRef.current) drawQueue(queueRef.current, game.nextPieces(3), Math.round(L.cell * 0.6));
      if (oppRef.current) drawSnapshot(oppRef.current, oppCells, Math.round(L.cell / 2));

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

  // Keyboard: engine handles auto-repeat, so ignore the OS key repeat.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const a = KEYS[e.code];
      if (!a) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      if (!e.repeat) gameRef.current?.press(a);
    };
    const up = (e: KeyboardEvent) => {
      const a = KEYS[e.code];
      if (a) gameRef.current?.release(a);
    };
    const blur = () => {
      for (const a of ["left", "right", "soft"] as const) gameRef.current?.release(a);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

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

  const pad = (a: Action, label: string, aria: string) => (
    <button
      type="button"
      className="tetris-pad-btn"
      aria-label={aria}
      onPointerDown={(e) => {
        e.preventDefault();
        gameRef.current?.press(a);
      }}
      onPointerUp={() => gameRef.current?.release(a)}
      onPointerLeave={() => gameRef.current?.release(a)}
      onPointerCancel={() => gameRef.current?.release(a)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );

  return (
    <div ref={wrapRef} className="tetris-play">
      <div className="tetris-boards">
        <canvas ref={mainRef} className="tetris-canvas" aria-label="Your board" />
        <div className="tetris-side" style={{ width: cell * 5 }}>
          <div className="tetris-label">NEXT</div>
          <canvas ref={queueRef} className="tetris-canvas" aria-label="Next pieces" />
          <dl className="tetris-stats">
            <dt>LEVEL</dt>
            <dd>{stats.level}</dd>
            <dt>LINES</dt>
            <dd>{stats.lines}</dd>
            <dt>SENT</dt>
            <dd>{stats.sent}</dd>
          </dl>
          <div className="tetris-label tetris-label--opp" title={props.opponentName}>
            {props.opponentName}
          </div>
          <canvas ref={oppRef} className="tetris-canvas" aria-label="Opponent board" />
        </div>
      </div>
      <div className="tetris-pad">
        {pad("left", "◀", "Move left")}
        {pad("right", "▶", "Move right")}
        {pad("soft", "▼", "Soft drop")}
        {pad("ccw", "⟲", "Rotate counter-clockwise")}
        {pad("cw", "⟳", "Rotate clockwise")}
        {pad("hard", "⤓", "Hard drop")}
      </div>
    </div>
  );
}

/** Third-party view: both players' relayed boards side by side. */
export function SpectatorBoards({
  matchId,
  names,
  subscribe,
}: {
  matchId: string;
  names: [string, string];
  subscribe: (fn: (e: TetrisEvent) => void) => () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const refs = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];
  const boards = useRef<[string | null, string | null]>([null, null]);
  const cell = useCellSize(wrapRef);
  const size = Math.max(8, Math.round(cell * 0.7));

  useEffect(() => {
    boards.current = [null, null];
    const draw = () =>
      refs.forEach((r, i) => r.current && drawSnapshot(r.current, boards.current[i], size));
    draw();
    return subscribe((e) => {
      if (e.type !== "board" || e.matchId !== matchId) return;
      boards.current[e.seat] = e.cells;
      draw();
    });
    // refs are stable objects, so they are not listed as dependencies.
  }, [matchId, size, subscribe]);

  return (
    <div ref={wrapRef} className="tetris-spectate">
      {refs.map((r, i) => (
        <div key={i} className="tetris-spectate-board">
          <div className="tetris-label">{names[i]}</div>
          <canvas ref={r} className="tetris-canvas" aria-label={`${names[i]} board`} />
        </div>
      ))}
    </div>
  );
}
