import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import "../tetris.css";
import "../chess.css";
import { Avatar } from "../components/chess/Avatar";
import { Board, kingSquare, parseFen, PIECE_NAMES } from "../components/chess/Board";
import { PastGames } from "../components/chess/PastGames";
import { Piece, type PieceType } from "../components/chess/Piece";
import { PixelName } from "../components/chess/PixelName";
import { PixelText } from "../components/chess/PixelText";
import { ScrollButton, ScrollDialog } from "../components/chess/ScrollDialog";
import { AVATARS, expressionFor } from "../lib/chessAvatars";
import { playMoveSound, unlockChessSounds } from "../lib/chessSounds";
import { useChess, type ChessState, type Color } from "../lib/chessSocket";
import { resultLine, seatStatus, TONE_GEM, topReadout } from "../lib/chessStatus";
import { enterFullscreen, exitFullscreen, useGameViewport } from "../lib/gameShell";

const NAME_KEY = "pretzel_chess_name";
const FLIP_KEY = "pretzel_chess_flip";
const AVATAR_KEY = "pretzel_chess_avatar";
const CAPTURE_ORDER: PieceType[] = ["p", "n", "b", "r", "q"];
const START: Record<PieceType, number> = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
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

type Taken = { t: PieceType; n: number }[];

/**
 * Pieces each side has taken off the board, cheapest first, plus the material
 * balance (+ favours White). A promoted piece counts back as the pawn it was.
 */
