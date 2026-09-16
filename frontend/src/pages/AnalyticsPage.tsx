import { Link } from 'react-router-dom';
import { Building2, Gauge, Map as MapIcon, TrendingUp } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useDashboard } from '../hooks/useDashboard';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { PanelHeader } from '../components/PanelHeader';
import { DelayTrendChart } from '../charts/DelayTrendChart';
import { DistrictHeatmap } from '../charts/DistrictHeatmap';
import { byDepartment, byState, formatDays, formatPercent, summarize } from '../utils/portfolio';

const RISK_COLOUR = (probability: number): string =>
  probability >= 0.75 ? '#aa3140' : probability >= 0.5 ? '#c4552d' : probability >= 0.25 ? '#d49b35' : '#55a477';

/**
 * Department and district analytics.
 *
 * Every figure is aggregated from the project rows the analytics API returned,
 * so this page and the dashboard cannot disagree: they are reading the same
 * response. Nothing is computed from a constant.
 */
export function AnalyticsPage() {
  const { data, isLoading, isError } = useDashboard();

  if (isLoading) return <div className="page-wrap"><SkeletonLoader /></div>;
  if (isError || !data) {
    return (
      <div className="page-wrap">
        <div className="empty-state">
          <Gauge size={22} />
          <h2>Analytics unavailable</h2>
          <p>Refresh the page or verify the analytics API connection.</p>
        </div>
      </div>
    );
  }

  const summary = summarize(data.projects);
  const departments = byDepartment(data.projects);
  const states = byState(data.districts);
  const departmentChart = departments.map((row) => ({
    name: row.department.replace(' Department', '').replace('National Highways Authority', 'NHAI'),
    probability: Number((row.averageProbability * 100).toFixed(1)),
    raw: row.averageProbability,
  }));

  return (
    <div className="page-wrap" data-demo="analytics-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ANALYTICS WORKSPACE</div>
          <h1>Department and district analytics</h1>
          <p>Compare processing pressure, risk concentration, and historical movement.</p>
        </div>
        <div className="heading-actions">
          <span className="data-pill">
            <span className="live-dot" />
            {data.live ? 'LIVE FROM API' : 'OFFLINE DEMO DATA'} · {data.projects.length} PROJECTS
          </span>
          <Link className="outline-button" to="/">Return to overview</Link>
        </div>
      </div>

      <div className="alert-summary">
        <div className="alert-summary-card sev-critical">
          <span>CRITICAL</span>
          <strong>{summary.byRisk.CRITICAL}</strong>
        </div>
        <div className="alert-summary-card sev-high">
          <span>HIGH</span>
          <strong>{summary.byRisk.HIGH}</strong>
        </div>
        <div className="alert-summary-card sev-warning">
          <span>MEDIUM</span>
          <strong>{summary.byRisk.MEDIUM}</strong>
        </div>
        <div className="alert-summary-card sev-info">
          <span>LOW</span>
          <strong>{summary.byRisk.LOW}</strong>
        </div>
        <div className="alert-summary-card">
          <span>DELAY EXPOSURE</span>
          <strong style={{ fontSize: 17 }}>{formatDays(summary.predictedDelayDays)}</strong>
        </div>
      </div>

      <div className="chart-grid" data-demo="analytics-charts">
        <div className="panel chart-panel" data-demo="department-analytics">
          <PanelHeader title="Average delay probability by department" meta={`${departments.length} departments in scope`} />
          <p className="chart-note">
            Averaged across each department&apos;s projects. A tall bar is a department carrying pressure, not a department
            performing badly; the cause is in the individual cases.
          </p>
          <ResponsiveContainer width="100%" height={Math.max(180, departmentChart.length * 34)}>
            <BarChart data={departmentChart} layout="vertical" margin={{ left: 4, right: 20, top: 4, bottom: 4 }}>
              <CartesianGrid horizontal={false} stroke="#e7ecef" />
              <XAxis type="number" domain={[0, 100]} tick={{ fill: '#76828b', fontSize: 10 }} axisLine={false} tickLine={false} unit="%" />
              <YAxis type="category" dataKey="name" width={132} tick={{ fill: '#4b5d66', fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: '#f4f7f8' }} formatter={(value) => [`${Number(value ?? 0)}%`, 'Average delay probability'] as [string, string]} />
              <Bar dataKey="probability" radius={[0, 3, 3, 0]}>
                {departmentChart.map((row) => (
                  <Cell key={row.name} fill={RISK_COLOUR(row.raw)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="panel chart-panel" data-demo="district-analytics">
          <PanelHeader title="Risk concentration by district" meta={`${data.districts.length} districts in scope`} />
          <p className="chart-note">
            The value is the average delay probability across the district&apos;s projects, as a percentage.
          </p>
          <DistrictHeatmap districts={data.districts} />
        </div>

        <div className="panel chart-panel" data-demo="trend-analytics">
          <PanelHeader title="Delay probability trend" meta="Last six months of stored predictions" />
          <p className="chart-note">
            Each point is the average across every prediction recorded that month, so the line is a record of what the system
            said over time rather than a projection.
          </p>
          <DelayTrendChart data={data.trend} />
        </div>

        <div className="panel chart-panel" data-demo="state-analytics">
          <PanelHeader title="State rollup" meta={`${states.length} states in scope`} />
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>State</th>
                  <th>Districts</th>
                  <th>Projects</th>
                  <th>Average risk</th>
                </tr>
              </thead>
              <tbody>
                {states.map((row) => (
                  <tr key={row.state}>
                    <td><strong style={{ color: '#304854' }}>{row.state}</strong></td>
                    <td>{row.districts}</td>
                    <td>{row.projects}</td>
                    <td>
                      <span style={{ color: RISK_COLOUR(row.averageProbability), fontWeight: 600 }}>
                        {formatPercent(row.averageProbability)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }} data-demo="department-table">
        <PanelHeader title="Department workload and exposure" meta="Aggregated from the same rows the dashboard reads" />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th><Building2 size={12} /> Department</th>
                <th>Projects</th>
                <th><TrendingUp size={12} /> Average delay probability</th>
                <th>High / critical</th>
                <th><Gauge size={12} /> Predicted delay</th>
                <th><MapIcon size={12} /> Open objections</th>
              </tr>
            </thead>
            <tbody>
              {departments.map((row) => (
                <tr key={row.department}>
                  <td><strong style={{ color: '#304854' }}>{row.department}</strong></td>
                  <td>{row.projects}</td>
                  <td>
                    <span style={{ color: RISK_COLOUR(row.averageProbability), fontWeight: 600 }}>
                      {formatPercent(row.averageProbability)}
                    </span>
                  </td>
                  <td className={row.highOrCritical > 0 ? 'danger-text' : 'good-text'}>{row.highOrCritical}</td>
                  <td>{formatDays(row.predictedDelayDays)}</td>
                  <td>{row.objections}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
