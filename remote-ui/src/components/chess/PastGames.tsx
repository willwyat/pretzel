import { useEffect, useState } from "react";
import { fetchJson } from "../../lib/fetchJson";
import { Board } from "./Board";

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

type Full = {
  id: string;
  white: string | null;
  black: string | null;
  result: string | null;
  reason: string | null;
  moves: { san: string; from: string; to: string }[];
  fens: string[];
  pgn: string;
};

const NO_TARGETS = new Set<string>();

export function PastGames({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Summary[] | null>(null);
  const [game, setGame] = useState<Full | null>(null);
  const [ply, setPly] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchJson("/pretzel/chess/games").then((r) => {
      if (r.ok) setList((r.data as { games: Summary[] }).games);
      else setErr("Could not load games.");
    });
  }, []);

  const open = (id: string) =>
    fetchJson(`/pretzel/chess/games/${id}`).then((r) => {
      if (r.ok) {
        const g = (r.data as { game: Full }).game;
        setGame(g);
        setPly(g.moves.length);
      } else setErr("Could not load game.");
    });

  const last = game && ply > 0 ? game.moves[ply - 1] : null;

  return (
    <div className="win-modal">
      <div className="win win--wide" role="dialog" aria-label="Past games">
        <div className="win-title">
          <span>{game ? `${game.white} vs ${game.black}` : "Past games"}</span>
          <button type="button" className="win-titlebtn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="win-body">
          {err ? <p className="win-hint">{err}</p> : null}
          {!game ? (
            <div className="win-sunken win-list">
              {list === null ? <p className="win-hint">Loading…</p> : null}
              {list?.length === 0 ? <p className="win-hint">No finished games yet.</p> : null}
              {list?.map((g) => (
                <button key={g.id} type="button" className="win-listrow" onClick={() => open(g.id)}>
                  <span>{g.white} vs {g.black}</span>
                  <span>{g.result} · {g.moveCount} moves</span>
                  <span className="win-hint">{g.reason}{g.endedAt ? ` · ${new Date(g.endedAt).toLocaleString()}` : ""}</span>
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className="win-sunken win-board-wrap">
                <Board
                  fen={game.fens[ply]}
                  flipped={false}
                  selected={null}
                  targets={NO_TARGETS}
                  lastMove={last}
                  checkSquare={null}
                />
              </div>
              <div className="win-row win-row--center">
                <button type="button" className="win-btn" onClick={() => setPly(0)} disabled={ply === 0}>|◀</button>
                <button type="button" className="win-btn" onClick={() => setPly(ply - 1)} disabled={ply === 0}>◀</button>
                <span className="win-lcd">{ply}/{game.moves.length}</span>
                <button type="button" className="win-btn" onClick={() => setPly(ply + 1)} disabled={ply === game.moves.length}>▶</button>
                <button type="button" className="win-btn" onClick={() => setPly(game.moves.length)} disabled={ply === game.moves.length}>▶|</button>
              </div>
              <div className="win-sunken win-moves">
                {game.moves.map((m, i) => (
                  <button key={i} type="button" className={`win-mv${i + 1 === ply ? " win-mv--on" : ""}`} onClick={() => setPly(i + 1)}>
                    {i % 2 === 0 ? `${i / 2 + 1}. ` : ""}{m.san}
                  </button>
                ))}
              </div>
              <div className="win-row">
                <button type="button" className="win-btn" onClick={() => setGame(null)}>◀ List</button>
                <span className="win-hint">{game.result} — {game.reason}</span>
              </div>
            </>
          )}
        </div>
        <div className="win-dialog-buttons">
          <button type="button" className="win-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
