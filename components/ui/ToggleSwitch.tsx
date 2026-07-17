export function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={
        'relative h-6 w-11 shrink-0 rounded-full transition-colors ' +
        (checked ? 'bg-tan' : 'bg-[#e5e5e5]')
      }
    >
      <span
        className={
          'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-cream shadow-sm transition-transform ' +
          (checked ? 'translate-x-[20px]' : 'translate-x-0')
        }
      />
    </button>
  );
}
