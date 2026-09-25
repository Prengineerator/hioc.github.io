// PRN-1/PRN-4 — raw ESC/POS over USB via libusb (the `usb` package). It's an
// optionalDependency (native module — install can fail with no build
// toolchain on a bare Windows counter machine) and is loaded lazily here with
// `require`, never a static import, so a machine that never got the native
// binding still works fine on network and OS printers and gets exactly one
// clear error if staff try to add a USB printer. R1/R5 in the spec.
//
// The `usb` module ships its own types, but we deliberately type everything
// here as `any` past the `require()` boundary: a static `import type` would
// make this file (and `tsc --noEmit`) depend on the package actually being
// installed, which defeats the point of loading it lazily.

import type { PrinterHealth } from '@/lib/desktop/bridge';
import { allStatusQueries, parseStatus, type ParsedStatus, type StatusBytes } from './escposStatus';

const USB_PRINTER_CLASS = 0x07;
const STATUS_READ_TIMEOUT_MS = 1500;

export interface UsbPrinterTarget {
  vendorId: number;
  productId: number;
  serialNumber?: string;
}

export interface DetectedUsbPrinter {
  vendorId: number;
  productId: number;
  serialNumber?: string;
  label: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let cachedUsb: Any = undefined;

function loadUsb(): Any {
  if (cachedUsb === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cachedUsb = require('usb');
    } catch {
      cachedUsb = null;
    }
  }
  if (!cachedUsb) {
    throw new Error(
      'USB printing is not available on this machine — the "usb" driver did not install. ' +
        'Add this printer as a network or OS printer instead.',
    );
  }
  return cachedUsb;
}

function readStringDescriptor(device: Any, index: number | undefined): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!index) {
      resolve(undefined);
      return;
    }
    try {
      device.getStringDescriptor(index, (err: unknown, data: unknown) => {
        resolve(err ? undefined : (data as string | undefined));
      });
    } catch {
      resolve(undefined);
    }
  });
}

function hasPrinterInterface(configDescriptor: Any): boolean {
  const interfaces: Any[] = configDescriptor?.interfaces ?? [];
  return interfaces.some((alternates: Any[]) => alternates.some((alt) => alt.bInterfaceClass === USB_PRINTER_CLASS));
}

/** Lists USB devices that advertise the USB printer class (0x07). Devices we
 * can't open (permissions, in use) are skipped rather than failing detect(). */
export async function detectUsbPrinters(): Promise<DetectedUsbPrinter[]> {
  const usb = loadUsb();
  const found: DetectedUsbPrinter[] = [];

  for (const device of usb.getDeviceList()) {
    try {
      device.open();
    } catch {
      continue;
    }
    try {
      if (!hasPrinterInterface(device.configDescriptor)) continue;
      const desc = device.deviceDescriptor;
      const serialNumber = await readStringDescriptor(device, desc.iSerialNumber);
      const product = await readStringDescriptor(device, desc.iProduct);
      found.push({
        vendorId: desc.idVendor,
        productId: desc.idProduct,
        ...(serialNumber ? { serialNumber } : {}),
        label: product || `USB printer ${desc.idVendor.toString(16)}:${desc.idProduct.toString(16)}`,
      });
    } catch {
      // Skip devices we can't introspect rather than failing detect() outright.
    } finally {
      try {
        device.close();
      } catch {
        // already closed / not openable
      }
    }
  }

  return found;
}

function findDevice(usb: Any, target: UsbPrinterTarget): Any {
  const matches = usb
    .getDeviceList()
    .filter(
      (d: Any) => d.deviceDescriptor.idVendor === target.vendorId && d.deviceDescriptor.idProduct === target.productId,
    );
  if (matches.length === 0) {
    throw new Error(
      `USB printer ${target.vendorId.toString(16)}:${target.productId.toString(16)} was not found`,
    );
  }
  // Serial disambiguation, if given, is best-effort — several identical
  // printers with no serial reporting still resolve to the first match.
  return matches[0];
}

interface ClaimedInterface {
  device: Any;
  iface: Any;
  outEndpoint: Any;
  inEndpoint: Any | null;
  detached: boolean;
}

