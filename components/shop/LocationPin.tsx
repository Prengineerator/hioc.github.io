'use client';

// The delivery pin on /shop (lib/shop/location.ts): optional, so a parcel for
// another address isn't pinned to wherever the buyer happens to be.
//
//   "Use my current location"   the phone's GPS, no key needed
//   a draggable Google Map      only with NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (Maps
//                               JavaScript API): tap to drop the pin, drag it
//                               to the exact door
//   without a key               a read-only Google Maps preview of the GPS pin
//                               (the keyless embed the Contact page uses)

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { describePin, googleMapsEmbed, googleMapsLink, VAGUE_ACCURACY_M, type ShopLocation } from '@/lib/shop/location';

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';
const INDIA_CENTER = { lat: 22.5, lng: 79 };

// Just the bits of the Maps JavaScript API used here (no @types package).
type LatLngLiteral = { lat: number; lng: number };
type MapsLatLng = LatLngLiteral | { lat(): number; lng(): number };
interface MapsMap {
  setCenter(c: LatLngLiteral): void;
  setZoom(z: number): void;
  getZoom(): number | undefined;
  addListener(ev: string, fn: (e: { latLng?: MapsLatLng }) => void): void;
}
interface MapsMarker {
  addListener(ev: string, fn: () => void): void;
  setPosition?(p: LatLngLiteral): void;
  getPosition?(): MapsLatLng | null;
  position?: MapsLatLng | null;
  map?: MapsMap | null;
}
interface MapsApi {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => MapsMap;
  Marker: new (opts: Record<string, unknown>) => MapsMarker & { setMap(m: MapsMap | null): void };
  marker?: { AdvancedMarkerElement?: new (opts: Record<string, unknown>) => MapsMarker };
}

declare global {
  interface Window {
    google?: { maps?: MapsApi };
    __hiocMapsReady?: () => void;
  }
}

let mapsPromise: Promise<MapsApi | null> | null = null;

