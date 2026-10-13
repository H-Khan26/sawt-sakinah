import { AppShell } from "@/components/layout/AppShell";
import { EditorPage } from "@/pages/EditorPage";
import { ProjectLibraryPage } from "@/pages/ProjectLibraryPage";
import { Navigate, Route, Routes } from "react-router-dom";

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<ProjectLibraryPage />} />
        <Route path="/new" element={<ProjectLibraryPage newSheet />} />
        <Route path="/p/:projectId" element={<EditorPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
