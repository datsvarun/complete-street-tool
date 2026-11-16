// CAD-style ribbon: a title bar with quick-access actions, a row of tabs, and
// one band of labelled tool groups per tab. Every command lives here — there
// is no side panel. A tab selects its design stage; long lists open as
// flyouts under their button.
import { useEffect, useRef, useState } from 'react';
import { useCst } from '../store';
import { downloadDocument } from '../persistence';
import type { Stage } from '../types';
import { GeocodeSearch } from './GeocodeSearch';
import {
  DetailTab,
  DrawTab,
  EditTab,
  ExportTab,
  JunctionTab,
  MeshTab,
  NetworkTab,
  StreetTab,
  ViewTab,
} from './RibbonTabs';

// ── Shell ────────────────────────────────────────────────────────────────

type TabId = Stage | 'draw' | 'view';

const TABS: Array<{ id: TabId; label: string; stage: Stage | null; hint: string }> = [
  { id: 'network', label: 'Network', stage: 'network', hint: 'Import, clean and check the street network (1)' },
  { id: 'draw', label: 'Draw', stage: 'network', hint: 'Draw and modify street centerlines' },
  { id: 'sections', label: 'Street', stage: 'sections', hint: 'Assign cross-sections (2)' },
  { id: 'junctions', label: 'Junction', stage: 'junctions', hint: 'Corners, trims and junction type (3)' },
  { id: 'mesh', label: 'Mesh', stage: 'mesh', hint: 'Node-mesh editing — reshape everything (4)' },
  { id: 'detailing', label: 'Detail', stage: 'detailing', hint: 'Furniture, markings, crossings (5)' },
  { id: 'edit', label: 'Edit', stage: 'edit', hint: 'Free-form shape patches and cuts (6)' },
  { id: 'export', label: 'Export', stage: 'export', hint: 'Print or download the plan (7)' },
  { id: 'view', label: 'View', stage: null, hint: 'Basemap, layers and display settings' },
];

interface RibbonProps {
  open: boolean;
  onToggle: (open: boolean) => void;
  onOpen3d: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}

export function Ribbon({ open, onToggle, onOpen3d, onOpenSettings, onOpenHelp }: RibbonProps) {
  const stage = useCst((s) => s.stage);
  const setStage = useCst((s) => s.setStage);
  const [tab, setTab] = useState<TabId>('network');
  const fileRef = useRef<HTMLInputElement>(null);

  // Stage changes from elsewhere (number keys) pull the ribbon along; the
  // View tab is stage-neutral and stays put.
  useEffect(() => {
    setTab((t) => {
      const cur = TABS.find((x) => x.id === t)!;
      return cur.stage === null || cur.stage === stage ? t : stage;
    });
  }, [stage]);

  const openFile = async (file: File) => {
    try {
      useCst.getState().loadDocument(JSON.parse(await file.text()), file.name);
    } catch {
      useCst.setState({ statusMsg: `Open failed: ${file.name} is not valid JSON` });
    }
  };

  return (
    <div className="ribbon">
      <div className="rb-titlebar">
        <span className="brand">
          CST <span className="muted">· IRC Street Designer</span>
        </span>
        <div className="rb-qat">
          <button
            title="New — clear everything and start a new design"
            onClick={() => {
              if (window.confirm('Start a new design? The current design will be discarded.')) {
                useCst.getState().clearAll();
              }
            }}
          >
            New
          </button>
          <button title="Open a saved .cst.json design" onClick={() => fileRef.current?.click()}>
            Open
          </button>
          <button title="Save the design as a .cst.json file" onClick={() => downloadDocument(useCst.getState())}>
            Save
          </button>
          <button title="Undo (Ctrl+Z)" onClick={() => useCst.getState().undo()}>
            ↩
          </button>
          <button title="Redo (Ctrl+Shift+Z)" onClick={() => useCst.getState().redo()}>
            ↪
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) openFile(f);
              e.target.value = '';
            }}
          />
        </div>
        <GeocodeSearch />
        <div className="rb-qat rb-right">
          <button title="Preview the design in 3D" onClick={onOpen3d}>
            3D
          </button>
          <button title="Settings — theme, traffic side, junction blending" onClick={onOpenSettings}>
            ⚙
          </button>
          <button title="Keyboard shortcuts (?)" onClick={onOpenHelp}>
            ?
          </button>
        </div>
      </div>

      <div className="rb-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'rb-tab active' : 'rb-tab'}
            title={t.hint}
            onClick={() => {
              if (tab === t.id) {
                onToggle(!open);
                return;
              }
              setTab(t.id);
              if (t.stage && t.stage !== stage) setStage(t.stage);
              onToggle(true);
            }}
          >
            {t.label}
          </button>
        ))}
        <button
          className="rb-collapse"
          title={open ? 'Collapse the ribbon (P)' : 'Expand the ribbon (P)'}
          onClick={() => onToggle(!open)}
        >
          {open ? '▴' : '▾'}
        </button>
      </div>

      {open && (
        <div className="rb-band">
          {tab === 'network' && <NetworkTab />}
          {tab === 'draw' && <DrawTab />}
          {tab === 'sections' && <StreetTab />}
          {tab === 'junctions' && <JunctionTab />}
          {tab === 'mesh' && <MeshTab />}
          {tab === 'detailing' && <DetailTab />}
          {tab === 'edit' && <EditTab />}
          {tab === 'export' && <ExportTab />}
          {tab === 'view' && <ViewTab onOpen3d={onOpen3d} onOpenSettings={onOpenSettings} onOpenHelp={onOpenHelp} />}
        </div>
      )}
    </div>
  );
}
