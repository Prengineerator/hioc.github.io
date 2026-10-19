// Copies every Storage file from the old Supabase project to the new one, same
// bucket and path, using the Storage HTTP API directly (plain fetch, no SDK, so
// it runs on the runner's stock Node). Called by scripts/db-move/move.sh, which
// pipes in the object list read from the old database:
//
//   bucket<TAB>name<TAB>mimetype    (one object per line)
//
// Env: OLD_SUPABASE_URL, OLD_SERVICE_KEY, NEW_SUPABASE_URL, NEW_SERVICE_KEY.
// Idempotent: uploads use x-upsert, so a re-run overwrites instead of failing.

import { readFileSync } from 'node:fs';

const OLD = { url: process.env.OLD_SUPABASE_URL.replace(/\/$/, ''), key: process.env.OLD_SERVICE_KEY };
const NEW = { url: process.env.NEW_SUPABASE_URL.replace(/\/$/, ''), key: process.env.NEW_SERVICE_KEY };

// New-style keys (sb_secret_…) are not JWTs: the platform rejects them on the
// Authorization header, so they travel on `apikey` alone. Legacy service_role
// keys are JWTs and go on both, as before.
const auth = (key) => (key.startsWith('sb_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` });
const objectPath = (name) => name.split('/').map(encodeURIComponent).join('/');

async function ensureBucket(id) {
  const have = await fetch(`${NEW.url}/storage/v1/bucket/${id}`, { headers: auth(NEW.key) });
  if (have.ok) return;
  const src = await fetch(`${OLD.url}/storage/v1/bucket/${id}`, { headers: auth(OLD.key) });
  if (!src.ok) throw new Error(`bucket ${id}: cannot read it on the old project (${src.status})`);
  const b = await src.json();
  const made = await fetch(`${NEW.url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...auth(NEW.key), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: b.id,
      name: b.name,
      public: b.public,
      file_size_limit: b.file_size_limit,
      allowed_mime_types: b.allowed_mime_types,
    }),
  });
  if (!made.ok) throw new Error(`bucket ${id}: create failed (${made.status} ${await made.text()})`);
  console.log(`created bucket ${id} (${b.public ? 'public' : 'private'})`);
}

const rows = readFileSync(0, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [bucket, name, mimetype] = line.split('\t');
    return { bucket, name, mimetype: mimetype || 'application/octet-stream' };
  });

let copied = 0;
const failed = [];
for (const bucket of new Set(rows.map((r) => r.bucket))) await ensureBucket(bucket);
for (const { bucket, name, mimetype } of rows) {
  const path = `${bucket}/${objectPath(name)}`;
  try {
    const got = await fetch(`${OLD.url}/storage/v1/object/${path}`, { headers: auth(OLD.key) });
    if (!got.ok) throw new Error(`download ${got.status}`);
    const body = Buffer.from(await got.arrayBuffer());
    const put = await fetch(`${NEW.url}/storage/v1/object/${path}`, {
      method: 'POST',
      headers: { ...auth(NEW.key), 'Content-Type': mimetype, 'x-upsert': 'true' },
      body,
    });
    if (!put.ok) throw new Error(`upload ${put.status} ${await put.text()}`);
    copied += 1;
  } catch (err) {
    failed.push(`${bucket}/${name}: ${err.message}`);
  }
}

console.log(`storage: ${copied}/${rows.length} files copied`);
if (failed.length) {
  for (const f of failed) console.error(`  failed ${f}`);
  process.exit(1);
}
