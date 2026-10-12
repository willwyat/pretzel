import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Pixels per second; the strip moves one whole pixel per step. */
const SPEED_PX_S = 30;
/** Hold at the start of each lap so the beginning is readable. */
const HOLD_MS = 1500;
/** Blank run between the end of the text and its next copy, in px. */
const GAP_PX = 48;

/**
 * Amber pixel-font lamp. Text that fits sits still; text that doesn't
 * scrolls left one pixel at a time and wraps round like a carousel.
 */
export function PixelMarquee({
  text,
  className = "",
  title,
}: {
  text: string;
  className?: string;
  title?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  /** Width of one lap (text + gap) when it overflows, else 0. */
  const [lap, setLap] = useState(0);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const span = textRef.current;
    if (!box || !span) return;
    const measure = () => {
      const style = getComputedStyle(box);
      const inner =
        box.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      const w = Math.ceil(span.getBoundingClientRect().width);
      setLap(w > inner + 1 ? w + GAP_PX : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    // The webfont can land after first paint and change the width.
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [text]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.style.transform = "translateX(0)";
    if (!lap) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let start = performance.now() + HOLD_MS;
    let last = -1;
    const tick = (now: number) => {
      const px = Math.max(0, Math.floor(((now - start) * SPEED_PX_S) / 1000));
      if (px >= lap) {
        // Lap done: the copy now sits exactly where the original began.
        start = now + HOLD_MS;
        last = 0;
        strip.style.transform = "translateX(0)";
      } else if (px !== last) {
        last = px;
        strip.style.transform = `translateX(${-px}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lap]);

  return (
    <div
      ref={boxRef}
      className={`pretzel-readout pretzel-pixel-readout ${className}`}
      title={title ?? text}
    >
      <div ref={stripRef} className="pretzel-pixel-readout__strip">
        <span ref={textRef}>{text}</span>
        {lap > 0 && (
          <span aria-hidden style={{ paddingLeft: GAP_PX }}>
            {text}
          </span>
        )}
      </div>
    </div>
  );
}
