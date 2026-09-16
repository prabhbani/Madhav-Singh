import type { Project } from '../types/project';
export function ProjectStatusBadge({ status }: { status: Project['stage'] }) { return <span className="status-copy"><span>Current stage</span><strong>{status}</strong></span>; }
