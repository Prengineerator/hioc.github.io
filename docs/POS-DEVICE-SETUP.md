# Counter machine setup — printing, install, enrolment

**Ticket:** PRT-2 (Phase 6 §4) · **Audience:** the cafe owner, following this alone, once per counter machine
**Time:** about 15 minutes the first time
**Result:** an order placed at the counter prints its ticket — and, if the receipt printer has a cash drawer
wired into it, pops the drawer on a cash sale — with **no dialog, no flicker, and no change to what is on
screen**.

There are two ways to set up a counter machine. **Use the HIOC POS desktop app** (below) unless you have a
specific reason not to — it is what makes the cash drawer possible, it lets kitchen tickets and the receipt
go to two different printers from the same machine, and it is what the printer setup screen at
**Staff → Printers** is for. The older Chrome-shortcut method still works and is kept as a documented
fallback further down, but it can only ever print to a single default printer and it can never open a cash
drawer — a browser has no way to do either.

---

## Recommended: the HIOC POS desktop app

### What you need

- The counter PC (Windows 10 or 11).
- A receipt printer with its normal Windows driver installed (USB is the common case; network printers
  work too). If it has a cash drawer wired into it (the RJ11 "kick" port on the back of the printer), the
  drawer is driven through the printer — no separate cable to the PC.
- Your staff or owner login.

### 1. Install the printer and prove it works on its own

Install the printer's driver from its CD or the manufacturer's site, then:

**Settings → Bluetooth & devices → Printers & scanners → [your printer] → Printer properties → Print Test Page**

Do not continue until a test page comes out. If it does not print here, nothing later in this guide will
make it print — it is a driver or cable problem, and it is much easier to solve now than after.

### 2. Download and install HIOC POS

Download the installer from
**[github.com/Prengineerator/hioc.github.io/releases/latest](https://github.com/Prengineerator/hioc.github.io/releases/latest)**
(the `.exe` under "Assets") and run it.

Windows will very likely show a blue **"Windows protected your PC"** screen — the installer isn't
code-signed yet. This is expected, not a sign anything is wrong: click **More info**, then **Run anyway**.
The installer adds a **HIOC POS** desktop shortcut and start-menu entry; it opens on its own like a normal
installed app from then on.

### 3. Sign in and enrol the machine

Open **HIOC POS** and sign in with a staff account. It's its own private, isolated session — signing in or
out here never affects Chrome, and signing in or out of Chrome never affects HIOC POS. The app also only
ever shows the staff/POS screens: no address bar, no customer site, no owner pages.

To enrol this counter as a trusted device, go to **Printers → This counter** in the app:

1. If nobody has enrolled this machine yet and you (the owner) are signed in, name it — "Counter 1", "Front
   till" — and press **Enrol this counter**.
2. If a staffer is signed in instead, the screen shows **"Ask the owner to enrol this counter from this
   app"** with an **Owner: sign in to enrol this counter** link. Use it to sign in with the owner account
   right there — it replaces the session on this counter for a moment, so let the regular staffer sign back
   in once enrolment is done.

Once enrolled, the screen shows the device's name and the date it was enrolled — "Trusted counter". To set
this machine's default order type or auto-print behaviour, that's still at **Owner → Devices** in a normal
browser (the app itself only exposes the name-and-enrol step, not the full settings).

### 4. Add your printer

Go to **Printers** in the staff nav (it's always there; it just points here if you open it from a plain
browser tab).

1. **Add printer** → choose the connection:
   - **USB printer with its normal Windows driver** (the common case): choose **Installed printer**, click
     **Scan for printers**, pick it from the list, and leave the mode on **Raw**. This uses the printer's
     stock driver through the Windows spooler — no separate USB driver install needed.
   - **Network printer** (Ethernet/WiFi, port 9100): choose **Network** and enter its IP.
2. Set the **paper width** (58mm or 80mm).
3. Tick which tickets print here — **KOT**, **Receipt**, **Token** — and how many copies of each.
4. If this is the printer with the cash drawer wired into it, tick **Drives the cash drawer**. Only one
   printer can drive it; turning this on here turns it off anywhere else automatically.
5. **Save printer**.

Repeat for a second printer (e.g. a separate kitchen printer) if you have one — this is exactly what a
browser-only setup cannot do.

### 5. Test print, test cut, and test drawer

Back on the printer list, each printer has a **Test print** button — use it to confirm paper actually comes
out before trusting it with a real order. It also prints an alignment ruler the full width of the paper —
if it wraps onto a second line or is cut off, the **Paper width** setting (58mm/80mm) doesn't match the
roll actually loaded.

If **Cut after print** is ticked, a **Cut style** dropdown appears (Standard, Partial, Full, Legacy) with a
**Test cut** button on each raw-capable printer row — use it to confirm the printer actually cuts, without
wasting a whole test ticket. **If the paper doesn't cut**, try the next style in the dropdown and press
**Test cut** again — cheap 80mm printers commonly only support one of these command sets. If none of the
four styles cuts, the printer likely has no auto-cutter, or its cutter has been switched off in the
printer's own configuration utility or DIP switches (check the printer's manual) — in that case, leave
**Cut after print** off and let staff tear the ticket at the built-in tear bar.

