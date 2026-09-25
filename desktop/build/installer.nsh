; SHL-3 — force-close a running "HIOC POS" before the installer or the
; uninstaller touches any files, so a running copy can never block replacing
; or removing it. Wired in via `nsis.include` in electron-builder.yml.
;
; Why this is needed on top of electron-builder's own built-in app-running
; check (CHECK_APP_RUNNING in its packaged
; node_modules/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh):
; that check DOES run for the installer here (nsis.oneClick: false, assisted
; mode, not a UAC "inner" elevated re-launch — see installSection.nsh) — but
; for the UNINSTALLER, `un.onInit` in uninstaller.nsh only ever calls it for a
; SILENT uninstall or a one-click build:
;
;   Function un.onInit
;     ${If} ${Silent}
;       call un.checkAppRunning
;     ${else}
;       !ifdef ONE_CLICK
;         ...
;         call un.checkAppRunning
;         ...
;       !endif
;     ${endIf}
;     ...
;     !ifmacrodef customUnInit
;       !insertmacro customUnInit
;     !endif
;   FunctionEnd
;
; This app is `oneClick: false` (an owner-facing, per-user "assisted"
; installer — see electron-builder.yml), and the normal path a person takes to
; remove it — Settings -> Apps -> HIOC POS -> Uninstall — runs the uninstaller
; NON-silently. So with electron-builder's own logic alone, the uninstaller
; never even checks whether HIOC POS is still running before it starts
; deleting files: exactly the owner's report ("uninstalling the old
; application is also not supported"). `customUnInit` below runs
; unconditionally in both branches, right after that block, so it closes the
; gap.
;
; `customInit` on the installer side is redundant with CHECK_APP_RUNNING in
; the cases that already work, but is cheap insurance against the few ways
; that check can still fall short in practice (e.g. a machine's PowerShell
; blocked by policy falling back to a `tasklist`/`taskkill` pairing that can
; race a process still exiting) — see main.ts's own quit-hardening
; (will-prevent-unload, before-quit cleanup, and its ~3s app.exit(0)
; failsafe) for the same belt-and-suspenders reasoning on the app side.
;
; The exact executable name — productName + ".exe" (electron-builder's
; default `${APP_EXECUTABLE_FILENAME}`, spaces and all — this is
; case-insensitive and space-tolerant when quoted, which it is below).

!macro closeHiocPos
  ; /T also ends any child processes taskkill can see under this image name
  ; (e.g. a PRN-5 hidden driver-print window, which is the same executable).
  ; Exit code 128 ("not found") from taskkill just means it wasn't running —
  ; not an error worth surfacing, so this is logged, never fatal to setup.
  nsExec::ExecToLog 'taskkill /F /T /IM "HIOC POS.exe"'
  Pop $0
!macroend

!macro customInit
  !insertmacro closeHiocPos
!macroend

!macro customUnInit
  !insertmacro closeHiocPos
!macroend

!macro customUnInstall
  ; Remove the login-item `Run` entry HIOC POS registers on every packaged
  ; launch (main.ts, `app.setLoginItemSettings({ openAtLogin: true, name:
  ; 'HIOC POS' })`) — an uninstalled app must not keep relaunching itself at
  ; sign-in. `perMachine: false` means this is always a per-user install, so
  ; HKCU is the only hive that can hold it.
  ;
  ; "HIOC POS" is the value name 0.1.1+ writes explicitly (main.ts's
  ; LOGIN_ITEM_NAME). "hioc-pos" (desktop/package.json's `name` field) is
  ; deleted too, best-effort, in case a machine still on 0.1.0 — which never
  ; passed an explicit `name` and so took Electron's own default — used that
  ; value instead; deleting a value that isn't there is a silent no-op, not
  ; an error.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "HIOC POS"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "hioc-pos"
!macroend
