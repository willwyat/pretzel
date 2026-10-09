import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pixels } from "./Piece";

const CLOSE_GLYPH = [
  "##....##",
  ".##..##.",
  "..####..",
  "...##...",
  "..####..",
  ".##..##.",
  "##....##",
];

/** Classic window frame: navy title bar, optional controls, grey face. */
export function WinWindow({
  title,
  icon,
  onClose,
  className = "",
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  onClose?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`win ${className}`.trim()}>
      <div className="win-title">
        {icon ? <span className="win-title-icon" aria-hidden>{icon}</span> : null}
        <span className="win-title-text">{title}</span>
        {onClose ? (
          <button type="button" className="win-titlebtn" onClick={onClose} aria-label="Close">
            <Pixels rows={CLOSE_GLYPH} palette={{ "#": "#000" }} className="win-titlebtn-glyph" />
          </button>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export type MsgButton = { label: string; onClick: () => void; primary?: boolean };

/** Modal message box with a row of push buttons (Esc picks the last one). */
export function MsgBox({
  title,
  icon,
  children,
  buttons,
}: {
  title: string;
  icon?: "question" | "info" | "warning";
  children: ReactNode;
  buttons: MsgButton[];
}) {
  const primary = useRef<HTMLButtonElement>(null);
  const latest = useRef(buttons);
  latest.current = buttons;
  useEffect(() => {
    primary.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") latest.current[latest.current.length - 1]?.onClick();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="win-modal">
      <WinWindow title={title} className="win--dialog">
        <div role="alertdialog" aria-label={title} className="win-dialog-body">
          {icon ? <MsgIcon kind={icon} /> : null}
          <div>{children}</div>
        </div>
        <div className="win-dialog-buttons">
          {buttons.map((b) => (
            <button
              key={b.label}
              ref={b.primary ? primary : undefined}
              type="button"
              className={`win-btn${b.primary ? " win-btn--default" : ""}`}
              onClick={b.onClick}
            >
              {b.label}
            </button>
          ))}
        </div>
      </WinWindow>
    </div>
  );
}

function MsgIcon({ kind }: { kind: "question" | "info" | "warning" }) {
  const glyph = kind === "question" ? "?" : kind === "info" ? "i" : "!";
  return (
    <span className={`win-msgicon win-msgicon--${kind}`} aria-hidden>
      {glyph}
    </span>
  );
}

export type MenuItem =
  | { label: string; onClick: () => void; disabled?: boolean; checked?: boolean }
  | "separator";

/**
 * Menu bar with drop-downs. Tap/click opens, tapping anywhere else (or Esc)
 * closes, and once one menu is open hovering another switches to it.
 */
export function MenuBar({ menus }: { menus: { label: string; items: MenuItem[] }[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open === null) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="win-menubar" ref={ref} role="menubar">
      {menus.map((m, i) => (
        <div key={m.label} className="win-menu">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="true"
            aria-expanded={open === i}
            className={`win-menuitem${open === i ? " win-menuitem--open" : ""}`}
            onClick={() => setOpen(open === i ? null : i)}
            onPointerEnter={(e) => e.pointerType === "mouse" && open !== null && setOpen(i)}
          >
            <u>{m.label[0]}</u>
            {m.label.slice(1)}
          </button>
          {open === i ? (
            <div className="win-dropdown" role="menu">
              {m.items.map((it, j) =>
                it === "separator" ? (
                  <hr key={`sep-${j}`} className="win-sep" />
                ) : (
                  <button
                    key={it.label}
                    type="button"
                    role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                    aria-checked={it.checked}
                    disabled={it.disabled}
                    onClick={() => {
                      setOpen(null);
                      it.onClick();
                    }}
                  >
                    <span className="win-check" aria-hidden>
                      {it.checked ? "✓" : ""}
                    </span>
                    {it.label}
                  </button>
                ),
              )}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
