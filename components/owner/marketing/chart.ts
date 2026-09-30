// Geometry for the Overview's weekly chart: 9 bars (identified customers per
// week) with a line over them (all orders). Pure, so the maths — nice axis
// ticks, bar sizes, the rounded-top path, which x labels fit — is unit-tested
// (tests/marketingDashboardFormat.test.ts) and the component only draws.
//
// Both series count things the owner thinks of as "people or orders per week",
// so they share ONE y-axis (no dual axis: two scales on one chart make a line
// crossing a bar mean nothing). Orders can only be >= customers (every customer
// order is an order; walk-ins add more), so the line sits above the bars.

import { formatIstDate } from './format';
import type { WeeklyPoint } from '@/lib/marketing/types';

/** Bars are capped at this thickness however wide the chart is; the rest of the slot is air. */
export const MAX_BAR_PX = 24;
/** Rounded data-end; the baseline end stays square. */
export const BAR_RADIUS_PX = 4;

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BarGeometry {
  index: number;
  week_start: string;
  /** Left edge / top edge / size of the bar. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Centre x of the slot — where the line's point sits and the hit target is centred. */
  cx: number;
  customers: number;
  orders: number;
  /** SVG path with a 4px rounded top and a square base; '' for a zero-height bar. */
  path: string;
  /** The label under the axis, or '' when this slot's label is skipped for lack of room. */
  label: string;
}

export interface LinePoint {
  x: number;
  y: number;
  value: number;
}

export interface WeeklyChartModel {
  width: number;
  height: number;
  padding: Padding;
  /** Top of the y-axis (a "nice" number ≥ the largest value). */
  yMax: number;
  ticks: { value: number; y: number }[];
  baselineY: number;
  slot: number;
  bars: BarGeometry[];
  line: LinePoint[];
  /** "M x,y L x,y …" through every order point; '' with fewer than 2 points. */
  linePath: string;
}

/** The smallest "nice" axis maximum ≥ `max` and 4 or fewer round ticks up to it (0, 5, 10, 15, 20). */
export function niceAxis(max: number): { max: number; ticks: number[] } {
  const safe = Number.isFinite(max) && max > 0 ? max : 1;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  let step = steps.find((s) => Math.ceil(safe / s) <= 4);
  if (step === undefined) step = Math.pow(10, Math.ceil(Math.log10(safe / 4)));
  const top = Math.ceil(safe / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { max: top, ticks };
}

/** A column with rounded top corners and a square base: the mark spec for bars. */
export function barPath(x: number, y: number, w: number, h: number, radius: number = BAR_RADIUS_PX): string {
  if (!(h > 0) || !(w > 0)) return '';
  const r = Math.min(radius, h, w / 2);
  const bottom = y + h;
  return [
    `M${x},${bottom}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${x + w - r},${y}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `L${x + w},${bottom}`,
    'Z',
  ].join(' ');
}

/**
 * Lays the chart out for a given pixel size. `width` is the real rendered width
 * (the component measures it), so text and bars are drawn 1:1 instead of being
 * scaled by a viewBox — a scaled chart would blow bars past their 24px cap on a
 * desktop and shrink the labels to nothing on a phone.
 */
export function weeklyChartModel(
  points: readonly WeeklyPoint[],
  width: number,
  height: number,
  padding: Padding = { top: 12, right: 34, bottom: 26, left: 32 },
): WeeklyChartModel {
  const n = points.length;
  const plotW = Math.max(1, width - padding.left - padding.right);
  const plotH = Math.max(1, height - padding.top - padding.bottom);
  const dataMax = points.reduce((m, p) => Math.max(m, p.customers, p.orders), 0);
  const axis = niceAxis(dataMax);
  const baselineY = padding.top + plotH;
  const yOf = (v: number) => baselineY - (v / axis.max) * plotH;

  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.min(MAX_BAR_PX, Math.max(4, slot * 0.6));
  // Labels are ~36px wide ("22 Sep"); when slots are narrower, label every second
  // week counting back from the newest so the latest week is always named.
  const labelEvery = slot < 44 ? 2 : 1;

  const bars: BarGeometry[] = points.map((p, i) => {
    const cx = padding.left + slot * i + slot / 2;
    const y = yOf(p.customers);
    const h = baselineY - y;
    const showLabel = (n - 1 - i) % labelEvery === 0;
    return {
      index: i,
      week_start: p.week_start,
      x: cx - barW / 2,
      y,
      w: barW,
      h,
      cx,
      customers: p.customers,
      orders: p.orders,
      path: barPath(cx - barW / 2, y, barW, h),
      label: showLabel ? formatIstDate(p.week_start) : '',
    };
  });

  const line: LinePoint[] = points.map((p, i) => ({ x: bars[i].cx, y: yOf(p.orders), value: p.orders }));
  const linePath = line.length >= 2 ? line.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x},${pt.y}`).join(' ') : '';

  return {
    width,
    height,
    padding,
    yMax: axis.max,
    ticks: axis.ticks.map((value) => ({ value, y: yOf(value) })),
    baselineY,
    slot,
    bars,
    line,
    linePath,
  };
}

/** The one-line summary read by screen readers and shown as the default readout. */
export function describeWeek(p: WeeklyPoint): string {
  return `Week of ${formatIstDate(p.week_start)}: ${p.customers} customer${p.customers === 1 ? '' : 's'}, ${p.orders} order${p.orders === 1 ? '' : 's'}`;
}
