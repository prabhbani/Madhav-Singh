/**
 * The guided demonstration script.
 *
 * Twelve steps, timed to run in about two and a half minutes, so a judge can
 * follow the whole argument without anyone narrating it: here is the portfolio,
 * here is what is at risk, here is one case, here is why the system says so,
 * here is what to do about it, and here is how the organisation sees it.
 *
 * Each step names the element it points at by a `data-demo` attribute rather
 * than a class, so restyling a component cannot silently break the tour.
 */

export type DemoStep = {
  /** Shown as "Step 3 of 12". */
  id: string;
  title: string;
  /** What the judge should take away. Two sentences at most. */
  narration: string;
  /** Route the step runs on. The tour navigates if it is not already there. */
  route: string;
  /** `data-demo` value of the element to spotlight. */
  target: string;
  /** Seconds this step holds before autoplay advances. */
  seconds: number;
  /** Opens the detail drawer on the highest-risk project before spotlighting. */
  opensCriticalProject?: boolean;
  /** Closes the drawer before spotlighting, so a later step is not covered. */
  closesDrawer?: boolean;
  /** Invites the judge to click the highlighted control themselves. */
  invitesClick?: boolean;
};

export const DEMO_STEPS: readonly DemoStep[] = [
  {
    id: 'dashboard',
    title: 'Executive dashboard',
    narration:
      'One screen for a state monitoring cell. It shows every acquisition case in the officer’s scope, ranked by where intervention can still change the outcome.',
    route: '/',
    target: 'dashboard-heading',
    seconds: 11,
  },
  {
    id: 'active-projects',
    title: 'Active acquisition projects',
    narration:
      'The portfolio in one number, counted from the database rather than typed in. Every tile beside it is computed from the same rows as the table below.',
    route: '/',
    target: 'kpi-total',
    seconds: 11,
  },
  {
    id: 'high-risk',
    title: 'Projects at high risk',
    narration:
      'The cases carrying real delay exposure, separated from the ones that are merely large. Scale is not risk, and a system that confuses the two wastes officer attention on the biggest projects rather than the most troubled ones.',
    route: '/',
    target: 'kpi-high-critical',
    seconds: 12,
  },
  {
    id: 'open-critical',
    title: 'Open the most critical case',
    narration:
      'Opening the highest-risk project in the register. From here the system has to justify itself: a number an officer cannot interrogate is a number they will ignore.',
    route: '/',
    target: 'project-detail',
    seconds: 12,
    opensCriticalProject: true,
  },
  {
    id: 'probability',
    title: 'Predicted delay probability',
    narration:
      'The probability that this case suffers a significant delay within the reporting horizon. It is a rule score here, and the interface says so rather than implying a calibrated model ran.',
    route: '/',
    target: 'prediction-probability',
    seconds: 13,
    opensCriticalProject: true,
  },
  {
    id: 'expected-delay',
    title: 'Expected delay in days',
    narration:
      'How far behind this case is predicted to run. Days are what a project review can act on; a percentage on its own is not actionable.',
    route: '/',
    target: 'prediction-delay',
    seconds: 11,
    opensCriticalProject: true,
  },
  {
    id: 'why',
    title: 'Why the system considers it risky',
    narration:
      'The explanation travels with the prediction. It states plainly that these are associations rather than causes, because the system has not established causation and should not pretend otherwise.',
    route: '/',
    target: 'why-card',
    seconds: 14,
    opensCriticalProject: true,
  },
  {
    id: 'factors',
    title: 'Top risk factors',
    narration:
      'Each factor names its measured value and what it contributed. An officer can check any one of them against the case file, which is the only way this earns trust.',
    route: '/',
    target: 'risk-factors',
    seconds: 13,
    opensCriticalProject: true,
  },
  {
    id: 'recommendations',
    title: 'Recommended preventive actions',
    narration:
      'Ranked actions, each with a responsible department, a suggested deadline, and a hedged expected impact. The three problems here belong to three different departments, and each is told what to do.',
    route: '/',
    target: 'recommended-actions',
    seconds: 15,
    opensCriticalProject: true,
  },
  {
    id: 'alert',
    title: 'Early warning alert',
    narration:
      'The same evidence reaches the intervention queue as an alert, carrying the condition that fired. An unchanged condition is never raised twice, so the queue stays worth reading.',
    route: '/alerts',
    target: 'alert-card',
    seconds: 13,
    closesDrawer: true,
  },
  {
    id: 'acknowledge',
    title: 'Officer acknowledgement',
    narration:
      'An officer acknowledges the alert and the decision is recorded against them. Try it: the highlighted button is live.',
    route: '/alerts',
    target: 'alert-acknowledge',
    seconds: 14,
    invitesClick: true,
  },
  {
    id: 'analytics',
    title: 'Department and district trends',
    narration:
      'The same cases rolled up by department, district, and state, so a monitoring cell can see where pressure is concentrating rather than only which project is late.',
    route: '/analytics',
    target: 'analytics-charts',
    seconds: 14,
  },
];

/** Roughly how long the guided run takes, for the invitation card. */
export const DEMO_DURATION_SECONDS = DEMO_STEPS.reduce((total, step) => total + step.seconds, 0);
