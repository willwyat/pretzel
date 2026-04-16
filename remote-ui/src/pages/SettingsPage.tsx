import { Link } from "react-router-dom";
import { SettingsSection } from "../components/SettingsSection";

export function SettingsPage() {
  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-100">Pretzel remote</h1>
          <p className="mt-1 text-sm text-gray-500">Operator settings</p>
        </div>
        <Link
          to="/"
          className="flex-shrink-0 rounded-lg border border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-gray-800"
        >
          ← Home
        </Link>
      </div>

      <SettingsSection />
    </>
  );
}
