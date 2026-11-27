import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Rate your order' };

export default function ReviewLayout({ children }: { children: ReactNode }) {
  return children;
}
