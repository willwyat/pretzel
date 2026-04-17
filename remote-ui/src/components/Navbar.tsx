import type { HomeRoomTab } from "../types/homeRoom";

const navBtnBase =
  "min-w-24 flex flex-1 flex-col items-center rounded-lg py-2 nav-button transition-[box-shadow,ring]";

function navBtnActive(active: boolean) {
  return active
    ? "ring-2 ring-[#888] ring-offset-2 ring-offset-[var(--pretzel-surface-page)]"
    : "";
}

type NavbarProps = {
  activeRoom: HomeRoomTab;
  onActiveRoomChange: (room: HomeRoomTab) => void;
};

export function Navbar({ activeRoom, onActiveRoomChange }: NavbarProps) {
  return (
    <nav
      className="pretzel-nav-gradient fixed bottom-0 left-0 right-0 z-30 pt-4 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      role="navigation"
      aria-label="Rooms"
    >
      <div className="mx-auto flex max-w-lg justify-between gap-2 px-3">
        <button
          type="button"
          className={`${navBtnBase} ${navBtnActive(activeRoom === "lounge")}`}
          aria-pressed={activeRoom === "lounge"}
          onClick={() => onActiveRoomChange("lounge")}
        >
          <div className="h-8 w-8 bg-gray-600" />
          <div className="text-base font-semibold uppercase">Lounge</div>
        </button>
        <button
          type="button"
          className={`${navBtnBase} ${navBtnActive(activeRoom === "bedroom")}`}
          aria-pressed={activeRoom === "bedroom"}
          onClick={() => onActiveRoomChange("bedroom")}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center text-gray-200">
            <img
              src="/icons/bedroom.svg"
              alt=""
              className="block h-full max-h-8 w-full max-w-8 object-contain"
              aria-hidden
            />
          </span>
          <div className="text-base font-semibold uppercase">Bedroom</div>
        </button>
        <button
          type="button"
          className={`${navBtnBase} ${navBtnActive(activeRoom === "pretzel")}`}
          aria-pressed={activeRoom === "pretzel"}
          onClick={() => onActiveRoomChange("pretzel")}
        >
          <div className="h-8 w-8 bg-gray-600" />
          <div className="text-base font-semibold uppercase">Pretzel</div>
        </button>
      </div>
    </nav>
  );
}
