import type { Risk } from '../types/project';
import { riskMeta } from '../utils/risk';
export function RiskBadge({ risk }: { risk: Risk }) { const meta = riskMeta[risk]; return <span className="risk-badge" style={{ color: meta.color, background: meta.soft }}><span className="risk-dot" style={{ background: meta.color }} />{meta.label}</span>; }
