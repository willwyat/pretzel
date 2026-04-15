import { LightsSection } from "./components/LightsSection";
import { PretzelSection } from "./components/PretzelSection";
import { TvSection } from "./components/TvSection";

export default function App() {
  return (
    <div className="mx-auto min-h-screen max-w-lg px-4 py-6">
      <h1 className="text-xl font-semibold text-gray-100">Pretzel remote</h1>
      <p className="mt-1 text-sm text-gray-500">
        Same Wi‑Fi only. TV, Pi speaker, LIFX.
      </p>

      <div className="mt-6 flex flex-col gap-6">
        <TvSection />
        <PretzelSection />
        <LightsSection />
      </div>
    </div>
  );
}
