// PRN-4 — raw ESC/POS over TCP (port 9100 by convention). Status is queried
// before AND after the job: before, so a printer that's already out of paper
// fails loudly before staff walk away; after, so a fault the job itself caused
// (or one that appeared mid-print) is caught before the caller reports
// success. A printer that took the bytes but never answered the AFTER status
// query is not a failure — some clones just don't reply reliably — so that
// case resolves `{ confirmed: false }` and leaves PRT-3's "Didn't print"
// affordance to the caller, exactly like the OS-driver routes.

import * as net from 'node:net';
import type { PrinterHealth } from '@/lib/desktop/bridge';
import { allStatusQueries, parseStatus, type ParsedStatus, type StatusBytes } from './escposStatus';

const CONNECT_TIMEOUT_MS = 3000;
const STATUS_READ_TIMEOUT_MS = 1500;

export interface NetworkPrinterTarget {
  host: string;
  port: number;
}

export interface NetworkJobResult {
  confirmed: boolean;
}

function connect(target: NetworkPrinterTarget): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('connect timed out'));
    }, CONNECT_TIMEOUT_MS);

    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    socket.connect(target.port, target.host, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

function writeBytes(socket: net.Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(Buffer.from(bytes), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Sends one `DLE EOT n` query and waits up to STATUS_READ_TIMEOUT_MS for the
 * single-byte reply. Resolves `undefined` on timeout or write failure — never
 * rejects — because "this printer didn't answer" is data, not a fault. */
function readStatusByte(socket: net.Socket, query: Uint8Array): Promise<number | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: number | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      resolve(value);
    };
    const onData = (data: Buffer) => finish(data.length > 0 ? data[0] : undefined);
    const timer = setTimeout(() => finish(undefined), STATUS_READ_TIMEOUT_MS);

    socket.on('data', onData);
    socket.write(Buffer.from(query), (err) => {
      if (err) finish(undefined);
    });
  });
}

async function queryHealth(socket: net.Socket): Promise<ParsedStatus> {
  const bytes: StatusBytes = {};
  for (const q of allStatusQueries()) {
    const value = await readStatusByte(socket, q.bytes);
    if (value !== undefined) bytes[q.kind] = value;
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

export async function printOverNetwork(
  target: NetworkPrinterTarget,
  name: string,
  bytes: Uint8Array,
): Promise<NetworkJobResult> {
  let socket: net.Socket;
  try {
    socket = await connect(target);
  } catch {
    throw new Error(`${name} is not reachable at ${target.host}`);
  }

  try {
    assertHealthy(await queryHealth(socket), name);

    await writeBytes(socket, bytes);

    const after = await queryHealth(socket);
    if (after.health === 'unknown') {
      return { confirmed: false };
    }
    assertHealthy(after, name);
    return { confirmed: true };
  } finally {
    socket.destroy();
  }
}

export async function checkNetworkStatus(target: NetworkPrinterTarget): Promise<ParsedStatus> {
  let socket: net.Socket;
  try {
    socket = await connect(target);
  } catch {
    return { health: 'offline', detail: `Not reachable at ${target.host}` };
  }
  try {
    return await queryHealth(socket);
  } finally {
    socket.destroy();
  }
}
