// Shared HTTP response helpers for app/api/** route handlers.
// Every error response follows the API contract's `{ "error": string }` shape.

import { NextResponse } from 'next/server';

export function errorResponse(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export const unauthorized = () => errorResponse(401, 'Unauthorized');
export const notFound = () => errorResponse(404, 'Not found');

/**
 * Safely parse a Route Handler's JSON body. Returns null (instead of
 * throwing) when the body is missing/malformed, so callers can respond with
 * a clean 400 rather than letting Next.js surface an unhandled exception.
 */
export async function parseJsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}
