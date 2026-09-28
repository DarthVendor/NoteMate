/*
 * A tool call of a ChessMind answer (tools.ts): a compact chip ("Engine: +0.4, best Nf3", "Engine…" while it runs,
 * "Engine: no result (timeout)"); clicking it shows what the model asked (the position, the call's line) and the exact
 * result text it read.
 */
import { useId, useState } from 'react';
import { Chess } from 'chess.js';
import type { ChatToolPart } from '../types';
import { toolChipLabel } from './tools';
import './ToolChip.css';

/** SAN of the call's line from `fen` ("after 3...a6 4.Ba4"), '' without one. */
function callLine(p: ChatToolPart, startFen: string | undefined): string {
  if (!p.moves?.length) return '';
  let c: Chess;
  try {
    c = new Chess(startFen);
  } catch {
    return p.moves.join(' ');
  }
  const out: string[] = [];
  for (const [i, u] of p.moves.entries()) {
    const no = c.moveNumber();
    const white = c.turn() === 'w';
    try {
      const san = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san;
      out.push(white ? `${no}.${san}` : i === 0 ? `${no}...${san}` : san);
    } catch {
      out.push(u);
    }
  }
  return out.join(' ');
}

interface Props {
  part: ChatToolPart;
  /** Where the call's line starts (the snapshot in force, else the question's position). */
  startFen?: string;
}

export function ToolChip({ part, startFen }: Props) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const pending = part.result === undefined || (!part.result.trim() && part.ok === undefined);
  const failed = !pending && (part.ok === false || /: no result \(/.test(part.result ?? ''));
  const line = callLine(part, startFen);
  const where = part.name === 'all_notes' ? 'whole game' : line ? `after ${line}` : 'current position';
  return (
    <span className={`cm-tool ${pending ? 'is-pending' : ''} ${failed ? 'is-error' : ''} ${open ? 'is-open' : ''}`} data-testid="chessmind-tool">
      <button
        type="button"
        className="cm-tool-chip"
        aria-expanded={pending ? undefined : open}
        aria-controls={pending ? undefined : bodyId}
        disabled={pending}
        onClick={() => setOpen((o) => !o)}
        title={pending ? `Running ${part.name} (${where})` : `${part.name} · ${where}`}
      >
        <span className="cm-tool-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="10" height="10">
            <path d="M9.5 2.5a3.5 3.5 0 0 0-3.2 4.9L2.5 11.2l2.3 2.3 3.8-3.8a3.5 3.5 0 0 0 4.9-3.2l-2 2-2-.5-.5-2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="cm-tool-label">{toolChipLabel(part)}</span>
        {line && <span className="cm-tool-where">{line}</span>}
      </button>
      {open && !pending && (
        <span className="cm-tool-body" id={bodyId}>
          <span className="cm-tool-row">
            <b>{part.name}</b> · {where}
            {part.fen && <span className="cm-tool-fen"> · {part.fen}</span>}
          </span>
          <code className="cm-tool-result">{part.result}</code>
        </span>
      )}
    </span>
  );
}