The printer wired to the drawer also has a **Test drawer** button — use it to confirm the drawer pops
without needing a cash sale.

### 6. Prove it — the test that actually matters

With the printer on:

1. Place a small test order at the counter and settle it with **cash**.
2. It passes when **all** of these are true:
   - [ ] The kitchen/receipt tickets print, with no dialog and no change to what's on screen.
   - [ ] The cash drawer pops open (if one is wired in and ticked above).
3. **Switch the printer off** and place another test order. A chip should appear saying the ticket didn't
   print. Switch the printer back on and retry from that chip.

Cancel or void the test orders afterwards so they don't land in the day's takings.

### Closing, updating and uninstalling

- **To close it**, click the **X** on the window, or press **Ctrl+Q** — it quits fully every time.
- **It reopens on its own at Windows sign-in** — that's intentional, so the counter is always ready.
- **To install a newer version**, just run the new installer over the old one — it closes the running app
  for you first, no need to close it by hand.
- **To uninstall**, go to **Settings → Apps → HIOC POS → Uninstall**. Your saved printer setup is kept, so
  reinstalling later picks it back up.
- **If a machine was set up with an early version (0.1.0)** and its window won't close, or a new installer
  or the uninstaller seems stuck: open Task Manager, find every **HIOC POS** entry, and **End task** on each
  one (or, from Command Prompt: `taskkill /F /T /IM "HIOC POS.exe"`), then try the install or uninstall
  again. This is a one-time step for machines on that early version only.
- **Installer says "HIOC POS cannot be closed. Please close it manually and click Retry to continue."
  forever, even though nothing is actually running (0.1.2 and earlier)** — check Task Manager or
  `taskkill /F /T /IM "HIOC POS.exe"`; if it reports HIOC POS isn't running and the installer still loops,
  this is it. Cause: on that machine, an earlier install (or a directory you typed by hand) put HIOC POS in
  a shared folder — the whole of `C:\Program Files`, `%LOCALAPPDATA%\Programs` itself, or your Windows user
  folder — instead of its own dedicated one. The installer's "is it still running?" check matches by that
  folder, so a shared folder makes it match (and try to close) other things on the machine entirely, and it
  can never fully succeed. Fix: install **0.1.3 or later** — it always installs into its own folder and only
  ever checks by the app's name, not by folder, so this can't happen again. If 0.1.3+ still won't get past
  the same message on a machine that had this problem: open Registry Editor (`regedit`), delete the key
  `HKEY_CURRENT_USER\Software\95dacd72-f399-5de5-844d-7e49549a979b` (this only clears HIOC POS's own
  remembered install location, nothing else), then run the 0.1.3+ installer again — with that key gone it
  has no shared folder left to remember and installs cleanly into its own folder.

---

## Turning on PIN unlock (Phase 6, PIN-2/3)

**Ticket:** PIN-1..5 (Phase 6 §6) · **Audience:** the owner, once per deployment (not once per machine)
**Result:** once a counter is enrolled (step 3 above), staff unlock it by tapping their name and a 4-digit
PIN instead of signing in with an email and password every time someone's shift starts. The browser fallback
below is unaffected — it keeps working with a normal per-person login regardless of this setting.

This is a one-time setup across the whole deployment, done in this order:

1. **Apply both migrations**, in this order (each is idempotent — safe to run again):
   - `supabase/2026-08-pos-devices.sql` (device enrolment — if you followed step 3 above, this is likely
     already applied).
   - `supabase/2026-08-staff-pins.sql` (the PIN credentials themselves).

   Run `npm run verify:db` afterwards and confirm the **PIN-1/PIN-5 · staff PINs** section passes.

