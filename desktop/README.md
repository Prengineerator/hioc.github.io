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

## Isolation & lockdown (Phase 7)

Owner request: "totally an isolated interface for POS... more trusted and more
powerful". Four things make that true.

**A dedicated session.** The POS window loads in its own persistent Electron
partition (`persist:hioc-pos`), set via `webPreferences.partition` in
`src/main.ts`. Its cookies, `localStorage` and IndexedDB are entirely separate
from any other Electron/Chrome profile on the machine — signing in or out in
Chrome never touches the POS app's session, and the reverse (root cause of the
old "syncing" bug: `supabase.auth.signOut()`'s default scope is `'global'`,
which revokes every device's refresh tokens; the auth routes now pass
`{ scope: 'local' }`). PRN-5's hidden driver-print window (`src/printers/driver.ts`)
is opened in this SAME session explicitly (`webPreferences.session`, not
`partition`, so it's the exact same session object) — it must never fall back
to Electron's default session, or the staffer's login simply wouldn't be there
for that same-origin `/staff-print/` page.

On Windows, Chromium/Electron encrypts this partition's cookies at rest with
DPAPI (Windows Data Protection API), tied to the machine's OS user account —
this is Electron's default cookie-encryption behavior and needs no extra
configuration; verified still the default as of Electron 44 (this repo's
version, `desktop/package.json`).

**POS-only navigation.** `src/allowedOrigin.ts` exports the pure, unit-tested
`isPosNavigationAllowed(url, opts)` (tests: `tests/desktop/allowedOrigin.test.ts`).
The app window may load or navigate to:

- `https://staff.hioc.in/**` — the staff surface host, any path.
- `https://hioc.in` (the main domain, path-based routing) — but only
  `/staff/**`, `/staff-print/**`, and `/login`.
- `http://localhost:3001` — only when the shell itself was launched with
  `HIOC_POS_URL` pointed at it (dev only; never implied by any other value).

Everything else — the customer site, `https://owner.hioc.in` and `/owner/**`
on the main domain, any other external link, and lookalike hosts
(`staff.hioc.in.evil.com`, `evilhioc.in`) — is refused in the window. An
`https://` link still opens in the OS's default browser
(`shell.openExternal`, `src/main.ts`); `file:`, `javascript:` and any custom
scheme are dropped outright and never handed to `shell.openExternal`. This
one predicate gates navigation (`will-navigate`, `will-redirect`,
`setWindowOpenHandler`, and the initial `loadURL`), every IPC handler's
sender check, and the `window.hiocDesktop` bridge exposure in `preload.ts` —
none of them can drift from the others.

**No dev tools, no browser chrome, in a packaged build.**
`webPreferences.devTools: !app.isPackaged` disables DevTools entirely in a
packaged build (F12/Ctrl+Shift+I do nothing); `Menu.setApplicationMenu(null)` +
`autoHideMenuBar` remove the application menu; Ctrl+R/F5 still reload the
page (recovers a frozen screen) but devtools accelerators are blocked as a
second layer on top of `devTools: false`. `window.open`/`target=_blank` never
opens a popup — an allowed URL navigates the same window, anything else goes
to the OS browser (or is dropped) — so there's no popup path at all, matching
how the POS actually prints (PRN-5's driver window is opened directly by the
main process, never via a renderer's `window.open`). A dropped file (or any
other drag-and-drop navigation) is just another `will-navigate` attempt, so
it's covered by the same allowlist. `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false` and `webSecurity: true` are all explicit in
`webPreferences` (the preload script only uses `contextBridge`/`ipcRenderer`,
both available under `sandbox: true`).

**App identity marker — a UI hint only, never trust.** The window's user
agent gets ` HIOCPOS/<app version>` appended (`src/main.ts`,
`webContents.setUserAgent`) — useful for reading server logs, never for
authorization. In the web app, `lib/desktop/isDesktopApp.ts` is the reliable
in-page signal (`getDesktopBridge() !== null`); server-side trust for
anything that matters (enrolling a counter, printing, the cash drawer) comes
from the enrolled-device cookie (`lib/api/device.ts`), never from the UA or
any client-reported header.

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

These build a local installer only — no `--publish` flag, so nothing is
uploaded anywhere. See "Releasing" below for that.

### Signing & notarization env vars

All optional — omitting them produces an unsigned build (D7-7: acceptable for
the pilot and for the unsigned installer this repo currently ships, with the
caveats below).

| Var | Platform | Effect |
|---|---|---|
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Win + Mac | Code-signing certificate (`.p12`/`.pfx`) and its password. Unset → unsigned installer; **Windows SmartScreen shows "Windows protected your PC" on first run** — this is expected for every install today (click **More info → Run anyway**), not a sign of a broken build. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Mac | Notarization credentials (electron-builder calls `@electron/notarize` automatically when these are set and the build is signed). Unset → the `.dmg` is not notarized; Gatekeeper blocks it on any Mac other than the one that built it, until the user right-click → Open's past the warning. There is currently no macOS release job — see "Releasing" below. |
| `GH_TOKEN` | Win | Needed only when actually publishing a release (`npm run release:win`, below); not needed for a plain `dist:win` build. In CI this is the repo's own built-in Actions token — no secret to configure. |

electron-updater's `autoUpdater.checkForUpdatesAndNotify()` runs once at
launch, but only in a packaged build (`app.isPackaged`) — a dev checkout never
tries to hit the update feed. It reads its feed from `electron-builder.yml`'s
`publish` block (this repo, GitHub Releases) — nothing to set per machine.

## Releasing

Installers are built and published by `.github/workflows/pos-desktop-release.yml`
(Windows only — see below), which creates a **published** (not draft) GitHub
Release on **this repo** carrying the `.exe` installer, `latest.yml` and its
`.blockmap`, so both a direct download and `electron-updater`'s auto-update
check work immediately.

**To cut a release:**

1. Bump the `version` field in `desktop/package.json` (semver, e.g.
   `0.1.0` → `0.2.0`) and commit that to `main`.
2. Trigger the build either way:
   - **GitHub Actions tab** → "POS desktop release (Windows)" → **Run
     workflow** (simplest — no tag to get right), or
   - push a git tag named `pos-v<version>` (matching the version you just
     set, e.g. `pos-v0.2.0`) — the workflow also triggers on any `pos-v*` tag
     push.
3. Wait for the job to finish. The release appears at
   <https://github.com/Prengineerator/hioc.github.io/releases/latest> under
   tag `pos-v<version>`.

The tag name is **not** something this workflow invents: electron-builder
derives it itself from `desktop/package.json`'s version plus
`electron-builder.yml`'s `publish.tagNamePrefix: pos-v`. If you push a tag by
hand, it must equal what electron-builder will derive (`pos-v<version>`) —
pushing a differently-named tag still builds, but the Release still lands
under `pos-v<version>`, not the tag you pushed.

There is intentionally no macOS release job yet: an unsigned, non-notarized
`.dmg` needs its own Gatekeeper workaround on every machine, the owner's
counter is Windows, and a flaky macOS leg is not worth risking the Windows
release for. `npm run dist:mac` still works locally when a macOS build is
needed by hand.

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
