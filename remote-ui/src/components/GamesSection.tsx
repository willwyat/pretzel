import { Link } from "react-router-dom";

export function GamesSection() {
  return (
    <section className="pretzel-panel" aria-label="Games">
      <div className="pretzel-panel__header">
        <h2 className="pretzel-text-panel-title">Games</h2>
      </div>
      <div className="pretzel-panel__body">
        <Link to="/chess" className="pretzel-btn-ghost">
          Chess
        </Link>
      </div>
    </section>
  );
}
