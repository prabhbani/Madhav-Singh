import { z } from 'zod';

export const riskSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type Risk = z.infer<typeof riskSchema>;
export const projectSchema = z.object({ id: z.string(), name: z.string(), district: z.string(), department: z.string(), state: z.string(), stage: z.string(), progress: z.number(), probability: z.number(), expectedDelay: z.number(), risk: riskSchema, factor: z.string(), updated: z.string(), parcels: z.number(), owners: z.number(), objections: z.number(), compensation: z.string(), legal: z.string(), targetDate: z.string(), area: z.string() });
export type Project = z.infer<typeof projectSchema>;
export const dashboardSchema = z.object({ projects: z.array(projectSchema), trend: z.array(z.object({ month: z.string(), probability: z.number(), critical: z.number(), high: z.number() })), districts: z.array(z.object({ name: z.string(), state: z.string(), value: z.number(), projects: z.number() })) });
export type DashboardData = z.infer<typeof dashboardSchema>;
