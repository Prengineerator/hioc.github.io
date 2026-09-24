// PRN-5 (system+raw half) — hand raw ESC/POS bytes to an installed OS printer
// via its spooler instead of a raw socket/USB endpoint. Neither this route nor
// driver.ts can read paper status (see PRN-4's doc comment in escposStatus.ts)
// — the caller keeps PRT-3's "Didn't print" affordance for these.
//
// Windows RAW printing goes through winspool via a small, FIXED PowerShell/C#
// script loaded from a temp .ps1 file. The printer name and the byte payload
// are both passed as process arguments (`-PrinterName`, `-DataFile`), never
// interpolated into the script text, so an odd printer name can't inject
// PowerShell.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WebContents } from 'electron';

export interface SystemPrinterJobResult {
  confirmed: boolean;
}

export interface SystemPrinterInfo {
  name: string;
  displayName?: string;
}

function execFileAsync(cmd: string, args: string[], input?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve();
      }
    });
    if (input) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

async function printRawUnix(deviceName: string, bytes: Uint8Array): Promise<void> {
  await execFileAsync('lp', ['-d', deviceName, '-o', 'raw'], Buffer.from(bytes));
}

// Fixed script body — no user input is ever interpolated into this string.
const WINSPOOL_TYPE = `
using System;
using System.IO;
using System.Runtime.InteropServices;

public class HiocRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFOA {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA pDocInfo);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

  public static void Send(string printerName, string filePath) {
    byte[] bytes = File.ReadAllBytes(filePath);
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
      throw new Exception("OpenPrinter failed for " + printerName);
    }
    try {
      DOCINFOA di = new DOCINFOA();
      di.pDocName = "HIOC POS";
      di.pDataType = "RAW";
      if (!StartDocPrinter(hPrinter, 1, ref di)) throw new Exception("StartDocPrinter failed");
      try {
        if (!StartPagePrinter(hPrinter)) throw new Exception("StartPagePrinter failed");
        int written;
        if (!WritePrinter(hPrinter, bytes, bytes.Length, out written)) throw new Exception("WritePrinter failed");
        EndPagePrinter(hPrinter);
      } finally {
        EndDocPrinter(hPrinter);
      }
    } finally {
      ClosePrinter(hPrinter);
    }
  }
}
`;

const WINSPOOL_SCRIPT = `
param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$DataFile
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINSPOOL_TYPE}
'@
[HiocRawPrint]::Send($PrinterName, $DataFile)
`;

async function printRawWindows(deviceName: string, bytes: Uint8Array): Promise<void> {
  const tmpData = path.join(os.tmpdir(), `hioc-pos-${randomUUID()}.bin`);
  const tmpScript = path.join(os.tmpdir(), `hioc-pos-${randomUUID()}.ps1`);
  await fs.writeFile(tmpData, Buffer.from(bytes));
  await fs.writeFile(tmpScript, WINSPOOL_SCRIPT, 'utf8');
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      tmpScript,
      '-PrinterName',
      deviceName,
      '-DataFile',
      tmpData,
    ]);
  } finally {
    await fs.unlink(tmpData).catch(() => undefined);
    await fs.unlink(tmpScript).catch(() => undefined);
  }
}

/** Raw ESC/POS bytes through the OS spooler. Can't confirm paper state — the
 * caller must keep the manual "Didn't print" affordance for this route. */
export async function printRawToSystemPrinter(deviceName: string, bytes: Uint8Array): Promise<SystemPrinterJobResult> {
  if (process.platform === 'win32') {
    await printRawWindows(deviceName, bytes);
  } else {
    await printRawUnix(deviceName, bytes);
  }
  return { confirmed: false };
}

/** OS-installed printers, for the "OS printer" option in PRN-1's add-printer
 * flow and for PRN-2 detect(). Needs a live BrowserWindow's webContents. */
export async function listSystemPrinters(webContents: WebContents): Promise<SystemPrinterInfo[]> {
  const printers = await webContents.getPrintersAsync();
  return printers.map((p) => ({ name: p.name, displayName: p.displayName }));
}
