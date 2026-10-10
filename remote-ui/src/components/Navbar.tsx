import type { ReactNode } from "react";
import type { HomeRoomTab } from "../types/homeRoom";

const navBtnBase =
  "nav-button min-w-24 flex flex-1 flex-col items-center pt-2 pb-2.5";

const strokeIcon = {
  className: "pretzel-nav-icon",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function SofaIcon() {
  return (
    <svg {...strokeIcon}>
      <path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3" />
      <path d="M3 13a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M6 18v2M18 18v2" />
    </svg>
  );
}

function PretzelIcon() {
  return (
    <svg {...strokeIcon}>
      <path d="M12 20c-4.5 0-8.5-3-8.5-7.5a4.5 4.5 0 0 1 8.5-2 4.5 4.5 0 0 1 8.5 2c0 4.5-4 7.5-8.5 7.5z" />
      <path d="M7.5 15.5 15 9.5M16.5 15.5 9 9.5" />
    </svg>
  );
}

/** The bedroom glyph ships as a fixed-color SVG file; mask it so it takes the key's legend color. */
function BedroomIcon() {
  return (
    <span
      className="pretzel-nav-icon block bg-current"
      style={{
        WebkitMask: "url(/icons/bedroom.svg) center / contain no-repeat",
        mask: "url(/icons/bedroom.svg) center / contain no-repeat",
      }}
      aria-hidden
    />
  );
}

const ROOMS: { id: HomeRoomTab; label: string; icon: ReactNode }[] = [
  { id: "lounge", label: "Lounge", icon: <SofaIcon /> },
  { id: "bedroom", label: "Bedroom", icon: <BedroomIcon /> },
  { id: "pretzel", label: "Pretzel", icon: <PretzelIcon /> },
];

type NavbarProps = {
  activeRoom: HomeRoomTab;
  onActiveRoomChange: (room: HomeRoomTab) => void;
};

export function Navbar({ activeRoom, onActiveRoomChange }: NavbarProps) {
  return (
    <nav
      className="pretzel-nav-gradient fixed bottom-0 left-0 right-0 z-30 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      role="navigation"
      aria-label="Rooms"
    >
      <div className="mx-auto flex max-w-lg justify-between gap-2 px-3">
        {ROOMS.map(({ id, label, icon }, index) => (
          <button
            key={id}
            type="button"
            className={`${navBtnBase} ${
              index === 0
                ? "nav-button-start"
                : index === ROOMS.length - 1
                  ? "nav-button-end"
                  : "nav-button-center"
            } ${activeRoom === id ? "pretzel-nav-tab-active" : ""}`.trim()}
            aria-pressed={activeRoom === id}
            onClick={() => onActiveRoomChange(id)}
          >
            <span className="pretzel-nav-lamp" aria-hidden />
            {icon}
            <span className="pretzel-nav-label font-bold uppercase">{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
