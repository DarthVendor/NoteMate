import { useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { Keys } from '../ui/primitives';
import { onboardingDismissed, setOnboardingDismissed } from './onboardingStore';

const TIPS: { title: string; body: React.ReactNode }[] = [
  { title: 'Welcome to NoteMate', body: <>Play moves on the board, or import a game with <Keys keys={['i']} />. A different move from any position becomes a variation.</> },
  { title: 'Draw on the board', body: <>Right-drag for an arrow, right-click to circle a square. Hold <Keys keys={['Shift']} />, <Keys keys={['Alt']} /> or <Keys keys={['Ctrl']} /> for other colours.</> },
  { title: 'Everything from the keyboard', body: <>Step through moves with <Keys keys={['ArrowLeft']} /> <Keys keys={['ArrowRight']} />, and press <Keys keys={['Mod', 'k']} /> for every command. <Keys keys={['?']} /> lists shortcuts.</> },
  { title: 'Make the workspace yours', body: <>Drag a panel’s tab to dock it left, right or bottom, or onto another panel to tab them together. Presets live in the Layout menu.</> },
];

/** First-run hints: a slim, dismissible card above the board (never covers controls). */
export function Onboarding() {
  const [dismissed, setDismissed] = useState(onboardingDismissed);
  const [step, setStep] = useState(0);
  if (dismissed) return null;
  const close = () => {
    setOnboardingDismissed(true);
    setDismissed(true);
  };
  const tip = TIPS[step];
  return (
    <aside className="onboarding" aria-label="Getting started" data-testid="onboarding">
      <div className="onb-steps" aria-hidden>
        {TIPS.map((_, i) => (
          <span key={i} className={i === step ? 'on' : ''} />
        ))}
      </div>
      <div className="onb-text">
        <strong>{tip.title}</strong>
        <span>{tip.body}</span>
      </div>
      <div className="onb-actions">
        {step < TIPS.length - 1 ? (
          <button className="btn btn-sm" onClick={() => setStep(step + 1)}>
            Next <ChevronRight size={13} />
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" onClick={close}>
            Got it
          </button>
        )}
        <button className="btn btn-ghost btn-icon btn-sm" onClick={close} title="Dismiss tips" aria-label="Dismiss tips">
          <X size={14} />
        </button>
      </div>
    </aside>
  );
}
