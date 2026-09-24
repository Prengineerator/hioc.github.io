# HIOC POS (desktop shell)

Electron shell for the counter machine — Phase 7 pillars SHL (shell) and PRN
(configurable printers). See `docs/PHASE-7-SPEC.md` §§1–3 for the design, and
`lib/desktop/bridge.ts` for the exact contract this app implements
(`window.hiocDesktop`). Offline ordering / sync (OFF, SYN) is a later
milestone and is not implemented here.

## Dev run

Needs **Node 22.12+** (Electron's installer is ESM-only; on Node 20 `npm i`
fails with `ERR_REQUIRE_ESM` and Electron never downloads). `.nvmrc` pins it:

```sh
cd desktop
nvm use          # or: nvm install
npm i
HIOC_POS_URL=http://localhost:3001 npm start
```

`npm start` builds (`esbuild` → `dist/main.js` + `dist/preload.js`) and then
launches `electron .`. Without `HIOC_POS_URL` the shell loads
`https://staff.hioc.in` (production). Localhost is only ever an allowed
navigation/bridge target when `HIOC_POS_URL` itself points at
`http://localhost:3001` — pointing it anywhere else (e.g. a staging domain)
does not implicitly allow localhost.

Printer config lives outside the repo, in this OS user's Electron `userData`
directory (`printers.json`) — deleting that file resets printer setup without
touching anything else.

## Building / type-checking

```sh
cd desktop
npx tsc --noEmit -p .     # type-check only, no output
npm run build              # esbuild → dist/main.js, dist/preload.js
```

## Packaging

```sh
cd desktop
npm run dist:win   # → release/*.exe (NSIS, x64)
npm run dist:mac   # → release/*.dmg (universal)
```

### Signing & notarization env vars

All optional — omitting them produces an unsigned build (D7-7: acceptable for
an internal pilot, with the caveats below).

| Var | Platform | Effect |
|---|---|---|
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Win + Mac | Code-signing certificate (`.p12`/`.pfx`) and its password. Unset → unsigned installer; Windows SmartScreen will warn on first run. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Mac | Notarization credentials (electron-builder calls `@electron/notarize` automatically when these are set and the build is signed). Unset → the `.dmg` is not notarized; Gatekeeper blocks it on any Mac other than the one that built it, until the user right-click → Open's past the warning. |
| `HIOC_POS_GH_OWNER`, `HIOC_POS_GH_REPO` | Both | GitHub repo for `electron-updater`'s auto-update feed (`publish.provider: github`). |
| `GH_TOKEN` | Both | Needed only when actually publishing a release (`electron-builder --publish always`); not needed for a local `dist:*` build. |

electron-updater's `autoUpdater.checkForUpdatesAndNotify()` runs once at
launch, but only in a packaged build (`app.isPackaged`) — a dev checkout never
tries to hit the update feed.

### Windows USB note

Raw ESC/POS **over USB** needs the WinUSB driver bound to the printer (e.g.
via [Zadig](https://zadig.akeo.ie/)) instead of the manufacturer's default
Windows printer driver — most counter printers ship without it. Until that's
done on a given machine, add the printer as an **"OS printer, raw"**
(`connection.kind: 'system', mode: 'raw'`) instead of `kind: 'usb'`: it prints
through the normal Windows spooler (`RAW` datatype via `winspool.drv`), which
works with the printer's stock driver and needs no USB driver swap. This is
the safe default for a pilot Windows counter; USB-raw is opt-in once WinUSB is
confirmed installed (R1 in the spec).

## Verifying without a GUI

```sh
cd desktop && npx tsc --noEmit -p .
cd desktop && npm run build
cd .. && npx vitest run tests/desktop
```
