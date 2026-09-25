// Pure helpers for the order_feedback_1 template's three quick-reply buttons
// and its URL button — parsing/formatting only, no I/O, so both the cron send
// and the inbound webhook import the same vocabulary instead of each growing
// their own copy of "what does button index 1 mean".
//
// Template button layout (docs/WHATSAPP-FEEDBACK-TEMPLATE.md), fixed order:
//   index 0  quick_reply  "😍 Loved it"      → rating 5
//   index 1  quick_reply  "🙂 It was okay"   → rating 3
//   index 2  quick_reply  "😞 Not happy"     → rating 1
//   index 3  url          "Rate your order"  → https://hioc.in/feedback/{{1}}

export type FeedbackButtonRating = 5 | 3 | 1;

export interface FeedbackButton {
  index: 0 | 1 | 2;
  label: string;
  rating: FeedbackButtonRating;
}

// Single source of truth for both the send-time button text (adapters.ts
// passes nothing but the payload for quick replies, but the doc and the
// text-fallback parser below both need the exact label) and the inbound
// fallback match.
export const FEEDBACK_BUTTONS: readonly FeedbackButton[] = [
  { index: 0, label: '😍 Loved it', rating: 5 },
  { index: 1, label: '🙂 It was okay', rating: 3 },
  { index: 2, label: '😞 Not happy', rating: 1 },
];

export const FEEDBACK_URL_BUTTON_LABEL = 'Rate your order';

const PAYLOAD_PREFIX = 'fb:';

/** Builds the payload string for one quick-reply button: `fb:<requestId>:<rating>`. */
export function formatFeedbackButtonPayload(requestId: string, rating: FeedbackButtonRating): string {
  return `${PAYLOAD_PREFIX}${requestId}:${rating}`;
}

export interface ParsedFeedbackPayload {
  requestId: string;
  rating: FeedbackButtonRating;
}

/**
 * Parses `fb:<requestId>:<rating>` from a button payload. Never trusts the
 * shape beyond what it claims to be: an unrecognised rating or a missing id
 * segment returns null rather than a best-effort guess — the caller (the
 * webhook) must not act on unparseable attacker-controlled input.
 */
export function parseFeedbackButtonPayload(raw: string | null | undefined): ParsedFeedbackPayload | null {
  if (typeof raw !== 'string' || !raw.startsWith(PAYLOAD_PREFIX)) return null;
  const rest = raw.slice(PAYLOAD_PREFIX.length);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon <= 0) return null;
  const requestId = rest.slice(0, lastColon);
  const ratingRaw = rest.slice(lastColon + 1);
  const rating = Number(ratingRaw);
  if (!requestId || ![5, 3, 1].includes(rating)) return null;
  return { requestId, rating: rating as FeedbackButtonRating };
}

/**
 * Fallback for a tap whose payload came through empty/malformed — Meta's own
 * docs note `button.text` is the more reliable field on some client versions.
 * Matches the exact configured label; returns null (never a guess) for
 * anything else, including a customer who happens to type the same words.
 */
export function ratingFromButtonText(text: string | null | undefined): FeedbackButtonRating | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const match = FEEDBACK_BUTTONS.find((b) => b.label === trimmed);
  return match?.rating ?? null;
}

/** STOP / UNSUBSCRIBE, case-insensitive, ignoring surrounding whitespace. */
export function isOptOutKeyword(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim().toUpperCase();
  return t === 'STOP' || t === 'UNSUBSCRIBE';
}
