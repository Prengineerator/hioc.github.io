import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The status page is a client component, so its title lives here. Child routes
// (receipt, review) set their own.
export const metadata: Metadata = { title: 'Order status' };

export default function OrderLayout({ children }: { children: ReactNode }) {
  return children;
}
