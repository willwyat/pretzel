import { Link } from "react-router-dom";
import { LightsSection } from "../components/LightsSection";
import { PretzelSection } from "../components/PretzelSection";
import { TvSection } from "../components/TvSection";
import { useEffect, useState } from "react";

export function HomePage() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const colonVisible = now.getSeconds() % 2 === 0;
  return (
    <div className="py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1
            className="text-6xl font-bold tabular-nums text-[#222]"
            aria-label={`${h}:${m}`}
          >
            <span aria-hidden="true">{h}</span>
            <span
              aria-hidden="true"
              className={colonVisible ? "opacity-100" : "opacity-0"}
            >
              {`:`}
            </span>
            <span aria-hidden="true">{m}</span>
          </h1>
        </div>
        <Link
          to="/settings"
          className="flex-shrink-0 rounded-lg border border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-gray-800"
        >
          Settings
        </Link>
      </div>

      <div className="flex flex-col gap-6">
        <TvSection />
        <PretzelSection />
        <LightsSection />
      </div>
    </div>
  );
}
