import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useSession } from './SessionProvider';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { ROLE_LABELS, type Permission } from './permissions';

/**
 * Route guard.
 *
 * This hides a page a role cannot use. It is a usability measure, not a security
 * one: the data behind the page is protected by the server, which refuses the
 * request whatever the browser decides to render.
 */
export function ProtectedRoute({
  permissions,
  mode = 'all',
  children,
}: {
  permissions: Permission[];
  /** `all` requires every permission; `any` requires at least one. */
  mode?: 'all' | 'any';
  children: React.ReactNode;
}) {
  const { session, loading, can, canAny } = useSession();

  if (loading) return <div className="page-wrap"><SkeletonLoader /></div>;

  const allowed = mode === 'any' ? canAny(...permissions) : can(...permissions);
  if (allowed) return <>{children}</>;

  return (
    <div className="page-wrap">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACCESS RESTRICTED</div>
          <h1>You do not have access to this page</h1>
          <p>Your role does not include the permission this page requires.</p>
        </div>
        <Link className="outline-button" to="/">Return to overview</Link>
      </div>
      <div className="empty-state">
        <ShieldAlert size={22} />
        <h2>{session ? ROLE_LABELS[session.user.role] : 'Unknown role'}</h2>
        <p>
          This page requires {mode === 'any' ? 'one of' : 'all of'}: {permissions.join(', ')}.
          Contact your administrator if you need it.
        </p>
      </div>
    </div>
  );
}

/** Renders children only when the session holds the permissions. */
export function Can({
  permissions,
  mode = 'all',
  children,
  fallback = null,
}: {
  permissions: Permission[];
  mode?: 'all' | 'any';
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { can, canAny } = useSession();
  const allowed = mode === 'any' ? canAny(...permissions) : can(...permissions);
  return <>{allowed ? children : fallback}</>;
}
