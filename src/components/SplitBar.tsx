import { MEMBER_COLORS, TREASURY_COLOR } from '../lib/split';

interface Segment {
  label: string;
  bps: number;
  color: string;
  treasury?: boolean;
}

export function segmentsOf(members: { name: string; bps: number }[], treasuryBps?: number): Segment[] {
  const list: Segment[] = members.map((m, i) => ({
    label: m.name || `Teammate ${i + 1}`,
    bps: Math.max(0, m.bps || 0),
    color: MEMBER_COLORS[i % MEMBER_COLORS.length],
  }));
  if (treasuryBps && treasuryBps > 0) list.push({ label: 'Treasury', bps: treasuryBps, color: TREASURY_COLOR, treasury: true });
  return list;
}

/** The split itself, drawn to scale. Pulls apart when a payment lands. */
export function SplitBar({ segments, paid = false }: { segments: Segment[]; paid?: boolean }) {
  const total = segments.reduce((sum, s) => sum + s.bps, 0);
  const unassigned = Math.max(0, 10_000 - total);
  const summary = segments.map((s) => `${s.label} ${(s.bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`).join(', ');
  return (
    <div className={`bar${paid ? ' is-paid' : ''}`} role="img" aria-label={`Shares: ${summary || 'none yet'}`}>
      {segments
        .filter((s) => s.bps > 0)
        .map((s, i) => (
          <span
            key={i}
            className={`bar-seg${s.treasury ? ' is-treasury' : ''}`}
            style={{ flexGrow: s.bps, background: s.color }}
          >
            {s.bps >= 900 && <b>{(s.bps / 100).toFixed(2).replace(/\.?0+$/, '')}%</b>}
          </span>
        ))}
      {unassigned > 0 && <span className="bar-seg is-empty" style={{ flexGrow: unassigned }} />}
    </div>
  );
}
