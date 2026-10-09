import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "../chess.css";
import { Board, kingSquare, PIECE_NAMES } from "../components/chess/Board";
import { MoveList } from "../components/chess/MoveList";
import { PastGames } from "../components/chess/PastGames";
import { Piece } from "../components/chess/Piece";
import { PlayerPanel } from "../components/chess/PlayerPanel";
import { MenuBar, MsgBox, WinWindow } from "../components/chess/win";
import { useChess, type ChessState, type Color } from "../lib/chessSocket";

const NAME_KEY = "pretzel_chess_name";
const PREFS_KEY = "pretzel_chess_prefs";

type Prefs = { flip: boolean; coords: boolean; sound: boolean };
const DEFAULT_PREFS: Prefs = { flip: false, coords: true, sound: true };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

const cap = (c: Color) => (c === "white" ? "White" : "Black");

function resultText(s: ChessState): string {
  if (s.result === "*") return "Game abandoned";
  const who = s.result === "1-0" ? "White wins" : s.result === "0-1" ? "Black wins" : "Draw";
  return `${who} — ${s.reason}`;
}

function statusText(s: ChessState): string {
  if (s.status === "over") return resultText(s);
  if (s.status === "waiting") {
    if (s.you) return "Waiting for an opponent to sit down…";
    return "Waiting for players…";
  }
  const check = s.inCheck ? " — Check!" : "";
  if (s.you === s.turn) return `Your move${check}`;
  if (s.you) return `Waiting for ${s.players[s.turn]?.name ?? cap(s.turn)}…${check}`;
  return `${cap(s.turn)} to move${check}`;
}

/** Short square-wave blip, like the PC speaker. */
function beep(freq = 880, ms = 70) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
    osc.onended = () => void ctx.close();
  } catch {
    /* no audio */
  }
}

