import { Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";

export default function App() {
  return (
    <div className="mx-auto min-h-screen max-w-lg px-4 py-6">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </div>
  );
}
