'use client';

// Weekly active customers (bars) with all orders (line) — 9 IST weeks, inline SVG,
// no chart library (spec §7.1). Drawn at the real rendered width (see chart.ts),
// so bars stay ≤ 24px and text stays readable on a phone.
//
// One y-axis for both series; a legend because there are two; a value label only
// on the line's newest point (the readout above carries every other number, on
// hover, focus or tap); the drop week is marked with a ▼ as well as a colour.
// The full numbers are always available as a table, for screen readers and for
// anyone who'd rather read than squint.

import { useRef, useState } from 'react';
import type { WeeklyPoint } from '@/lib/marketing/types';
import { describeWeek, weeklyChartModel } from './chart';
import { formatCount, formatIstDate } from './format';
import { useElementWidth } from './hooks';

// Brand colours as literals: these are SVG attributes, where a Tailwind class
// can't reach (tailwind.config.ts: tan #ad825e, charcoal #232325, muted #6b6560, line #e5e5e5).
const BAR = '#ad825e';
const BAR_DROP = '#b91c1c';
const LINE = '#232325';
const GRID = '#e5e5e5';
const MUTED = '#6b6560';
const HILITE = '#f6efe9';
const HEIGHT = 220;

export function WeeklyChart({ points, dropWeekStart }: { points: WeeklyPoint[]; dropWeekStart: string | null }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef, 320);
  const [active, setActive] = useState<number | null>(null);

  if (points.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No weekly numbers yet. They appear once customers have ordered.</p>;
  }

  const model = weeklyChartModel(points, width, HEIGHT);
  const current = active ?? points.length - 1;
  const cur = points[current];
  const last = model.line[model.line.length - 1];
  const isDrop = (p: WeeklyPoint) => dropWeekStart !== null && p.week_start === dropWeekStart;

  return (
    <div>
      <p className="mb-2 text-sm text-charcoal" aria-live="polite">
        <span className="font-semibold">{describeWeek(cur)}</span>
        {isDrop(cur) ? <span className="font-semibold text-red-700"> · ▼ a drop from the usual</span> : null}
      </p>

      <div ref={wrapRef} className="w-full">
        <svg className="block max-w-full" width={width} height={HEIGHT} role="img" aria-label={`Weekly customers and orders for the last ${points.length} weeks. ${describeWeek(points[points.length - 1])}. A table with every week is below the chart.`}>
          {model.ticks.map((t) => (
            <g key={t.value}>
              <line x1={model.padding.left} x2={model.width - model.padding.right + 6} y1={t.y} y2={t.y} stroke={GRID} strokeWidth={1} />
              <text x={model.padding.left - 6} y={t.y + 4} textAnchor="end" fontSize={11} fill={MUTED}>
                {t.value}
              </text>
            </g>
          ))}

          {model.bars.map((b) => (
            <g key={b.week_start}>
              {b.index === current ? <rect x={model.padding.left + model.slot * b.index} y={model.padding.top - 4} width={model.slot} height={model.baselineY - model.padding.top + 4} fill={HILITE} /> : null}
            </g>
          ))}

          {model.bars.map((b) => (
            <g key={`bar-${b.week_start}`}>
              {b.path ? <path d={b.path} fill={isDrop(points[b.index]) ? BAR_DROP : BAR} /> : null}
              {isDrop(points[b.index]) ? (
                <text x={b.cx} y={b.y - 6} textAnchor="middle" fontSize={11} fill={BAR_DROP} aria-hidden="true">
                  ▼
                </text>
              ) : null}
              {b.label ? (
                <text x={b.cx} y={model.baselineY + 16} textAnchor="middle" fontSize={11} fill={MUTED}>
                  {b.label}
                </text>
              ) : null}
            </g>
          ))}

          {model.linePath ? <path d={model.linePath} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
          {model.line.map((pt, i) => (
            <circle key={i} cx={pt.x} cy={pt.y} r={4} fill={LINE} stroke="#ffffff" strokeWidth={2} />
          ))}
          {last ? (
            <text x={last.x + 10} y={last.y + 4} fontSize={11} fontWeight={700} fill={LINE}>
              {formatCount(last.value)}
            </text>
          ) : null}

          {/* Hit targets: a full-height column per week, wider than any mark, reachable by touch, mouse and keyboard. */}
          {model.bars.map((b) => (
            <rect
              key={`hit-${b.week_start}`}
              x={model.padding.left + model.slot * b.index}
              y={0}
              width={model.slot}
              height={HEIGHT}
              fill="transparent"
              tabIndex={0}
              aria-label={describeWeek(points[b.index])}
              onMouseEnter={() => setActive(b.index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(b.index)}
              onBlur={() => setActive(null)}
              onClick={() => setActive(b.index)}
              style={{ outline: 'none' }}
            />
          ))}
        </svg>
      </div>

      <ul className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-xs text-charcoal">
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: BAR }} />
          Customers who ordered (people we can identify)
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-0.5 w-5" style={{ backgroundColor: LINE }} />
          All orders (walk-ins included)
        </li>
      </ul>

      <details className="mt-2 text-sm">
        <summary className="min-h-[44px] cursor-pointer py-2 font-semibold text-tan-dark">Show as a table</summary>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[280px] text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-muted">
                <th className="py-1 pr-3 font-semibold">Week starting</th>
                <th className="py-1 pr-3 text-right font-semibold">Customers</th>
                <th className="py-1 text-right font-semibold">Orders</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.week_start} className="border-t border-[#f2efe9]">
                  <td className="py-1 pr-3 text-charcoal">
                    {formatIstDate(p.week_start)}
                    {isDrop(p) ? <span className="font-semibold text-red-700"> ▼ drop</span> : null}
                  </td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums">{formatCount(p.customers)}</td>
                  <td className="py-1 text-right font-mono tabular-nums">{formatCount(p.orders)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
