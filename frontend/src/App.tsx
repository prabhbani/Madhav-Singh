import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './layouts/AppShell';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { RegistryPage } from './pages/RegistryPage';
import { AlertsPage } from './pages/AlertsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AdminPage } from './pages/AdminPage';
import { SessionProvider } from './auth/SessionProvider';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { DemoModeProvider } from './demo/DemoModeProvider';
import { DemoTour } from './demo/DemoTour';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/**
 * Each route declares the permission its page needs. The guard hides a page the
 * role cannot use; the API refuses the underlying request regardless.
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <BrowserRouter>
          {/* Inside the router: the tour navigates between routes itself. */}
          <DemoModeProvider>
            <DemoTour />
            <Routes>
            <Route element={<AppShell />}>
              <Route
                path="/"
                element={
                  <ProtectedRoute permissions={['analytics:read']}>
                    <DashboardPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/projects"
                element={
                  <ProtectedRoute permissions={['projects:read']}>
                    <RegistryPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/alerts"
                element={
                  <ProtectedRoute permissions={['alerts:read']}>
                    <AlertsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/analytics"
                element={
                  <ProtectedRoute permissions={['analytics:read']}>
                    <AnalyticsPage />
                  </ProtectedRoute>
                }
              />
              <Route path="/access" element={<AdminPage />} />
            </Route>
            </Routes>
          </DemoModeProvider>
        </BrowserRouter>
      </SessionProvider>
    </QueryClientProvider>
  );
}
