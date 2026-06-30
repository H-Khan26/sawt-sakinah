// Placeholder shell for Phase 0. The real landing card (link input -> POST /projects)
// is built in Phase 3 on top of the Phase 1 API hooks.
export function LandingPage() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 p-8">
      <h1 className="font-heading text-4xl text-accent">Sawt Sakinah</h1>
      <p className="font-arabic-display text-3xl text-accent-secondary" lang="ar" dir="rtl">
        صوت سكينة
      </p>
      <p className="text-text-secondary">Paste a YouTube link to begin.</p>
    </main>
  );
}
