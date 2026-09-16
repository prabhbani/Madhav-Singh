export type ApiResponse<T> = { data: T; requestId?: string };
export type RiskFactor = { factorCode: string; direction: 'INCREASES_RISK' | 'REDUCES_RISK' | 'NEUTRAL'; explanation: string };
export type PredictionResponse = { projectId: string; delayProbability: number; expectedDelayDays: number; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; confidence?: number; topRiskFactors: RiskFactor[]; recommendedActions: string[] };
