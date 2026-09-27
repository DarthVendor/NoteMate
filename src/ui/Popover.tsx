import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  /** Renders the trigger; spread `props` onto a button. */
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu'; ref: (el: HTMLElement | null) => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  width?: number;
  label?: string;
}

/** A menu/popover rendered in a portal (so dock panels with overflow:hidden never clip it). */
export function Popover({ trigger, children, align = 'end', width = 260, label }: Props) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(width, vw - 16);
      let left = align === 'end' ? r.right - w : r.left;
      left = Math.max(8, Math.min(left, vw - w - 8));
      const below = vh - r.bottom - 12;
      const above = r.top - 12;
      const h = pop.current?.offsetHeight ?? 300;
      const top = h > below && above > below ? Math.max(8, r.top - 6 - Math.min(h, above)) : r.bottom + 6;
      setPos({ top, left, maxH: Math.max(160, h > below && above > below ? above : below) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, align, width, anchor]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || anchor?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        anchor?.focus();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchor]);

  // Focus the first item when opened.
  useEffect(() => {
    if (open && pos) pop.current?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]')?.focus();
  }, [open, pos]);

  const close = () => setOpen(false);
  return (
    <>
      {trigger({
        onClick: () => setOpen((o) => !o),
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        ref: setAnchor,
      })}
      {open &&
        createPortal(
          <div
            ref={pop}
            className="popover"
            role="menu"
            aria-label={label}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: Math.min(width, window.innerWidth - 16), maxHeight: pos?.maxH }}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              const items = [...(pop.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
              const i = items.indexOf(document.activeElement as HTMLElement);
              items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
              e.preventDefault();
            }}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

export function MenuItem({ icon, children, onClick, checked, hint, danger, disabled }: { icon?: ReactNode; children: ReactNode; onClick: () => void; checked?: boolean; hint?: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      className={`menu-item ${danger ? 'danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-text">{children}</span>
      {hint && <span className="menu-hint">{hint}</span>}
      {checked !== undefined && <span className={`menu-check ${checked ? 'on' : ''}`} aria-hidden />}
    </button>
  );
}

export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-label">{children}</div>;
export const MenuDivider = () => <div className="menu-divider" role="separator" />;
