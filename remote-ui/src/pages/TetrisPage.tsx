import { useState } from "react";
import { Link } from "react-router-dom";
import "../tetris.css";
import { SpectatorBoards, TetrisGame } from "../components/tetris/TetrisGame";
import { useTetris, type TetrisState } from "../lib/tetrisSocket";

const NAME_KEY = "pretzel_tetris_name";

function nameOf(s: TetrisState, seat: 0 | 1): string {
  return s.players[seat]?.name ?? `Player ${seat + 1}`;
}

/** Name of whoever played that seat in the current/last match, even if they have since left. */
function matchName(s: TetrisState, seat: 0 | 1): string {
  return s.matchNames?.[seat] ?? nameOf(s, seat);
}

function statusText(s: TetrisState): string {
  const you = s.you;
  switch (s.status) {
    case "waiting":
      return you !== null ? "Waiting for Player 2…" : "Waiting for players…";
    case "countdown":
      return "Get ready…";
    case "active":
      return you !== null ? "Match in Progress" : "Spectating";
    case "over": {
      if (s.winner === null) return "Game Over";
      const loser = matchName(s, s.winner === 0 ? 1 : 0);
      if (you === s.winner) return `You Win! ${loser} ${s.reason ?? ""}`.trim();
      if (you !== null) return s.reason === "topped out" ? "Game Over" : `Game Over — you ${s.reason}`;
      return `${matchName(s, s.winner)} wins — ${loser} ${s.reason ?? ""}`.trim();
    }
  }
}

export function TetrisPage() {
  const { state, connected, error, clearError, clockOffset, send, subscribe } = useTetris();
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });

  if (!state) {
    return (
      <div className="tetris-root">
        <h1 className="tetris-title">TETRIS</h1>
        <p className="tetris-status">{connected ? "Loading…" : "Connecting to Pretzel…"}</p>
      </div>
    );
  }

  const you = state.you;
  const inMatch = state.status === "countdown" || state.status === "active";
  const canJoin = you === null && !inMatch && state.players.some((p) => p === null);
  const opponent = you === null ? null : state.players[you === 0 ? 1 : 0];

  const join = () => {
    const n = name.trim();
    try {
      if (n) localStorage.setItem(NAME_KEY, n);
    } catch {
      /* ignore */
    }
    send({ type: "join", name: n });
  };

  let resultText: string | null = null;
  if (state.status === "over" && you !== null) resultText = state.winner === you ? "YOU WIN!" : "GAME OVER";

  return (
    <div className="tetris-root">
      <header className="tetris-header">
        <Link to="/" className="tetris-link">
          ← Home
        </Link>
        <h1 className="tetris-title">TETRIS</h1>
        <span className={`tetris-dot${connected ? " tetris-dot--on" : ""}`} title={connected ? "Connected" : "Reconnecting…"} />
      </header>

      <p className="tetris-status" role="status">
        {statusText(state)}
      </p>

      <div className="tetris-players">
        <span className={you === 0 ? "tetris-you" : undefined}>
          {state.players[0] ? nameOf(state, 0) : "—"}
          {state.players[0] && !state.players[0].connected ? " (away)" : ""}
        </span>
        <span className="tetris-vs">VS</span>
        <span className={you === 1 ? "tetris-you" : undefined}>
          {state.players[1] ? nameOf(state, 1) : "—"}
          {state.players[1] && !state.players[1].connected ? " (away)" : ""}
        </span>
      </div>

      {error ? (
        <button type="button" className="tetris-error" onClick={clearError}>
          {error} ✕
        </button>
      ) : null}

      {canJoin ? (
        <form
          className="tetris-join"
          onSubmit={(e) => {
            e.preventDefault();
            join();
          }}
        >
          <input
            className="tetris-input"
            value={name}
            maxLength={20}
            placeholder="Your name"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="tetris-btn tetris-btn--primary">
            Join
          </button>
        </form>
      ) : null}

      {you !== null ? (
        <div className="tetris-actions">
          {state.status === "over" ? (
            state.players[you]?.ready ? (
              <span className="tetris-hint">
                {opponent ? "Waiting for opponent…" : "Waiting for a new opponent…"}
              </span>
            ) : (
              <button type="button" className="tetris-btn tetris-btn--primary" onClick={() => send({ type: "ready" })}>
                Play again
              </button>
            )
          ) : null}
          <button type="button" className="tetris-btn" onClick={() => send({ type: "leave" })}>
            Leave
          </button>
        </div>
      ) : null}

      {state.matchId && state.seed !== null && state.startsAt !== null ? (
        you !== null ? (
          <TetrisGame
            matchId={state.matchId}
            seed={state.seed}
            status={state.status}
            startsAt={state.startsAt}
            clockOffset={clockOffset}
            you={you}
            opponentName={matchName(state, you === 0 ? 1 : 0)}
            resultText={resultText}
            send={send}
            subscribe={subscribe}
          />
        ) : (
          <SpectatorBoards matchId={state.matchId} names={[matchName(state, 0), matchName(state, 1)]} subscribe={subscribe} />
        )
      ) : null}

      <p className="tetris-help">
        ← → move · ↑ / X rotate · Z rotate back · ↓ soft drop · Space hard drop. Clearing 2 / 3 / 4 lines sends 1 / 2 / 4
        garbage rows; your clears cancel incoming garbage first (red bar).
      </p>
    </div>
  );
}
