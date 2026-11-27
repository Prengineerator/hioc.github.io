// Shown the instant a staff screen change starts, until the new screen arrives.
//
// There used to be no loading state anywhere under /staff: a tap on New order
// or Tables left the old screen standing, untouched, while the server checked
// the sign-in and rendered the page. To the counter that read as "it didn't
// hear me", so people tapped again (and again), and the POS looked hung. The
// header stays live above this (the layout isn't re-rendered on a screen
// change), so the staffer can still go somewhere else.
//
// Deliberately plain: a server component with no data, so it costs nothing to
// send ahead of time.

export default function StaffLoading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div aria-hidden className="animate-pulse">
        <div className="mb-2 h-7 w-48 rounded bg-line/70" />
        <div className="mb-6 h-4 w-72 max-w-full rounded bg-line/50" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-24 rounded-md border border-line bg-cream" />
          ))}
        </div>
      </div>
    </div>
  );
}
