/** Small isometric icons drawn for Divvy. Pure SVG, no assets. */
const defs = (id: string, a: string, b: string, c: string) => (
  <defs>
    <linearGradient id={`${id}-top`} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor={a} />
      <stop offset="1" stopColor={b} />
    </linearGradient>
    <linearGradient id={`${id}-side`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={b} />
      <stop offset="1" stopColor={c} />
    </linearGradient>
  </defs>
);

/** An isometric block: top face plus two sides. */
function Block({ id, x, y, w, h }: { id: string; x: number; y: number; w: number; h: number }) {
  const d = w / 2;
  return (
    <g>
      <path d={`M${x} ${y} l${w} ${d} l0 ${h} l${-w} ${-d} z`} fill={`url(#${id}-side)`} />
      <path d={`M${x + w} ${y + d} l${w} ${-d} l0 ${h} l${-w} ${d} z`} fill={`url(#${id}-side)`} opacity="0.72" />
      <path d={`M${x} ${y} l${w} ${-d} l${w} ${d} l${-w} ${d} z`} fill={`url(#${id}-top)`} />
    </g>
  );
}

export function IconShares() {
  return (
    <svg viewBox="0 0 64 64" className="icon3d" aria-hidden="true">
      {defs('s1', '#8FB4FF', '#3D7BFF', '#1B3FA8')}
      {defs('s2', '#FFD48A', '#FFB23F', '#B36A00')}
      {defs('s3', '#7FE3C4', '#16A37B', '#0A5C45')}
      <Block id="s3" x={34} y={30} w={11} h={10} />
      <Block id="s2" x={21} y={26} w={11} h={18} />
      <Block id="s1" x={8} y={20} w={11} h={26} />
    </svg>
  );
}

export function IconSign() {
  return (
    <svg viewBox="0 0 64 64" className="icon3d" aria-hidden="true">
      {defs('g1', '#B9A2FF', '#8A63F2', '#4A2CA8')}
      <ellipse cx="32" cy="40" rx="20" ry="10" fill="url(#g1-side)" />
      <rect x="12" y="32" width="40" height="8" fill="url(#g1-side)" />
      <ellipse cx="32" cy="32" rx="20" ry="10" fill="url(#g1-top)" />
      <path d="M23 32 l6 4 l12 -8" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconPay() {
  return (
    <svg viewBox="0 0 64 64" className="icon3d" aria-hidden="true">
      {defs('p1', '#FFD48A', '#FFB23F', '#B36A00')}
      {defs('p2', '#8FB4FF', '#3D7BFF', '#1B3FA8')}
      <g>
        <ellipse cx="22" cy="44" rx="13" ry="6.5" fill="url(#p2-side)" />
        <rect x="9" y="39" width="26" height="5" fill="url(#p2-side)" />
        <ellipse cx="22" cy="39" rx="13" ry="6.5" fill="url(#p2-top)" />
      </g>
      <g>
        <ellipse cx="42" cy="44" rx="13" ry="6.5" fill="url(#p1-side)" />
        <rect x="29" y="39" width="26" height="5" fill="url(#p1-side)" />
        <ellipse cx="42" cy="39" rx="13" ry="6.5" fill="url(#p1-top)" />
      </g>
      <path d="M34 8 l-9 15 h7 l-3 12 l11 -17 h-7 z" fill="#fff" stroke="#0B1020" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
