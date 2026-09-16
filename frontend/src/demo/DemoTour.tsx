import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, MousePointerClick, Pause, Play, X } from 'lucide-react';
import { useDemoMode } from './DemoModeProvider';
import { DEMO_STEPS } from './steps';

type Rect = { top: number; left: number; width: number; height: number };

/**
 * Tracks where the current step's target sits on screen.
 *
 * The element may not exist yet: a step can navigate to another route, or open
 * the project drawer, and the spotlight has to wait rather than point at
 * nothing. It polls briefly, then gives up and reports null, which the tour
 * renders as a centred card with no spotlight instead of a broken one.
 */
const useTargetRect = (target: string | undefined): Rect | null => {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!target) {
      setRect(null);
      return;
    }
    let frame = 0;
    let attempts = 0;
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;
      const element = document.querySelector<HTMLElement>(`[data-demo="${target}"]`);
      if (element) {
        const box = element.getBoundingClientRect();
        setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
        if (box.top < 0 || box.bottom > window.innerHeight) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else if (attempts < 120) {
        // Roughly two seconds at sixty frames, enough for a route change and a
        // data fetch without hanging the tour on a target that will never come.
        setRect(null);
      }
      attempts += 1;
      frame = window.requestAnimationFrame(measure);
    };

    frame = window.requestAnimationFrame(measure);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [target]);

  return rect;
};

const PADDING = 8;

/**
 * The guided tour overlay.
 *
 * A spotlight ring around the current target, and a control card that names the
 * step, explains it, and offers manual navigation. The ring uses a very large
 * outward shadow to dim everything else, and takes no pointer events, so the
 * highlighted control stays clickable. That matters for the acknowledgement
 * step, where the judge is invited to press the button themselves.
 */
export function DemoTour() {
  const { active, step, stepIndex, total, autoplay, remaining, next, back, goTo, stop, setAutoplay } = useDemoMode();
  const rect = useTargetRect(step?.target);

  if (!active || !step) return null;

  const progress = step.seconds > 0 ? 1 - remaining / step.seconds : 0;

  return (
    <div className="demo-tour" role="dialog" aria-label={`Guided demonstration, step ${stepIndex + 1} of ${total}`}>
      {rect ? (
        <div
          className="demo-spotlight"
          style={{
            top: rect.top - PADDING,
            left: rect.left - PADDING,
            width: rect.width + PADDING * 2,
            height: rect.height + PADDING * 2,
          }}
        />
      ) : (
        <div className="demo-scrim" />
      )}

      <section className="demo-card" data-demo-card>
        <header className="demo-card-head">
          <span className="demo-step-count">
            STEP {String(stepIndex + 1).padStart(2, '0')} / {total}
          </span>
          <span className="demo-badge">SYNTHETIC DEMO DATA</span>
          <button className="demo-icon-button" onClick={stop} aria-label="Exit the guided demonstration">
            <X size={16} />
          </button>
        </header>

        <h2>{step.title}</h2>
        <p>{step.narration}</p>

        {step.invitesClick ? (
          <p className="demo-invite">
            <MousePointerClick size={13} />
            The highlighted control is live. Press it, or carry on.
          </p>
        ) : null}

        <div className="demo-progress" aria-hidden="true">
          <i style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>

        <footer className="demo-card-foot">
          <div className="demo-dots">
            {DEMO_STEPS.map((entry, index) => (
              <button
                key={entry.id}
                className={`demo-dot ${index === stepIndex ? 'current' : index < stepIndex ? 'done' : ''}`}
                onClick={() => goTo(index)}
                aria-label={`Go to step ${index + 1}: ${entry.title}`}
                title={`${index + 1}. ${entry.title}`}
              />
            ))}
          </div>
          <div className="demo-controls">
            <button className="demo-button" onClick={back} disabled={stepIndex === 0} aria-label="Previous step">
              <ChevronLeft size={15} />
            </button>
            <button
              className="demo-button"
              onClick={() => setAutoplay(!autoplay)}
              aria-label={autoplay ? 'Pause the guided demonstration' : 'Resume the guided demonstration'}
            >
              {autoplay ? <Pause size={14} /> : <Play size={14} />}
            </button>
            {stepIndex === total - 1 ? (
              <button className="demo-button primary" onClick={stop}>
                Finish
              </button>
            ) : (
              <button className="demo-button primary" onClick={next} aria-label="Next step">
                Next
                <ChevronRight size={15} />
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
