// One-off: resize the Desktop/Selected_img photos, upload them to the public
// `menu-images` Supabase bucket, and set menu_items.image_url on the matching
// item(s). Uses the Supabase Storage + PostgREST HTTP APIs directly (plain fetch,
// no SDK) so it runs on Node 20. Reads creds from .env.local. Run from repo root:
//   node scripts/upload-menu-images.mjs
// Idempotent: deterministic object paths + upsert, so re-running overwrites.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const AUTH = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const SRC = `${os.homedir()}/Desktop/Selected_img`;
const BUCKET = 'menu-images';
const tmp = mkdtempSync(join(os.tmpdir(), 'menuimg-'));

const MAP = {
  'Cappucino.JPG': ['Cappucino'],
  'Latte.JPG': ['Latte'],
  'Espresso.JPG': ['Espresso'],
  'FlatWhite.JPG': ['Flat White'],
  'Mocha.JPG': ['Signature Mocha'],
  'HotChocolate.JPG': ['Signature Hot Chocolate'],
  'HazelnutHotchocolate.JPG': ['Hazelnut Hot Chocolate'],
  'HazelnutCreme.JPG': ['Hazelnut Creme'],
  'CaramelCreme.JPG': ['Caramel Creme'],
  'BiscoffCreme.JPG': ['Lotus Biscoff Creme'],
  'SignatureChocolateCreme.JPG': ['Signature Chocolate Creme'],
  'CranberryIced.JPG': ['Cranberry Iced'],
  'ValenciaOrangeIced.JPG': ['Valencia Orange Iced'],
  'OnTheRocks.JPG': ['On The Rocks'],
  'ChocoBerry.JPG': ['Choco Berry Iced'],
  'IcedCappucino.JPG': ['Cappucino Iced'],
  'IcedLatte.JPG': ['Latte Iced'],
  'IcedMocha.JPG': ['Signature Mocha Iced'],
  'BlackForestStick.JPG': ['Black Forest'],
  'ChocoChipStick.JPG': ['Choco-Chips'],
  'TripleChocoStick.JPG': ['Tripple Choco'],
  'NutellaStick.JPG': ['Nutella'],
  'OreoHeavenStick.JPG': ['Oreo-Heaven'],
  'WhiteGarlandStick.JPG': ['White Garland'],
  'ChocoChipChips.JPG': ['Choco-Chip Chips'],
  'TripleChocoChips.JPG': ['Tripple Choco Chips'],
  'blackforestChips.JPG': ['Black Forest Chips'],
  'Crumble Chips.JPG': ['Crumble Chips'],
  'Americano:LongBlack.JPG': ['Americano', 'Long Black'],
  'Iced Americano:Iced Long Black.JPG': ['Americano Iced', 'Long Black Iced'],
  'CookieCrumble:BrookieCreme.JPG': ['Cookie Crumble Creme', 'Brookie Creme'],
  'Nutella Hazelnut:Almond Stick.JPG': ['Nutella-Hazelnut', 'Nutella-Almond'],
  // Resolved with the owner (2026-07): renamed item, lemonade, combo, butterscotch.
  'MochaChipCreme.JPG': ['Mocha Chip Creme'],
  'RasberryLemonade.JPG': ['Berry Lemonata Iced'],
  'HIC_8279.JPG': ['Butterscotch'],
  'HotChocolate+Mocha Combo.JPG': ['Hot Chocolate + Mocha Combo'],
  // Second batch of photos (2026-07).
  'BlueberryCreme.jpg': ['Blueberry Cheesecake Creme'],
  'Garlic Bread.jpg': ['Garlic Bread Toast'],
  'KitkatCreme.jpg': ['Krazy Kitkat Creme'],
  'MangoCreme.jpg': ['Fruity Mango Creme'],
  'MatchaCreme.jpg': ['Matcha Creme'],
  'MinionCreme.jpg': ['Minion Creme (Nutella-Banana)'],
  'Oreo Creme.jpg': ['Oreo Creme'],
  'Strawberry:StrawberryCheesecake Creme.jpg': ['Fruity Strawberry Creme', 'Strawberry Cheesecake Creme'],
  'Sandwich.jpg': ['Indo-Cottage Sandwich', 'Cheesy Mushroom Sandwich'],
};

const slug = (s) =>
  s.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function ensureBucket() {
  const res = await fetch(`${URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 2 * 1024 * 1024 }),
  });
  // 200 = created, 409 = already exists — both fine.
  if (!res.ok && res.status !== 409) {
    console.log('bucket ensure warning:', res.status, await res.text().catch(() => ''));
  }
}

async function uploadObject(objectPath, buf) {
  const res = await fetch(`${URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'cache-control': '31536000' },
    body: buf,
  });
  return res.ok ? { ok: true } : { ok: false, error: `${res.status} ${await res.text().catch(() => '')}` };
}

async function setImage(name, publicUrl) {
  const res = await fetch(`${URL}/rest/v1/menu_items?name=eq.${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { ...AUTH, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ image_url: publicUrl }),
  });
  if (!res.ok) return { count: -1, error: `${res.status} ${await res.text().catch(() => '')}` };
  const data = await res.json().catch(() => []);
  return { count: Array.isArray(data) ? data.length : 0 };
}

await ensureBucket();

let images = 0,
  rows = 0,
  failures = 0;
const unmatched = [];

for (const [file, names] of Object.entries(MAP)) {
  const srcPath = join(SRC, file);
  if (!existsSync(srcPath)) {
    console.log('MISSING FILE:', file);
    failures++;
    continue;
  }
  const objectPath = `menu/${slug(file)}.jpg`;
  const outPath = join(tmp, `${slug(file)}.jpg`);
  try {
    execFileSync('sips', ['-Z', '1400', '-s', 'format', 'jpeg', '-s', 'formatOptions', '75', srcPath, '--out', outPath], { stdio: 'ignore' });
  } catch (e) {
    console.log('RESIZE FAIL', file, e.message);
    failures++;
    continue;
  }
  const buf = readFileSync(outPath);

  const up = await uploadObject(objectPath, buf);
  if (!up.ok) {
    console.log('UPLOAD FAIL', file, up.error);
    failures++;
    continue;
  }
  const publicUrl = `${URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
  images++;

  for (const name of names) {
    const r = await setImage(name, publicUrl);
    if (r.error) {
      console.log('DB FAIL', name, r.error);
      failures++;
    } else if (r.count === 0) {
      unmatched.push(`${name}  (from ${file})`);
    } else {
      rows += r.count;
      console.log(`OK  ${(buf.length / 1024) | 0}KB  ${file}  ->  ${name}  (${r.count} row)`);
    }
  }
}

console.log(`\nDONE. images uploaded=${images}  item rows set=${rows}  failures=${failures}`);
if (unmatched.length) {
  console.log('\nNAMES THAT MATCHED NO ITEM (fix the mapping):');
  unmatched.forEach((u) => console.log('  - ' + u));
}
