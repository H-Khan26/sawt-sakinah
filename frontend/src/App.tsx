import { AppShell } from "@/components/layout/AppShell";
import { EditorPage } from "@/pages/EditorPage";
// TEMPORARY: primitives gallery — remove this import and its route before the Phase 2 PR.
import { GalleryPage } from "@/pages/GalleryPage";
import { LandingPage } from "@/pages/LandingPage";
import { Navigate, Route, Routes } from "react-router-dom";

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/p/:projectId" element={<EditorPage />} />
        {/* TEMPORARY dev route — remove before the Phase 2 PR. */}
        <Route path="/dev/ui" element={<GalleryPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
