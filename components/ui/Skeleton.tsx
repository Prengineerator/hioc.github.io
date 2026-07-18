/** A pulsing placeholder block for content that's still loading — sized via className (e.g. `h-4 w-2/3`, `aspect-[4/3]`) to match the final layout and avoid CLS. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-line ${className}`} />;
}
