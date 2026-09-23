# Counter machine setup — printing, install, enrolment

**Ticket:** PRT-2 (Phase 6 §4) · **Audience:** the cafe owner, following this alone, once per counter machine
**Time:** about 20 minutes the first time
**Result:** an order placed at the counter prints its ticket with **no dialog, no flicker, and no change to what is on screen**. The POS opens in its own window like an installed app and comes back by itself after a reboot.

> Do the steps in order. Step 5 (enrolment) only works if step 4 is done first — that is the one place where doing it out of order silently gives you the wrong result.

---

## What you need

- The counter PC (Windows 10 or 11) — these instructions are for Windows; macOS notes are at the end.
- An **80 mm thermal receipt printer**, USB, with its driver installed.
- Google Chrome (or Microsoft Edge — both work, the commands are the same with `msedge.exe`).
- Your owner login.

---

## 1. Install the printer and prove it works on its own

Install the printer's driver from its CD or the manufacturer's site, then:

**Settings → Bluetooth & devices → Printers & scanners → [your printer] → Printer properties → Print Test Page**

Do not continue until a test page comes out. If it does not print here, nothing later in this guide will make it print — it is a driver or cable problem, and it is much easier to solve now than after five more steps.

## 2. Stop Windows from moving your default printer

This is the single most common cause of "it printed to the wrong printer" — and it costs nothing to prevent.

**Settings → Bluetooth & devices → Printers & scanners →** turn **OFF** "Let Windows manage my default printer".

Windows leaves that on by default, and it means *the last printer you used becomes the default*. Print one thing to a PDF or an office printer and every kitchen ticket silently follows it there.

## 3. Make the thermal printer the default, on the right paper

Still in **Printers & scanners**: open your thermal printer → **Set as default**.

Then **Printer properties → Preferences** and set the paper size to the **80 mm roll** option (drivers name it differently: "80mm x 297mm", "Roll Paper 80 x 3276mm", "RP80"). Pick the roll size, not A4.

The tickets already declare their own width and remove page margins, so this is belt-and-braces — but a driver defaulting to A4 can still stretch or split a receipt, and this is where that gets fixed.

## 4. Create the POS shortcut

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

## 5. Sign in and enrol the machine — from inside this window

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

## 6. Make it come back after a restart

Press **Windows + R**, type `shell:startup`, press Enter. Copy your **HIOC POS** shortcut into the folder that opens.

The POS now reopens by itself whenever the machine is switched on.

## 7. Prove it — the test that actually matters

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

## When it misbehaves

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

## The limitation, stated plainly

`--kiosk-printing` prints **everything to the one default printer** of that profile. One counter printer is exactly what this handles well.

If you later want **kitchen tickets on a kitchen printer and receipts at the counter from this same machine**, this method cannot do it — a browser has no way to choose a printer per job. That needs a small helper application installed on the counter PC, which is a real piece of work with its own installer and updates, and is deliberately not built until a second printer actually exists. See `docs/COUNTER-PAYMENTS-SPEC.md` §5 for where that decision is recorded and what would re-open it.

The workaround in the meantime is a second Chrome profile (another shortcut with a different `--user-data-dir`) with the kitchen printer as *its* default, opened on the order board. It works, and it is clumsy.

---

## macOS

Same idea, different shortcut. Create `~/hioc-pos.command` containing:

```bash
#!/bin/bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --kiosk-printing \
  --user-data-dir="$HOME/hioc-pos-profile" \
  --app=https://staff.hioc.in
```

Then `chmod +x ~/hioc-pos.command`, and add it under **System Settings → General → Login Items** to start it automatically. Set the thermal printer as the default in **System Settings → Printers & Scanners**. Steps 5 and 7 are unchanged.