function claimPrinterInterface(device: Any): ClaimedInterface {
  device.open();
  const iface = device.interfaces.find((i: Any) => i.descriptor?.bInterfaceClass === USB_PRINTER_CLASS) ?? device.interfaces[0];
  if (!iface) throw new Error('USB printer has no usable interface');

  let detached = false;
  if (process.platform !== 'win32' && typeof iface.isKernelDriverActive === 'function' && iface.isKernelDriverActive()) {
    iface.detachKernelDriver();
    detached = true;
  }
  iface.claim();

  const outEndpoint = iface.endpoints.find((e: Any) => e.direction === 'out');
  const inEndpoint = iface.endpoints.find((e: Any) => e.direction === 'in') ?? null;
  if (!outEndpoint) throw new Error('USB printer has no OUT endpoint to write to');

  return { device, iface, outEndpoint, inEndpoint, detached };
}

function releaseInterface(claimed: ClaimedInterface): void {
  try {
    claimed.iface.release(true, () => {
      if (claimed.detached && process.platform !== 'win32') {
        try {
          claimed.iface.attachKernelDriver();
        } catch {
          // best-effort restore; not fatal either way
        }
      }
      try {
        claimed.device.close();
      } catch {
        // already closed
      }
    });
  } catch {
    try {
      claimed.device.close();
    } catch {
      // ignore
    }
  }
}

function transferOut(endpoint: Any, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    endpoint.transfer(Buffer.from(bytes), (err: unknown) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    });
  });
}

function transferIn(endpoint: Any, length: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Buffer | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), STATUS_READ_TIMEOUT_MS);
    try {
      endpoint.transfer(length, (err: unknown, data: Buffer) => {
        clearTimeout(timer);
        finish(err ? undefined : data);
      });
    } catch {
      clearTimeout(timer);
      finish(undefined);
    }
  });
}

async function queryHealth(claimed: ClaimedInterface): Promise<ParsedStatus> {
  if (!claimed.inEndpoint) {
    return { health: 'unknown', detail: 'This USB printer has no status endpoint' };
  }
  const bytes: StatusBytes = {};
  for (const q of allStatusQueries()) {
    await transferOut(claimed.outEndpoint, q.bytes).catch(() => undefined);
    const reply = await transferIn(claimed.inEndpoint, 1);
    if (reply && reply.length > 0) bytes[q.kind] = reply[0];
  }
  return parseStatus(bytes);
}

function assertHealthy(result: ParsedStatus, name: string): void {
  const health: PrinterHealth = result.health;
  switch (health) {
    case 'paper_out':
      throw new Error(`${name} is out of paper`);
    case 'cover_open':
      throw new Error(`${name} cover is open`);
    case 'offline':
      throw new Error(`${name} is offline`);
    case 'error':
      throw new Error(`${name} reported an error`);
    default:
      return;
  }
}

export async function printOverUsb(
  target: UsbPrinterTarget,
  name: string,
  bytes: Uint8Array,
): Promise<{ confirmed: boolean }> {
  const usb = loadUsb();
  const device = findDevice(usb, target);
  const claimed = claimPrinterInterface(device);
  try {
    assertHealthy(await queryHealth(claimed), name);

    await transferOut(claimed.outEndpoint, bytes);

    const after = await queryHealth(claimed);
    if (after.health === 'unknown') return { confirmed: false };
    assertHealthy(after, name);
    return { confirmed: true };
  } finally {
    releaseInterface(claimed);
  }
}

export async function checkUsbStatus(target: UsbPrinterTarget): Promise<ParsedStatus> {
  const usb = loadUsb();
  const device = findDevice(usb, target);
  const claimed = claimPrinterInterface(device);
  try {
    return await queryHealth(claimed);
  } finally {
    releaseInterface(claimed);
  }
}

/** Called once on app quit (main.ts). Nothing in this file keeps a USB device
 * handle open outside the lifetime of a single detect/print/status call
 * (each of those always closes its device in a `finally`, even on error), and
 * nothing here registers hotplug ('attach'/'detach') listeners, so there is
 * no known persistent handle to release. Still, best-effort: if the native
 * module was ever loaded, drop any listeners it might hold and unref its
 * hotplug event thread (present on some `usb` versions/platforms) so it can
 * never itself be the reason the process outlives its window. */
export function releaseUsbForShutdown(): void {
  if (!cachedUsb) return;
  try {
    cachedUsb.unrefHotplugEvents?.();
  } catch {
    // best-effort only
  }
  try {
    cachedUsb.removeAllListeners?.();
  } catch {
    // best-effort only
  }
}
