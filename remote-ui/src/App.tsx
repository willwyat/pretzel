import { useState } from "react";
import { Route, Routes } from "react-router-dom";
import { Navbar } from "./components/Navbar";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";
import type { HomeRoomTab } from "./types/homeRoom";

export default function App() {
  const [homeRoom, setHomeRoom] = useState<HomeRoomTab>("lounge");

  return (
    <>
      <div className="pretzel-app-shell mx-auto min-h-screen max-w-lg px-3 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))]">
        <Routes>
          <Route
            path="/"
            element={<HomePage activeRoom={homeRoom} />}
          />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
      <Navbar activeRoom={homeRoom} onActiveRoomChange={setHomeRoom} />
    </>
  );
}
