// BILL-3/4/5 — turns a machine reason code into something a staffer or owner can
// act on. Deliberately dependency-free and client-safe: the same wording is used
// by the POS/order-detail resend action and the owner delivery log, so a cause
// can't be described two different ways in two places.

const PLAIN: Record<string, string> = {
  no_phone: 'No phone number on this order',
  no_email: 'No email address on this order',
  notifications_disabled: 'Notifications are turned off',
  send_failed: 'The provider rejected the message',
};

/**
 * `reason` is '' when the channel delivered. `not_configured:A,B` names the
 * missing environment variables — an owner-fixable cause, so we say so.
 */
export function describeSkipReason(reason: string): string {
  if (!reason) return '';
  if (reason.startsWith('not_configured:')) {
    const vars = reason.slice('not_configured:'.length).split(',').filter(Boolean);
    return vars.length > 0 ? `Channel not configured (missing ${vars.join(', ')})` : 'Channel not configured';
  }
  return PLAIN[reason] ?? reason;
}

/** One line summarising a two-channel bill send for a toast or inline status. */
export function describeBillOutcome(
  sent: { whatsapp: boolean; email: boolean },
  reasons: { whatsapp: string; email: string },
): string {
  const delivered: string[] = [];
  if (sent.whatsapp) delivered.push('WhatsApp');
  if (sent.email) delivered.push('email');
  if (delivered.length > 0) return `Bill sent on ${delivered.join(' and ')}.`;

  // Nothing sent — say why, preferring the channel the cafe actually relies on.
  const cause = describeSkipReason(reasons.whatsapp) || describeSkipReason(reasons.email);
  return cause ? `Bill not sent — ${cause.toLowerCase()}.` : 'Bill not sent.';
}
