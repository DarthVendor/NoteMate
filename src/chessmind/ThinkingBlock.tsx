/*
 * Hidden reasoning of a ChessMind answer (format-4 models: `<|think|> ... <|end_think|>` before the answer).
 * Collapsed by default to a muted header ("Thinking…" while it streams, "Thought for N tokens" once closed);
 * expanding shows its text and its lines as SAN. The lines are display-only: they are never inserted into the
 * move tree or drawn on the board (only answer parts do that).
 */
import { useId, useState } from 'react';
import { Chess } from 'chess.js';
import type { ChatLeafPart } from '../types';
import { DEFAULT_MAX_THINK_TOKENS } from './protocol';
import { LINE_END_LABEL, lineEnding } from './lineRules';
import { lineText } from './lines';
import { ToolChip } from './ToolChip';
import './ThinkingBlock.css';

interface Props {
  parts: ChatLeafPart[];
  /** The running plan closing the think (prompt-role models: `<|plan|> ... <|end_plan|>`, the think part's `plan`). */
  plan?: ChatLeafPart[];
  /** No <|end_think|> yet. */
  open?: boolean;
  /** Tokens generated inside the think. */
  tokens?: number;
  /** The message is finished (an open think of a finished message was stopped). */
  done?: boolean;
  /** Where lines start before any snapshot inside the think (the question's FEN; undefined = initial position). */
  startFen?: string;
  /** Full FEN for a snapshot FEN (which has no move number / castling), when the caller knows the position. */
  resolveFen?: (fen: string) => string;
  /** The think budget, shown with the live token count while it streams. */
  budget?: number;
  /** Renders text part `i` (e.g. with the claim checker's marks); default: the plain text. */
  renderText?: (text: string, i: number) => React.ReactNode;
}

/** SAN of a UCI line from `fen`, with move numbers ("4...d5 5.exd5 Nxd5"); unparsable moves stay UCI. */
function sanLine(fen: string | undefined, moves: string[]): string {
  let c: Chess;
  try {
    c = new Chess(fen);
  } catch {
    return moves.join(' ');
  }
  const out: string[] = [];
  let broken = false;
  moves.forEach((uci, i) => {
    const no = c.moveNumber();
    const white = c.turn() === 'w';
    let san = uci;
    if (!broken) {
      try {
        san = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
      } catch {
        broken = true;
      }
    }
    out.push(broken ? uci : white ? `${no}.${san}` : i === 0 ? `${no}...${san}` : san);
  });
  return out.join(' ');
}

/** "(draw by repetition)" etc. after a line that stopped in a finished position (mate shows as # in the SAN). */
export function LineEndNote({ fen, moves }: { fen: string | undefined; moves: string[] }) {
  const end = lineEnding(fen, moves);
  if (!end || end === 'checkmate') return null;
  return <span className="cm-line-end"> ({LINE_END_LABEL[end]})</span>;
}

const sideOf = (fen: string) => (fen.split(' ')[1] === 'b' ? 'Black' : 'White');

export function ThinkingBlock({ parts, plan, open, tokens, done, startFen, resolveFen, budget = DEFAULT_MAX_THINK_TOKENS, renderText }: Props) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const streaming = !!open && !done;
  const empty = parts.length === 0 && !plan?.length;
  let label: string;
  if (streaming) label = 'Thinking';
  else if (open) label = 'Thinking stopped';
  else if (empty) label = 'Skipped thinking';
  else if (tokens !== undefined) label = `Thought for ${tokens} token${tokens === 1 ? '' : 's'}`;
  else label = 'Reasoning';
  const canExpand = !empty;
  const calls = parts.filter((p) => p.kind === 'tool').length;

  // Lines start from the latest snapshot inside the think, else from startFen.
  const lineFens: (string | undefined)[] = [];
  const planFen = parts.reduce((f, p) => {
    lineFens.push(f);
    return p.kind === 'fen' ? (resolveFen?.(p.fen) ?? p.fen) : f;
  }, startFen);
  return (
    <div className={`cm-think ${streaming ? 'is-streaming' : ''} ${expanded ? 'is-expanded' : ''}`} data-testid="chessmind-think">
      <button
        type="button"
        className="cm-think-head"
        aria-expanded={canExpand ? expanded : undefined}
        aria-controls={canExpand ? bodyId : undefined}
        disabled={!canExpand}
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="cm-think-chevron" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="10" height="10"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <span className="cm-think-label">{label}</span>
        {streaming && (
          <span className="cm-think-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        {streaming && (
          <span className="cm-think-count" aria-live="off" title="Tokens of reasoning so far / the think budget">
            {tokens ?? 0} / {budget} tokens
          </span>
        )}
      </button>
      {!expanded && calls > 0 && (
        // Tool calls stay visible while the reasoning is collapsed: what the model looked up, and the answer it got.
        <div className="cm-think-tools">
          {parts.map((p, i) => (p.kind === 'tool' ? <ToolChip key={i} part={p} startFen={lineFens[i]} /> : null))}
        </div>
      )}
      {expanded && canExpand && (
        <div className="cm-think-body" id={bodyId}>
          {parts.map((p, i) => {
            if (p.kind === 'text') return <p key={i} className="cm-think-text">{renderText ? renderText(p.text, i) : p.text}</p>;
            if (p.kind === 'fen') return <p key={i} className="cm-think-fen">position · {sideOf(p.fen)} to move</p>;
            if (p.kind === 'tool') return <p key={i} className="cm-think-tool"><ToolChip part={p} startFen={lineFens[i]} /></p>;
            return (
              <p key={i} className="cm-think-line">
                {!p.moves.length ? '(empty line)' : p.branches?.length || p.end ? lineText(p, lineFens[i]) : sanLine(lineFens[i], p.moves)}
                {p.moves.length > 0 && !p.end && !p.branches?.length && <LineEndNote fen={lineFens[i]} moves={p.moves} />}
              </p>
            );
          })}
          {!!plan?.length && (
            // Plan lines start from the think's latest snapshot, else where the think started
            <p className="cm-think-plan">
              <strong>Plan:</strong>{' '}
              {plan.map((p, i) =>
                p.kind === 'text' ? <span key={i}>{p.text} </span> : p.kind === 'line' ? <span key={i}>{sanLine(planFen, p.moves)} </span> : null,
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
