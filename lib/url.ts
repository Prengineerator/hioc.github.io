// Absolute-URL helper for customer-facing links placed in messages we send out
// (WhatsApp, email), where a bare path won't do. Precedence matches the order
// notification links (lib/notifications/templates.ts): explicit site URL, then
// the Vercel production URL, then a bare path as a dev fallback.
export function absoluteUrl(path: string): string {
  const base = (
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : '')
  ).replace(/\/$/, '');
  const rel = path.startsWith('/') ? path : `/${path}`;
  return `${base}${rel}`;
}
