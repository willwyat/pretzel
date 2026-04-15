import { useCallback, useEffect, useState } from "react";
import type { Light } from "../types/lifx";
import { LightbulbIcon } from "./LightbulbIcon";

interface LightCardProps {
  light: Light;
  onToggle: (light: Light) => void;
  onBrightness: (light: Light, brightness: number) => void;
  onColor: (light: Light, color: string) => void;
}

interface ColorSwatch {
  label: string;
  color: string;
  bg: string;
  hue?: number;
  kelvin?: number;
}

const COLOR_SWATCHES: ColorSwatch[] = [
  { label: "Warm", color: "kelvin:2700", bg: "#ffb347", kelvin: 2700 },
  { label: "White", color: "kelvin:4000", bg: "#fff5e0", kelvin: 4000 },
  { label: "Cool", color: "kelvin:6500", bg: "#e8f4ff", kelvin: 6500 },
  { label: "Red", color: "hue:0 saturation:1.0", bg: "#ff3b30", hue: 0 },
  { label: "Orange", color: "hue:30 saturation:1.0", bg: "#ff9500", hue: 30 },
  { label: "Yellow", color: "hue:60 saturation:1.0", bg: "#ffcc00", hue: 60 },
  { label: "Green", color: "hue:120 saturation:1.0", bg: "#34c759", hue: 120 },
  { label: "Cyan", color: "hue:180 saturation:1.0", bg: "#32ade6", hue: 180 },
  { label: "Blue", color: "hue:240 saturation:1.0", bg: "#007aff", hue: 240 },
  { label: "Purple", color: "hue:270 saturation:1.0", bg: "#af52de", hue: 270 },
  { label: "Pink", color: "hue:320 saturation:1.0", bg: "#ff2d55", hue: 320 },
];

const KELVIN_SWATCHES: ColorSwatch[] = [
  { label: "Candle", color: "kelvin:1500", bg: "#ff6a00", kelvin: 1500 },
  { label: "Warm", color: "kelvin:2700", bg: "#ffb347", kelvin: 2700 },
  { label: "Neutral", color: "kelvin:3500", bg: "#ffd580", kelvin: 3500 },
  { label: "White", color: "kelvin:4000", bg: "#fff5e0", kelvin: 4000 },
  { label: "Cool", color: "kelvin:5000", bg: "#e8f4ff", kelvin: 5000 },
  { label: "Day", color: "kelvin:6500", bg: "#cce8ff", kelvin: 6500 },
];

function isSwatchActive(swatch: ColorSwatch, light: Light): boolean {
  const sat = light.color?.saturation ?? 0;
  const kelvin = light.color?.kelvin ?? 0;
  const hue = light.color?.hue ?? 0;
  if (swatch.kelvin !== undefined && sat < 0.1) {
    return Math.abs(kelvin - swatch.kelvin) < 300;
  }
  if (swatch.hue !== undefined && sat >= 0.5) {
    const diff = Math.abs(hue - swatch.hue);
    return Math.min(diff, 360 - diff) < 20;
  }
  return false;
}

function kelvinToTailwind(kelvin: number): string {
  if (kelvin <= 2500) return "bg-orange-400";
  if (kelvin <= 3000) return "bg-amber-300";
  if (kelvin <= 4000) return "bg-yellow-200";
  if (kelvin <= 5000) return "bg-yellow-100";
  return "bg-blue-100";
}

function kelvinLabel(kelvin: number): string {
  if (kelvin <= 2500) return "Candlelight";
  if (kelvin <= 3000) return "Warm";
  if (kelvin <= 4000) return "Neutral";
  if (kelvin <= 5000) return "Cool White";
  return "Daylight";
}

export function LightCard({
  light,
  onToggle,
  onBrightness,
  onColor,
}: LightCardProps) {
  const isOn = light.power === "on";
  const [localBrightness, setLocalBrightness] = useState(light.brightness ?? 0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setLocalBrightness(light.brightness ?? 0);
  }, [light.id, light.brightness]);

  const commitBrightness = useCallback(
    (value: number) => {
      onBrightness(light, value);
    },
    [light, onBrightness],
  );

  const kelvin = light.color?.kelvin ?? 4000;

  return (
    <div
      className={`relative overflow-hidden rounded-xl border transition-all ${
        isOn
          ? "border-gray-700 bg-gray-800 shadow-sm"
          : "border-gray-800 bg-gray-900"
      }`}
    >
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          onClick={() => onToggle(light)}
          className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition ${
            isOn
              ? `${kelvinToTailwind(kelvin)} text-gray-900 shadow-inner`
              : "bg-gray-700 text-gray-400"
          }`}
          title={isOn ? "Turn off" : "Turn on"}
        >
          <LightbulbIcon className="h-[18px] w-[18px] select-none" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3
              className={`truncate text-sm font-medium ${
                isOn ? "text-gray-100" : "text-gray-500"
              }`}
            >
              {light.label}
            </h3>
            {!light.connected && (
              <span className="flex-shrink-0 rounded bg-rose-900/80 px-1.5 py-0.5 text-[10px] font-medium text-rose-300">
                Offline
              </span>
            )}
          </div>

          <p className="text-xs text-gray-400">
            {light.product?.name || "LIFX Light"}
            {isOn && ` · ${kelvinLabel(kelvin)}`}
          </p>

          {isOn && (
            <div className="mt-3 flex items-center gap-2">
              <svg
                className="h-3.5 w-3.5 flex-shrink-0 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
                />
              </svg>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(
                  (dragging ? localBrightness : (light.brightness ?? 0)) * 100,
                )}
                onChange={(e) => {
                  const val = Number(e.target.value) / 100;
                  setLocalBrightness(val);
                  setDragging(true);
                }}
                onMouseUp={() => {
                  setDragging(false);
                  commitBrightness(localBrightness);
                }}
                onTouchEnd={() => {
                  setDragging(false);
                  commitBrightness(localBrightness);
                }}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-amber-500"
              />
              <span className="w-8 text-right text-[11px] tabular-nums text-gray-400">
                {Math.round(
                  (dragging ? localBrightness : (light.brightness ?? 0)) * 100,
                )}
                %
              </span>
            </div>
          )}

          {isOn && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(light.product?.capabilities?.has_color
                ? COLOR_SWATCHES
                : light.product?.capabilities?.has_variable_color_temp
                  ? KELVIN_SWATCHES
                  : []
              ).map((swatch) => {
                const active = isSwatchActive(swatch, light);
                return (
                  <button
                    key={swatch.label}
                    type="button"
                    title={swatch.label}
                    onClick={() => onColor(light, swatch.color)}
                    className={`h-5 w-5 rounded-full transition-transform hover:scale-110 ${
                      active ? "ring-2 ring-offset-1 ring-gray-500 ring-offset-gray-900" : ""
                    }`}
                    style={{ background: swatch.bg }}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