2. **Set `OPERATOR_JWT_SECRET`** in the Vercel project's Environment Variables (Production). This is a
   dedicated secret — do not reuse `CRON_SECRET` or anything else. Generate one with:

   ```
   openssl rand -base64 48
   ```

   It must be at least 32 characters or the whole feature reports itself disabled rather than running with
   a weak secret — see `.env.local.example` for the same note.

3. **Set `NEXT_PUBLIC_FLAG_PIN_SWITCH=true`** in the same place, and redeploy. With this off (the default),
   nothing about the app changes — no lock screen, no new cookie, every existing sign-in flow untouched.

4. **The owner sets PINs** for each staff member: **Owner → Staff**, the **⋯** menu on their row → **PIN**.
   Type one or leave it blank to have one generated. It is shown **once**, on that screen — write it down or
   tell the person immediately, because neither you nor anyone else can look it up again afterwards (only
   reset it). A deactivated login has no PIN option — there's nothing to unlock with it.

5. **The enrolled counter shows the lock screen** the next time it's opened in the HIOC POS app (not the
   browser fallback): a grid of names, tap one, enter the 4-digit PIN. It auto-locks after 15 minutes idle,
   and **Switch** in the header locks it manually — an order in progress underneath is not lost either way.

If a PIN is entered wrong 5 times in a row it locks that person out for 60 seconds, doubling on each further
wrong entry, capped at 15 minutes — the owner can clear this early from the same **⋯ → PIN** screen (a fresh
set/reset also clears it).

---

## Fallback: browser-only setup (Chrome/Edge kiosk-printing)

Use this only when the desktop app genuinely isn't an option (e.g. a locked-down machine that can't run
installers). It has real limits the desktop app doesn't: it can only ever print to **one** default printer
for the whole machine, and **it can never open a cash drawer** — a browser has no API for either. If a cash
drawer is wired to the printer, this method cannot use it; go back to the desktop app above.

### 1. Install the printer and prove it works on its own

Install the printer's driver from its CD or the manufacturer's site, then:

**Settings → Bluetooth & devices → Printers & scanners → [your printer] → Printer properties → Print Test Page**

Do not continue until a test page comes out. If it does not print here, nothing later in this guide will make it print — it is a driver or cable problem, and it is much easier to solve now than after five more steps.

### 2. Stop Windows from moving your default printer

This is the single most common cause of "it printed to the wrong printer" — and it costs nothing to prevent.

**Settings → Bluetooth & devices → Printers & scanners →** turn **OFF** "Let Windows manage my default printer".

Windows leaves that on by default, and it means *the last printer you used becomes the default*. Print one thing to a PDF or an office printer and every kitchen ticket silently follows it there.

### 3. Make the thermal printer the default, on the right paper

Still in **Printers & scanners**: open your thermal printer → **Set as default**.

Then **Printer properties → Preferences** and set the paper size to the **80 mm roll** option (drivers name it differently: "80mm x 297mm", "Roll Paper 80 x 3276mm", "RP80"). Pick the roll size, not A4.

The tickets already declare their own width and remove page margins, so this is belt-and-braces — but a driver defaulting to A4 can still stretch or split a receipt, and this is where that gets fixed.

### 4. Create the POS shortcut

Right-click the desktop → **New → Shortcut**, and paste this as the location:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --user-data-dir="C:\HIOC-POS" --app=https://staff.hioc.in
```

Name it **HIOC POS**.

What each part is doing, because you will want to know when something misbehaves:

| Part | Why |
|---|---|
| `--kiosk-printing` | The whole point. Printing goes straight to the default printer with **no dialog**. Browsers refuse to print silently without this explicit opt-in, and that refusal is correct — this flag is you giving permission on this machine. |
| `--user-data-dir="C:\HIOC-POS"` | A separate Chrome profile just for the POS. Keeps the silent-printing permission and the default printer away from normal browsing on the same PC. |
| `--app=https://staff.hioc.in` | Opens with no tabs and no address bar — it looks and behaves like an application window. |

> Using Edge instead? Replace the path with `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"`. Everything else is identical.

> On the main domain rather than the subdomain? Use `--app=https://hioc.in/staff`. Both work.

### 5. Sign in and enrol the machine — from inside this window

**Open the HIOC POS shortcut you just made, and do this inside it.** Not in your normal Chrome.

That profile has its own separate cookies. A device enrolled in ordinary Chrome is a *different* machine as far as the POS is concerned, and the counter window will keep behaving like an unknown browser no matter how many times you enrol.