function captures(fen: string): { taken: Record<Color, Taken>; balance: number } {
  const count = { w: {}, b: {} } as Record<"w" | "b", Partial<Record<PieceType, number>>>;
  let balance = 0;
  for (const p of Object.values(parseFen(fen))) {
    count[p.c][p.t] = (count[p.c][p.t] ?? 0) + 1;
    balance += (p.c === "w" ? 1 : -1) * VALUE[p.t];
  }
  const lost = (c: "w" | "b"): Taken => {
    const have = (t: PieceType) => count[c][t] ?? 0;
    const promoted = CAPTURE_ORDER.reduce((n, t) => n + Math.max(0, have(t) - START[t]), 0);
    return CAPTURE_ORDER.map((t) => ({ t, n: Math.max(0, START[t] - have(t) - (t === "p" ? promoted : 0)) })).filter(
      (g) => g.n > 0,
    );
  };
  return { taken: { white: lost("b"), black: lost("w") }, balance };
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Hourglass and bitmap digits on an inset plaque; ticks locally from the last server snapshot. */
function Clock({ ms, running, since }: { ms: number; running: boolean; since: RefObject<number> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => tick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [running]);
  const left = running ? ms - (Date.now() - since.current) : ms;
  const cls = ["chess-clock", running ? "chess-clock--running" : "", left < 20_000 ? "chess-clock--low" : ""];
  return (
    <span className={cls.filter(Boolean).join(" ")}>
      <span className="chess-hourglass" aria-hidden />
      <span className="chess-clock__face">
        <PixelText text={fmtClock(left)} />
      </span>
    </span>
  );
}

/** Portrait, name (Fraktur), clock, and the status line for one side of the board. */
function SeatRow({ state, color, receivedAt }: { state: ChessState; color: Color; receivedAt: RefObject<number> }) {
  const p = state.players[color];
  const status = seatStatus(state, color);
  const { taken, balance } = captures(state.fen);
  const lead = color === "white" ? balance : -balance;
  const mine = taken[color];
  const takenLabel = mine.length
    ? `Captured ${mine.map((g) => `${g.n} ${PIECE_NAMES[g.t]}${g.n > 1 ? "s" : ""}`).join(", ")}${lead > 0 ? `, up ${lead}` : ""}`
    : "No captures";
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
        <div className="chess-seat__status chess-dos" role="status">
          <span className={TONE_GEM[status.tone]} aria-hidden />
          <span className="chess-seat__text">{status.text}</span>
          <span className="chess-seat__material" role="img" aria-label={takenLabel}>
            {mine.map(({ t, n }) => (
              <span key={t} className="chess-captures">
                {Array.from({ length: n }, (_, i) => (
                  <Piece key={i} type={t} color={color === "white" ? "b" : "w"} className="chess-piece chess-piece--tiny" />
                ))}
              </span>
            ))}
            {lead > 0 ? <span className="chess-seat__lead">+{lead}</span> : null}
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
      <ScrollDialog title="Chess">
        <p className="pretzel-text-panel-muted">{connected ? "Loading..." : "Connecting to Pretzel..."}</p>
      </ScrollDialog>
    );
  } else if (sheet === "past") {
    overlay = <PastGames onClose={() => setSheet(null)} />;
  } else if (sheet === "help") {
    overlay = (
      <ScrollDialog title="How to play" onClose={() => setSheet(null)}>
        <p className="pretzel-text-panel-body">
          Open Chess on two phones. Each player taps Play, enters a name and takes a side; anyone else can watch.
        </p>
        <p className="pretzel-text-panel-body">
          Tap a piece, then one of the marked squares. The Pi checks every move, runs the clocks and keeps finished
          games under Past games. Leaving the page keeps your seat; come back on the same phone to continue.
        </p>
        <dl className="chess-legend">
          <dt>
            <span className={TONE_GEM.turn} aria-hidden /> Emerald
          </dt>
          <dd>That player's move.</dd>
          <dt>
            <span className={TONE_GEM.alert} aria-hidden /> Topaz
          </dt>
          <dd>Check, or a draw offer.</dd>
          <dt>
            <span className={TONE_GEM.off} aria-hidden /> Ruby
          </dt>
          <dd>Offline; their clock still runs.</dd>
        </dl>
      </ScrollDialog>
    );
  } else if (view === "menu") {
    const p = state.players;
    overlay = (
      <ScrollDialog title="Chess">
        <p className="pretzel-text-panel-muted">
          {p.white?.name ?? "Open seat"} <span className="tetris-vs">vs</span> {p.black?.name ?? "Open seat"}
          {state.status === "active" && state.moves.length > 0 ? " · in progress" : ""}
        </p>
        <div className="chess-menu">
          <ScrollButton tone="gold" label={you ? "Resume game" : "Play"} onClick={() => setView(you ? "game" : "join")} />
          <ScrollButton label="Past games" onClick={() => setSheet("past")} />
          <ScrollButton label="How to play" onClick={() => setSheet("help")} />
          <ScrollButton label="Exit" onClick={exit} />
        </div>
      </ScrollDialog>
    );
  } else if (view === "join") {
    const can = state.can;
    const seatOpen = can.sit.white || can.sit.black;
    const named = !!name.trim();
    overlay = (
      <ScrollDialog title="Join game" onClose={() => setView("menu")}>
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
          <p className="chess-banner tetris-overlay__readout">
            <PixelText text={state.status === "over" ? "GAME FINISHED" : "SEATS TAKEN"} />
          </p>
        )}
        <div className="chess-menu">
          {can.sit.white ? (
            <ScrollButton
              tone="gold"
              label="Play White"
              icon={<Piece type="k" color="w" className="chess-piece chess-piece--btn" />}
              disabled={!named}
              onClick={() => sit("white")}
            />
          ) : null}
          {can.sit.black ? (
            <ScrollButton
              tone="gold"
              label="Play Black"
              icon={<Piece type="k" color="b" className="chess-piece chess-piece--btn" />}
              disabled={!named}
              onClick={() => sit("black")}
            />
          ) : null}
          {state.status === "over" && can.newGame ? (
            <ScrollButton tone="gold" label="Set up a new board" onClick={() => send({ type: "newGame" })} />
          ) : null}
          <ScrollButton label="Watch" onClick={() => setView("game")} />
        </div>
        {seatOpen && !named ? <p className="pretzel-text-panel-muted">Enter a name to take a seat.</p> : null}
      </ScrollDialog>
    );
  } else if (promo) {
    overlay = (
      <ScrollDialog title="Promote to" onClose={() => setPromo(null)}>
        <div className="chess-promo">
          {(["q", "r", "b", "n"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className="chess-btn chess-promo__key"
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
      </ScrollDialog>
    );
  } else if (state.status === "active" && you && state.drawOffer && state.drawOffer !== you) {
    overlay = (
      <ScrollDialog title="Draw offer">
        <p className="pretzel-text-panel-body">{state.players[state.drawOffer]?.name ?? "Your opponent"} offers a draw.</p>
        <div className="chess-btn-row">
          <ScrollButton tone="gold" label="Accept draw" onClick={() => send({ type: "respondDraw", accept: true })} />
          <ScrollButton label="Play on" onClick={() => send({ type: "respondDraw", accept: false })} />
        </div>
      </ScrollDialog>
    );
  } else if (sheet === "resign") {
    overlay = (
      <ScrollDialog title="Resign?" onClose={() => setSheet(null)}>
        <p className="pretzel-text-panel-body">The game is recorded as a loss.</p>
        <div className="chess-btn-row">
          <ScrollButton
            tone="danger"
            label="Resign"
            onClick={() => {
              send({ type: "resign" });
              setSheet(null);
            }}
          />
          <ScrollButton label="Keep playing" onClick={() => setSheet(null)} />
        </div>
      </ScrollDialog>
    );
  } else if (sheet === "menu") {
    const can = state.can;
    const youOffered = state.drawOffer === you && state.status === "active";
    const act = (fn: () => void) => () => {
      setSheet(null);
      fn();
    };
    overlay = (
      <ScrollDialog title="Game" onClose={() => setSheet(null)}>
        <div className="chess-menu">
          {can.newGame ? (
            <ScrollButton
              tone="gold"
              label={state.status === "over" ? (you ? "Rematch (swap colours)" : "New game") : "Swap colours"}
              onClick={act(() => send({ type: "newGame" }))}
            />
          ) : null}
          {youOffered ? (
            <ScrollButton label="Withdraw draw offer" onClick={act(() => send({ type: "respondDraw", accept: false }))} />
          ) : can.offerDraw ? (
            <ScrollButton label="Offer draw" onClick={act(() => send({ type: "offerDraw" }))} />
          ) : null}
          <ScrollButton
            label="Flip board"
            onClick={act(() => {
              setFlip(!flip);
              writeLocal(FLIP_KEY, flip ? "0" : "1");
            })}
          />
          <ScrollButton label="Past games" onClick={() => setSheet("past")} />
          <span className="chess-menu__rule" aria-hidden />
          {can.stand ? <ScrollButton label="Leave seat" onClick={act(() => send({ type: "stand" }))} /> : null}
          <ScrollButton label="Main menu" onClick={act(() => setView("menu"))} />
          {can.resign && state.moves.length > 0 ? (
            <ScrollButton tone="danger" label="Resign..." onClick={() => setSheet("resign")} />
          ) : null}
        </div>
      </ScrollDialog>
    );
  } else if (state.status === "over" && you && seenResult !== state.id) {
    const won = state.result === (you === "white" ? "1-0" : "0-1");
    const drawn = state.result === "1/2-1/2";
    overlay = (
      <ScrollDialog title={won ? "Victory" : drawn ? "Draw" : "Defeat"} onClose={() => setSeenResult(state.id)}>
        <p className="chess-banner chess-banner--xl tetris-overlay__readout">
          <PixelText text={won ? "YOU WIN!" : drawn ? "DRAW" : "GAME OVER"} />
        </p>
        <p className="pretzel-text-panel-muted">{resultLine(state.result, state.reason)}</p>
        <div className="chess-btn-row">
          {state.can.newGame ? <ScrollButton tone="gold" label="Rematch" onClick={() => send({ type: "newGame" })} /> : null}
          <ScrollButton label="View board" onClick={() => setSeenResult(state.id)} />
        </div>
      </ScrollDialog>
    );
  }

  const showCheck = !!state && state.inCheck && (state.status === "active" || state.reason === "checkmate");
  const checkSq = showCheck ? kingSquare(state.fen, state.turn) : null;

  return (
    <div className="tetris-shell chess-shell">
      <header className="tetris-top chess-top">
        <h1 className="pretzel-text-panel-title chess-top__title">Chess</h1>
        <div className="tetris-top__mid">
          <span className={`pretzel-led ${connected ? "pretzel-led--ok" : "pretzel-led--off"}`} aria-hidden />
          <span className="pretzel-readout tetris-top__status" role="status">
            {topReadout(state, connected)}
          </span>
        </div>
        <button type="button" className="pretzel-btn-icon chess-top__quit" aria-label="Quit game" onClick={exit}>
          ✕
        </button>
      </header>

      <div className="chess-stage">
        <div className="chess-scroll">
          <div className="chess-scroll__roller" aria-hidden />
          <div className="chess-scroll__paper">
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
          <div className="chess-scroll__roller chess-scroll__roller--key">
            <ScrollButton
              tone="wood"
              label="Menu"
              className="chess-scroll__menu"
              aria-label="Game menu"
              onClick={() => (view === "game" ? setSheet("menu") : setView("menu"))}
            />
          </div>
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
