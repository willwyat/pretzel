/** Express path segment: encode `id:…` for /lifx/lights/:selector/state */
export function lifxStatePath(lightId: string): string {
  return `/lifx/lights/${encodeURIComponent(`id:${lightId}`)}/state`;
}