export function ChessPage() {
  const navigate = useNavigate();
  const { state, connected, error, clearError, receivedAt, send } = useChess();
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [prefs, setPrefs] = useState<Prefs>(() => load(PREFS_KEY, DEFAULT_PREFS));
  const [selected, setSelected] = useState<string | null>(null);
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null);
  const [dialog, setDialog] = useState<null | "resign" | "help" | "about" | "past">(null);

  const setPref = (k: keyof Prefs) => {
    const next = { ...prefs, [k]: !prefs[k] };
    setPrefs(next);
    save(PREFS_KEY, next);
  };

  // Drop a stale selection whenever the position changes.
  useEffect(() => {
    setSelected(null);
    setPromo(null);
  }, [state?.fen]);

  // Beep when the opponent moves (or the game ends) so you can look away.
  const seenPly = useRef<number | null>(null);
  useEffect(() => {
    if (!state) return;
    const ply = state.moves.length;
    const prev = seenPly.current;
    seenPly.current = ply;
    if (!prefs.sound || prev === null || ply <= prev || !state.you) return;
    if (state.moves[ply - 1].color !== state.you) beep(state.inCheck ? 1200 : 880);
  }, [state, prefs.sound]);

  // Title shows whose move it is, for when the tab is in the background.
  useEffect(() => {
    const prev = document.title;
    document.title = state && state.status === "active" && state.you === state.turn ? "● Your move — Pretzel Chess" : "Pretzel Chess";
    return () => {
      document.title = prev;
    };
  }, [state]);

  const you = state?.you ?? null;
  const myTurn = !!state && state.status === "active" && you === state.turn;
  const flipped = (you === "black") !== prefs.flip;

  const targets = useMemo(() => {
    if (!state || !selected) return new Set<string>();
    return new Set(state.legalMoves.filter((m) => m.from === selected).map((m) => m.to));
  }, [state, selected]);
  const movable = useMemo(() => new Set(state?.legalMoves.map((m) => m.from) ?? []), [state]);

  const close = () => navigate("/");

  if (!state) {
    return (
      <div className="win-root win-desktop">
        <WinWindow title="Pretzel Chess" className="win--dialog" onClose={close}>
          <div className="win-dialog-body">{connected ? "Loading…" : "Connecting to Pretzel…"}</div>
        </WinWindow>
      </div>
    );
  }

  const onSquare = (sq: string) => {
    if (!myTurn) return;
    if (selected && targets.has(sq)) {
      const cands = state.legalMoves.filter((m) => m.from === selected && m.to === sq);
      if (cands.some((m) => m.promotion)) setPromo({ from: selected, to: sq });
      else send({ type: "move", from: selected, to: sq });
      setSelected(null);
      return;
    }
    setSelected(movable.has(sq) && sq !== selected ? sq : null);
  };

  const sit = (color: Color) => {
    const n = name.trim();
    if (!n) return;
    save(NAME_KEY, n);
    send({ type: "sit", name: n, color });
  };

  const can = state.can;
  const top: Color = flipped ? "white" : "black";
  const bottom: Color = flipped ? "black" : "white";
  const offeredToYou = state.status === "active" && !!you && !!state.drawOffer && state.drawOffer !== you;
  const youOffered = state.status === "active" && !!you && state.drawOffer === you;
  const checkSq = state.inCheck && state.status !== "waiting" ? kingSquare(state.fen, state.turn) : null;
  const shareUrl = `${location.host}/chess`;

  return (
    <div className="win-root win-desktop">
      <WinWindow
        className="win--main"
        title={
          state.players.white || state.players.black
            ? `Pretzel Chess — ${state.players.white?.name ?? "?"} vs ${state.players.black?.name ?? "?"}`
            : "Pretzel Chess"
        }
        icon={<Piece type="n" color="b" className="win-title-piece" />}
        onClose={close}
      >
        <MenuBar
          menus={[
            {
              label: "Game",
              items: [
                { label: "New game", disabled: !can.newGame, onClick: () => send({ type: "newGame" }) },
                { label: "Offer draw", disabled: !can.offerDraw, onClick: () => send({ type: "offerDraw" }) },
                { label: "Resign…", disabled: !can.resign || state.moves.length === 0, onClick: () => setDialog("resign") },
                { label: "Leave seat", disabled: !can.stand, onClick: () => send({ type: "stand" }) },
                "separator",
                { label: "Past games…", onClick: () => setDialog("past") },
                "separator",
                { label: "Exit", onClick: close },
              ],
            },
            {
              label: "Options",
              items: [
                { label: "Flip board", checked: prefs.flip, onClick: () => setPref("flip") },
                { label: "Coordinates", checked: prefs.coords, onClick: () => setPref("coords") },
                { label: "Sound", checked: prefs.sound, onClick: () => setPref("sound") },
              ],
            },
            {
              label: "Help",
              items: [
                { label: "How to play", onClick: () => setDialog("help") },
                { label: "About Pretzel Chess", onClick: () => setDialog("about") },
              ],
            },
          ]}
        />

        <div className="win-layout">
          <div className="win-board-col">
            <PlayerPanel state={state} color={top} receivedAt={receivedAt} />
            <div className="win-board-wrap">
              <Board
                fen={state.fen}
                flipped={flipped}
                selected={selected}
                targets={targets}
                lastMove={state.lastMove}
                checkSquare={checkSq}
                coords={prefs.coords}
                onSquare={myTurn ? onSquare : undefined}
              />
            </div>
            <PlayerPanel state={state} color={bottom} receivedAt={receivedAt} />
          </div>

          <div className="win-side">
            {can.sit.white || can.sit.black ? (
              <fieldset className="win-group">
                <legend>Join the game</legend>
                <div className="win-row">
                  <label htmlFor="chess-name">Name:</label>
                  <input
                    id="chess-name"
                    className="win-input"
                    maxLength={20}
                    autoComplete="nickname"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="win-row">
                  <button type="button" className="win-btn" disabled={!name.trim() || !can.sit.white} onClick={() => sit("white")}>
                    Play White
                  </button>
                  <button type="button" className="win-btn" disabled={!name.trim() || !can.sit.black} onClick={() => sit("black")}>
                    Play Black
                  </button>
                </div>
              </fieldset>
            ) : null}

            {you && state.status === "waiting" ? (
              <fieldset className="win-group">
                <legend>Waiting</legend>
                <p className="win-p">
                  Open <b>{shareUrl}</b> on another device to play {cap(you === "white" ? "black" : "white")}.
                </p>
              </fieldset>
            ) : null}

            {can.setTimeControl ? (
              <fieldset className="win-group">
                <legend>Time control</legend>
                <div className="win-radios">
                  {state.timeControls.map((tc) => (
                    <label key={tc.id} className="win-radio">
                      <input
                        type="radio"
                        name="tc"
                        checked={state.timeControl === tc.id}
                        onChange={() => send({ type: "setTimeControl", id: tc.id })}
                      />
                      <span>{tc.label}</span>
                    </label>
                  ))}
                </div>
                <p className="win-hint">Clocks start after White's first move.</p>
              </fieldset>
            ) : null}

            {state.status === "over" ? (
              <fieldset className="win-group win-group--result">
                <legend>Game over</legend>
                <p className="win-p">
                  <b>{resultText(state)}</b>
                </p>
                <button type="button" className="win-btn win-btn--default" disabled={!can.newGame} onClick={() => send({ type: "newGame" })}>
                  {you ? "Rematch" : "New game"}
                </button>
              </fieldset>
            ) : null}

            {!you && state.status === "active" ? <p className="win-hint">You are watching this game.</p> : null}

            <fieldset className="win-group win-group--moves">
              <legend>Moves</legend>
              <MoveList sans={state.moves.map((m) => m.san)} />
            </fieldset>

            {you && state.status === "active" && state.moves.length > 0 ? (
              <div className="win-row win-actions">
                {youOffered ? (
                  <button type="button" className="win-btn" onClick={() => send({ type: "respondDraw", accept: false })}>
                    Withdraw draw
                  </button>
                ) : (
                  <button type="button" className="win-btn" disabled={!can.offerDraw} onClick={() => send({ type: "offerDraw" })}>
                    Offer draw
                  </button>
                )}
                <button type="button" className="win-btn" disabled={!can.resign} onClick={() => setDialog("resign")}>
                  Resign
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="win-statusbar" role="status">
          <div className="win-status-cell win-status-cell--grow">
            {youOffered ? "Draw offered — waiting for an answer…" : statusText(state)}
          </div>
          <div className="win-status-cell">
            {state.timeControls.find((t) => t.id === state.timeControl)?.label ?? ""}
          </div>
          <div className="win-status-cell">
            <span className={`win-net${connected ? " win-net--on" : ""}`} aria-hidden />
            {connected ? "Online" : "Offline"}
          </div>
        </div>
      </WinWindow>

      {promo ? (
        <MsgBox title="Promote pawn" buttons={[{ label: "Cancel", onClick: () => setPromo(null) }]}>
          <p className="win-p">Promote to:</p>
          <div className="win-promo">
            {(["q", "r", "b", "n"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className="win-btn win-promo-btn"
                aria-label={`Promote to ${PIECE_NAMES[t]}`}
                onClick={() => {
                  send({ type: "move", from: promo.from, to: promo.to, promotion: t });
                  setPromo(null);
                }}
              >
                <Piece type={t} color={you === "black" ? "b" : "w"} className="win-promo-piece" />
              </button>
            ))}
          </div>
        </MsgBox>
      ) : null}

      {dialog === "resign" ? (
        <MsgBox
          title="Resign"
          icon="question"
          buttons={[
            { label: "Yes", primary: true, onClick: () => { send({ type: "resign" }); setDialog(null); } },
            { label: "No", onClick: () => setDialog(null) },
          ]}
        >
          Are you sure you want to resign this game?
        </MsgBox>
      ) : null}

      {offeredToYou ? (
        <MsgBox
          title="Draw offer"
          icon="question"
          buttons={[
            { label: "Accept", primary: true, onClick: () => send({ type: "respondDraw", accept: true }) },
            { label: "Decline", onClick: () => send({ type: "respondDraw", accept: false }) },
          ]}
        >
          {state.players[state.drawOffer!]?.name ?? "Your opponent"} offers a draw.
        </MsgBox>
      ) : null}

      {dialog === "help" ? (
        <MsgBox title="How to play" icon="info" buttons={[{ label: "OK", primary: true, onClick: () => setDialog(null) }]}>
          <p className="win-p">Open this page on two devices on the Pretzel Wi‑Fi. Each player enters a name and takes a side; anyone else can watch.</p>
          <p className="win-p">Tap a piece, then tap a highlighted square. The Pi checks every move, keeps the clocks and saves finished games under Game ▸ Past games.</p>
          <p className="win-p">Checkmate, stalemate, repetition, the fifty-move rule, resignation, agreed draws and running out of time all end the game.</p>
        </MsgBox>
      ) : null}

      {dialog === "about" ? (
        <MsgBox title="About Pretzel Chess" icon="info" buttons={[{ label: "OK", primary: true, onClick: () => setDialog(null) }]}>
          <p className="win-p"><b>Pretzel Chess</b></p>
          <p className="win-p">Two-player chess refereed by the Pretzel Pi.</p>
        </MsgBox>
      ) : null}

      {error ? (
        <MsgBox title="Pretzel Chess" icon="warning" buttons={[{ label: "OK", primary: true, onClick: clearError }]}>
          {error}
        </MsgBox>
      ) : null}

      {dialog === "past" ? <PastGames onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
