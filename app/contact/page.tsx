import type { Metadata } from 'next';
import {
  CAFE_ADDRESS,
  CAFE_DIRECTIONS_URL,
  CAFE_HOURS,
  CAFE_INSTAGRAM_HANDLE,
  CAFE_INSTAGRAM_URL,
  CAFE_MAPS_EMBED_SRC,
  CAFE_PHONE_DISPLAY,
  CAFE_PHONE_HREF,
} from '@/lib/constants';
import { Card } from '@/components/ui/Card';
import { buttonVariants } from '@/components/ui/Button';
import { BUSINESS } from '@/lib/legal';

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

      <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card className="flex flex-col gap-6">
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
          <InfoBlock label="Email">
            <a href={BUSINESS.emailHref} className="text-tan hover:underline">
              {BUSINESS.email}
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
          <InfoBlock label="Business">
            <p>{BUSINESS.legalName} (operating {BUSINESS.name})</p>
            {BUSINESS.gstin ? <p className="text-sm text-muted">GSTIN: {BUSINESS.gstin}</p> : null}
          </InfoBlock>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <a href={CAFE_PHONE_HREF} className={buttonVariants({ fullWidth: true })}>
              Call Us
            </a>
            <a
              href={CAFE_DIRECTIONS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: 'secondary', fullWidth: true })}
            >
              Get Directions
            </a>
          </div>
        </Card>

        <Card padding="none" className="overflow-hidden">
          <iframe
            src={CAFE_MAPS_EMBED_SRC}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            width="100%"
            height="100%"
            className="min-h-[320px] w-full"
            style={{ border: 0 }}
            title="HIOC location map"
          />
        </Card>
      </div>
    </div>
  );
}
