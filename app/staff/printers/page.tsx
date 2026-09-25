import { PrinterSettings } from '@/components/staff/PrinterSettings';

// PRN-1 — printer configuration for this counter machine. The /staff/**
// layout already gates this route behind getCounterActor() (PIN-3: a classic
// session, or an enrolled device's PIN operator); there's no extra permission
// split here, matching the pattern of sibling pages like
// app/staff/tables/page.tsx.
//
// The page itself is desktop-only in effect: outside the HIOC POS desktop app
// (no `window.hiocDesktop`), PrinterSettings renders a panel pointing staff at
// the app instead of the settings form — so this route is always in the web
// nav (StaffHeader) and safe to load directly, from a browser or the app.
export default function StaffPrintersPage() {
  return <PrinterSettings />;
}
