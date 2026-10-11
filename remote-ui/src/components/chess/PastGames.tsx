import { useEffect, useState } from "react";
import { fetchJson } from "../../lib/fetchJson";
import { resultLine } from "../../lib/chessStatus";
import { Board } from "./Board";
import { PixelText } from "./PixelText";
import { ScrollButton, ScrollDialog } from "./ScrollDialog";

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

function score(r: string | null) {
  return r === "1/2-1/2" ? "½–½" : r === "*" ? "—" : (r ?? "").replace("-", "–");
}

/** Archive of finished games, then a step-through replay. */
export function PastGames({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Summary[] | null>(null);
  const [game, setGame] = useState<Full | null>(null);
  const [ply, setPly] = useState(0);
  const [flip, setFlip] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        setPly(0);
        setErr(null);
      })
      .catch(() => setErr("Could not load that game."));

  if (game) {
    const n = game.moves.length;
    const last = ply > 0 ? game.moves[ply - 1] : null;
    const moveNo = ply === 0 ? "Start" : `${Math.ceil(ply / 2)}${ply % 2 ? "." : "…"} ${last?.san}`;
    return (
      <ScrollDialog title={`${game.white ?? "?"} vs ${game.black ?? "?"}`} onClose={onClose}>
        <div className="chess-board-frame">
          <Board fen={game.fens[ply]} flipped={flip} lastMove={last} />
        </div>
        <div className="chess-replay-nav">
          <ScrollButton label="|<" aria-label="Start" className="chess-btn--icon" disabled={ply === 0} onClick={() => setPly(0)} />
          <ScrollButton label="<" aria-label="Back" className="chess-btn--icon" disabled={ply === 0} onClick={() => setPly(ply - 1)} />
          <span className="chess-plaque chess-replay-ply">{moveNo}</span>
          <ScrollButton label=">" aria-label="Forward" className="chess-btn--icon" disabled={ply === n} onClick={() => setPly(ply + 1)} />
          <ScrollButton label=">|" aria-label="End" className="chess-btn--icon" disabled={ply === n} onClick={() => setPly(n)} />
        </div>
        <p className="pretzel-text-panel-muted">{resultLine(game.result, game.reason)}</p>
        <div className="chess-btn-row">
          <ScrollButton label="All games" onClick={() => setGame(null)} />
          <ScrollButton label="Flip board" onClick={() => setFlip(!flip)} />
        </div>
      </ScrollDialog>
    );
  }

  return (
    <ScrollDialog title="Past games" onClose={onClose}>
      {err ? <p className="pretzel-text-alert text-sm">{err}</p> : null}
      {list === null && !err ? <p className="pretzel-text-panel-muted">Loading…</p> : null}
      {list?.length === 0 ? <p className="pretzel-text-panel-muted">No finished games yet.</p> : null}
      {list && list.length > 0 ? (
        <ul className="chess-history">
          {list.map((g) => (
            <li key={g.id}>
              <button type="button" className="chess-btn chess-history__row" onClick={() => open(g.id)}>
                <span className="chess-history__names">
                  {g.white ?? "?"} <span className="tetris-vs">vs</span> {g.black ?? "?"}
                </span>
                <span className="chess-banner">
                  <PixelText text={score(g.result)} />
                </span>
                <span className="chess-history__meta">
                  {g.reason ?? ""} · {Math.ceil(g.moveCount / 2)} moves
                  {g.endedAt ? ` · ${new Date(g.endedAt).toLocaleDateString()}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </ScrollDialog>
  );
}
