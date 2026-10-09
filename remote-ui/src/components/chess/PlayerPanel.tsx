import { useEffect, useState, type RefObject } from "react";
import type { ChessState, Color } from "../../lib/chessSocket";
import { parseFen } from "./Board";
import { Piece } from "./Piece";
import type { PieceType } from "./sprites";

const ORDER: PieceType[] = ["q", "r", "b", "n", "p"];
const VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/**
 * Net material per side: for each piece type, the surplus one side has over
 * the other (so promotions never show up as phantom captures), plus the point
 * balance for White.
 */
export function material(fen: string) {
  const count = { w: {} as Record<string, number>, b: {} as Record<string, number> };
  let balance = 0;
  for (const p of Object.values(parseFen(fen))) {
    count[p.c][p.t] = (count[p.c][p.t] ?? 0) + 1;
    balance += (p.c === "w" ? 1 : -1) * VALUE[p.t];
  }
  const surplus = (me: "w" | "b", them: "w" | "b") =>
    ORDER.flatMap((t) => Array<PieceType>(Math.max(0, (count[me][t] ?? 0) - (count[them][t] ?? 0))).fill(t));
  return { up: { white: surplus("w", "b"), black: surplus("b", "w") }, balance };
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** LED clock that ticks locally from the last server snapshot. */
function Clock({ ms, running, since }: { ms: number; running: boolean; since: RefObject<number> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => tick((t) => t + 1), 200);
    return () => window.clearInterval(id);
  }, [running]);
  const left = running ? ms - (Date.now() - since.current) : ms;
  return (
    <span className={`win-lcd${left < 20_000 ? " win-lcd--low" : ""}`} aria-label="Time left">
      {fmtClock(left)}
    </span>
  );
}

export function PlayerPanel({
  state,
  color,
  receivedAt,
}: {
  state: ChessState;
  color: Color;
  receivedAt: RefObject<number>;
}) {
  const p = state.players[color];
  const onMove = state.status === "active" && state.turn === color;
  const { up, balance } = material(state.fen);
  // Drawn in the opponent's colour, as if captured.
  const captured = up[color];
  const lead = color === "white" ? balance : -balance;
  const timed = state.timeControl !== "untimed";
  return (
    <div className={`win-player${onMove ? " win-player--onmove" : ""}`}>
      <span className={`win-player-swatch win-player-swatch--${color}`} aria-hidden />
      <div className="win-player-main">
        <div className="win-player-name">
          {p ? p.name : <i>Empty seat</i>}
          {p && state.you === color ? <span className="win-tag">You</span> : null}
          {p && !p.connected ? <span className="win-tag win-tag--off">Offline</span> : null}
        </div>
        <div className="win-captured" aria-label="Material advantage">
          {captured.map((t, i) => (
            <Piece key={i} type={t} color={color === "white" ? "b" : "w"} className="win-captured-piece" />
          ))}
          {lead > 0 ? <span className="win-lead">+{lead}</span> : null}
        </div>
      </div>
      {timed ? (
        <Clock
          ms={state.clocks[color]}
          running={state.clockRunning && state.turn === color}
          since={receivedAt}
        />
      ) : null}
    </div>
  );
}
