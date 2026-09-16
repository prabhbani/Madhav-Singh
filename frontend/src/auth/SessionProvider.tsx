import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { apiGet } from '../api/client';
import { ROLES, permissionsForRole, type Permission, type Role } from './permissions';

const sessionSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    role: z.enum(ROLES),
    stateCode: z.string().nullable(),
    districtCode: z.string().nullable(),
    department: z.string().nullable(),
  }),
  scope: z.object({
    level: z.enum(['GLOBAL', 'STATE', 'DISTRICT', 'DEPARTMENT', 'NONE']),
    stateCode: z.string().nullable(),
    districtCode: z.string().nullable(),
    department: z.string().nullable(),
    basis: z.string(),
  }),
  permissions: z.array(z.string()),
});

export type Session = z.infer<typeof sessionSchema>;

type SessionState = {
  session: Session | null;
  /** True when the session came from the server rather than the demo fallback. */
  live: boolean;
  loading: boolean;
  can: (...permissions: Permission[]) => boolean;
  canAny: (...permissions: Permission[]) => boolean;
  /** Demo only: switches the simulated role so the guards can be exercised. */
  setDemoRole: (role: Role) => void;
};

const DEMO_ROLE_KEY = 'demoRole';

/** A simulated session, used only when no API session is available. */
const demoSession = (role: Role): Session => ({
  user: {
    id: 'demo-user',
    email: 'demo.officer@example.gov',
    role,
    stateCode: 'Punjab',
    districtCode: role === 'DISTRICT_OFFICER' || role === 'PROJECT_OFFICER' ? 'Ludhiana' : null,
    department: role === 'PROJECT_OFFICER' ? 'Public Works Department' : null,
  },
  scope: {
    level:
      role === 'SUPER_ADMIN' ? 'GLOBAL' : role === 'PROJECT_OFFICER' ? 'DEPARTMENT' : role === 'DISTRICT_OFFICER' ? 'DISTRICT' : 'STATE',
    stateCode: 'Punjab',
    districtCode: role === 'DISTRICT_OFFICER' || role === 'PROJECT_OFFICER' ? 'Ludhiana' : null,
    department: role === 'PROJECT_OFFICER' ? 'Public Works Department' : null,
    basis: 'Simulated scope for the demo environment.',
  },
  permissions: [...permissionsForRole(role)],
});

const readDemoRole = (): Role => {
  try {
    const stored = localStorage.getItem(DEMO_ROLE_KEY);
    if (stored && (ROLES as readonly string[]).includes(stored)) return stored as Role;
  } catch {
    // Storage can be unavailable in a private window; the default still applies.
  }
  return 'DISTRICT_OFFICER';
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const fetched = await apiGet('/auth/me', sessionSchema);
        if (!cancelled) {
          setSession(fetched);
          setLive(true);
        }
      } catch {
        // No API session. Fall back to a clearly-labelled simulated session so
        // the interface is still navigable in the demo environment.
        if (!cancelled) {
          setSession(demoSession(readDemoRole()));
          setLive(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setDemoRole = useCallback((role: Role) => {
    try {
      localStorage.setItem(DEMO_ROLE_KEY, role);
    } catch {
      // A failed write only means the choice is not remembered.
    }
    setSession(demoSession(role));
    setLive(false);
  }, []);

  const value = useMemo<SessionState>(() => {
    const held = new Set(session?.permissions ?? []);
    return {
      session,
      live,
      loading,
      can: (...permissions: Permission[]) => permissions.every((permission) => held.has(permission)),
      canAny: (...permissions: Permission[]) => permissions.some((permission) => held.has(permission)),
      setDemoRole,
    };
  }, [session, live, loading, setDemoRole]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider');
  return context;
}
