import type { ButtonHTMLAttributes, ReactNode } from "react";
import { PixelName } from "./PixelName";
import { PixelText } from "./PixelText";

/**
 * Chess's version of the Tetris Overlay: the same dimmed full-screen sheet,
 * but the card is a small parchment scroll that unrolls, titled in pixel
 * Fraktur. Lives inside .chess-shell so it picks up the scroll tokens.
 */
export function ScrollDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="tetris-overlay chess-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="chess-dialog__scroll">
        <div className="chess-scroll__roller" aria-hidden />
        <div className="chess-scroll__paper chess-dialog__paper">
          <div className="chess-dialog__header">
            <h2 className="chess-dialog__title">
              <PixelName text={title} />
            </h2>
            {onClose ? <ScrollButton label="X" aria-label="Close" className="chess-btn--icon" onClick={onClose} /> : null}
          </div>
          <div className="chess-dialog__body">{children}</div>
        </div>
        <div className="chess-scroll__roller" aria-hidden />
      </div>
    </div>
  );
}

/**
 * Bevelled pixel button with a bitmap label. Tones: plain parchment, gold for
 * the main action, wax red for destructive ones, wood for the scroll's own key.
 */
export function ScrollButton({
  label,
  tone,
  icon,
  className = "",
  ...rest
}: {
  label: string;
  tone?: "gold" | "danger" | "wood";
  icon?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ["chess-btn", tone ? `chess-btn--${tone}` : "", className].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} {...rest}>
      {icon}
      <PixelText text={label} />
    </button>
  );
}
