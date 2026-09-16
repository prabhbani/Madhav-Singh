/**
 * Audit policy.
 *
 * Declares which actions are recorded, which logical resource and table they
 * touch, and whether the caller's IP address is recorded.
 *
 * IP is not collected by default. It is personal data, so it is recorded only
 * where it genuinely supports a security investigation: authentication, account
 * administration, deletions, exports, and access to personal case documents.
 * Ordinary reads of operational data are audited without it.
 */

import type { Resource } from '../authz/permissions.js';

export type AuditActionName =
  | 'AUTH_LOGIN_SUCCESS'
  | 'AUTH_LOGIN_FAILURE'
  | 'AUTH_LOGOUT'
  | 'ACCESS_DENIED'
  | 'PROJECT_CREATE'
  | 'PROJECT_UPDATE'
  | 'PROJECT_DELETE'
  | 'CASE_MILESTONE_CREATE'
  | 'CASE_MILESTONE_UPDATE'
  | 'DOCUMENT_CREATE'
  | 'DOCUMENT_READ'
  | 'PREDICTION_CREATE'
  | 'RECOMMENDATION_GENERATE'
  | 'RECOMMENDATION_STATUS_UPDATE'
  | 'ALERT_EVALUATE'
  | 'ALERT_EVALUATE_ALL'
  | 'ALERT_ACKNOWLEDGE'
  | 'ALERT_STATUS_UPDATE'
  | 'USER_CREATE'
  | 'USER_UPDATE'
  | 'USER_DEACTIVATE'
  | 'ANALYTICS_EXPORT'
  | 'AUDIT_LOG_READ';

export type AuditActionPolicy = {
  resource: Resource;
  /** Physical table, recorded alongside the logical resource. */
  tableName: string;
  /** Record the caller's IP for this action. */
  recordIp: boolean;
  /** Capture the row before the change, so the audit shows what was replaced. */
  captureBefore: boolean;
};

export const AUDIT_POLICY: Record<AuditActionName, AuditActionPolicy> = {
  AUTH_LOGIN_SUCCESS: { resource: 'users', tableName: 'users', recordIp: true, captureBefore: false },
  AUTH_LOGIN_FAILURE: { resource: 'users', tableName: 'users', recordIp: true, captureBefore: false },
  AUTH_LOGOUT: { resource: 'users', tableName: 'users', recordIp: true, captureBefore: false },
  ACCESS_DENIED: { resource: 'users', tableName: 'users', recordIp: true, captureBefore: false },

  PROJECT_CREATE: { resource: 'projects', tableName: 'projects', recordIp: false, captureBefore: false },
  PROJECT_UPDATE: { resource: 'projects', tableName: 'projects', recordIp: false, captureBefore: true },
  PROJECT_DELETE: { resource: 'projects', tableName: 'projects', recordIp: true, captureBefore: true },

  CASE_MILESTONE_CREATE: { resource: 'cases', tableName: 'milestones', recordIp: false, captureBefore: false },
  CASE_MILESTONE_UPDATE: { resource: 'cases', tableName: 'milestones', recordIp: false, captureBefore: true },

  // Case documents carry landowner records, so reads are audited with the IP.
  DOCUMENT_CREATE: { resource: 'documents', tableName: 'documents', recordIp: true, captureBefore: false },
  DOCUMENT_READ: { resource: 'documents', tableName: 'documents', recordIp: true, captureBefore: false },

  PREDICTION_CREATE: { resource: 'predictions', tableName: 'predictions', recordIp: false, captureBefore: false },

  RECOMMENDATION_GENERATE: { resource: 'recommendations', tableName: 'recommendations', recordIp: false, captureBefore: false },
  RECOMMENDATION_STATUS_UPDATE: { resource: 'recommendations', tableName: 'recommendations', recordIp: false, captureBefore: true },

  ALERT_EVALUATE: { resource: 'alerts', tableName: 'alerts', recordIp: false, captureBefore: false },
  ALERT_EVALUATE_ALL: { resource: 'alerts', tableName: 'alerts', recordIp: true, captureBefore: false },
  ALERT_ACKNOWLEDGE: { resource: 'alerts', tableName: 'alerts', recordIp: false, captureBefore: true },
  ALERT_STATUS_UPDATE: { resource: 'alerts', tableName: 'alerts', recordIp: false, captureBefore: true },

  USER_CREATE: { resource: 'users', tableName: 'users', recordIp: true, captureBefore: false },
  USER_UPDATE: { resource: 'users', tableName: 'users', recordIp: true, captureBefore: true },
  USER_DEACTIVATE: { resource: 'users', tableName: 'users', recordIp: true, captureBefore: true },

  ANALYTICS_EXPORT: { resource: 'analytics', tableName: 'projects', recordIp: true, captureBefore: false },
  AUDIT_LOG_READ: { resource: 'auditLogs', tableName: 'audit_logs', recordIp: true, captureBefore: false },
};
