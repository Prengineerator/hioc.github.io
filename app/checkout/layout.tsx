import type { ReactNode } from 'react';

// The checkout page is a client component and can't export metadata itself.
export const metadata = { title: 'Checkout' };

export default function CheckoutLayout({ children }: { children: ReactNode }) {
  return children;
}
