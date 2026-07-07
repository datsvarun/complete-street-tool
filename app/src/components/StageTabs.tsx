import { useCst } from '../store';
import type { Stage } from '../types';

const STAGES: Array<{ id: Stage; label: string; enabled: boolean }> = [
  { id: 'network', label: '1 · Network', enabled: true },
  { id: 'sections', label: '2 · Sections', enabled: true },
  { id: 'junctions', label: '2A · Junctions', enabled: true },
  { id: 'detailing', label: '3 · Detailing', enabled: true },
  { id: 'export', label: '4 · Export', enabled: true },
];

export function StageTabs() {
  const stage = useCst((s) => s.stage);
  const setStage = useCst((s) => s.setStage);
  return (
    <nav className="stage-tabs">
      {STAGES.map((s) => (
        <button
          key={s.id}
          className={stage === s.id ? 'tab active' : 'tab'}
          disabled={!s.enabled}
          title={s.enabled ? undefined : 'Coming in a later phase'}
          onClick={() => setStage(s.id)}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
}
