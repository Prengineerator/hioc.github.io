import { redirect } from 'next/navigation';
import { appendSearchParams } from '@/lib/url';

// SET-1 — printer settings moved under the consolidated /staff/settings
// area (app/staff/settings/printers/page.tsx). This route stays as a plain
// redirect rather than disappearing: it's bookmarked, and the desktop app
// itself may still have it open in a tab that hasn't reloaded. Preserves any
// query string the visitor arrived with (appendSearchParams, lib/url.ts).
//
// /staff/** is already gated by middleware.ts + app/staff/layout.tsx before
// this ever renders — nothing route-specific to carry over here.
export default function StaffPrintersRedirectPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  redirect(appendSearchParams('/staff/settings/printers', searchParams));
}
