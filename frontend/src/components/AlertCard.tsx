import { BellRing, Building2, CheckCheck, Clock, UserRound } from 'lucide-react';
import { ALERT_TYPE_LABELS, type Alert, type AlertSeverity } from '../types/alert';

const SEVERITY_CLASS: Record<AlertSeverity, string> = {
  CRITICAL: 'level-critical',
  HIGH: 'level-high',
  WARNING: 'level-medium',
  INFO: 'level-low',
};

const relativeTime = (iso: string): string => {
  const elapsedMinutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(elapsedMinutes)) return iso;
  if (elapsedMinutes < 1) return 'just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes} min ago`;
  const hours = Math.round(elapsedMinutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
};

export function AlertCard({ alert, onAcknowledge }: { alert: Alert; onAcknowledge?: (alert: Alert) => void }) {
  const acknowledged = alert.status !== 'OPEN';
  return (
    <article className={`alert-item ${acknowledged ? 'is-acknowledged' : ''}`} data-demo="alert-card">
      <header className="alert-item-head">
        <span className={`alert-severity ${SEVERITY_CLASS[alert.severity]}`}>{alert.severity}</span>
        <strong>{ALERT_TYPE_LABELS[alert.type] ?? alert.type}</strong>
        <span className="alert-time">
          <Clock size={12} />
          {relativeTime(alert.triggeredAt)}
        </span>
      </header>

      <p className="alert-project">
        {alert.project?.name ?? 'Unknown project'}
        <small>
          {alert.project?.projectCode ?? '—'}
          {alert.project?.district ? ` · ${alert.project.district}` : ''}
        </small>
      </p>

      <p className="alert-message">{alert.message}</p>
      <p className="alert-trigger">
        <BellRing size={12} />
        <code>{alert.trigger}</code>
      </p>

      <dl className="alert-meta">
        <div>
          <dt>Recommended action</dt>
          <dd>{alert.recommendedAction}</dd>
        </div>
        <div>
          <dt>Responsible</dt>
          <dd>
            {alert.assignedTo ? (
              <>
                <UserRound size={12} /> {alert.assignedTo.displayName}
              </>
            ) : (
              <>
                <Building2 size={12} /> {alert.responsibleDepartment}
              </>
            )}
            {alert.assignedTo ? <small>{alert.responsibleDepartment}</small> : <small>No officer mapped to this department</small>}
          </dd>
        </div>
      </dl>

      <footer className="alert-item-foot">
        <span>
          {acknowledged ? `${alert.status.replace('_', ' ')}` : 'Awaiting acknowledgement'}
          {alert.occurrenceCount > 1 ? ` · observed ${alert.occurrenceCount}×` : ''}
        </span>
        {acknowledged ? (
          <span className="alert-ack">
            <CheckCheck size={14} /> Acknowledged
          </span>
        ) : (
          <button className="assign-button" data-demo="alert-acknowledge" onClick={() => onAcknowledge?.(alert)}>
            Acknowledge
          </button>
        )}
      </footer>
    </article>
  );
}
