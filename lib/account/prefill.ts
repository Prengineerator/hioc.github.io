// What checkout should prefill for a signed-in customer (name + e-bill email).
// Pure — kept apart from the route so the fallback order is testable without
// mocking Supabase.
//
// Most customers sign in with a WhatsApp code, which creates a profile with no
// name, and nothing ever stored an email on the profile — so reading the
// profile alone prefilled nothing for them. Each field therefore falls back to
// what the customer typed on their most recent order.

export interface CheckoutPrefill {
  name: string;
  email: string;
}

export function checkoutPrefill(
  profileName: string | null | undefined,
  verifiedEmail: string | null | undefined,
  lastOrder: { customer_name?: string | null; customer_email?: string | null } | null | undefined,
): CheckoutPrefill {
  const name = (profileName ?? '').trim() || (lastOrder?.customer_name ?? '').trim();
  const email = (verifiedEmail ?? '').trim() || (lastOrder?.customer_email ?? '').trim();
  return { name, email };
}
