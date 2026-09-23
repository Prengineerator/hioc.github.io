import { PrinterSettings } from '@/components/staff/PrinterSettings';

// PRN-1 — printer configuration for this counter machine. The /staff/**
// layout already gates this route behind getStaffOrOwner() (a signed-in
// staff/manager/owner is guaranteed); there's no extra permission split here,
// matching the pattern of sibling pages like app/staff/tables/page.tsx.
//
// The page itself is desktop-only in effect: PrinterSettings renders a plain
// "not available in a browser" message unless `window.hiocDesktop` exists, so
// this route is safe to link from the web nav (StaffHeader hides the link
// itself when there's no bridge) and safe to load directly too.
export default function StaffPrintersPage() {
  return <PrinterSettings />;
}
