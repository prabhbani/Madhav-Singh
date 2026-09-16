import { ChevronRight } from 'lucide-react';
export function PanelHeader({ title, meta, action }: { title: string; meta?: string; action?: string }) { return <div className="panel-header"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action && <button className="text-button">{action}<ChevronRight size={14} /></button>}</div>; }
