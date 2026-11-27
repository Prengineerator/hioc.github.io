import { HOME_BLEND_NAME } from '@/lib/shop/catalog';

// The styled stand-in for the Home Blend photo (HOME_BLEND_IMAGE is null until
// the photo exists). Shared by the Choose-step card and the /shop line card.
// `compact` hides the words below md so a small thumbnail shows just the cup.
export function HomeBlendPlaceholder({ className = '', compact = false, warm = false }: { className?: string; compact?: boolean; warm?: boolean }) {
  const text = compact ? 'hidden md:inline' : '';
  return (
    <div
      style={warm ? { background: 'radial-gradient(ellipse at 50% 35%, #ffffff 0%, #f6efe9 60%, #efe3d6 100%)' } : undefined}
      role="img"
      aria-label={`${HOME_BLEND_NAME} pack. Photo coming soon.`}
      className={`flex flex-col items-center justify-center gap-1 bg-cream text-center ${compact ? 'p-2 md:p-4' : 'p-4'} ${className}`}
    >
      <span aria-hidden="true" className="text-4xl">
        ☕
      </span>
      <span className={`text-base font-bold text-charcoal ${text}`}>Signature Home Blend</span>
      <span className={`text-sm text-muted ${text}`}>Photo coming soon</span>
    </div>
  );
}
