// Simple, accessible single-series charts (SVG bars + horizontal bar lists).
import { useState } from 'react';

const BAR = '#0E9384'; // validated: lightness, chroma and 3:1 contrast on white

/** Vertical bar chart. data: [{ label, value, tip }] */
export function BarChart({ data, height = 220, labelEvery = 1, title, valueLabel = 'calls' }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const nice = Math.ceil(max / 4) * 4 || 4;
  const W = 720; const H = height; const padL = 32; const padB = 26; const padT = 12;
  const plotW = W - padL - 8; const plotH = H - padB - padT;
  const step = plotW / data.length;
  const barW = Math.max(2, step - 2); // 2px gap between bars
  const y = (v) => padT + plotH - (v / nice) * plotH;
  const ticks = [0, nice / 4, nice / 2, (3 * nice) / 4, nice];

  return (
    <figure className="chart">
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="chart-svg">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} stroke="#E6EDEB" strokeWidth="1" />
              <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="chart-axis">{t}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = padL + i * step + 1;
            const h = Math.max(0, y(0) - y(d.value));
            const r = Math.min(4, barW / 2, h);
            return (
              <g key={d.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0}
                aria-label={`${d.tip || d.label}: ${d.value} ${valueLabel}`}>
                {/* generous hit target */}
                <rect x={x - 1} y={padT} width={step} height={plotH} fill="transparent" />
                {h > 0 && (
                  <path d={`M${x},${y(0)} V${y(d.value) + r} Q${x},${y(d.value)} ${x + r},${y(d.value)} H${x + barW - r} Q${x + barW},${y(d.value)} ${x + barW},${y(d.value) + r} V${y(0)} Z`}
                    fill={BAR} opacity={hover === null || hover === i ? 1 : 0.55} />
                )}
                {i % labelEvery === 0 && (
                  <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="chart-axis">{d.label}</text>
                )}
              </g>
            );
          })}
          <line x1={padL} x2={W - 8} y1={y(0)} y2={y(0)} stroke="#B8C9C4" strokeWidth="1" />
        </svg>
        {hover !== null && (
          <div className="chart-tip" style={{ left: `${((padL + hover * step + step / 2) / W) * 100}%` }}>
            <strong>{data[hover].value}</strong> {valueLabel}<br /><span>{data[hover].tip || data[hover].label}</span>
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>Show as table</summary>
        <table className="table"><thead><tr><th>{title}</th><th>Value</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.label}><td>{d.tip || d.label}</td><td>{d.value}</td></tr>)}</tbody></table>
      </details>
    </figure>
  );
}

/** Horizontal bars with direct labels. items: [{ label, value }] */
export function BarList({ items, empty = 'No data yet.' }) {
  if (!items.length) return <p className="muted">{empty}</p>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="barlist">
      {items.map((i) => (
        <li key={i.label}>
          <div className="barlist-row"><span>{i.label}</span><strong>{i.value}</strong></div>
          <div className="barlist-track"><div className="barlist-fill" style={{ width: `${(i.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}
