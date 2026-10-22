import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The POS's request budget lives in startRefreshLoop: how often each screen
// asks the server while realtime is live, dead, or can't be trusted, and what a
// hidden tab or a return to it costs. Driven here with fake timers, a fake
// document/window and a fake Supabase channel.

const state: { session: unknown; realtime: boolean } = { session: { user: { id: 'u1' } }, realtime: true };

type StatusCb = (status: string) => void;
const channels: { name: string; event?: () => void; status?: StatusCb; unsubscribed: boolean }[] = [];

vi.mock('@/lib/flags', () => ({
  flags: {
    get realtime() {
      return state.realtime;
    },
  },
}));

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    auth: { getSession: () => Promise.resolve({ data: { session: state.session } }) },
    channel: (name: string) => {
      const ch = {
        name,
        unsubscribed: false,
        event: undefined as undefined | (() => void),
        status: undefined as undefined | StatusCb,
        on(_type: string, _filter: unknown, cb: () => void) {
          ch.event = cb;
          return ch;
        },
        subscribe(cb: StatusCb) {
          ch.status = cb;
          return ch;
        },
        unsubscribe() {
          ch.unsubscribed = true;
        },
      };
      channels.push(ch);
      return ch;
    },
  }),
}));

const {
  startRefreshLoop,
  backstopDelay,
  FALLBACK_POLL_MS,
  LIVE_POLL_MS,
  ORDERS_COALESCE_MS,
  REFOCUS_MIN_GAP_MS,
} = await import('@/lib/realtime/hooks');

class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
}
let doc: FakeDocument;
let win: EventTarget;

beforeEach(() => {
  vi.useFakeTimers();
  doc = new FakeDocument();
  win = new EventTarget();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  state.session = { user: { id: 'u1' } };
  state.realtime = true;
  channels.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function start(opts: Partial<Parameters<typeof startRefreshLoop>[0]> = {}) {
  const onChange = vi.fn();
  const setConnection = vi.fn();
  const stop = startRefreshLoop(
    {
      pollMs: FALLBACK_POLL_MS,
      livePollMs: LIVE_POLL_MS,
      requiresSession: true,
      whileHidden: 'pause',
      coalesceMs: ORDERS_COALESCE_MS,
      channelName: 'test',
      build: (channel, fire) => (channel as unknown as { on: (...a: unknown[]) => typeof channel }).on('x', {}, fire),
      ...opts,
    },
    { current: onChange },
    setConnection,
  );
  return { onChange, setConnection, stop, channel: channels[channels.length - 1] };
}

/** Let getSession() resolve. */
const settle = () => vi.advanceTimersByTimeAsync(0);

const hide = () => {
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
};
const show = () => {
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('focus'));
};

describe('backstopDelay', () => {
  const base = { pollMs: 15_000, livePollMs: 120_000 };
  it('slows to the safety net only while realtime is trusted', () => {
    expect(backstopDelay({ ...base, trusted: true, hidden: false, whileHidden: 'pause' })).toBe(120_000);
    expect(backstopDelay({ ...base, trusted: false, hidden: false, whileHidden: 'pause' })).toBe(15_000);
  });
  it('stops a paused loop while hidden, keeps a running one going', () => {
    expect(backstopDelay({ ...base, trusted: true, hidden: true, whileHidden: 'pause' })).toBeNull();
    expect(backstopDelay({ ...base, trusted: false, hidden: true, whileHidden: 'pause' })).toBeNull();
    expect(backstopDelay({ ...base, trusted: false, hidden: true, whileHidden: 'run' })).toBe(15_000);
    expect(backstopDelay({ ...base, trusted: true, hidden: true, whileHidden: 'run' })).toBe(120_000);
  });
});

describe('startRefreshLoop', () => {
  it('polls every 15 s until the channel is live, then every 2 minutes', async () => {
    const { onChange, channel, stop } = start();
    await settle();
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    expect(onChange).toHaveBeenCalledTimes(1);

    channel.status!('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // an idle hour
    // 30 polls an hour, down from 240.
    expect(onChange).toHaveBeenCalledTimes(1 + 30);
    stop();
  });

  it('keeps the 15 s poll on a counter with no Supabase session (RLS sends it no events)', async () => {
    state.session = null;
    const { onChange, channel, stop } = start();
    await settle();
    channel.status!('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(onChange).toHaveBeenCalledTimes(240);
    stop();
  });

  it('trusts a public table without a session', async () => {
    state.session = null;
    const { onChange, channel, stop } = start({ requiresSession: false, livePollMs: 300_000 });
    channel.status!('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(onChange).toHaveBeenCalledTimes(12);
    stop();
  });

  it('goes back to the fast poll when the socket drops, and catches up on reconnect', async () => {
    const { onChange, channel, stop } = start();
    await settle();
    channel.status!('SUBSCRIBED');
    channel.status!('CHANNEL_ERROR');
    await vi.advanceTimersByTimeAsync(FALLBACK_POLL_MS);
    expect(onChange).toHaveBeenCalledTimes(1);

    channel.status!('SUBSCRIBED'); // a re-subscribe: events may have been missed
    await vi.advanceTimersByTimeAsync(ORDERS_COALESCE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not refetch on the first subscribe — the screen has just fetched', async () => {
    const { onChange, channel, stop } = start();
    await settle();
    channel.status!('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(ORDERS_COALESCE_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });

  it("coalesces one order's insert and updates into a single refetch", async () => {
    const { onChange, channel, stop } = start();
    await settle();
    channel.status!('SUBSCRIBED');
    channel.event!();
    await vi.advanceTimersByTimeAsync(300);
    channel.event!();
    await vi.advanceTimersByTimeAsync(400);
    channel.event!();
    await vi.advanceTimersByTimeAsync(ORDERS_COALESCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('rests while hidden and refetches once on return', async () => {
    const { onChange, channel, stop } = start();
    await settle();
    channel.status!('SUBSCRIBED');
    hide();
    channel.event!(); // dropped while hidden...
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(onChange).not.toHaveBeenCalled();

    show(); // ...and covered by the one refetch on return (visibility + focus together)
    await vi.advanceTimersByTimeAsync(ORDERS_COALESCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('refetches on return even inside the minimum gap if something was missed', async () => {
    const { onChange, channel, stop } = start();
    await settle();
    channel.status!('SUBSCRIBED');
    hide();
    channel.event!();
    show(); // well inside REFOCUS_MIN_GAP_MS of the mount fetch
    await vi.advanceTimersByTimeAsync(ORDERS_COALESCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('skips a focus refetch right after the last fetch', async () => {
    const { onChange, channel, stop } = start();
    await settle();
    channel.status!('SUBSCRIBED');
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(ORDERS_COALESCE_MS);
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(REFOCUS_MIN_GAP_MS);
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(ORDERS_COALESCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("'run' keeps the alarm working in a background tab", async () => {
    const { onChange, channel, stop } = start({ whileHidden: 'run' });
    await settle();
    channel.status!('SUBSCRIBED');
    hide();
    channel.event!();
    await vi.advanceTimersByTimeAsync(ORDERS_COALESCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('polls only, at the fast rate, when realtime is switched off', async () => {
    state.realtime = false;
    const { onChange, setConnection, stop } = start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(setConnection).toHaveBeenCalledWith('reconnecting');
    expect(channels).toHaveLength(0);
    stop();
  });

  it('stops everything on cleanup', async () => {
    const { onChange, channel, stop } = start();
    await settle();
    stop();
    expect(channel.unsubscribed).toBe(true);
    channel.event!();
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