1. Sign in with a staff or owner account.
2. Go to **Owner → Devices** (`https://owner.hioc.in/devices`, or `hioc.in/owner/devices`).
3. Name this machine something you would recognise in a list — "Counter 1", "Front till".
4. Click **Enrol this machine**.

Now set what this machine should do by default, on the same screen:

- **Opens on** — Dine-in or Takeaway, whichever this till does most.
- **Kitchen ticket** — Always print.
- **Customer receipt** — your choice; most counters leave this on the store setting.

While you are on the cafe's WiFi, this is also the moment to open **Owner → Settings → Attendance** and press **Add this network**, so staff punches from this connection stop getting flagged.

### 6. Make it come back after a restart

Press **Windows + R**, type `shell:startup`, press Enter. Copy your **HIOC POS** shortcut into the folder that opens.

The POS now reopens by itself whenever the machine is switched on.

### 7. Prove it — the test that actually matters

With the printer on, in the POS window:

1. Place a small test order at the counter.
2. Watch the screen as you tap **Charge**.

It passes when **all three** are true:

- [ ] Paper comes out.
- [ ] **No print dialog appeared.**
- [ ] The screen did not move, flash, or open anything — you can start the next order immediately.

Then pull it apart deliberately:

3. **Switch the printer off** and place another test order. Within about ten seconds a chip must appear saying the ticket did not print. Switch the printer on and tap the chip to retry — the ticket should come out.

That second test is the important one. Silent printing's failure mode is silent *non*-printing, and the only thing that makes silence safe is knowing failure is loud.

Finally, cancel or void the test orders so they do not land in the day's takings.

---

### When it misbehaves

**A print dialog appears.**
The shortcut is not the one being used — Windows probably opened Chrome normally, or the POS was launched from a pinned icon made before step 4. Close every Chrome window (check the system tray) and reopen using the HIOC POS shortcut. Right-click the taskbar icon → Pin to taskbar to get a correct pinned copy.

**It prints to the wrong printer.**
Step 2 was skipped or got switched back on. Re-check "Let Windows manage my default printer" is OFF, then set the thermal printer as default again.

**The web address and the date print across the top of every ticket.**
That is Chrome's header and footer, drawn in the page margin. The ticket pages set `margin: 0` to refuse the margin box, so seeing this means the app is serving an older version — reload the POS window with **Ctrl + Shift + R**.

**Tickets are stretched, cut off, or use a whole A4 page.**
The driver's paper size is still A4. Go back to step 3.

**Nothing prints and no chip appears.**
Printing never started. Check the POS window is signed in (a signed-out window shows the login page inside the hidden print frame and prints nothing), then retry.

**"This machine" is not showing on the Devices screen.**
Step 5 was done in a different Chrome profile. Open the HIOC POS shortcut and enrol again from inside it.

---

### The limitation, stated plainly

`--kiosk-printing` prints **everything to the one default printer** of that profile, and can never touch a
cash drawer. One counter printer with no drawer is exactly what this handles well.

If you want **kitchen tickets on a kitchen printer and receipts at the counter from the same machine**, or a
**cash drawer that pops on a cash sale**, this method cannot do either — a browser has no way to choose a
printer per job or to send the drawer's kick pulse. That is exactly what the HIOC POS desktop app (the
recommended method, above) is for; it now exists, so there is no reason to build around this limitation —
switch to the desktop app instead of working around it.

The old workaround, kept here only for machines still on this method: a second Chrome profile (another
shortcut with a different `--user-data-dir`) with the kitchen printer as *its* default, opened on the order
board. It works, and it is clumsy — the desktop app replaces it.

---

## macOS (desktop app)

The desktop app also builds for macOS (`npm run dist:mac` in `desktop/`, see `desktop/README.md`), though
there is currently no downloadable release for it — only Windows is built and published automatically.
Everything above (Printers screen, test print/drawer) works the same once it's installed.

### macOS (browser fallback)

Same idea, different shortcut. Create `~/hioc-pos.command` containing:

```bash
#!/bin/bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --kiosk-printing \
  --user-data-dir="$HOME/hioc-pos-profile" \
  --app=https://staff.hioc.in
```

Then `chmod +x ~/hioc-pos.command`, and add it under **System Settings → General → Login Items** to start it automatically. Set the thermal printer as the default in **System Settings → Printers & Scanners**. Steps 5 and 7 are unchanged.
