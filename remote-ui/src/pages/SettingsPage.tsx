import { Link } from "react-router-dom";
import { SettingsSection } from "../components/SettingsSection";

export function SettingsPage() {
  return (
    <div className="py-4">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="pretzel-page-title">Pretzel remote</h1>
          <p className="pretzel-page-subtitle">Operator settings</p>
        </div>
        <Link to="/" className="pretzel-btn-ghost">
          ← Home
        </Link>
      </div>

      <SettingsSection />
    </div>
  );
}
