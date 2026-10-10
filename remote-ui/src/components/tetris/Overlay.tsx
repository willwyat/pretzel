import type { ReactNode } from "react";

/** Dimmed full-screen sheet with a black-plate card, built from the Moog panel classes. */
export function Overlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="tetris-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="tetris-overlay__card">
        <div className="pretzel-panel__header">
          <h2 className="pretzel-text-panel-title">{title}</h2>
          {onClose ? (
            <button type="button" className="pretzel-btn-icon" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          ) : null}
        </div>
        <div className="pretzel-panel__body flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}
