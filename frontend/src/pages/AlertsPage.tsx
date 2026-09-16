import { useMemo, useState } from 'react';
import { BellRing, Link as LinkIcon, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AlertCard } from '../components/AlertCard';
import { useNotificationCentre } from '../hooks/useNotificationCentre';
import { acknowledgeAlert } from '../services/alertService';
import { SkeletonLoader } from '../components/SkeletonLoader';
import type { Alert, AlertSeverity } from '../types/alert';

const FILTERS: Array<{ label: string; value: AlertSeverity | 'ALL' }> = [
  { label: 'All', value: 'ALL' },
  { label: 'Critical', value: 'CRITICAL' },
  { label: 'High', value: 'HIGH' },
  { label: 'Warning', value: 'WARNING' },
  { label: 'Info', value: 'INFO' },
];

/**
 * Notification centre.
 *
 * Alerts are grouped by severity, newest condition last within a group, so the
 * oldest unacknowledged item stays visible rather than being pushed down by new
 * arrivals. Acknowledgement is recorded per alert.
 */
export function AlertsPage() {
  const { data, isLoading, refetch } = useNotificationCentre();
  const [filter, setFilter] = useState<AlertSeverity | 'ALL'>('ALL');
  const [acknowledged, setAcknowledged] = useState<Record<string, true>>({});

  const groups = useMemo(() => {
    const source = data?.centre.groups ?? [];
    return source
      .filter((group) => filter === 'ALL' || group.severity === filter)
      .map((group) => ({
        ...group,
        alerts: group.alerts.map((alert) =>
          acknowledged[alert.id] ? { ...alert, status: 'ACKNOWLEDGED' as const } : alert,
        ),
      }));
  }, [data, filter, acknowledged]);

  const counts = data?.centre.counts;
  const onAcknowledge = async (alert: Alert) => {
    setAcknowledged((current) => ({ ...current, [alert.id]: true }));
    await acknowledgeAlert(alert.id);
    void refetch();
  };

  return (
    <div className="page-wrap">
      <div className="page-heading">
        <div>
          <div className="eyebrow">EARLY WARNING SYSTEM</div>
          <h1>Notification centre</h1>
          <p>
            Alerts are raised from threshold crossings on recorded case data. An unchanged condition is not raised again.
          </p>
        </div>
        <Link className="outline-button" to="/">
          Return to overview
        </Link>
      </div>

      {isLoading ? (
        <SkeletonLoader />
      ) : !counts || counts.total === 0 ? (
        <div className="empty-state">
          <ShieldCheck size={22} />
          <h2>No live alerts</h2>
          <p>No detector threshold is currently crossed on any active project.</p>
          <Link className="outline-button" to="/projects">
            <LinkIcon size={15} />
            Open the project registry
          </Link>
        </div>
      ) : (
        <>
          <div className="alert-summary">
            {(['CRITICAL', 'HIGH', 'WARNING', 'INFO'] as AlertSeverity[]).map((severity) => (
              <div key={severity} className={`alert-summary-card sev-${severity.toLowerCase()}`}>
                <span>{severity}</span>
                <strong>{counts[severity]}</strong>
              </div>
            ))}
            <div className="alert-summary-card">
              <span>AWAITING ACTION</span>
              <strong>{counts.unacknowledged}</strong>
            </div>
          </div>

          <div className="alert-toolbar">
            <div className="alert-filters">
              {FILTERS.map((option) => (
                <button
                  key={option.value}
                  className={`filter-chip ${filter === option.value ? 'selected' : ''}`}
                  onClick={() => setFilter(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <span className="data-pill">
              {data?.live ? 'Live alert feed' : 'Demo feed derived from the project registry; the API is unavailable'}
            </span>
          </div>

          <p className="association-note">
            <BellRing size={13} /> Each alert records the condition expression that fired. A threshold crossing is an
            association with elevated delay risk, not a causal finding, and an authorized official decides what action it
            warrants.
          </p>

          {groups.length === 0 ? (
            <div className="empty-state">
              <ShieldCheck size={22} />
              <h2>Nothing at this severity</h2>
              <p>Change the filter to see alerts at other severities.</p>
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.severity} className="alert-group">
                <h2>
                  {group.severity}
                  <span>{group.alerts.length} alert(s)</span>
                </h2>
                <div className="alert-list">
                  {group.alerts.map((alert) => (
                    <AlertCard key={alert.id} alert={alert} onAcknowledge={onAcknowledge} />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}
    </div>
  );
}
