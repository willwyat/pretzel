import { Link } from "react-router-dom";

export function GamesSection() {
  return (
    <section className="pretzel-panel" aria-label="Games">
      <div className="pretzel-panel__header">
        <h2 className="pretzel-text-panel-title">Games</h2>
      </div>
      <div className="pretzel-panel__body flex flex-wrap gap-2">
        <Link to="/chess" className="pretzel-btn-ghost">
          Chess
        </Link>
        <Link to="/tetris" className="pretzel-btn-ghost">
          Tetris
        </Link>
      </div>
    </section>
  );
}
