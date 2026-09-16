import { useState } from 'react';
import { FlaskConical, PlayCircle, X } from 'lucide-react';
import { useDemoMode } from './DemoModeProvider';
import { DEMO_DURATION_SECONDS, DEMO_STEPS } from './steps';

const durationLabel = (): string => {
  const minutes = Math.floor(DEMO_DURATION_SECONDS / 60);
  const seconds = DEMO_DURATION_SECONDS % 60;
  return `${minutes} min ${seconds.toString().padStart(2, '0')} s`;
};

/**
 * The demonstration mode indicator.
 *
 * It sits above everything, on every screen, and it never goes away. That is the
 * point: a judge must never be in doubt about whether they are looking at real
 * government records. The data is synthetic, generated for this demonstration,
 * and the banner says so in those words rather than in a subtle colour.
 */
export function DemoBanner() {
  const { active, start, stop } = useDemoMode();

  return (
    <div className="demo-banner" data-demo="demo-banner" role="status">
      <span className="demo-banner-mark">
        <FlaskConical size={13} />
        DEMO MODE
      </span>
      <span className="demo-banner-text">
        Synthetic demonstration data. <strong>Not live government records.</strong> Generated for evaluation; no real
        landowner, compensation, or case information appears anywhere in this system.
      </span>
      {active ? (
        <button className="demo-banner-action" onClick={stop}>
          <X size={13} />
          Exit guided tour
        </button>
      ) : (
        <button className="demo-banner-action primary" onClick={start} data-demo="start-tour">
          <PlayCircle size={13} />
          Guided tour · {durationLabel()}
        </button>
      )}
    </div>
  );
}

/**
 * The opening invitation.
 *
 * Shown once, over the dashboard, so a judge who has two minutes knows there is
 * a two-minute path through the system rather than having to find one.
 */
export function DemoInvitation() {
  const { active, start } = useDemoMode();
  const [dismissed, setDismissed] = useState(false);

  if (active || dismissed) return null;

  return (
    <div className="demo-invitation" data-demo="demo-invitation">
      <button className="demo-icon-button" onClick={() => setDismissed(true)} aria-label="Dismiss the guided tour invitation">
        <X size={15} />
      </button>
      <span className="eyebrow">SMART INDIA HACKATHON</span>
      <h2>See the whole system in {durationLabel()}</h2>
      <p>
        A guided walkthrough of {DEMO_STEPS.length} steps: the portfolio, one critical acquisition case, why the system
        considers it risky, what it recommends doing, and how a monitoring cell sees the pattern across departments.
      </p>
      <ol className="demo-outline">
        {DEMO_STEPS.map((step, index) => (
          <li key={step.id}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            {step.title}
          </li>
        ))}
      </ol>
      <div className="demo-invitation-foot">
        <button className="demo-button primary" onClick={start} data-demo="start-tour-primary">
          <PlayCircle size={15} />
          Start the guided tour
        </button>
        <button className="demo-button" onClick={() => setDismissed(true)}>
          Explore on my own
        </button>
      </div>
      <p className="demo-invitation-note">
        Every figure is computed from the demonstration database. Nothing on screen is a hardcoded number, and nothing is
        real government data.
      </p>
    </div>
  );
}
