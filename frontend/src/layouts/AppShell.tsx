import { Bell, ChevronDown, CircleAlert, Gauge, LayoutDashboard, Map, Menu, ShieldCheck } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useNotificationCentre } from '../hooks/useNotificationCentre';
import { useSession } from '../auth/SessionProvider';
import { ROLE_LABELS, SCOPE_LABELS, type Permission } from '../auth/permissions';
import { DemoBanner } from '../demo/DemoBanner';

type NavEntry = { to: string; label: string; icon: typeof LayoutDashboard; permission: Permission };

const NAV: NavEntry[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, permission: 'analytics:read' },
  { to: '/projects', label: 'Project registry', icon: Map, permission: 'projects:read' },
  { to: '/alerts', label: 'Intervention queue', icon: CircleAlert, permission: 'alerts:read' },
  { to: '/analytics', label: 'Analytics', icon: Gauge, permission: 'analytics:read' },
];

export function AppShell() {
  // The badge and the bell both read the live notification centre, so an officer
  // sees the queue depth without opening it.
  const { data } = useNotificationCentre();
  const counts = data?.centre.counts;
  const awaiting = counts?.unacknowledged ?? 0;
  const urgent = (counts?.CRITICAL ?? 0) + (counts?.HIGH ?? 0);

  // Navigation is filtered to what the role can use. This is presentation only;
  // typing a hidden URL still reaches a guarded route and a guarded API.
  const { session, live, can } = useSession();
  const visible = NAV.filter((entry) => can(entry.permission));
  const initials = (session?.user.email ?? 'demo user')
    .split(/[.@]/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return (
    <div className="app-shell with-demo-banner">
      <DemoBanner />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">LA</div>
          <div>
            <strong>Land Acquisition</strong>
            <span>Command Centre</span>
          </div>
        </div>
        <div className="nav-label">MONITORING</div>
        <nav>
          {visible.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
              <Icon size={18} />
              {label}
              {to === '/alerts' && awaiting > 0 ? <span className="nav-count">{awaiting}</span> : null}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="data-status">
            <span className="live-dot" />
            {live ? 'Server session' : 'Demo environment'}
            <div>
              <strong>{session ? ROLE_LABELS[session.user.role] : 'No session'}</strong>
              <small>
                {session ? SCOPE_LABELS[session.scope.level] ?? session.scope.level : 'Unknown scope'}
                {session?.scope.department ? ` · ${session.scope.department}` : ''}
                {!session?.scope.department && session?.scope.districtCode ? ` · ${session.scope.districtCode}` : ''}
              </small>
            </div>
          </div>
          <NavLink to="/access" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <ShieldCheck size={18} />
            Roles and access
          </NavLink>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Open navigation">
            <Menu size={20} />
          </button>
          <div className="crumb">
            <span>State Monitoring Cell</span>
            <span>›</span>
            <strong>Decision dashboard</strong>
          </div>
          <div className="top-actions">
            <span className="date-chip">16 September 2026</span>
            {can('alerts:read') ? (
              <NavLink to="/alerts" className="icon-button notification" aria-label={`Notifications: ${awaiting} awaiting action`}>
                <Bell size={19} />
                {urgent > 0 ? <i /> : null}
              </NavLink>
            ) : null}
            <div className="profile">
              <div className="avatar">{initials || 'NA'}</div>
              <div>
                <strong>{session?.user.email.split('@')[0] ?? 'Not signed in'}</strong>
                <span>{session ? ROLE_LABELS[session.user.role] : 'No role'}</span>
              </div>
              <ChevronDown size={15} />
            </div>
          </div>
        </header>
        <Outlet />
      </main>
    </div>
  );
}
