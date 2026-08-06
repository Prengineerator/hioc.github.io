// Parse a latitude/longitude out of whatever the owner pasted.
//
// The realistic inputs are all things Google Maps hands you, and they are not
// one format. Right-click → "copy coordinates" gives bare decimals; copying the
// address bar gives a URL with @lat,lng; the app's share sheet gives a short
// link; and the info panel sometimes shows degrees-minutes-seconds. Asking an
// owner to normalise that themselves is asking them to get it wrong, and a
// wrong store point means either nobody can clock in or everybody can from
// anywhere.
//
// Pure and exported so it can be unit-tested — the cost of a silent
// mis-parse here is high enough to want the edge cases pinned down.

export interface ParsedCoordinates {
  lat: number;
  lng: number;
}

export type CoordinateParseResult =
  | { ok: true; value: ParsedCoordinates }
  | { ok: false; error: string };

function inRange(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** "28°36'50.2\"N" → 28.613944 */
function dmsToDecimal(deg: number, min: number, sec: number, hemisphere: string): number {
  const magnitude = deg + min / 60 + sec / 3600;
  const negative = /[SW]/i.test(hemisphere);
  return negative ? -magnitude : magnitude;
}

const DMS_PAIR =
  /(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*([\d.]+)\s*["″]?\s*([NS])[,\s]+(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*([\d.]+)\s*["″]?\s*([EW])/i;

export function parseCoordinates(raw: string): CoordinateParseResult {
  const input = (raw ?? '').trim();
  if (!input) return { ok: false, error: 'Paste coordinates or a Google Maps link.' };

  // A shortened share link carries no coordinates at all — it is an opaque id
  // that only Google can expand. Resolving it would mean a server-side redirect
  // fetch to a third party; saying so plainly is better than pretending.
  if (/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(input)) {
    return {
      ok: false,
      error:
        "That's a short Google link, which doesn't contain the coordinates. Open it in Maps, right-click the exact spot, click the numbers to copy them, and paste those here.",
    };
  }

  // Degrees/minutes/seconds, as shown in the Maps info panel.
  const dms = DMS_PAIR.exec(input);
  if (dms) {
    const lat = dmsToDecimal(Number(dms[1]), Number(dms[2]), Number(dms[3]), dms[4]);
    const lng = dmsToDecimal(Number(dms[5]), Number(dms[6]), Number(dms[7]), dms[8]);
    if (!inRange(lat, lng)) return { ok: false, error: 'Those coordinates are out of range.' };
    return { ok: true, value: { lat, lng } };
  }

  // A Maps URL. `@lat,lng` is the map centre (address-bar copy); `q=`/`query=`
  // is the pinned place. Prefer the pin when both are present — the pin is the
  // place the owner actually chose, whereas the centre drifts as they pan.
  if (/^https?:\/\//i.test(input)) {
    const q = /[?&](?:q|query|destination)=(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/i.exec(input);
    const at = /@(-?\d+\.?\d*),(-?\d+\.?\d*)/.exec(input);
    const hit = q ?? at;
    if (hit) {
      const lat = Number(hit[1]);
      const lng = Number(hit[2]);
      if (!inRange(lat, lng)) return { ok: false, error: 'Those coordinates are out of range.' };
      return { ok: true, value: { lat, lng } };
    }
    return {
      ok: false,
      error:
        "That link doesn't have coordinates in it. In Google Maps, right-click the exact spot and click the numbers that appear to copy them, then paste those here.",
    };
  }

  // Bare decimals: "28.613939, 77.209023" — the copy-coordinates format.
  const pair = /^(-?\d+\.?\d*)\s*[, ]\s*(-?\d+\.?\d*)$/.exec(input);
  if (pair) {
    const lat = Number(pair[1]);
    const lng = Number(pair[2]);
    if (!inRange(lat, lng)) return { ok: false, error: 'Those coordinates are out of range.' };
    return { ok: true, value: { lat, lng } };
  }

  return {
    ok: false,
    error:
      "Couldn't read that. Paste either \"28.613939, 77.209023\" or a Google Maps link with the location in it.",
  };
}
