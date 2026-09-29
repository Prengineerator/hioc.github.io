'use client';

// Step 3 loading state (§3.3): skeleton cards plus Coffey "thinking" out loud,
// while POST /api/suggest is in flight. The rotating lines are in Coffey's own
// voice (COFFEY-SPEC §6.2: warm, brief, first person).
//
// The lines are ThinkingCopy, a separate piece from the skeleton cards, because
// they belong INSIDE Coffey's speech bubble, which the wizard keeps mounted
// through loading → picks (so a screen reader speaks the picks' header when it
// arrives; see SuggestWizard). The cards sit below the step heading.

import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';

const ROTATING_COPY = [
  'Tasting the menu in my head…',
  "Checking what's cold and what's cosy…",
  "Picking three that aren't the same…",
  'Warming the cups while I think…',
] as const;

/**
 * One of Coffey's "thinking" lines, changing every ~1.6s. Purely visual
 * (aria-hidden): a polite live region that spoke every rotation would talk over
 * the customer for the whole wait, and the step heading already says "Finding
 * your picks…". Someone who has asked their device for less motion gets the
 * first line and no rotation.
 */
export function ThinkingCopy() {
  const [copyIndex, setCopyIndex] = useState(0);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => {
      setCopyIndex((i) => (i + 1) % ROTATING_COPY.length);
    }, 1600);
    return () => clearInterval(id);
  }, []);

  return <span aria-hidden="true">{ROTATING_COPY[copyIndex]}</span>;
}

function SkeletonCard() {
  return (
    <div className="rounded-md border border-line bg-cream p-4 shadow-card">
      <Skeleton className="mb-3 aspect-[4/3] w-full" />
      <Skeleton className="mb-2 h-4 w-2/3" />
      <Skeleton className="mb-3 h-3 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

export function ResultsSkeleton() {
  return (
    <div aria-hidden="true" className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
