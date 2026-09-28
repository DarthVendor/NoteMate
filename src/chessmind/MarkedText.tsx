/** Answer text with the claim checker's marks (chatContext.ts markText): sentences the board contradicts and made-up
 * evaluations get a quiet dotted underline with the reason as a tooltip; the text itself is never changed. */
import type { TextSegment } from './chatContext';

export function MarkedText({ segments }: { segments: TextSegment[] }) {
  return (
    <>
      {segments.map((s, i) => {
        if (!s.claim && !s.evalNote) return s.text;
        const title = [s.claim, s.evalNote].filter(Boolean).join('\n');
        return (
          <span key={i} className={`cm-claim ${s.claim ? 'is-false' : ''} ${s.evalNote ? 'is-eval' : ''}`} title={title} data-testid="chessmind-claim">
            {s.text}
          </span>
        );
      })}
    </>
  );
}
