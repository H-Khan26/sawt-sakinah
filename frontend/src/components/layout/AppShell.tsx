import type { ReactNode } from "react";
import { useMatch } from "react-router-dom";
import { EditorShell } from "./EditorShell";
import { LibraryShell } from "./LibraryShell";

/**
 * Picks the layout for the current route: {@link EditorShell} for a recording (`/p/:projectId`),
 * {@link LibraryShell} for the library and the new-recording flow.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const editor = useMatch("/p/:projectId/*");
  if (editor) return <EditorShell>{children}</EditorShell>;
  return <LibraryShell>{children}</LibraryShell>;
}
