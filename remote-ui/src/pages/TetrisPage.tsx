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

  const header = (
    <div className="mb-6 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="pretzel-page-title">Tetris</h1>
        <p className="pretzel-page-subtitle">Two-player versus</p>
      </div>
      <Link to="/" className="pretzel-btn-ghost">
        ← Home
      </Link>
    </div>
  );

  if (!state) {
    return (
      <div className="py-4">
        {header}
        <p className="pretzel-text-panel-muted">{connected ? "Loading…" : "Connecting to Pretzel…"}</p>
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

  const player = (seat: 0 | 1) => {
    const p = state.players[seat];
    if (!p) return <span className="tetris-player tetris-player--empty">Open seat</span>;
    return (
      <span className={`tetris-player${you === seat ? " tetris-player--you" : ""}`}>
        {p.name}
        {p.connected ? "" : " (away)"}
      </span>
    );
  };

  return (
    <div className="py-4">
      {header}

      <section className="pretzel-panel tetris-root" aria-label="Match">
        <div className="pretzel-panel__header">
          <div className="min-w-0">
            <h2 className="pretzel-text-panel-title">Match</h2>
            <p className="pretzel-text-panel-muted">
              {player(0)} <span className="tetris-vs">vs</span> {player(1)}
            </p>
          </div>
          <span
            className={`pretzel-led mt-1.5 ${connected ? "pretzel-led--ok" : "pretzel-led--off"}`}
            title={connected ? "Connected" : "Reconnecting…"}
            aria-hidden
          />
        </div>

        <div className="pretzel-panel__body flex flex-col gap-4">
          <p className="pretzel-readout pretzel-readout--lg tetris-status" role="status">
            {statusText(state)}
          </p>

          {error ? (
            <button type="button" className="pretzel-text-alert text-left text-sm" onClick={clearError}>
              {error} ✕
            </button>
          ) : null}

          {canJoin ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                join();
              }}
            >
              <input
                className="pretzel-input"
                value={name}
                maxLength={20}
                placeholder="Your name"
                aria-label="Your name"
                onChange={(e) => setName(e.target.value)}
              />
              <button type="submit" className="pretzel-btn-secondary pretzel-key--accent">
                Join
              </button>
            </form>
          ) : null}

          {you !== null ? (
            <div className="flex flex-wrap items-center gap-2">
              {state.status === "over" ? (
                state.players[you]?.ready ? (
                  <span className="pretzel-text-panel-muted">
                    {opponent ? "Waiting for opponent…" : "Waiting for a new opponent…"}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="pretzel-btn-secondary pretzel-key--accent"
                    onClick={() => send({ type: "ready" })}
                  >
                    Play again
                  </button>
                )
              ) : null}
              <button type="button" className="pretzel-btn-secondary" onClick={() => send({ type: "leave" })}>
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
              <SpectatorBoards
                matchId={state.matchId}
                names={[matchName(state, 0), matchName(state, 1)]}
                subscribe={subscribe}
              />
            )
          ) : null}
        </div>
      </section>

      <section className="pretzel-panel mt-6" aria-label="How to play">
        <div className="pretzel-panel__header">
          <h2 className="pretzel-text-panel-title">How to play</h2>
        </div>
        <div className="pretzel-panel__body">
          <p className="pretzel-text-panel-body">
            ← → move · ↑ / X rotate · Z rotate back · ↓ soft drop · Space hard drop. On a phone, use the keys under
            the board. Clearing 2 / 3 / 4 lines sends 1 / 2 / 4 garbage rows; your own clears cancel incoming garbage
            first (the red bar beside your board).
          </p>
        </div>
      </section>
    </div>
  );
}
