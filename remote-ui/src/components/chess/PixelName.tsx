import { useEffect, useRef } from "react";

const FONT = '"UnifrakturMaguntia"';
/** Glyphs are drawn this many CSS px tall, then each canvas pixel is shown as SCALE×SCALE CSS px. */
const BASE_PX = 20;
const SCALE = 1.5;

/**
 * Player name in UnifrakturMaguntia with a hard pixel look: drawn small on a
 * canvas, anti-aliasing thresholded away, then scaled up with
 * `image-rendering: pixelated`. Falls back to plain text until the font loads.
 */
export function PixelName({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    const draw = async () => {
      const canvas = ref.current;
      if (!canvas) return;
      const font = `${BASE_PX}px ${FONT}`;
      try {
        await document.fonts.load(font, text);
      } catch {
        /* draw with whatever is available */
      }
      if (cancelled) return;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.font = font;
      const w = Math.max(1, Math.ceil(ctx.measureText(text).width) + 2);
      const h = Math.ceil(BASE_PX * 1.25);
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${w * SCALE}px`;
      canvas.style.height = `${h * SCALE}px`;
      ctx.font = font; // resizing resets context state
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = getComputedStyle(canvas).color;
      ctx.fillText(text, 1, Math.round(BASE_PX * 0.95));
      const img = ctx.getImageData(0, 0, w, h);
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] > 110 ? 255 : 0;
      ctx.putImageData(img, 0, 0);
    };
    void draw();
    return () => {
      cancelled = true;
    };
  }, [text]);

  return <canvas ref={ref} className={`chess-pixelname ${className}`.trim()} role="img" aria-label={text} />;
}
