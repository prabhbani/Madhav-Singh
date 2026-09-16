import type { ReactNode } from 'react';

export function AnalyticsChart({ title, meta, children }: { title: string; meta: string; children: ReactNode }) { return <div className="panel trend-panel"><div className="panel-header"><div><h2>{title}</h2><span>{meta}</span></div></div>{children}</div>; }
