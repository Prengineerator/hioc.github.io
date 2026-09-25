// Stub for the `electron` package (see vitest.config.ts alias).
//
// `desktop/src/printers/store.ts` imports `{ app }` from `electron` only to
// resolve `app.getPath('userData')` for the printers.json path — a real
// Electron main process, which Vitest never has. This stub supplies just
// enough (`app.getPath`) so the module's pure, unit-testable functions
// (`validatePrinterConfig(s)`) can be imported without a real Electron
// runtime; nothing here is exercised by those functions.
export const app = {
  getPath: (_name: string) => '/tmp/hioc-pos-test-userdata',
};
