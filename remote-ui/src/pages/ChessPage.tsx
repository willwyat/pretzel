import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import "../chess.css";
import { Board, kingSquare } from "../components/chess/Board";
import { PastGames } from "../components/chess/PastGames";
import { useChess, type Color, type ChessState } from "../lib/chessSocket";

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function statusText(s: ChessState): string {
  if (s.status === "waiting") return "Waiting for two players to sit down…";
  if (s.status === "over") {
    const who = s.result === "1-0" ? "White wins" : s.result === "0-1" ? "Black wins" : "Draw";
    return `${who} — ${s.reason}`;
  }
  const side = s.turn === "white" ? "White" : "Black";
  return `${side} to move${s.inCheck ? " — Check!" : ""}`;
}

function MsgBox({
  title,
  children,
  buttons,
}: {
  title: string;
  children: React.ReactNode;
  buttons: { label: string; onClick: () => void; primary?: boolean }[];
}) {
  return (
    <div className="win-modal">
      <div className="win win--dialog" role="dialog" aria-label={title}>
        <div className="win-title">
          <span>{title}</span>
        </div>
        <div className="win-dialog-body">{children}</div>
        <div className="win-dialog-buttons">
          {buttons.map((b) => (
            <button key={b.label} type="button" className={`win-btn${b.primary ? " win-btn--primary" : ""}`} onClick={b.onClick}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ChessPage() {
  const { state, connected, error, clearError, receivedAt, send } = useChess();
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem("pretzel_chess_name") ?? "";
    } catch {
      return "";
    }
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null);
  const [menu, setMenu] = useState<null | "game">(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [, setTick] = useState(0);

  // Local 4 Hz tick so clocks count down smoothly between server pushes.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, []);

  // Drop stale selection whenever the position changes.
  useEffect(() => {
    setSelected(null);
    setPromo(null);
  }, [state?.fen]);

  const you = state?.you ?? null;
  const flipped = you === "black";
  const myTurn = !!state && state.status === "active" && you === state.turn;

  const targets = useMemo(() => {
    if (!state || !selected) return new Set<string>();
    return new Set(state.legalMoves.filter((m) => m.from === selected).map((m) => m.to));
  }, [state, selected]);

  const movable = useMemo(
    () => new Set(state?.legalMoves.map((m) => m.from) ?? []),
    [state],
  );

  if (!state) {
    return (
      <div className="win-root">
        <div className="win">
          <div className="win-title"><span>Pretzel Chess</span></div>
          <div className="win-dialog-body">{connected ? "Loading…" : "Connecting to Pretzel…"}</div>
        </div>
      </div>
    );
  }

  const clockOf = (c: Color): number => {
    const base = state.clocks[c];
    if (state.clockRunning && state.turn === c && state.status === "active") {
      return base - (Date.now() - receivedAt);
    }
    return base;
  };
  const timed = state.timeControl !== "untimed";

  const onSquare = (sq: string) => {
    if (!myTurn) return;
    if (selected && targets.has(sq)) {
      const cands = state.legalMoves.filter((m) => m.from === selected && m.to === sq);
      if (cands.some((m) => m.promotion)) setPromo({ from: selected, to: sq });
      else send({ type: "move", from: selected, to: sq });
      setSelected(null);
      return;
    }
    setSelected(movable.has(sq) ? (sq === selected ? null : sq) : null);
  };

  const sit = (color?: Color) => {
    const n = name.trim();
    if (!n) return;
    try {
      localStorage.setItem("pretzel_chess_name", n);
    } catch {
      /* ignore */
    }
    send({ type: "sit", name: n, color });
  };

  const top: Color = flipped ? "white" : "black";
  const bottom: Color = flipped ? "black" : "white";
  const PlayerBar = ({ c }: { c: Color }) => {
    const p = state.players[c];
    const active = state.status === "active" && state.turn === c;
    return (
      <div className={`win-player${active ? " win-player--active" : ""}`}>
        <span className="win-player-name">
          {c === "white" ? "○" : "●"} {p ? p.name : "(empty seat)"}
          {p && !p.connected ? " (offline)" : ""}
          {p && you === c ? " — you" : ""}
        </span>
        {timed ? <span className="win-lcd">{fmtClock(clockOf(c))}</span> : null}
      </div>
    );
  };

  const pairs: { n: number; w: string; b?: string }[] = [];
  state.moves.forEach((m, i) => {
    if (i % 2 === 0) pairs.push({ n: i / 2 + 1, w: m.san });
    else pairs[pairs.length - 1].b = m.san;
  });

  const seated = !!you;
  const canStart = state.moves.length === 0 && state.status !== "over";

  return (
    <div className="win-root">
      <div className="win">
        <div className="win-title">
          <span>Pretzel Chess — {state.players.white?.name ?? "?"} vs {state.players.black?.name ?? "?"}</span>
          <Link to="/" className="win-titlebtn" aria-label="Close">×</Link>
        </div>

        <div className="win-menubar">
          <div className="win-menu">
            <button type="button" className="win-menuitem" onClick={() => setMenu(menu === "game" ? null : "game")}>
              <u>G</u>ame
            </button>
            {menu === "game" ? (
              <div className="win-dropdown" onMouseLeave={() => setMenu(null)}>
                <button type="button" disabled={!seated || (state.status === "active" && state.moves.length > 0)} onClick={() => { send({ type: "newGame" }); setMenu(null); }}>New game (swap colors)</button>
                <button type="button" disabled={!seated || state.status !== "active"} onClick={() => { send({ type: "offerDraw" }); setMenu(null); }}>Offer draw</button>
                <button type="button" disabled={!seated || state.status !== "active"} onClick={() => { setConfirmResign(true); setMenu(null); }}>Resign…</button>
                <button type="button" disabled={!seated || (state.moves.length > 0 && state.status === "active")} onClick={() => { send({ type: "stand" }); setMenu(null); }}>Leave seat</button>
              </div>
            ) : null}
          </div>
          <button type="button" className="win-menuitem" onClick={() => { setShowPast(true); setMenu(null); }}>
            <u>P</u>ast games
          </button>
          <Link to="/" className="win-menuitem"><u>H</u>ome</Link>
        </div>

        <div className="win-body">
          <PlayerBar c={top} />
          <div className="win-sunken win-board-wrap">
            <Board
              fen={state.fen}
              flipped={flipped}
              selected={selected}
              targets={targets}
              lastMove={state.lastMove}
              checkSquare={state.inCheck && state.status !== "waiting" ? kingSquare(state.fen, state.turn) : null}
              onSquare={onSquare}
            />
          </div>
          <PlayerBar c={bottom} />

          {!seated && state.status !== "over" ? (
            <fieldset className="win-group">
              <legend>Join the game</legend>
              <div className="win-row">
                <label htmlFor="chess-name">Your name:</label>
                <input id="chess-name" className="win-input" maxLength={20} value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="win-row">
                <button type="button" className="win-btn" disabled={!name.trim() || !!state.players.white} onClick={() => sit("white")}>Play White</button>
                <button type="button" className="win-btn" disabled={!name.trim() || !!state.players.black} onClick={() => sit("black")}>Play Black</button>
              </div>
              <p className="win-hint">Others on the network can watch.</p>
            </fieldset>
          ) : null}

          {seated && canStart ? (
            <fieldset className="win-group">
              <legend>Time control</legend>
              <div className="win-row win-row--wrap">
                {state.timeControls.map((tc) => (
                  <label key={tc.id} className="win-radio">
                    <input type="radio" name="tc" checked={state.timeControl === tc.id} onChange={() => send({ type: "setTimeControl", id: tc.id })} />
                    {tc.label}
                  </label>
                ))}
              </div>
              <p className="win-hint">Clock starts after White's first move.</p>
            </fieldset>
          ) : null}

          {state.status === "over" && seated ? (
            <div className="win-row">
              <button type="button" className="win-btn win-btn--primary" onClick={() => send({ type: "newGame" })}>Rematch</button>
            </div>
          ) : null}

          <div className="win-sunken win-moves" aria-label="Moves">
            {pairs.length === 0 ? <span className="win-hint">No moves yet.</span> : null}
            {pairs.map((p) => (
              <span key={p.n} className="win-movepair">
                <b>{p.n}.</b> {p.w} {p.b ?? ""}
              </span>
            ))}
          </div>
        </div>

        <div className="win-statusbar">
          <div className="win-status-cell win-status-cell--grow">{statusText(state)}</div>
          <div className="win-status-cell">{connected ? "Online" : "Offline"}</div>
        </div>
      </div>

      {promo ? (
        <MsgBox
          title="Promote pawn"
          buttons={[
            ["q", "Queen"], ["r", "Rook"], ["b", "Bishop"], ["n", "Knight"],
          ].map(([p, label]) => ({
            label,
            primary: p === "q",
            onClick: () => { send({ type: "move", from: promo.from, to: promo.to, promotion: p }); setPromo(null); },
          }))}
        >
          Promote to:
        </MsgBox>
      ) : null}

      {confirmResign ? (
        <MsgBox
          title="Resign"
          buttons={[
            { label: "Yes", primary: true, onClick: () => { send({ type: "resign" }); setConfirmResign(false); } },
            { label: "No", onClick: () => setConfirmResign(false) },
          ]}
        >
          Are you sure you want to resign this game?
        </MsgBox>
      ) : null}

      {state.drawOffer && you && state.drawOffer !== you && state.status === "active" ? (
        <MsgBox
          title="Draw offer"
          buttons={[
            { label: "Accept", primary: true, onClick: () => send({ type: "respondDraw", accept: true }) },
            { label: "Decline", onClick: () => send({ type: "respondDraw", accept: false }) },
          ]}
        >
          Your opponent offers a draw.
        </MsgBox>
      ) : null}

      {state.drawOffer && you && state.drawOffer === you && state.status === "active" ? (
        <div className="win-toast">Draw offered — waiting for opponent…</div>
      ) : null}

      {error ? (
        <MsgBox title="Pretzel Chess" buttons={[{ label: "OK", primary: true, onClick: clearError }]}>
          {error}
        </MsgBox>
      ) : null}

      {showPast ? <PastGames onClose={() => setShowPast(false)} /> : null}
    </div>
  );
}
