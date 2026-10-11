import type { Light } from "../types/lifx";

/** Express path segment: encode `id:…` for /lifx/lights/:selector/state */
export function lifxStatePath(lightId: string): string {
  return `/lifx/lights/${encodeURIComponent(`id:${lightId}`)}/state`;
}

/** State endpoint for any light: WiZ bulbs (by IP) and Tuya switches (by
 *  device id) go to pretzel-server. */
export function lightStatePath(light: Light): string {
  if (light.provider === "wiz") {
    return `/pretzel/wiz/lights/${encodeURIComponent(light.id)}/state`;
  }
  if (light.provider === "tuya") {
    return `/pretzel/tuya/switches/${encodeURIComponent(light.id)}/state`;
  }
  return lifxStatePath(light.id);
}
