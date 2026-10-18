import type { Ref } from 'react';
import { COL_W, type CombinedChart } from './combinedChart';

interface Props {
  chart: CombinedChart;
  /** Accessible name of the drawing. */
  label: string;
  /** The vertical axis title, translated. */
  axisTitle: string;
  ref?: Ref<SVGSVGElement>;
}

const INK = '#1A1A1A';
const MUTED = '#6B6B6B';
const WATER = '#1F6FD1';

/**
 * The combined soil chart: the selection's DIN 4023 profiles side by side on one axis (see
 * combinedChart.ts). Patterns come from the app's DinPatternDefs (url(#din-…)), so the chart export
 * inlines them. Each column's ID heads it; a planned line adds its chainage axis with leaders.
 */
export function CombinedProfiles({ chart, label, axisTitle, ref }: Props) {
  const { width, height, drawTop, drawBottom, left } = chart;
  return (
    <svg ref={ref} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} data-testid="combined-chart">
      <rect x={0} y={0} width={width} height={height} fill="#FFFFFF" />
      {/* Axis and its grid. */}
      <line x1={left} y1={drawTop} x2={left} y2={drawBottom} stroke={INK} strokeWidth={1} />
      {chart.ticks.map((t) => (
        <g key={`${t.y}`}>
          <line x1={left} y1={t.y} x2={width - 10} y2={t.y} stroke="#E4E4E4" strokeWidth={0.6} />
          <line x1={left - 4} y1={t.y} x2={left} y2={t.y} stroke={INK} strokeWidth={1} />
          <text x={left - 7} y={t.y + 3.5} fontSize={10} textAnchor="end" fill={INK}>
            {t.label}
          </text>
        </g>
      ))}
      <text x={14} y={(drawTop + drawBottom) / 2} fontSize={10.5} fill={INK} textAnchor="middle" transform={`rotate(-90 14 ${(drawTop + drawBottom) / 2})`}>
        {axisTitle}
      </text>

      {chart.columns.map((c) => (
        <g key={c.uid} data-uid={c.uid}>
          <text x={c.cx + 3.5} y={drawTop - 10} fontSize={10} fill={INK} transform={`rotate(-60 ${c.cx + 3.5} ${drawTop - 10})`}>
            {c.id}
          </text>
          {c.layers.map((l) => (
            <g key={l.n}>
              {l.underlay && <rect x={c.x} y={l.y0} width={COL_W} height={l.y1 - l.y0} fill="#FFFFFF" />}
              <rect x={c.x} y={l.y0} width={COL_W} height={l.y1 - l.y0} fill={l.fill} stroke={INK} strokeWidth={0.5} />
              {l.label && (
                <text x={c.cx} y={(l.y0 + l.y1) / 2 + 3.5} fontSize={9} textAnchor="middle" fill={INK} stroke="#FFFFFF" strokeWidth={2.4} paintOrder="stroke">
                  {l.label}
                </text>
              )}
            </g>
          ))}
          {c.notLogged && (
            <rect x={c.x} y={c.notLogged.y0} width={COL_W} height={c.notLogged.y1 - c.notLogged.y0} fill="none" stroke={MUTED} strokeWidth={0.8} strokeDasharray="3 2" />
          )}
          {!c.layers.length && !c.notLogged && (
            <text x={c.cx} y={c.groundY + 12} fontSize={9} textAnchor="middle" fill={MUTED}>
              –
            </text>
          )}
          {/* Ground: a short bar over the column. */}
          <line x1={c.x - 3} y1={c.groundY} x2={c.x + COL_W + 3} y2={c.groundY} stroke={INK} strokeWidth={1.6} />
          {c.groundwaterY != null && (
            <path d={`M${c.x + COL_W + 2} ${c.groundwaterY - 6}h9l-4.5 6z`} fill={WATER} />
          )}
          {chart.chainageAxis && c.anchorX != null && (
            <path
              d={`M${c.anchorX} ${chart.chainageAxis.y}L${c.cx} ${drawBottom + 8}L${c.cx} ${Math.max(c.bottomY, c.groundY) + 2}`}
              fill="none"
              stroke={MUTED}
              strokeWidth={0.6}
              strokeDasharray="2 2"
            />
          )}
        </g>
      ))}

      {chart.chainageAxis && (
        <g>
          <line x1={chart.chainageAxis.x0} y1={chart.chainageAxis.y} x2={chart.chainageAxis.x1} y2={chart.chainageAxis.y} stroke={INK} strokeWidth={1.2} />
          {chart.chainageAxis.ticks.map((t) => (
            <g key={t.x}>
              <line x1={t.x} y1={chart.chainageAxis!.y} x2={t.x} y2={chart.chainageAxis!.y + 5} stroke={INK} strokeWidth={1} />
              <text x={t.x} y={chart.chainageAxis!.y + 16} fontSize={9.5} textAnchor="middle" fill={INK}>
                {t.label}
              </text>
            </g>
          ))}
          {chart.columns.map((c) =>
            c.anchorX != null ? <circle key={c.uid} cx={c.anchorX} cy={chart.chainageAxis!.y} r={2.4} fill={INK} /> : null,
          )}
        </g>
      )}
    </svg>
  );
}
