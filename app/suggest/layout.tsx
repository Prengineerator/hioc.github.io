import type { Metadata } from 'next';

// app/suggest/page.tsx is a client component (the wizard's state lives there),
// and a client component can't export metadata — so the page's title and
// description live in this layout instead. The root layout's template adds
// " | HIOC." to the title.
export const metadata: Metadata = {
  title: 'Ask Coffey',
  description:
    'Tell Coffey how you feel and what sounds good, and get three picks from the real HIOC. menu, each with a reason.',
};

export default function SuggestLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
