import { useParams } from "react-router-dom";

// Placeholder shell for Phase 0. The editor (waveform + panels) is built in Phases 4-6.
export function EditorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-2 p-8">
      <h1 className="font-heading text-2xl text-accent">Editor</h1>
      <p className="text-text-tertiary">project: {projectId}</p>
    </main>
  );
}
