import { Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
  return (
    <div className="overflow-y-scroll mx-auto min-h-screen max-w-lg relative bg-[#ececec] px-3">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
      <div className="bg-[#ececec] border-t absolute bottom-0 left-0 right-0 flex justify-between gap-2 px-3 py-2 ">
        <button className="min-w-24 bg-gray-800 flex-1 py-2 rounded-lg flex flex-col items-center nav-button">
          <div className="w-8 h-8 bg-gray-600" />
          <div className="uppercase font-semibold text-base">Lounge</div>
        </button>
        <button className="min-w-24 bg-gray-800 flex-1 py-2 rounded-lg flex flex-col items-center nav-button">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center text-gray-200">
            <img
              src="/icons/bedroom.svg"
              alt=""
              className="block h-full w-full max-h-8 max-w-8 object-contain"
              aria-hidden
            />
          </span>
          <div className="uppercase font-semibold text-base">Bedroom</div>
        </button>
        <button className="min-w-24 bg-gray-800 flex-1 py-2 rounded-lg flex flex-col items-center nav-button">
          <div className="w-8 h-8 bg-gray-600" />
          <div className="uppercase font-semibold text-base">Pretzel</div>
        </button>
      </div>
    </div>
  );
}
