// What the screens say about the delivery person's WhatsApp list (WH-D17),
// after the existing email wording. Client-safe (no server imports), shared by
// the owner's Warehouse page and the staff Stock screen so both read the same.

/** The reply's `whatsapp` field. Absent when the feature is off or does not apply. */
export type PickupResult = 'sent' | 'already_sent' | 'no_number' | 'not_set_up' | 'limit_reached' | 'failed' | 'not_confirmed';

/** One short sentence to add to the notice; '' when there is nothing to add. */
export function pickupNotice(result: PickupResult | undefined, name: string): string {
  switch (result) {
    case 'sent':
      return `WhatsApp sent to ${name}.`;
    case 'no_number':
      return 'No WhatsApp: no number saved.';
    case 'not_set_up':
      return `No WhatsApp: it is not set up yet, so tell ${name}.`;
    case 'limit_reached':
      return `No WhatsApp: the daily limit is reached, so tell ${name}.`;
    case 'not_confirmed':
      return `The WhatsApp could not be confirmed, so tell ${name}.`;
    case 'failed':
      return `The WhatsApp could not be sent, so tell ${name}.`;
    case 'already_sent':
      return `${name} already has the WhatsApp.`;
    default:
      return '';
  }
}

/** Joins the existing notice and the WhatsApp sentence; the notice alone when there is none. */
export function withPickupNotice(notice: string, result: PickupResult | undefined, name: string): string {
  const extra = pickupNotice(result, name);
  return extra ? `${notice} ${extra}` : notice;
}
