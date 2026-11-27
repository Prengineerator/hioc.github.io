// Prints a new VAPID key pair for phone notifications (docs/WEB-PUSH-SPEC.md).
// Reads and writes no database and no files. Run: node scripts/generate-vapid-keys.mjs
// Copy the three lines into Vercel -> Settings -> Environment Variables (Production).
// The private key is a secret: only Vercel, never chat, never the repository.
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:YOUR-CAFE-EMAIL@example.com   # replace with the café contact email');
