import { useEffect } from "react";

const GAME_VIEWPORT = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

/** Real full screen where the browser supports it (Android); iPhone Safari keeps the fixed shell. */
export function enterFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: "hide" })
    .then(() => {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      return o.lock?.("portrait");
    })
    .catch(() => {
      /* not allowed here; the shell still fills the viewport */
    });
}

export function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

/**
 * While a full-screen game (Tetris, Chess) is open: no page scroll,
 * pull-to-refresh or zoom, and safe-area insets enabled.
 */
export function useGameViewport() {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("tetris-lock");
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const prev = meta?.content;
    if (meta) meta.content = GAME_VIEWPORT;
    return () => {
      html.classList.remove("tetris-lock");
      if (meta && prev !== undefined) meta.content = prev;
      exitFullscreen();
    };
  }, []);
}
