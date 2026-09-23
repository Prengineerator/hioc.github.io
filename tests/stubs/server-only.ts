// Stub for Next.js's `server-only` package (see vitest.config.ts alias).
//
// `import 'server-only'` exists purely to make the BUILD fail if a server module
// is pulled into a client bundle. It has no runtime behaviour and no Node
// resolution, so under Vitest — which already runs server-side — importing the
// real thing throws. This empty module keeps that guard meaningful in the app
// while letting the modules it protects be unit-tested.
export {};
