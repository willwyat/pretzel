import { useEffect, useState } from "react";
import { fetchJson } from "../../lib/fetchJson";
import { Board } from "./Board";
import { MoveList } from "./MoveList";
import { WinWindow } from "./win";

type Summary = {
  id: string;
  white: string | null;
  black: string | null;
  result: string | null;
  reason: string | null;
  timeControl: string;
  endedAt: number | null;
  moveCount: number;
};

type Full = Summary & {
  moves: { san: string; from: string; to: string }[];
  fens: string[];
  pgn: string;
};

function resultLabel(r: string | null) {
  return r === "1/2-1/2" ? "½–½" : r === "*" ? "—" : (r ?? "").replace("-", "–");
}

/** Archive browser: list of finished games, then a step-through replay. */
export function PastGames({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Summary[] | null>(null);
  const [game, setGame] = useState<Full | null>(null);
  const [ply, setPly] = useState(0);
  const [flip, setFlip] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void fetchJson("/pretzel/chess/games")
      .then((r) => {
        if (r.ok) setList((r.data as { games: Summary[] }).games);
        else setErr("Could not load games.");
      })
      .catch(() => setErr("Could not reach Pretzel."));
  }, []);

  const open = (id: string) =>
    void fetchJson(`/pretzel/chess/games/${encodeURIComponent(id)}`)
      .then((r) => {
        if (!r.ok) throw new Error();
        const g = (r.data as { game: Full }).game;
        setGame(g);
        setPly(g.moves.length);
        setErr(null);
      })
      .catch(() => setErr("Could not load that game."));

  // Arrow keys step through the replay.
  useEffect(() => {
    if (!game) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setPly((p) => Math.max(0, p - 1));
      if (e.key === "ArrowRight") setPly((p) => Math.min(game.moves.length, p + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [game]);

  const copyPgn = async () => {
    if (!game) return;
    try {
      await navigator.clipboard.writeText(game.pgn);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setErr("Copy is unavailable here (needs HTTPS).");
    }
  };

  const last = game && ply > 0 ? game.moves[ply - 1] : null;
  const n = game?.moves.length ?? 0;

  return (
    <div className="win-modal">
      <WinWindow
        className="win--wide"
        title={game ? `Replay — ${game.white ?? "?"} vs ${game.black ?? "?"}` : "Past games"}
        onClose={onClose}
      >
        <div className="win-body">
          {err ? <p className="win-hint win-hint--err">{err}</p> : null}
          {!game ? (
            <div className="win-sunken win-list" role="listbox" aria-label="Finished games">
              {list === null && !err ? <p className="win-hint win-pad">Loading…</p> : null}
              {list?.length === 0 ? <p className="win-hint win-pad">No finished games yet.</p> : null}
              {list?.map((g) => (
                <button key={g.id} type="button" role="option" className="win-listrow" onClick={() => open(g.id)}>
                  <span className="win-listrow-main">
                    <b>{g.white ?? "?"}</b> vs <b>{g.black ?? "?"}</b>
                    <span className="win-listrow-result">{resultLabel(g.result)}</span>
                  </span>
                  <span className="win-listrow-sub">
                    {g.reason} · {Math.ceil(g.moveCount / 2)} moves · {g.timeControl}
                    {g.endedAt ? ` · ${new Date(g.endedAt).toLocaleString()}` : ""}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="win-replay">
              <div className="win-board-wrap">
                <Board fen={game.fens[ply]} flipped={flip} lastMove={last} />
              </div>
              <div className="win-replay-side">
                <div className="win-row win-row--center win-vcr">
                  <button type="button" className="win-btn win-btn--icon" aria-label="Start" onClick={() => setPly(0)} disabled={ply === 0}>|◀</button>
                  <button type="button" className="win-btn win-btn--icon" aria-label="Back" onClick={() => setPly(ply - 1)} disabled={ply === 0}>◀</button>
                  <span className="win-lcd">{String(ply).padStart(3, "0")}</span>
                  <button type="button" className="win-btn win-btn--icon" aria-label="Forward" onClick={() => setPly(ply + 1)} disabled={ply === n}>▶</button>
                  <button type="button" className="win-btn win-btn--icon" aria-label="End" onClick={() => setPly(n)} disabled={ply === n}>▶|</button>
                </div>
                <MoveList sans={game.moves.map((m) => m.san)} current={ply} onPick={setPly} />
                <p className="win-p">
                  <b>{resultLabel(game.result)}</b> — {game.reason}
                </p>
                <div className="win-row win-row--wrap">
                  <button type="button" className="win-btn" onClick={() => setGame(null)}>
                    ◀ All games
                  </button>
                  <button type="button" className="win-btn" onClick={() => setFlip(!flip)}>
                    Flip
                  </button>
                  <button type="button" className="win-btn" onClick={() => void copyPgn()}>
                    {copied ? "Copied!" : "Copy PGN"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="win-dialog-buttons">
          <button type="button" className="win-btn win-btn--default" onClick={onClose}>
            Close
          </button>
        </div>
      </WinWindow>
    </div>
  );
}
