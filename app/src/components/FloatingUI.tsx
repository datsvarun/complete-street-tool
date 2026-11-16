// Floating map chrome that stays on the canvas: reactive scale bar, compass.
import { useCst } from '../store';

/** Round scale-bar length: 1/2/5 × 10^k metres targeting ~90 px. */
function niceBar(scale: number): { m: number; px: number } {
  const target = 90 / scale; // metres
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(target, 0.1))));
  const n = target / pow;
  const step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  const m = step * pow;
  return { m, px: m * scale };
}

export function ScaleBar({ scale }: { scale: number }) {
  const { m, px } = niceBar(scale);
  const label = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  return (
    <div className="scale-bar" title={`${scale.toFixed(1)} px/m`}>
      <div className="scale-line" style={{ width: `${px}px` }} />
      <span>{label}</span>
    </div>
  );
}

export function CompassRose() {
  const fitAll = useCst((s) => s.fitAll);
  return (
    <button
      className="compass overlay"
      title="North-up view · click to fit the whole network (F)"
      onClick={fitAll}
    >
      <svg viewBox="0 0 40 40" width="40" height="40">
        <circle cx="20" cy="20" r="18" fill="rgba(255,255,255,0.94)" stroke="#c9c3b4" strokeWidth="1" />
        <text x="20" y="11.5" textAnchor="middle" fontSize="6.5" fontWeight="700" fill="#212a33">
          N
        </text>
        <polygon points="20,13.5 23.4,25 20,22.6 16.6,25" fill="#d97a2e" />
        <polygon points="20,31.5 23.4,25 20,27.4 16.6,25" fill="#98a2ad" />
        <circle cx="20" cy="24.2" r="1.1" fill="#212a33" />
      </svg>
    </button>
  );
}
