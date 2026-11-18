// A compact, read-only view of a saved (or draft) address: label badge with an
// icon, name, one-line address, city + pincode and a masked phone.
//
// Radio-card pattern (checkout "Change" list): the PARENT renders a native
// <input type="radio" className="sr-only peer"> inside a <label> that wraps the
// card, so keyboard and screen-reader behaviour stay native:
//
//   <label className="block cursor-pointer">
//     <input type="radio" name="address" className="sr-only" checked={…} onChange={…} />
//     <AddressCard address={a} selected={checked} />
//   </label>
//
// `selected` only draws the state: a heavier border, a check mark and the text
// "Selected", so colour is never the only signal. `children` is a slot for
// actions (Edit, Delete, Make default); keep interactive children outside a
// wrapping radio <label>.

import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import type { SavedAddressFields } from '@/lib/shop/types';

export interface AddressCardData extends Partial<SavedAddressFields> {
  label?: string;
  is_default?: boolean;
}

/** +919876543210 → "••••• 43210". Anything shorter than 5 digits is fully masked. */
export function maskPhone(phone: string | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 5 ? `••••• ${digits.slice(-5)}` : '•••••';
}

function LabelIcon({ label }: { label: string }) {
  const l = label.toLowerCase();
  const path =
    l === 'home'
      ? 'M3 10.5 10 4l7 6.5V17H3z'
      : l === 'work'
        ? 'M3 7h14v10H3zM7 7V5h6v2'
        : 'M10 17s5-4.5 5-9a5 5 0 0 0-10 0c0 4.5 5 9 5 9z';
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5">
      <path d={path} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AddressCard({
  address,
  selected = false,
  children,
  className = '',
}: {
  address: AddressCardData;
  selected?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const label = address.label?.trim() || 'Address';
  const street = [address.address_line1, address.address_line2].filter(Boolean).join(', ');
  const place = [address.city, address.pincode].filter(Boolean).join(' ');
  return (
    <div
      className={[
        'flex flex-col gap-2 rounded-lg border bg-cream p-4 text-left',
        selected ? 'border-2 border-tan-dark' : 'border-line',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="neutral">
          <LabelIcon label={label} />
          {label}
        </Badge>
        {address.is_default ? <Badge variant="outline">Default</Badge> : null}
        {selected ? (
          <span className="ml-auto inline-flex items-center gap-1 text-sm font-semibold text-tan-dark">
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4">
              <path d="m4 10.5 4 4 8-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Selected
          </span>
        ) : null}
      </div>
      <div className="text-sm text-charcoal">
        <p className="font-semibold">{address.customer_name}</p>
        {street ? <p>{street}</p> : null}
        {place ? <p>{place}</p> : null}
        <p className="text-muted">{maskPhone(address.phone)}</p>
      </div>
      {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}
