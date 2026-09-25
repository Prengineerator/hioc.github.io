import { PrinterSettings } from '@/components/staff/settings/PrinterSettings';

// PRN-1/SET-1 — printer configuration for this counter machine, moved here
// from /staff/printers (now a redirect) as part of consolidating every
// POS/counter setting under /staff/settings. The /staff/settings/** layout
// already gates this behind getCounterActor() via app/staff/layout.tsx;
// there's no extra permission split here.
//
// PrinterSettings itself is desktop-only in effect: outside the HIOC POS
// desktop app (no `window.hiocDesktop`), it renders a panel pointing staff
// at the app instead of the settings form — so this route stays reachable
// from a browser or the app either way.
export default function StaffSettingsPrintersPage() {
  return <PrinterSettings />;
}
