export function Navbar() {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-30 bg-gradient-to-t from-[#ececec] via-[#ececec]/95 to-transparent pt-4 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      role="navigation"
      aria-label="Rooms"
    >
      <div className="mx-auto flex max-w-lg justify-between gap-2 px-3">
        <button
          type="button"
          className="min-w-24 flex flex-1 flex-col items-center rounded-lg py-2 nav-button"
        >
          <div className="h-8 w-8 bg-gray-600" />
          <div className="text-base font-semibold uppercase">Lounge</div>
        </button>
        <button
          type="button"
          className="min-w-24 flex flex-1 flex-col items-center rounded-lg py-2 nav-button"
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
          className="min-w-24 flex flex-1 flex-col items-center rounded-lg py-2 nav-button"
        >
          <div className="h-8 w-8 bg-gray-600" />
          <div className="text-base font-semibold uppercase">Pretzel</div>
        </button>
      </div>
    </nav>
  );
}
