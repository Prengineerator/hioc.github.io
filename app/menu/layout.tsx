import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The menu page is a client component, so its title lives here.
export const metadata: Metadata = { title: 'Menu' };

export default function MenuLayout({ children }: { children: ReactNode }) {
  return children;
}
