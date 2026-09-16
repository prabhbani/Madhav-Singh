import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DEMO_STEPS, type DemoStep } from './steps';

/**
 * Demo mode state.
 *
 * The provider owns the step index, drives route changes, and tells the
 * dashboard when a step needs the project drawer open. It does not know how
 * anything is rendered, which keeps the tour from becoming a second copy of the
 * interface.
 *
 * Autoplay is on by default: a judge should be able to watch rather than drive.
 * Any manual step, back, or jump pauses it, because someone who has taken
 * control does not want the screen moving under them.
 */

type DemoContextValue = {
  active: boolean;
  stepIndex: number;
  step: DemoStep | null;
  total: number;
  autoplay: boolean;
  /** Seconds remaining on the current step, for the progress ring. */
  remaining: number;
  /** True when a step needs the highest-risk project open in the drawer. */
  wantsCriticalProject: boolean;
  start: () => void;
  stop: () => void;
  next: () => void;
  back: () => void;
  goTo: (index: number) => void;
  setAutoplay: (autoplay: boolean) => void;
};

const DemoContext = createContext<DemoContextValue | null>(null);

const STORAGE_KEY = 'demoModeSeen';

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [autoplay, setAutoplay] = useState(true);
  const [remaining, setRemaining] = useState(0);
  const tickRef = useRef<number | null>(null);

  const step = active ? (DEMO_STEPS[stepIndex] ?? null) : null;

  const start = useCallback(() => {
    setStepIndex(0);
    setAutoplay(true);
    setActive(true);
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // A blocked storage write only means the invitation shows again.
    }
  }, []);

  const stop = useCallback(() => {
    setActive(false);
    setRemaining(0);
  }, []);

  const goTo = useCallback((index: number) => {
    setStepIndex(Math.max(0, Math.min(DEMO_STEPS.length - 1, index)));
  }, []);

  const next = useCallback(() => {
    setStepIndex((current) => {
      if (current >= DEMO_STEPS.length - 1) return current;
      return current + 1;
    });
  }, []);

  const back = useCallback(() => {
    setAutoplay(false);
    setStepIndex((current) => Math.max(0, current - 1));
  }, []);

  // Route changes are driven by the step, so a judge never has to navigate.
  useEffect(() => {
    if (!step) return;
    if (location.pathname !== step.route) navigate(step.route);
  }, [step, location.pathname, navigate]);

  // Autoplay countdown. Restarts whenever the step or the setting changes.
  useEffect(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (!active || !step) return;
    setRemaining(step.seconds);
    if (!autoplay) return;

    tickRef.current = window.setInterval(() => {
      setRemaining((seconds) => {
        if (seconds <= 1) {
          // The last step holds rather than looping, so the tour ends somewhere.
          setStepIndex((current) => (current >= DEMO_STEPS.length - 1 ? current : current + 1));
          return 0;
        }
        return seconds - 1;
      });
    }, 1_000);

    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
      tickRef.current = null;
    };
  }, [active, autoplay, step]);

  // Escape leaves the tour, and the arrows drive it, so a presenter is not
  // hunting for a button while a room watches.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stop();
      if (event.key === 'ArrowRight') {
        setAutoplay(false);
        next();
      }
      if (event.key === 'ArrowLeft') back();
      if (event.key === ' ') {
        event.preventDefault();
        setAutoplay((current) => !current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, stop, next, back]);

  const value = useMemo<DemoContextValue>(
    () => ({
      active,
      stepIndex,
      step,
      total: DEMO_STEPS.length,
      autoplay,
      remaining,
      wantsCriticalProject: Boolean(step?.opensCriticalProject),
      start,
      stop,
      next: () => {
        setAutoplay(false);
        next();
      },
      back,
      goTo: (index: number) => {
        setAutoplay(false);
        goTo(index);
      },
      setAutoplay,
    }),
    [active, stepIndex, step, autoplay, remaining, start, stop, next, back, goTo],
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemoMode(): DemoContextValue {
  const context = useContext(DemoContext);
  if (!context) throw new Error('useDemoMode must be used inside a DemoModeProvider');
  return context;
}

/** True once a judge has started the tour at least once in this browser. */
export const hasSeenDemo = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};
