import type { ReactNode } from 'react';

/** Simple vertical bar chart (SVG, no dependencies). */
export function BarChart({
  data,
  height = 160,
  format = (v) => String(v),
}: {
  data: { label: string; value: number }[];
  height?: number;
  format?: (v: number) => string;
}) {
  const width = 640;
  const pad = { top: 10, right: 8, bottom: 22, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(...data.map((d) => d.value), 0);
  const niceMax = max > 0 ? max * 1.1 : 1;
  const step = data.length ? innerW / data.length : innerW;
  const barW = Math.max(2, step * 0.68);
  const ticks = [0, 0.5, 1];
  const labelEvery = Math.ceil(data.length / 8);

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Bar chart">
      {ticks.map((t) => {
        const y = pad.top + innerH * (1 - t);
        return (
          <g key={t}>
            <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y} y2={y} />
            <text x={pad.left - 6} y={y + 3} textAnchor="end">
              {format(niceMax * t)}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const h = (d.value / niceMax) * innerH;
        const x = pad.left + i * step + (step - barW) / 2;
        return (
          <g key={d.label}>
            <rect className="bar" x={x} y={pad.top + innerH - h} width={barW} height={Math.max(h, d.value > 0 ? 1 : 0)} rx={2}>
              <title>{`${d.label}: ${format(d.value)}`}</title>
            </rect>
            {i % labelEvery === 0 ? (
              <text x={x + barW / 2} y={height - 6} textAnchor="middle">
                {d.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Horizontal bars with labels, e.g. spend by model. */
export function HBarList({ items }: { items: { label: ReactNode; value: number; display: ReactNode }[] }) {
  const max = Math.max(...items.map((i) => i.value), 0) || 1;
  return (
    <div className="stack sm">
      {items.map((item, idx) => (
        <div className="hbar" key={idx}>
          <span className="ellipsis">{item.label}</span>
          <span className="right nowrap">{item.display}</span>
          <div className="track">
            <div className="fill" style={{ width: `${(item.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
