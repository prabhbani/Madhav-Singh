import { ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useSession } from '../auth/SessionProvider';
import { ROLES, ROLE_LABELS, ROLE_PERMISSIONS, SCOPE_LABELS, type Role } from '../auth/permissions';

/**
 * Access control reference.
 *
 * Shows the caller's own role, scope, and permissions, and the full matrix. The
 * matrix here is the frontend mirror; the authoritative copy is served by the
 * API at `/authz/permissions`.
 */
export function AdminPage() {
  const { session, live, setDemoRole } = useSession();

  return (
    <div className="page-wrap">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACCESS CONTROL</div>
          <h1>Roles and permissions</h1>
          <p>Every permission below is enforced again on the server, which is the security boundary.</p>
        </div>
        <Link className="outline-button" to="/">Return to overview</Link>
      </div>

      {session ? (
        <div className="alert-summary">
          <div className="alert-summary-card">
            <span>YOUR ROLE</span>
            <strong style={{ fontSize: 15 }}>{ROLE_LABELS[session.user.role]}</strong>
          </div>
          <div className="alert-summary-card">
            <span>SCOPE</span>
            <strong style={{ fontSize: 15 }}>{SCOPE_LABELS[session.scope.level] ?? session.scope.level}</strong>
          </div>
          <div className="alert-summary-card">
            <span>ASSIGNED TO</span>
            <strong style={{ fontSize: 13 }}>
              {session.scope.department ?? session.scope.districtCode ?? session.scope.stateCode ?? 'All states'}
            </strong>
          </div>
          <div className="alert-summary-card">
            <span>PERMISSIONS</span>
            <strong>{session.permissions.length}</strong>
          </div>
          <div className="alert-summary-card">
            <span>SESSION</span>
            <strong style={{ fontSize: 13 }}>{live ? 'Server session' : 'Demo session'}</strong>
          </div>
        </div>
      ) : null}

      {!live ? (
        <div className="alert-toolbar">
          <div className="alert-filters">
            {ROLES.map((role: Role) => (
              <button
                key={role}
                className={`filter-chip ${session?.user.role === role ? 'selected' : ''}`}
                onClick={() => setDemoRole(role)}
              >
                {ROLE_LABELS[role]}
              </button>
            ))}
          </div>
          <span className="data-pill">Demo role switcher; a real session comes from the API</span>
        </div>
      ) : null}

      <p className="association-note">
        <ShieldCheck size={13} /> Hiding a page or a button is a convenience. A request that reaches the API is checked
        against the role, the permission, and the caller&apos;s geographic scope before anything is read or written.
      </p>

      <div className="panel">
        <div className="table-scroll">
          <table className="matrix-table">
            <thead>
              <tr>
                <th>Permission</th>
                {ROLES.map((role) => (
                  <th key={role}>{ROLE_LABELS[role]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROLE_PERMISSIONS.SUPER_ADMIN.map((permission) => (
                <tr key={permission}>
                  <td><code>{permission}</code></td>
                  {ROLES.map((role) => (
                    <td key={role} className={ROLE_PERMISSIONS[role].includes(permission) ? 'granted' : 'withheld'}>
                      {ROLE_PERMISSIONS[role].includes(permission) ? 'Yes' : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
