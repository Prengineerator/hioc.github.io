; SHL-3 — force-close a running "HIOC POS" before the installer or the
; uninstaller touches any files, so a running copy can never block replacing
; or removing it. Wired in via `nsis.include` in electron-builder.yml.
;
; ---------------------------------------------------------------------------
; v0.1.3 — fix "HIOC POS cannot be closed" looping forever on a machine
; where nothing is actually running (SHL-3 field bug).
;
; Root cause: electron-builder's own built-in running-app check
; (CHECK_APP_RUNNING / _CHECK_APP_RUNNING in its packaged
; node_modules/app-builder-lib/templates/nsis/include/
; allowOnlyOneInstallerInstance.nsh), when PowerShell is available (almost
; always), asks PowerShell whether ANY process's Path *starts with*
; $INSTDIR — not whether "HIOC POS.exe" is running:
;
;   Get-CimInstance -ClassName Win32_Process
;     | ? { $_.Path -and $_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') }
;
; $INSTDIR itself comes from the previous install's own InstallLocation
; (HKCU/HKLM "Software\${APP_GUID}"), copied in verbatim by
; multiUser.nsh's setInstallModePerUser/setInstallModePerAllUsers with
; nothing appended — so if an older install (0.1.2 and earlier had
; nsis.allowToChangeInstallationDirectory: true, with no dedicated-folder
; guard once the picker's own page was skipped by just clicking through) put
; that value at a shared/general folder — "C:\Program Files",
; "%LOCALAPPDATA%\Programs", the user's whole profile folder — the
; StartsWith match (no trailing "\" either, so it also catches a sibling
; folder like "...\HIOC POS 2") can catch a pile of completely unrelated
; processes. Some can't be closed (elevated, protected, or just someone
; else's app), so the installer shows "$(appCannotBeClosed)" and loops
; forever even though HIOC POS was never running — and Stop-Process may
; force-close other apps in the meantime.
;
; Two independent fixes, both needed:
;
;  1. `customCheckAppRunning` below replaces that check, in BOTH the
;     installer and the uninstaller (electron-builder's CHECK_APP_RUNNING
;     macro uses it automatically wherever it would otherwise use
;     PowerShell/IS_POWERSHELL_AVAILABLE — see
;     allowOnlyOneInstallerInstance.nsh's `!ifmacrodef customCheckAppRunning`
;     branch). It matches (and closes) HIOC POS by EXECUTABLE NAME ONLY,
;     the same tasklist/findstr exact-match pattern electron-builder's own
;     template already uses for its all-users branch — never $INSTDIR.
;
;  2. `forceDedicatedInstallDir` (called from customInit, installer only —
;     see its own comment for why never from the uninstaller) makes sure
;     $INSTDIR is always our own dedicated folder before anything reads or
;     writes it, so a stale InstallLocation from an older install can't
;     reintroduce a shared $INSTDIR going forward either. electron-builder.yml
;     also now sets `allowToChangeInstallationDirectory: false`, so there is
;     no directory page for an owner to repoint at a shared folder again.
;
; Why the taskkill-by-name in customInit/customUnInit below is *also* kept:
; belt and braces against the few ways even a name-only check can still lag
; reality for a moment (e.g. a process still exiting) — see main.ts's own
; quit-hardening (will-prevent-unload, before-quit cleanup, and its ~3s
; app.exit(0) failsafe) for the same reasoning on the app side.
;
; The exact executable name is productName + ".exe" — electron-builder's
; ${APP_EXECUTABLE_FILENAME} (defined in common.nsh from PRODUCT_FILENAME),
; spaces and all; case-insensitive and space-tolerant when quoted, which it
; is everywhere below.

!include "FileFunc.nsh"

!macro closeHiocPos
  ; /T also ends any child processes taskkill can see under this image name
  ; (e.g. a PRN-5 hidden driver-print window, which is the same executable).
  ; Exit code 128 ("not found") from taskkill just means it wasn't running —
  ; not an error worth surfacing, so this is logged, never fatal to setup.
  nsExec::ExecToLog 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
!macroend

; ---------------------------------------------------------------------------
; Is "${APP_EXECUTABLE_FILENAME}" running, by name only? Sets ${_RETURN} to
; 0 (found) or non-zero (not found) — same convention as electron-builder's
; own FIND_PROCESS.
;
; tasklist's own /FI IMAGENAME filter is documented as exact-match already,
; but findstr's anchored /B (start of line) /I (case-insensitive) match
; against the quoted name makes that authoritative rather than assumed —
; mirrors the ALL_USERS branch of allowOnlyOneInstallerInstance.nsh's own
; FIND_PROCESS macro. No /FI USERNAME filter: an elevated copy running as
; the same user must still be found (and reported), not silently ignored.
!macro hiocFindAppRunning _RETURN
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop ${_RETURN}
!macroend

; ---------------------------------------------------------------------------
; Replaces electron-builder's own PowerShell-and-$INSTDIR-based
; _CHECK_APP_RUNNING (see the long comment at the top of this file for why).
; electron-builder's CHECK_APP_RUNNING macro inserts this automatically, in
; both the installer (installSection.nsh, inside Section "install") and the
; uninstaller (uninstaller.nsh's Function un.checkAppRunning, itself called
; from un.onInit for a silent run and from the "un.Uninstall" section for a
; non-silent one) — so this one definition covers both.
;
; No self-exclusion (no ${GetProcessInfo}/$pid guard, unlike the default
; _CHECK_APP_RUNNING): the running installer/uninstaller process is never
; itself named "${APP_EXECUTABLE_FILENAME}" (it's the setup .exe or
; "Uninstall ${PRODUCT_FILENAME}.exe"), so an IMAGENAME match can never be
; a false positive against this process's own binary.
;
; Shape mirrors the default _CHECK_APP_RUNNING: one "$(appRunning)"
; OK/Cancel prompt before the first close attempt (skipped when ${isUpdated}
; — electron-updater relaunching the installer while the old app is still
; quitting on its own), then up to 5 silent force-close attempts a second
; apart; if it's still running after that (e.g. started elevated, so this
; taskkill can't touch it), "$(appCannotBeClosed)" Retry/Cancel — Retry
; resets the 5-attempt counter and tries again, Cancel quits. Kept as a
; retry loop with no hard cap (matching the default's own shape) rather than
; giving up after one round, since a real "can't be closed" case needs the
; owner to actually go close it by hand and then click Retry.
!macro customCheckAppRunning
  ${if} ${isUpdated}
    Sleep 300
  ${endIf}

  !insertmacro hiocFindAppRunning $R0
  ${if} $R0 != 0
    Goto hioc_check_done
  ${endIf}

  ${if} ${isUpdated}
    Sleep 1000
    Goto hioc_check_kill
  ${endIf}

  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK hioc_check_kill
  Quit

  hioc_check_kill:
  DetailPrint "$(appClosing)"

  StrCpy $R1 0
  hioc_check_retry:
    IntOp $R1 $R1 + 1

    nsExec::ExecToLog 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $R2

    Sleep 1000

    !insertmacro hiocFindAppRunning $R0
    ${if} $R0 != 0
      Goto hioc_check_done
    ${endIf}

    ${if} $R1 < 5
      DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
      Sleep 1000
      Goto hioc_check_retry
    ${endIf}

    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY hioc_check_retry_reset
    Quit

    hioc_check_retry_reset:
      StrCpy $R1 0
      Goto hioc_check_retry

  hioc_check_done:
!macroend

; ---------------------------------------------------------------------------
; Always install into our OWN dedicated folder — never whatever folder
; $INSTDIR happens to be pointing at right now.
;
; With nsis.allowToChangeInstallationDirectory now false there's no
; directory-picker page any more (and so none of electron-builder's own
; "instFilesPre" folder-name sanitizing in assistedInstaller.nsh either,
; since that only exists when the page does) — the per-user default that
; multiUser.nsh's setInstallModePerUser falls back to is already our own
; dedicated folder ($LocalAppData\Programs\${APP_FILENAME}). The one way
; $INSTDIR can still be wrong here is a stale
; HKCU\Software\${APP_GUID}\InstallLocation left behind by an OLDER install
; (0.1.2 and earlier) that had the directory page and whose owner picked (or
; was left at) a shared/general folder — setInstallModePerUser copies that
; registry value into $INSTDIR verbatim, nothing appended.
;
; So: if $INSTDIR's own last path component isn't literally our app's
; folder name, this isn't a dedicated per-app location — append our app
; folder name to whatever $INSTDIR is, rather than replacing $INSTDIR with a
; hardcoded default. Appending is the safer of the two options: it keeps
; whichever root multiUser.nsh already chose for this run — the per-user
; default ($LocalAppData\Programs) for a current-user install, or
; $PROGRAMFILES(64) for an all-users one (this app ships perMachine: false,
; so that is a secondary/elevated path, not the common one, but it must
; still end up dedicated too) — instead of silently forcing every corrupted
; install onto the per-user path regardless of which mode was actually
; chosen. It's also exactly what electron-builder's own "instFilesPre" in
; assistedInstaller.nsh already does when its directory page is enabled
; (append the app folder name when it's missing), so this keeps the exact
; same behavior for the one case that page can no longer cover itself.
;
; Comparing only the last path component (not the whole path) is what
; actually distinguishes "some folder that isn't ours" from "our own
; folder, wherever its parent happens to be" (e.g. a still-valid /allusers
; install under Program Files, which must be left alone, not have its own
; name appended a second time); ${GetFileName} and NSIS's own `==`
; (case-insensitive, see LogicLib.nsh's `_==`) make that comparison
; exact-component and case-insensitive, so "...\HIOC POS 2" is correctly
; treated as NOT ours (gets "\HIOC POS" appended) while "...\hioc pos" is
; (left alone).
;
; NEVER call this from the uninstaller (customUnInit): an uninstaller's
; whole job is to delete whatever is ACTUALLY at the $INSTDIR recorded for
; it (read fresh from the registry independently of this file — see
; uninstallOldVersion in installUtil.nsh). Silently redirecting that would
; make it remove nothing at the real install, or something at a guessed one.
!macro forceDedicatedInstallDir
  Push $0
  Push $1
  ${GetFileName} "$INSTDIR" $0
  ${if} $0 != "${APP_FILENAME}"
    ; defensive: $INSTDIR is never expected to carry a trailing "\" here
    ; (nothing in this codebase writes or reads one that way), but strip it
    ; first anyway rather than risk a doubled separator from a hand-edited
    ; registry value.
    StrCpy $1 "$INSTDIR" 1 -1
    ${if} $1 == "\"
      StrCpy $INSTDIR "$INSTDIR" -1
    ${endIf}
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${endIf}
  Pop $1
  Pop $0
!macroend

!macro customInit
  !insertmacro closeHiocPos
  !insertmacro forceDedicatedInstallDir
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
