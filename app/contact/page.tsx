import type { Metadata } from 'next';
import {
  CAFE_ADDRESS,
  CAFE_HOURS,
  CAFE_INSTAGRAM_HANDLE,
  CAFE_INSTAGRAM_URL,
  CAFE_MAPS_EMBED_SRC,
  CAFE_PHONE_DISPLAY,
  CAFE_PHONE_HREF,
} from '@/lib/constants';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Find HIOC. — address, hours, phone, and map for Kamla Nagar, Agra.',
};

function InfoBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-[0.2em] text-tan">
        {label}
      </p>
      <div className="mt-1 text-charcoal">{children}</div>
    </div>
  );
}

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-charcoal md:text-3xl">
          Find Us
        </h1>
        <p className="mt-2 text-muted">
          Come by for coffee, waffles, and a quiet corner to enjoy them in.
        </p>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-10 md:grid-cols-2">
        <div className="flex flex-col gap-6">
          <InfoBlock label="Address">
            <p>{CAFE_ADDRESS}</p>
          </InfoBlock>
          <InfoBlock label="Hours">
            <p>{CAFE_HOURS}</p>
          </InfoBlock>
          <InfoBlock label="Phone">
            <a href={CAFE_PHONE_HREF} className="text-tan hover:underline">
              {CAFE_PHONE_DISPLAY}
            </a>
          </InfoBlock>
          <InfoBlock label="Instagram">
            <a
              href={CAFE_INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-tan hover:underline"
            >
              {CAFE_INSTAGRAM_HANDLE}
            </a>
          </InfoBlock>
        </div>

        <div>
          <h2 className="mb-3 text-lg font-bold text-charcoal">Map</h2>
          <div className="overflow-x-auto">
            <iframe
              src={CAFE_MAPS_EMBED_SRC}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              width="100%"
              height="400"
              style={{ border: 0 }}
              title="HIOC location map"
            />
          </div>
          <p className="mt-2 text-sm text-muted">
            Find us on the map — E/773, Near V Mart, Kamla Nagar.
          </p>
        </div>
      </div>
    </div>
  );
}
