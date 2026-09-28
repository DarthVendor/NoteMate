/*
 * The moves of a ChessMind answer line as clickable SAN chips, with its branches (<|branch|> ... <|end_branch|>) as
 * indented variations under the move they replace, and end markers (<|mate|> / <|draw|> / <|repetition|>) as labels.
 */
import type { ChatLinePart } from '../types';
import { displayLine, MARK_LABEL, type DisplaySegment, type LineChip } from './lines';

interface Props {
  line: ChatLinePart;
  /** Where the line starts (undefined = the initial position). */
  fen?: string;
  /** Chips are clickable. */
  usable: boolean;
  title: string;
  /** The chip at `path` is the current board position. */
  isActive: (path: number[]) => boolean;
  onPick: (chip: LineChip) => void;
}

export function MarkLabel({ end }: { end?: ChatLinePart['end'] }) {
  if (!end) return null;
  return (
    <span className={`chat-line-mark mark-${end}`} data-testid="line-mark">
      {MARK_LABEL[end]}
    </span>
  );
}

function Segment({ seg, props }: { seg: DisplaySegment; props: Props }) {
  const rows: React.ReactNode[] = [];
  let run: React.ReactNode[] = [];
  const flush = (key: string) => {
    if (run.length) rows.push(<div key={key} className="chat-line-moves">{run}</div>);
    run = [];
  };
  seg.chips.forEach((c, k) => {
    run.push(
      <button
        key={c.path.join('.')}
        className={`chat-san ${props.isActive(c.path) ? 'active' : ''}`}
        disabled={!props.usable}
        title={props.title}
        onClick={() => props.onPick(c)}
      >
        {c.num && <span className="chat-num">{c.num}</span>}
        {c.san}
      </button>,
    );
    const subs = seg.branches.get(k);
    if (subs?.length) {
      flush(`m${k}`);
      subs.forEach((sub, j) =>
        rows.push(
          <div key={`b${k}.${j}`} className="chat-line-branch" data-testid="chessmind-branch">
            <Segment seg={sub} props={props} />
          </div>,
        ),
      );
    }
  });
  if (seg.end) run.push(<MarkLabel key="end" end={seg.end} />);
  flush('end');
  return <>{rows}</>;
}

/** The line's chips; returns null for a line with no playable move (the caller shows "(empty line)"). */
export function LineChips(props: Props) {
  const seg = displayLine(props.line, props.fen);
  if (!seg.chips.length) return null;
  return <Segment seg={seg} props={props} />;
}
