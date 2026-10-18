import { useMemo } from 'react';
import { TILE_URL } from '../config';
import { pinColor } from '../theme';
import type { BoreholeStatus } from '../domain/types';
import { MAP_H, MAP_W, mapExtract, type ExtractInput } from './mapExtract';

interface Props {
  input: ExtractInput;
  label: string;
  /** "© OpenStreetMap contributors" (plain text). */
  attribution: string;
  /** Shown instead of the map when no borehole of the selection has a position. */
  emptyText: string;
}

const INK = '#1A1A1A';

/** The static map extract of the selection (see mapExtract.ts). */
export function ReportMap({ input, label, attribution, emptyText }: Props) {
  const m = useMemo(() => mapExtract(input, TILE_URL), [input]);
  if (!m) return <p data-testid="report-map-empty">{emptyText}</p>;
  return (
    <svg width={MAP_W} height={MAP_H} viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label={label} data-testid="report-map">
      <defs>
        <clipPath id="report-map-clip">
          <rect width={MAP_W} height={MAP_H} />
        </clipPath>
      </defs>
      <g clipPath="url(#report-map-clip)">
        <rect width={MAP_W} height={MAP_H} fill="#EEF0EE" />
        <g style={{ filter: 'grayscale(1)' }} opacity={0.75}>
          {m.tiles.map((t) => (
            <image key={`${t.x},${t.y}`} href={t.href} x={t.x} y={t.y} width={256} height={256} preserveAspectRatio="none" />
          ))}
        </g>
        {m.band && <path d={m.band} fill="#1A1A1A" fillOpacity={0.08} stroke={INK} strokeOpacity={0.35} strokeWidth={0.8} fillRule="evenodd" />}
        {m.area?.kind === 'path' && <path d={m.area.d} fill="#1A1A1A" fillOpacity={0.06} stroke={INK} strokeWidth={1.4} strokeDasharray="5 3" fillRule="evenodd" />}
        {m.area?.kind === 'circle' && <circle cx={m.area.cx} cy={m.area.cy} r={m.area.r} fill="#1A1A1A" fillOpacity={0.06} stroke={INK} strokeWidth={1.4} strokeDasharray="5 3" />}
        {m.line && <path d={m.line} fill="none" stroke={INK} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />}
        {m.points.map((p) =>
          p.ax !== p.x || p.ay !== p.y ? (
            <g key={`lead-${p.no}`}>
              <line x1={p.ax} y1={p.ay} x2={p.x} y2={p.y} stroke={INK} strokeWidth={0.8} />
              <circle cx={p.ax} cy={p.ay} r={2} fill={INK} />
            </g>
          ) : null,
        )}
        {m.points.map((p) =>
          m.numbered ? (
            <g key={p.no}>
              <circle cx={p.x} cy={p.y} r={7.5} fill={pinColor(p.status as BoreholeStatus)} stroke="#FFFFFF" strokeWidth={1.5} />
              <text x={p.x} y={p.y + 3.2} fontSize={8.5} fontWeight={700} textAnchor="middle" fill="#FFFFFF">
                {p.no}
              </text>
            </g>
          ) : (
            <circle key={p.no} cx={p.x} cy={p.y} r={3.6} fill={pinColor(p.status as BoreholeStatus)} stroke="#FFFFFF" strokeWidth={1} />
          ),
        )}
      </g>
      {/* Scale bar and attribution. */}
      <g>
        <rect x={10} y={MAP_H - 24} width={m.scale.px + 16} height={16} fill="#FFFFFF" fillOpacity={0.85} />
        <path d={`M18 ${MAP_H - 14}v4h${m.scale.px}v-4`} fill="none" stroke={INK} strokeWidth={1.2} />
        <text x={18 + m.scale.px / 2} y={MAP_H - 15.5} fontSize={8.5} textAnchor="middle" fill={INK}>
          {m.scale.label}
        </text>
        <text x={MAP_W - 6} y={MAP_H - 6} fontSize={8} textAnchor="end" fill={INK} stroke="#FFFFFF" strokeWidth={2.4} paintOrder="stroke">
          {attribution}
        </text>
      </g>
    </svg>
  );
}
