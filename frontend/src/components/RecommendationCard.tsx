import type { Recommendation } from '../types/recommendation';

const PRIORITY_CLASS: Record<Recommendation['priority'], string> = {
  CRITICAL: 'level-critical',
  HIGH: 'level-high',
  MEDIUM: 'level-medium',
  LOW: 'level-low',
};

const formatDue = (dueAt: string): string => {
  const date = new Date(dueAt);
  return Number.isNaN(date.getTime())
    ? dueAt
    : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export function RecommendationCard({ recommendation, onAssign }: { recommendation: Recommendation; onAssign?: () => void }) {
  const { priority, action, reason, relatedRiskFactor, responsibleDepartment, suggestedDeadline, expectedImpact, status } = recommendation;
  return (
    <article className="action-item">
      <header className="action-item-head">
        <span className="action-rank">{String(recommendation.rank).padStart(2, '0')}</span>
        <span className={`action-priority ${PRIORITY_CLASS[priority]}`}>{priority} PRIORITY</span>
        <span className="action-status">{status.replace('_', ' ')}</span>
      </header>
      <h4>{action}</h4>
      <p className="action-reason">{reason}</p>
      <dl className="action-meta">
        <div>
          <dt>Related risk factor</dt>
          <dd>
            {relatedRiskFactor ? relatedRiskFactor.label : 'Rule evidence only'}
            {relatedRiskFactor ? <small>{relatedRiskFactor.source === 'RULE' ? 'Rule evidence' : 'Model factor'}</small> : null}
          </dd>
        </div>
        <div>
          <dt>Responsible</dt>
          <dd>{responsibleDepartment}</dd>
        </div>
        <div>
          <dt>Suggested deadline</dt>
          <dd>
            {suggestedDeadline.days} days<small>by {formatDue(suggestedDeadline.dueAt)}</small>
          </dd>
        </div>
        <div>
          <dt>Expected impact</dt>
          <dd>{expectedImpact}</dd>
        </div>
      </dl>
      {recommendation.capacityNote ? <p className="action-capacity">{recommendation.capacityNote}</p> : null}
      <footer className="action-item-foot">
        <span>Ranking score {recommendation.rankingScore.toFixed(2)}{recommendation.priorityBasis === 'POLICY_OVERRIDE' ? ' · priority set by policy override' : ''}</span>
        <button className="assign-button" onClick={onAssign}>Assign</button>
      </footer>
    </article>
  );
}
