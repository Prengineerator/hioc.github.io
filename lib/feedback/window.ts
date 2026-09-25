// Pure time math for the feedback feature — no I/O, unit-tested directly.

const MINUTE_MS = 60_000;
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * MINUTE_MS; // Meta's 24h rule
const EDIT_WINDOW_MS = 7 * 24 * 60 * MINUTE_MS; // web feedback page: 7 days

/**
 * When a completed order's feedback request should fire, given the store's
 * configured delay (store_settings.feedback_delay_min, default 30).
 */
export function computeScheduledFor(completedAt: Date, delayMin: number): Date {
  return new Date(completedAt.getTime() + delayMin * MINUTE_MS);
}

/**
 * Meta's customer-service window: a business may send FREE-FORM text only
 * within 24h of the customer's most recent inbound message. Outside it, only
 * an approved template may be sent. `lastInboundAt` null (never replied)
 * means the window has never opened.
 */
export function withinCustomerServiceWindow(lastInboundAt: string | Date | null, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false;
  const at = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
  if (Number.isNaN(at.getTime())) return false;
  return now.getTime() - at.getTime() < CUSTOMER_SERVICE_WINDOW_MS;
}

/** Whether the feedback TEMPLATE may be re-sent: it wasn't already sent in the last 24h. */
export function templateResendAllowed(lastTemplateSentAt: string | Date | null, now: Date = new Date()): boolean {
  if (!lastTemplateSentAt) return true;
  const at = lastTemplateSentAt instanceof Date ? lastTemplateSentAt : new Date(lastTemplateSentAt);
  if (Number.isNaN(at.getTime())) return true;
  return now.getTime() - at.getTime() >= CUSTOMER_SERVICE_WINDOW_MS;
}

/** The web feedback page (/feedback/[token]) allows editing for 7 days after the request was created. */
export function withinEditWindow(createdAt: string | Date, now: Date = new Date()): boolean {
  const at = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(at.getTime())) return false;
  return now.getTime() - at.getTime() < EDIT_WINDOW_MS;
}
