import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import "../tetris.css";
import "../chess.css";
import { Avatar } from "../components/chess/Avatar";
import { Board, kingSquare, parseFen, PIECE_NAMES } from "../components/chess/Board";
import { PastGames } from "../components/chess/PastGames";
import { Piece, type PieceType } from "../components/chess/Piece";
import { PixelName } from "../components/chess/PixelName";
import { Overlay } from "../components/tetris/Overlay";
import { AVATARS, expressionFor } from "../lib/chessAvatars";
import { playMoveSound, unlockChessSounds } from "../lib/chessSounds";
import { useChess, type ChessState, type Color } from "../lib/chessSocket";
import { resultLine, seatStatus, TONE_LED, topReadout } from "../lib/chessStatus";
import { enterFullscreen, exitFullscreen, useGameViewport } from "../lib/gameShell";

const NAME_KEY = "pretzel_chess_name";
const FLIP_KEY = "pretzel_chess_flip";
const AVATAR_KEY = "pretzel_chess_avatar";
const ORDER: PieceType[] = ["q", "r", "b", "n", "p"];
const VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function readLocal(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** Net material per side (surplus per piece type, so promotions never look like captures). */
function material(fen: string) {
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

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Amber readout that ticks locally from the last server snapshot. */
function Clock({ ms, running, since }: { ms: number; running: boolean; since: RefObject<number> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => tick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [running]);
  const left = running ? ms - (Date.now() - since.current) : ms;
  return (
    <span className={`pretzel-readout pretzel-readout--lg chess-clock${left < 20_000 ? " chess-clock--low" : ""}`}>
      {fmtClock(left)}
    </span>
  );
}

/** Portrait, name (Fraktur), clock, and the status line for one side of the board. */
function SeatRow({ state, color, receivedAt }: { state: ChessState; color: Color; receivedAt: RefObject<number> }) {
  const p = state.players[color];
  const status = seatStatus(state, color);
  const { up, balance } = material(state.fen);
  const lead = color === "white" ? balance : -balance;
  const name = p ? p.name : "Open seat";
  return (
    <div className={`chess-seat chess-seat--${status.tone}`}>
      <Avatar id={p?.avatar ?? null} expression={expressionFor(state, color)} />
      <div className="chess-seat__info">
        <div className="chess-seat__top">
          <PixelName text={name} className={p ? "" : "chess-pixelname--empty"} />
          {state.timeControl !== "untimed" ? (
            <Clock ms={state.clocks[color]} running={state.clockRunning && state.turn === color} since={receivedAt} />
          ) : null}
        </div>
        <div className="chess-seat__status" role="status">
          <span className={TONE_LED[status.tone]} aria-hidden />
          <span className="chess-seat__text">{status.text}</span>
          <span className="chess-seat__material" aria-label="Material advantage">
            {up[color].map((t, i) => (
              <Piece key={i} type={t} color={color === "white" ? "b" : "w"} className="chess-piece chess-piece--tiny" />
            ))}
            {lead > 0 ? <span>+{lead}</span> : null}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Walnut strip at the bottom: clock choice before the first move, then the move list. */
function MovesBar({ state, send }: { state: ChessState; send: ReturnType<typeof useChess>["send"] }) {
  const strip = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = strip.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [state.moves.length]);

  let body;
  if (state.can.setTimeControl) {
    body = (
      <div className="chess-tc" role="radiogroup" aria-label="Time control">
        <span className="pretzel-text-group-label">Clock</span>
        {state.timeControls.map((tc) => (
          <button
            key={tc.id}
            type="button"
            role="radio"
            aria-checked={state.timeControl === tc.id}
            className={`pretzel-btn-secondary chess-tc__key${state.timeControl === tc.id ? " pretzel-key--accent" : ""}`}
            onClick={() => send({ type: "setTimeControl", id: tc.id })}
          >
            {tc.id === "untimed" ? "∞" : tc.id.replace("+0", "").replace("+", "|")}
          </button>
        ))}
      </div>
    );
  } else if (state.moves.length === 0) {
    body = (
      <p className="chess-moves__empty">
        {state.status === "waiting" ? "Waiting for two players…" : "White to start"}
      </p>
    );
  } else {
    body = (
      <ol className="chess-moves" ref={strip} aria-label="Moves">
        {state.moves.map((m, i) => (
          <li key={i} className={i === state.moves.length - 1 ? "chess-moves__last" : undefined}>
            {i % 2 === 0 ? <span className="chess-moves__no">{i / 2 + 1}.</span> : null}
            {m.san}
          </li>
        ))}
      </ol>
    );
  }
  return <div className="chess-bar pretzel-nav-gradient">{<div className="pretzel-well chess-bar__well">{body}</div>}</div>;
}

type View = "menu" | "join" | "game";

export function ChessPage() {
  useGameViewport();
  const navigate = useNavigate();
  const { state, connected, error, clearError, receivedAt, send } = useChess();
  const [view, setView] = useState<View>("menu");
  const [sheet, setSheet] = useState<null | "menu" | "past" | "help" | "resign">(null);
  const [name, setName] = useState(() => readLocal(NAME_KEY));
  const [flip, setFlip] = useState(() => readLocal(FLIP_KEY) === "1");
  const [avatar, setAvatar] = useState(() => Number(readLocal(AVATAR_KEY)) || AVATARS[0].id);
  const [selected, setSelected] = useState<string | null>(null);
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null);
  const [seenResult, setSeenResult] = useState<string | null>(null);

  const you = state?.you ?? null;

  // Seated players (including after a reload) go straight to the board.
  useEffect(() => {
    if (you) setView("game");
  }, [you]);

  useEffect(() => {
    setSelected(null);
    setPromo(null);
  }, [state?.fen]);

  // Any tap may unlock audio (mobile browsers need a gesture before sound plays).
  useEffect(() => {
    document.addEventListener("pointerdown", unlockChessSounds);
    return () => document.removeEventListener("pointerdown", unlockChessSounds);
  }, []);

  // Click on every new move (not on load); also buzz when the opponent moves, so the phone can sit on the table.
  const seenPly = useRef<number | null>(null);
  useEffect(() => {
    if (!state) return;
    const ply = state.moves.length;
    const prev = seenPly.current;
    seenPly.current = ply;
    if (prev === null || ply <= prev) return;
    playMoveSound();
    if (state.you && state.moves[ply - 1].color !== state.you) navigator.vibrate?.(40);
  }, [state]);

  useEffect(() => {
    const prev = document.title;
    document.title = state?.status === "active" && you === state.turn ? "● Your move — Chess" : "Chess";
    return () => {
      document.title = prev;
    };
  }, [state, you]);

  const myTurn = !!state && state.status === "active" && you === state.turn;
  const targets = useMemo(() => {
    if (!state || !selected) return new Set<string>();
    return new Set(state.legalMoves.filter((m) => m.from === selected).map((m) => m.to));
  }, [state, selected]);
  const movable = useMemo(() => new Set(state?.legalMoves.map((m) => m.from) ?? []), [state]);

  const exit = () => {
    exitFullscreen();
    navigate("/");
  };

  // The opponent's character can't be picked; fall back to the first free one.
  const takenAvatars = new Set([state?.players.white?.avatar, state?.players.black?.avatar]);
  const pick = takenAvatars.has(avatar) ? (AVATARS.find((a) => !takenAvatars.has(a.id))?.id ?? avatar) : avatar;

  const sit = (color: Color) => {
    const n = name.trim();
    if (!n) return;
    writeLocal(NAME_KEY, n);
    writeLocal(AVATAR_KEY, String(pick));
    enterFullscreen();
    send({ type: "sit", name: n, color, avatar: pick });
  };

  const onSquare = (sq: string) => {
    if (!state || !myTurn) return;
    if (selected && targets.has(sq)) {
      const cands = state.legalMoves.filter((m) => m.from === selected && m.to === sq);
      if (cands.some((m) => m.promotion)) setPromo({ from: selected, to: sq });
      else send({ type: "move", from: selected, to: sq });
      setSelected(null);
      return;
    }
    setSelected(movable.has(sq) && sq !== selected ? sq : null);
  };

  const flipped = (you === "black") !== flip;
  const top: Color = flipped ? "white" : "black";
  const bottom: Color = flipped ? "black" : "white";

  // ── overlays: at most one, in priority order ──
  let overlay = null;
  if (!state) {
    overlay = (
      <Overlay title="Chess">
        <p className="pretzel-text-panel-muted">{connected ? "Loading…" : "Connecting to Pretzel…"}</p>
      </Overlay>
    );
  } else if (sheet === "past") {
    overlay = <PastGames onClose={() => setSheet(null)} />;
  } else if (sheet === "help") {
    overlay = (
      <Overlay title="How to play" onClose={() => setSheet(null)}>
        <p className="pretzel-text-panel-body">
          Open Chess on two phones. Each player taps Play, enters a name and takes a side; anyone else can watch.
        </p>
        <p className="pretzel-text-panel-body">
          Tap a piece, then one of the marked squares. The Pi checks every move, runs the clocks and keeps finished
          games under Past games. Leaving the page keeps your seat; come back on the same phone to continue.
        </p>
        <dl className="pretzel-well tetris-legend">
          <dt>Green</dt>
          <dd>That player's move.</dd>
          <dt>Amber</dt>
          <dd>Check, or a draw offer.</dd>
          <dt>Red</dt>
          <dd>Offline; their clock still runs.</dd>
        </dl>
      </Overlay>
    );
  } else if (view === "menu") {
    const p = state.players;
    overlay = (
      <Overlay title="Chess">
        <p className="pretzel-text-panel-muted">
          {p.white?.name ?? "Open seat"} <span className="tetris-vs">vs</span> {p.black?.name ?? "Open seat"}
          {state.status === "active" && state.moves.length > 0 ? " · in progress" : ""}
        </p>
        <div className="chess-menu">
          <button type="button" className="pretzel-btn-secondary pretzel-key--accent" onClick={() => setView(you ? "game" : "join")}>
            {you ? "Resume game" : "Play"}
          </button>
          <button type="button" className="pretzel-btn-secondary" onClick={() => setSheet("past")}>
            Past games
          </button>
          <button type="button" className="pretzel-btn-secondary" onClick={exit}>
            Exit
          </button>
        </div>
      </Overlay>
    );
  } else if (view === "join") {
    const can = state.can;
    const seatOpen = can.sit.white || can.sit.black;
    const named = !!name.trim();
    overlay = (
      <Overlay title="Join game" onClose={() => setView("menu")}>
        {seatOpen ? (
          <div className="chess-avatar-pick" role="radiogroup" aria-label="Character">
            {AVATARS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={pick === a.id}
                aria-label={a.name}
                disabled={takenAvatars.has(a.id)}
                className="chess-avatar-pick__key"
                onClick={() => setAvatar(a.id)}
              >
                <Avatar id={a.id} expression={pick === a.id ? "smug" : "neutral"} />
              </button>
            ))}
          </div>
        ) : null}
        {seatOpen ? (
          <input
            className="pretzel-input"
            value={name}
            maxLength={20}
            placeholder="Your name"
            aria-label="Your name"
            autoComplete="nickname"
            enterKeyHint="done"
            onChange={(e) => setName(e.target.value)}
          />
        ) : (
          <p className="pretzel-readout pretzel-readout--lg tetris-overlay__readout">
            {state.status === "over" ? "GAME FINISHED" : "SEATS TAKEN"}
          </p>
        )}
        <div className="chess-menu">
          {can.sit.white ? (
            <button type="button" className="pretzel-btn-secondary pretzel-key--accent" disabled={!named} onClick={() => sit("white")}>
              <Piece type="k" color="w" className="chess-piece chess-piece--btn" /> Play White
            </button>
          ) : null}
          {can.sit.black ? (
            <button type="button" className="pretzel-btn-secondary pretzel-key--accent" disabled={!named} onClick={() => sit("black")}>
              <Piece type="k" color="b" className="chess-piece chess-piece--btn" /> Play Black
            </button>
          ) : null}
          {state.status === "over" && can.newGame ? (
            <button type="button" className="pretzel-btn-secondary pretzel-key--accent" onClick={() => send({ type: "newGame" })}>
              Set up a new board
            </button>
          ) : null}
          <button type="button" className="pretzel-btn-secondary" onClick={() => setView("game")}>
            Watch
          </button>
        </div>
        {seatOpen && !named ? <p className="pretzel-text-panel-muted">Enter a name to take a seat.</p> : null}
      </Overlay>
    );
  } else if (promo) {
    overlay = (
      <Overlay title="Promote to" onClose={() => setPromo(null)}>
        <div className="chess-promo">
          {(["q", "r", "b", "n"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className="pretzel-btn-icon-wide chess-promo__key"
              aria-label={`Promote to ${PIECE_NAMES[t]}`}
              onClick={() => {
                send({ type: "move", from: promo.from, to: promo.to, promotion: t });
                setPromo(null);
              }}
            >
              <Piece type={t} color={you === "black" ? "b" : "w"} />
            </button>
          ))}
        </div>
      </Overlay>
    );
  } else if (state.status === "active" && you && state.drawOffer && state.drawOffer !== you) {
    overlay = (
      <Overlay title="Draw offer">
        <p className="pretzel-text-panel-body">{state.players[state.drawOffer]?.name ?? "Your opponent"} offers a draw.</p>
        <div className="flex gap-2">
          <button type="button" className="pretzel-btn-secondary pretzel-key--accent" onClick={() => send({ type: "respondDraw", accept: true })}>
            Accept draw
          </button>
          <button type="button" className="pretzel-btn-secondary" onClick={() => send({ type: "respondDraw", accept: false })}>
            Play on
          </button>
        </div>
      </Overlay>
    );
  } else if (sheet === "resign") {
    overlay = (
      <Overlay title="Resign?" onClose={() => setSheet(null)}>
        <p className="pretzel-text-panel-body">The game is recorded as a loss.</p>
        <div className="flex gap-2">
          <button
            type="button"
            className="pretzel-btn-secondary pretzel-key--danger"
            onClick={() => {
              send({ type: "resign" });
              setSheet(null);
            }}
          >
            Resign
          </button>
          <button type="button" className="pretzel-btn-secondary" onClick={() => setSheet(null)}>
            Keep playing
          </button>
        </div>
      </Overlay>
    );
  } else if (sheet === "menu") {
    const can = state.can;
    const youOffered = state.drawOffer === you && state.status === "active";
    const act = (fn: () => void) => () => {
      setSheet(null);
      fn();
    };
    overlay = (
      <Overlay title="Game" onClose={() => setSheet(null)}>
        <div className="chess-menu">
          {youOffered ? (
            <button type="button" className="pretzel-btn-secondary" onClick={act(() => send({ type: "respondDraw", accept: false }))}>
              Withdraw draw offer
            </button>
          ) : can.offerDraw ? (
            <button type="button" className="pretzel-btn-secondary" onClick={act(() => send({ type: "offerDraw" }))}>
              Offer draw
            </button>
          ) : null}
          {can.resign && state.moves.length > 0 ? (
            <button type="button" className="pretzel-btn-secondary pretzel-key--danger" onClick={() => setSheet("resign")}>
              Resign…
            </button>
          ) : null}
          {can.newGame ? (
            <button type="button" className="pretzel-btn-secondary pretzel-key--accent" onClick={act(() => send({ type: "newGame" }))}>
              {state.status === "over" ? (you ? "Rematch (swap colours)" : "New game") : "Swap colours"}
            </button>
          ) : null}
          {can.stand ? (
            <button type="button" className="pretzel-btn-secondary" onClick={act(() => send({ type: "stand" }))}>
              Leave seat
            </button>
          ) : null}
          <button
            type="button"
            className="pretzel-btn-secondary"
            onClick={act(() => {
              setFlip(!flip);
              writeLocal(FLIP_KEY, flip ? "0" : "1");
            })}
          >
            Flip board
          </button>
          <button type="button" className="pretzel-btn-secondary" onClick={() => setSheet("past")}>
            Past games
          </button>
          <button type="button" className="pretzel-btn-secondary" onClick={act(() => setView("menu"))}>
            Main menu
          </button>
        </div>
      </Overlay>
    );
  } else if (state.status === "over" && you && seenResult !== state.id) {
    const won = state.result === (you === "white" ? "1-0" : "0-1");
    const drawn = state.result === "1/2-1/2";
    overlay = (
      <Overlay title={won ? "Victory" : drawn ? "Draw" : "Defeat"} onClose={() => setSeenResult(state.id)}>
        <p className="pretzel-readout pretzel-readout--xl tetris-overlay__readout">
          {won ? "YOU WIN!" : drawn ? "DRAW" : "GAME OVER"}
        </p>
        <p className="pretzel-text-panel-muted">{resultLine(state.result, state.reason)}</p>
        <div className="flex flex-wrap gap-2">
          {state.can.newGame ? (
            <button type="button" className="pretzel-btn-secondary pretzel-key--accent" onClick={() => send({ type: "newGame" })}>
              Rematch
            </button>
          ) : null}
          <button type="button" className="pretzel-btn-secondary" onClick={() => setSeenResult(state.id)}>
            View board
          </button>
        </div>
      </Overlay>
    );
  }

  const showCheck = !!state && state.inCheck && (state.status === "active" || state.reason === "checkmate");
  const checkSq = showCheck ? kingSquare(state.fen, state.turn) : null;

  return (
    <div className="tetris-shell chess-shell">
      <header className="tetris-top">
        <button type="button" className="pretzel-btn-icon" aria-label="Exit" onClick={exit}>
          ✕
        </button>
        <div className="tetris-top__mid">
          <span className={`pretzel-led ${connected ? "pretzel-led--ok" : "pretzel-led--off"}`} aria-hidden />
          <span className="pretzel-readout tetris-top__status" role="status">
            {topReadout(state, connected)}
          </span>
        </div>
        <button
          type="button"
          className="pretzel-btn-icon"
          aria-label={view === "game" ? "Game menu" : "How to play"}
          onClick={() => setSheet(view === "game" ? "menu" : "help")}
        >
          {view === "game" ? "☰" : "?"}
        </button>
      </header>

      <div className="chess-stage">
        <div className="chess-table">
          {state ? <SeatRow state={state} color={top} receivedAt={receivedAt} /> : <div className="chess-seat" />}
          <div className="chess-board-frame">
          <Board
            fen={state?.fen ?? "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}
            flipped={flipped}
            selected={selected}
            targets={targets}
            lastMove={state?.lastMove ?? null}
            checkSquare={checkSq}
              onSquare={myTurn && view === "game" ? onSquare : undefined}
            />
          </div>
          {state ? <SeatRow state={state} color={bottom} receivedAt={receivedAt} /> : <div className="chess-seat" />}
        </div>
      </div>

      {state ? <MovesBar state={state} send={send} /> : <div className="chess-bar pretzel-nav-gradient" />}

      {error ? (
        <button type="button" className="tetris-toast pretzel-text-alert" onClick={clearError}>
          {error} ✕
        </button>
      ) : null}

      {overlay}
    </div>
  );
}
