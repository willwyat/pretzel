const SEGMENTS = 16;

/** Presentational LED bar: lights segments up to `value` (0–100). */
export function VuMeter({ value }: { value: number }) {
  const lit = Math.round((Math.min(Math.max(value, 0), 100) / 100) * SEGMENTS);
  return (
    <div className="pretzel-vu" aria-hidden>
      {Array.from({ length: SEGMENTS }, (_, i) => {
        const zone =
          i >= SEGMENTS - 2
            ? " pretzel-vu__seg--peak"
            : i >= SEGMENTS - 5
              ? " pretzel-vu__seg--hot"
              : "";
        return (
          <span
            key={i}
            className={`pretzel-vu__seg${zone}${i < lit ? " pretzel-vu__seg--lit" : ""}`}
          />
        );
      })}
    </div>
  );
}
