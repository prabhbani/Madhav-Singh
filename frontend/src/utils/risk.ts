import type { Risk } from '../types/project';
export const riskMeta: Record<Risk, { label: string; color: string; soft: string }> = { LOW: { label: 'Low', color: '#218657', soft: '#e2f4e9' }, MEDIUM: { label: 'Medium', color: '#b7791f', soft: '#fff3d7' }, HIGH: { label: 'High', color: '#c4552d', soft: '#ffeadf' }, CRITICAL: { label: 'Critical', color: '#aa3140', soft: '#ffe1e5' } };
export const riskOrder: Risk[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
