import { useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import "../tetris.css";
import { Overlay } from "../components/tetris/Overlay";
import { IdleStage, SpectatorStage, TetrisGame } from "../components/tetris/TetrisGame";
import { enterFullscreen, exitFullscreen, useGameViewport } from "../lib/gameShell";
import { soundtrack, type SoundMode } from "../lib/tetris/soundtrack";
import { useTetris, type TetrisState } from "../lib/tetrisSocket";

const NAME_KEY = "pretzel_tetris_name";
const SOUND_CHOICES: { mode: SoundMode; label: string; note: string }[] = [
  { mode: "midi", label: "Chiptune (MIDI)", note: "Game Boy voices; speeds up with the game." },
  { mode: "mp3", label: "Recording (MP3)", note: "The original recording at its own tempo." },
  { mode: "off", label: "Off", note: "No music or sound effects." },
];

function nameOf(s: TetrisState, seat: 0 | 1): string {
  return s.players[seat]?.name ?? `Player ${seat + 1}`;
}

/** Name of whoever played that seat in the current/last match, even if they have since left. */
function matchName(s: TetrisState, seat: 0 | 1): string {
  return s.matchNames?.[seat] ?? nameOf(s, seat);
}

/** Short amber readout in the top bar. */
function topStatus(s: TetrisState | null, connected: boolean): string {
  if (!s) return connected ? "LOADING" : "CONNECTING";
  const you = s.you;
  switch (s.status) {
    case "waiting":
      return "WAITING";
    case "countdown":
      return "GET READY";
    case "active":
      return you !== null ? `VS ${matchName(s, you === 0 ? 1 : 0)}` : "SPECTATING";
    case "over":
      if (you !== null && !s.playedLast) return "WAITING";
      if (s.winner === null) return "GAME OVER";
      if (you === s.winner) return "YOU WIN";
      if (you !== null) return "GAME OVER";
      return `${matchName(s, s.winner)} WINS`;
  }
}

/** Why the match ended, from the reader's point of view. */
function resultReason(s: TetrisState): string {
  if (s.winner === null) return "";
  const loser = matchName(s, s.winner === 0 ? 1 : 0);
  if (s.you === s.winner) return `${loser} ${s.reason ?? ""}`.trim();
  return s.reason === "topped out" ? "You topped out." : `You ${s.reason}.`;
}

export function TetrisPage() {
  useGameViewport();
  const navigate = useNavigate();
  const { state, connected, error, clearError, clockOffset, send, subscribe } = useTetris();
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [help, setHelp] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const sound = useSyncExternalStore(soundtrack.subscribe, soundtrack.status);
  const [confirmExit, setConfirmExit] = useState(false);
  const [watching, setWatching] = useState(false);

  const you = state?.you ?? null;
  const inMatch = state?.status === "countdown" || state?.status === "active";
  const canJoin = !!state && you === null && !inMatch && state.players.some((p) => p === null);
  const opponent = state && you !== null ? state.players[you === 0 ? 1 : 0] : null;
  const hasMatch = !!state?.matchId && state.seed !== null && state.startsAt !== null;

  const exit = () => {
    if (you !== null) send({ type: "leave" });
    exitFullscreen();
    navigate("/");
  };
  const requestExit = () => (you !== null && inMatch ? setConfirmExit(true) : exit());

  const join = () => {
    const n = name.trim();
    try {
      if (n) localStorage.setItem(NAME_KEY, n);
    } catch {
      /* ignore */
    }
    enterFullscreen();
    soundtrack.unlock();
    send({ type: "join", name: n });
  };

  // ── stage: own game, spectator boards, or an empty board behind an overlay ──
  let stage;
  if (state && hasMatch && you !== null && state.playedLast) {
    stage = (
      <TetrisGame
        matchId={state.matchId!}
        seed={state.seed!}
        status={state.status}
        startsAt={state.startsAt!}
        clockOffset={clockOffset}
        you={you}
        opponentName={matchName(state, you === 0 ? 1 : 0)}
        send={send}
        subscribe={subscribe}
      />
    );
  } else if (state && hasMatch && you === null && watching) {
    stage = (
      <SpectatorStage matchId={state.matchId!} names={[matchName(state, 0), matchName(state, 1)]} subscribe={subscribe} />
    );
  } else {
    stage = <IdleStage />;
  }

  // ── overlays (at most one; settings and flows all live here) ──
  let overlay = null;
  if (confirmExit) {
    overlay = (
      <Overlay title="Leave match?" onClose={() => setConfirmExit(false)}>
        <p className="pretzel-text-panel-body">Leaving now forfeits the match to your opponent.</p>
        <div className="flex gap-2">
          <button type="button" className="pretzel-btn-secondary pretzel-key--danger" onClick={exit}>
            Leave
          </button>
          <button type="button" className="pretzel-btn-secondary" onClick={() => setConfirmExit(false)}>
            Keep playing
          </button>
        </div>
      </Overlay>
    );
  } else if (soundOpen) {
    const live =
      sound.mode === "off"
        ? "OFF"
        : `${sound.mode.toUpperCase()} · ${sound.playing ? (sound.mode === "midi" ? `${sound.rate.toFixed(2)}×` : "PLAYING") : "READY"}`;
    overlay = (
      <Overlay title="Sound" onClose={() => setSoundOpen(false)}>
        <p className="pretzel-readout tetris-overlay__readout">{live}</p>
        <div className="flex flex-col gap-2">
          {SOUND_CHOICES.map((c) => (
            <button
              key={c.mode}
              type="button"
              aria-pressed={sound.mode === c.mode}
              className={`pretzel-btn-secondary tetris-sound-choice${sound.mode === c.mode ? " pretzel-key--accent" : ""}`}
              onClick={() => soundtrack.setMode(c.mode)}
            >
              <span>{c.label}</span>
              <span className="tetris-sound-choice__note">{c.note}</span>
            </button>
          ))}
        </div>
      </Overlay>
    );
  } else if (help) {
    overlay = (
      <Overlay title="How to play" onClose={() => setHelp(false)}>
        <dl className="pretzel-well tetris-legend">
          <dt>◀ ▶</dt>
          <dd>Move. Hold to slide.</dd>
          <dt>⟳</dt>
          <dd>Rotate clockwise.</dd>
          <dt>▼</dt>
          <dd>Soft drop while held.</dd>
          <dt>▼▼</dt>
          <dd>Double-tap to hard drop.</dd>
          <dt>♪</dt>
          <dd>Choose the music. The chiptune speeds up with the game; clearing 2+ lines plays a chime.</dd>
        </dl>
        <p className="pretzel-text-panel-body">
          Clearing 2 / 3 / 4 lines at once sends 1 / 2 / 4 garbage rows to your opponent. Your own clears cancel
          incoming garbage first; the red bar beside your board shows what is queued. First to top out loses.
          Leaving or locking your phone during a match forfeits it.
        </p>
      </Overlay>
    );
  } else if (!state) {
    overlay = (
      <Overlay title="Tetris">
        <p className="pretzel-text-panel-muted">{connected ? "Loading…" : "Connecting to Pretzel…"}</p>
      </Overlay>
    );
  } else if (you === null && (!watching || canJoin)) {
    overlay = (
      <Overlay title="Tetris">
        <p className="pretzel-text-panel-muted">
          {state.players[0] ? nameOf(state, 0) : "Open seat"} <span className="tetris-vs">vs</span>{" "}
          {state.players[1] ? nameOf(state, 1) : "Open seat"}
        </p>
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
              enterKeyHint="go"
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" className="pretzel-btn-secondary pretzel-key--accent">
              Join
            </button>
          </form>
        ) : (
          <>
            <p className="pretzel-readout pretzel-readout--lg tetris-overlay__readout">
              {inMatch ? "MATCH IN PROGRESS" : "SEATS TAKEN"}
            </p>
            <button type="button" className="pretzel-btn-secondary pretzel-key--accent" onClick={() => setWatching(true)}>
              Watch
            </button>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="pretzel-btn-secondary" onClick={() => setHelp(true)}>
            How to play
          </button>
          <button type="button" className="pretzel-btn-secondary" onClick={() => setSoundOpen(true)}>
            Sound
          </button>
          <button type="button" className="pretzel-btn-secondary" onClick={exit}>
            Exit
          </button>
        </div>
      </Overlay>
    );
  } else if (you !== null && (state.status === "waiting" || (state.status === "over" && !state.playedLast))) {
    // Waiting for a second player, or seated next to someone still looking at their last result.
    const other = opponent ? opponent.name.toUpperCase() : null;
    overlay = (
      <Overlay title="Tetris">
        <p className="pretzel-readout pretzel-readout--lg tetris-overlay__readout">
          {other ? `WAITING FOR ${other}` : "WAITING FOR PLAYER 2"}
        </p>
        <p className="pretzel-text-panel-muted">
          {other ? "The match starts when they press Play again." : "Ask someone to open Tetris on their phone."}
        </p>
        <button type="button" className="pretzel-btn-secondary" onClick={exit}>
          Leave
        </button>
      </Overlay>
    );
  } else if (you !== null && state.status === "over") {
    const won = state.winner === you;
    overlay = (
      <Overlay title={won ? "Victory" : "Defeat"}>
        <p className="pretzel-readout pretzel-readout--xl tetris-overlay__readout">{won ? "YOU WIN!" : "GAME OVER"}</p>
        <p className="pretzel-text-panel-muted">{resultReason(state)}</p>
        <div className="flex flex-wrap items-center gap-2">
          {state.players[you]?.ready ? (
            <span className="pretzel-text-panel-muted">
              {opponent ? "Waiting for opponent…" : "Waiting for a new opponent…"}
            </span>
          ) : (
            <button
              type="button"
              className="pretzel-btn-secondary pretzel-key--accent"
              onClick={() => {
                enterFullscreen();
                soundtrack.unlock();
                send({ type: "ready" });
              }}
            >
              Play again
            </button>
          )}
          <button type="button" className="pretzel-btn-secondary" onClick={exit}>
            Exit
          </button>
        </div>
      </Overlay>
    );
  }

  return (
    <div
      className="tetris-shell"
      data-sound={`${sound.mode}:${sound.playing ? "playing" : "stopped"}:${sound.rate.toFixed(2)}`}
      data-sfx={sound.sfx}
    >
      <header className="tetris-top">
        <button type="button" className="pretzel-btn-icon" aria-label="Exit" onClick={requestExit}>
          ✕
        </button>
        <div className="tetris-top__mid">
          <span className={`pretzel-led ${connected ? "pretzel-led--ok" : "pretzel-led--off"}`} aria-hidden />
          <span className="pretzel-readout tetris-top__status" role="status">
            {topStatus(state, connected)}
          </span>
        </div>
        <div className="tetris-top__right">
          <button type="button" className="pretzel-btn-icon" aria-label="Sound" onClick={() => setSoundOpen(true)}>
            ♪
          </button>
          <button type="button" className="pretzel-btn-icon" aria-label="How to play" onClick={() => setHelp(true)}>
            ?
          </button>
        </div>
      </header>

      {stage}

      {error ? (
        <button type="button" className="tetris-toast pretzel-text-alert" onClick={clearError}>
          {error} ✕
        </button>
      ) : null}

      {overlay}
    </div>
  );
}
