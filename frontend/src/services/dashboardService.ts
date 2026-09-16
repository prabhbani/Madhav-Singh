import { dashboardSchema, type DashboardData } from '../types/project';
import { apiGet } from '../api/client';
import { districts, projects, trend } from '../data';

/**
 * Dashboard data.
 *
 * The figures come from `/analytics/dashboard`, which the API computes from
 * stored rows and scopes to the caller. Nothing on the dashboard is calculated
 * in the browser.
 *
 * The offline fallback is generated from the same demonstration dataset the seed
 * writes, scored by the same rule engine, so an unreachable API changes where
 * the numbers come from but not what they are. `live` says which happened, and
 * the interface labels it.
 */
export async function getDashboardData(): Promise<DashboardData & { live: boolean }> {
  try {
    const data = await apiGet('/analytics/dashboard', dashboardSchema);
    return { ...data, live: true };
  } catch {
    return { ...dashboardSchema.parse({ projects, trend, districts }), live: false };
  }
}