function loadGoogleMaps(): Promise<MapsApi | null> {
  if (typeof window === 'undefined' || !MAPS_KEY) return Promise.resolve(null);
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps);
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve) => {
    window.__hiocMapsReady = () => resolve(window.google?.maps ?? null);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&v=weekly&libraries=marker&loading=async&callback=__hiocMapsReady`;
    s.async = true;
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
  return mapsPromise;
}

const toLiteral = (p: MapsLatLng | null | undefined): LatLngLiteral | null => {
  if (!p) return null;
  return typeof p.lat === 'function' ? { lat: (p as { lat(): number }).lat(), lng: (p as { lng(): number }).lng() } : (p as LatLngLiteral);
};

function InteractiveMap({ value, onPick }: { value: ShopLocation | null; onPick: (p: LatLngLiteral) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MapsMap | null>(null);
  const marker = useRef<MapsMarker | null>(null);
  const placeRef = useRef<(p: LatLngLiteral) => void>(() => {});
  const [failed, setFailed] = useState(false);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    let cancelled = false;
    void loadGoogleMaps().then((maps) => {
      if (cancelled || !el.current) return;
      if (!maps) {
        setFailed(true);
        return;
      }
      const start = value ? { lat: value.lat, lng: value.lng } : INDIA_CENTER;
      const m = new maps.Map(el.current, {
        center: start,
        zoom: value ? 17 : 4,
        mapId: MAP_ID,
        mapTypeControl: true,
        streetViewControl: false,
        fullscreenControl: false,
        gestureHandling: 'cooperative',
        clickableIcons: false,
      });
      map.current = m;
      const Advanced = maps.marker?.AdvancedMarkerElement;
      placeRef.current = (p: LatLngLiteral) => {
        if (!marker.current) {
          const mk = Advanced
            ? new Advanced({ map: m, position: p, gmpDraggable: true, title: 'Delivery pin' })
            : new maps.Marker({ map: m, position: p, draggable: true, title: 'Delivery pin' });
          mk.addListener('dragend', () => {
            const at = toLiteral(mk.getPosition ? mk.getPosition() : mk.position);
            if (at) pick.current(at);
          });
          marker.current = mk;
        } else if (marker.current.setPosition) {
          marker.current.setPosition(p);
        } else {
          marker.current.position = p;
        }
      };
      if (value) placeRef.current(start);
      m.addListener('click', (e) => {
        const at = toLiteral(e.latLng);
        if (!at) return;
        placeRef.current(at);
        pick.current(at);
      });
    });
    return () => {
      cancelled = true;
    };
    // The map is built once; later pins move the marker (effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pin from GPS (or cleared) after the map exists: move the marker there.
  useEffect(() => {
    if (!map.current || !value) return;
    const p = { lat: value.lat, lng: value.lng };
    placeRef.current(p);
    map.current.setCenter(p);
    if ((map.current.getZoom() ?? 0) < 16) map.current.setZoom(17);
  }, [value]);

  if (failed) return null;
  return (
    <div>
      <div ref={el} className="h-64 w-full overflow-hidden rounded-md border border-line bg-surface" aria-label="Map: tap to place the delivery pin, drag it to adjust" />
      <p className="mt-1 text-xs text-muted">Tap the map to drop the pin; drag it to your exact door. Satellite view helps.</p>
    </div>
  );
}

export function LocationPin({
  value,
  onChange,
  error,
}: {
  value: ShopLocation | null;
  onChange: (loc: ShopLocation | null) => void;
  error?: string;
}) {
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [canGeolocate, setCanGeolocate] = useState(false);

  useEffect(() => {
    setCanGeolocate(typeof navigator !== 'undefined' && 'geolocation' in navigator);
  }, []);

  function locate() {
    setGeoError(null);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        onChange({
          lat: Math.round(pos.coords.latitude * 1e6) / 1e6,
          lng: Math.round(pos.coords.longitude * 1e6) / 1e6,
          accuracy_m: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
          source: 'gps',
        });
      },
      (err) => {
        setLocating(false);
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? 'Location is blocked for this site. Allow it in your browser settings, or skip this — the address is enough.'
            : "Couldn't get your location just now. Try again, or skip this — the address is enough.",
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }

  const vague = value?.source === 'gps' && (value.accuracy_m ?? 0) > VAGUE_ACCURACY_M;

  return (
    <section aria-labelledby="pin-heading" className="mt-6 rounded-md border border-line p-4">
      <h3 id="pin-heading" className="font-semibold text-charcoal">
        Pin your location <span className="font-normal text-muted">(optional)</span>
      </h3>
      <p className="mt-1 text-sm text-muted">
        Helps the courier find your door. Ordering for a different address? Skip this — we&apos;ll use the address above.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canGeolocate ? (
          <Button variant="secondary" size="sm" onClick={locate} loading={locating}>
            {value ? 'Use my current location again' : 'Use my current location'}
          </Button>
        ) : null}
        {value ? (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Remove pin
          </Button>
        ) : null}
      </div>

      {MAPS_KEY ? (
        <div className="mt-3">
          <InteractiveMap value={value} onPick={(p) => onChange({ lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6, accuracy_m: null, source: 'map' })} />
        </div>
      ) : value ? (
        <iframe
          title="Your delivery pin on Google Maps"
          src={googleMapsEmbed(value)}
          className="mt-3 h-56 w-full rounded-md border border-line"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      ) : null}

      {value ? (
        <p className="mt-2 text-sm text-charcoal" role="status">
          <span aria-hidden="true">📍</span> Pin set ({describePin(value)}).{' '}
          <a href={googleMapsLink(value)} target="_blank" rel="noopener noreferrer" className="font-semibold text-tan-dark underline">
            Check it on Google Maps
          </a>
        </p>
      ) : null}
      {vague ? (
        <p className="mt-1 text-sm text-amber-800">
          Your phone&apos;s location is only approximate here. {MAPS_KEY ? 'Drag the pin to your door, or' : 'Try again near a window, or'} remove the pin.
        </p>
      ) : null}
      {geoError ? <p className="mt-2 text-sm text-amber-800">{geoError}</p> : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
