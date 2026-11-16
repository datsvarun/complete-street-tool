// Ribbon building blocks: labelled groups, big/small buttons, compact stacks
// and flyouts (popovers for lists, galleries and forms).
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export function RGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rb-group">
      <div className="rb-group-body">{children}</div>
      <div className="rb-group-title">{title}</div>
    </div>
  );
}

/** Column of compact rows (small buttons, checkboxes, fields). */
export function RStack({ children }: { children: ReactNode }) {
  return <div className="rb-stack">{children}</div>;
}

interface RBtnProps {
  icon?: ReactNode;
  label: ReactNode;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  small?: boolean;
  danger?: boolean;
  onClick?: () => void;
}

export function RBtn({ icon, label, title, active, disabled, small, danger, onClick }: RBtnProps) {
  const cls = ['rb-btn', small && 'small', active && 'active', danger && 'danger'].filter(Boolean).join(' ');
  return (
    <button className={cls} title={title} disabled={disabled} onClick={onClick}>
      {icon !== undefined && <span className="rb-icon">{icon}</span>}
      <span className="rb-label">{label}</span>
    </button>
  );
}

/** A ribbon button that opens a popover below it (lists, galleries, forms).
 *  Positioned fixed so the scrolling ribbon band cannot clip it. */
export function RFlyout({
  icon,
  label,
  title,
  badge,
  wide,
  small,
  disabled,
  children,
}: {
  icon?: ReactNode;
  label: ReactNode;
  title?: string;
  badge?: number;
  wide?: boolean;
  small?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const width = wide ? 420 : 300;

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPos(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [pos]);

  const toggle = () => {
    if (pos || !btn.current) {
      setPos(null);
      return;
    }
    const r = btn.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 4 });
  };

  const cls = ['rb-btn', small && 'small', pos && 'active'].filter(Boolean).join(' ');
  return (
    <>
      <button ref={btn} className={cls} title={title} disabled={disabled} onClick={toggle}>
        {icon !== undefined && <span className="rb-icon">{icon}</span>}
        <span className="rb-label">
          {label}
          {badge ? <span className="rb-badge">{badge}</span> : null} ▾
        </span>
      </button>
      {pos && (
        <div
          ref={pop}
          className="rb-flyout panel"
          style={{ left: pos.left, top: pos.top, width, maxHeight: `calc(100vh - ${pos.top + 12}px)` }}
        >
          {children}
        </div>
      )}
    </>
  );
}
