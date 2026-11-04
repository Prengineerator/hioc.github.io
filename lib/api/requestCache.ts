// Per-request memoisation for server reads. Next.js bundles a React build that
// provides cache(); plain React 18 (vitest, scripts) does not, so fall back to
// calling straight through — identical behaviour, just without the memo.
import * as React from 'react';

type AnyFn = (...args: never[]) => unknown;
const reactCache = (React as unknown as { cache?: <F extends AnyFn>(fn: F) => F }).cache;

export function requestCache<F extends AnyFn>(fn: F): F {
  return reactCache ? reactCache(fn) : fn;
}
