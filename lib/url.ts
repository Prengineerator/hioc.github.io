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

/**
 * A post-login redirect target, or null. Only a same-site absolute path is
 * allowed: it must start with a single "/" (not "//", which browsers treat as
 * another host) and contain no backslash (some browsers normalise "/\\host").
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return null;
  if (/[\u0000-\u001f]/.test(v)) return null;
  return v;
}
