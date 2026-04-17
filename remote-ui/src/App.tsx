import { Route, Routes } from "react-router-dom";
import { Navbar } from "./components/Navbar";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
  return (
    <>
      <div className="mx-auto min-h-screen max-w-lg bg-[#ececec] px-3 pb-[calc(6.5rem+env(safe-area-inset-bottom,0px))]">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
      <Navbar />
    </>
  );
}
