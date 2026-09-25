'use client';

// Step 3 loading state (§3.3): skeleton cards plus rotating gentle copy,
// while POST /api/suggest is in flight.

import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';

const ROTATING_COPY = [
  'Grinding some ideas…',
  'Warming the cups…',
  'Pulling a shot of inspiration…',
  'Steaming up a few suggestions…',
] as const;

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
  const [copyIndex, setCopyIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setCopyIndex((i) => (i + 1) % ROTATING_COPY.length);
    }, 1600);
    return () => clearInterval(id);
  }, []);

  return (
    <div aria-live="polite" className="flex flex-col items-center gap-6">
      <p className="text-center text-sm font-semibold text-tan">{ROTATING_COPY[copyIndex]}</p>
      <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
