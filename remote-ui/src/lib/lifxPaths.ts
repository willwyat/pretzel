import type { Light } from "../types/lifx";

/** Express path segment: encode `id:…` for /lifx/lights/:selector/state */
export function lifxStatePath(lightId: string): string {
  return `/lifx/lights/${encodeURIComponent(`id:${lightId}`)}/state`;
}

/** State endpoint for any light: WiZ bulbs go to pretzel-server by IP. */
export function lightStatePath(light: Light): string {
  if (light.provider === "wiz") {
    return `/pretzel/wiz/lights/${encodeURIComponent(light.id)}/state`;
  }
  return lifxStatePath(light.id);
}
