// RETIRED PATH — kept only because Meta is configured to call it.
//
// This endpoint shipped in commit 8bd9859 with a fail-OPEN signature check:
//
//     const secret = process.env.WHATSAPP_APP_SECRET;
//     if (!secret) return true;  // not configured — accept
//
// WHATSAPP_APP_SECRET has never been set in any environment, so for as long as
// this file had its own handler it was an unauthenticated public write endpoint
// into `notifications` — anyone who could guess a wamid could rewrite delivery
// history. It also collapsed sent/delivered/read into 'sent' with no rank guard
// and blanked `error` on every update, so even the receipts it did accept were
// wrong.
//
// WA-4 wrote the correct handler at /api/webhooks/whatsapp (fail-closed HMAC,
// forward-only ladder, set-once receipts). Deleting this file was the obvious
// move and is the wrong one: `.env.local.example` documents THIS path as the
// Meta callback URL, and a 404 on a live webhook makes Meta retry and then
// disable the subscription — silently, which is the failure class this phase
// exists to remove.
//
// So the path survives and the handler does not. Both URLs now run exactly one
// implementation. Once Meta's callback URL is switched to /api/webhooks/whatsapp
// and a delivery receipt has been observed arriving there, this file can be
// deleted outright.

export { GET, POST, dynamic } from '@/app/api/webhooks/whatsapp/route';
