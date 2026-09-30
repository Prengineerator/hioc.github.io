import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { CLICK_TOKEN_ALPHABET, CLICK_TOKEN_LENGTH } from '@/lib/marketing/types';

export const dynamic = 'force-dynamic';

// GET /r/[token] — PUBLIC. The URL behind a marketing message's "Order now" button
// (https://hioc.in/r/<click_token>). It records that the recipient clicked — the FIRST
// click only — and sends them to the menu.
//
// It can never fail visibly: an unknown token, a malformed one, a database that is down
// or a migration that is not applied all end the same way, at /menu. Nothing personal is
// in the URL (the token is random and says nothing about who it belongs to), and nothing
// personal comes back.
const TOKEN = new RegExp(`^[${CLICK_TOKEN_ALPHABET.replace('-', '\\-')}]{${CLICK_TOKEN_LENGTH}}$`);

export async function GET(request: Request, { params }: { params: { token: string } }) {
  if (TOKEN.test(params.token)) {
    try {
      await createAdminSupabaseClient()
        .from('marketing_recipients')
        .update({ clicked_at: new Date().toISOString() })
        .eq('click_token', params.token)
        .is('clicked_at', null);
    } catch (err) {
      console.error('marketing click: stamp failed', err);
    }
  }
  // 302, not Next's default 307: a browser follow-up to /menu is a plain GET either way,
  // and a click link is not something a client should cache as permanent.
  return NextResponse.redirect(new URL('/menu', request.url), 302);
}
