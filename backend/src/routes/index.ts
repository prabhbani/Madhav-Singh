/**
 * API router.
 *
 * Every protected route declares three things explicitly: the permission it
 * needs, the scope check that binds it to the caller's geography, and the audit
 * action it records. Reading this file should be enough to answer "who can do
 * this, to which rows, and is it recorded".
 *
 * Order of middleware on a protected route is always:
 *   authenticate → attachScope → requirePermission → validate → enforceScope → audit → handler
 *
 * Validation runs before the scope check so the identifier used to load the
 * target row has already been checked for shape.
 */

import { Router } from 'express';
import { authenticate } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';
import { attachScope, enforceScope, enforceScopeOnBody, requirePermission, requireRole } from '../middlewares/authorize.js';
import { authLimiter, expensiveLimiter, exportLimiter } from '../middlewares/security.js';
import { audit } from '../middlewares/audit.js';
import * as auth from '../controllers/authController.js';
import * as authz from '../controllers/authzController.js';
import * as projects from '../controllers/projectController.js';
import * as predictions from '../controllers/predictionController.js';
import * as analytics from '../controllers/analyticsController.js';
import * as alerts from '../controllers/alertController.js';
import * as recommendations from '../controllers/recommendationController.js';
import * as documents from '../controllers/documentController.js';
import * as users from '../controllers/userController.js';
import * as auditLogs from '../controllers/auditController.js';
import {
  idParam,
  projectList,
  projectCreate,
  projectUpdate,
  milestoneCreate,
  milestoneUpdate,
  predictionCreate,
  acknowledge,
  documentCreate,
  login,
  recommendationGenerate,
  recommendationStatus,
  alertEvaluate,
  alertEvaluateAll,
  alertList,
  alertStatus,
  auditLogList,
  userCreate,
  userList,
  userUpdate,
} from '../validators/schemas.js';

const router = Router();

// --- Public -----------------------------------------------------------------
router.post('/auth/login', authLimiter, validate(login), auth.login);

// --- Everything below requires a valid token and a resolved scope ------------
router.use(authenticate, attachScope);

router.post('/auth/logout', auth.logout);
router.get('/auth/me', authz.me);
router.get('/authz/permissions', authz.matrix);

// --- Projects ---------------------------------------------------------------
router.get('/projects', requirePermission('projects:read'), validate(projectList), projects.list);
router.get('/projects/:id', requirePermission('projects:read'), validate(idParam), enforceScope('project'), projects.get);
router.post(
  '/projects',
  requirePermission('projects:create'),
  validate(projectCreate),
  enforceScopeOnBody('projects', { required: true }),
  audit('PROJECT_CREATE'),
  projects.create,
);
router.put(
  '/projects/:id',
  requirePermission('projects:update'),
  validate(projectUpdate),
  // Both checks are needed: the first proves the caller may touch the project as
  // it stands, the second proves the body is not relocating it out of scope.
  enforceScope('project'),
  enforceScopeOnBody('projects'),
  audit('PROJECT_UPDATE', { subject: 'project' }),
  projects.update,
);
router.delete(
  '/projects/:id',
  requirePermission('projects:delete'),
  validate(idParam),
  enforceScope('project'),
  audit('PROJECT_DELETE', { subject: 'project' }),
  projects.remove,
);

// --- Cases (milestone-level case records) -----------------------------------
router.get('/projects/:id/milestones', requirePermission('cases:read'), validate(idParam), enforceScope('project'), projects.milestones);
router.post(
  '/projects/:id/milestones',
  requirePermission('cases:create'),
  validate(milestoneCreate),
  enforceScope('project'),
  audit('CASE_MILESTONE_CREATE'),
  projects.createMilestone,
);
router.put(
  '/milestones/:id',
  requirePermission('cases:update'),
  validate(milestoneUpdate),
  enforceScope('milestone'),
  audit('CASE_MILESTONE_UPDATE', { subject: 'milestone' }),
  projects.updateMilestone,
);

// --- Documents --------------------------------------------------------------
router.post(
  '/documents',
  requirePermission('documents:create'),
  validate(documentCreate),
  enforceScope('project', { from: 'body.projectId', resource: 'documents' }),
  audit('DOCUMENT_CREATE'),
  documents.create,
);
// Reads are audited too: case documents carry landowner records.
router.get(
  '/documents/:id',
  requirePermission('documents:read'),
  validate(idParam),
  enforceScope('document'),
  audit('DOCUMENT_READ'),
  documents.get,
);

// --- Predictions ------------------------------------------------------------
router.post(
  '/predictions',
  expensiveLimiter,
  requirePermission('predictions:create'),
  validate(predictionCreate),
  enforceScope('project', { from: 'body.projectId', resource: 'predictions' }),
  audit('PREDICTION_CREATE'),
  predictions.create,
);
router.get('/projects/:id/prediction', requirePermission('predictions:read'), validate(idParam), enforceScope('project'), predictions.latest);
router.get('/projects/:id/prediction/history', requirePermission('predictions:read'), validate(idParam), enforceScope('project'), predictions.history);

// --- Analytics --------------------------------------------------------------
router.get('/risk/overview', requirePermission('analytics:read'), analytics.riskOverview);
router.get('/risk/high', requirePermission('analytics:read'), analytics.highRisk);
router.get('/risk/trends', requirePermission('analytics:read'), analytics.riskTrends);
router.get('/analytics/dashboard', requirePermission('analytics:read'), analytics.dashboard);
router.get('/analytics/overview', requirePermission('analytics:read'), analytics.overview);
router.get('/analytics/departments', requirePermission('analytics:read'), analytics.departments);
router.get('/analytics/districts', requirePermission('analytics:read'), analytics.districts);
router.get('/analytics/timeline', requirePermission('analytics:read'), analytics.timeline);
router.get('/analytics/export', exportLimiter, requirePermission('analytics:export'), audit('ANALYTICS_EXPORT'), analytics.exportDataset);

// --- Alerts -----------------------------------------------------------------
// Static paths precede the :id routes so a literal segment is never read as an id.
router.get('/alerts', requirePermission('alerts:read'), validate(alertList), alerts.list);
router.get('/alerts/activity', requirePermission('alerts:read'), alerts.activity);
router.get('/alerts/policy-versions', requirePermission('alerts:read'), alerts.versions);
router.get('/notifications', requirePermission('alerts:read'), alerts.notificationCentre);
router.post(
  '/alerts/evaluate',
  expensiveLimiter,
  requireRole('SUPER_ADMIN', 'STATE_ADMIN'),
  requirePermission('alerts:evaluate'),
  validate(alertEvaluateAll),
  audit('ALERT_EVALUATE_ALL'),
  alerts.evaluateAll,
);
router.post(
  '/projects/:id/alerts/evaluate',
  expensiveLimiter,
  requirePermission('alerts:evaluate'),
  validate(alertEvaluate),
  enforceScope('project', { resource: 'alerts' }),
  audit('ALERT_EVALUATE'),
  alerts.evaluate,
);
router.get('/alerts/:id/history', requirePermission('alerts:read'), validate(idParam), enforceScope('alert'), alerts.history);
router.post(
  '/alerts/:id/acknowledge',
  requirePermission('alerts:acknowledge'),
  validate(acknowledge),
  enforceScope('alert'),
  audit('ALERT_ACKNOWLEDGE', { subject: 'alert' }),
  alerts.acknowledge,
);
router.patch(
  '/alerts/:id/status',
  requirePermission('alerts:manage'),
  validate(alertStatus),
  enforceScope('alert'),
  audit('ALERT_STATUS_UPDATE', { subject: 'alert' }),
  alerts.updateStatus,
);

// --- Recommendations --------------------------------------------------------
router.get('/recommendations/policy-versions', requirePermission('recommendations:read'), recommendations.versions);
router.get(
  '/projects/:id/recommendations',
  requirePermission('recommendations:read'),
  validate(idParam),
  enforceScope('project', { resource: 'recommendations' }),
  recommendations.list,
);
router.post(
  '/projects/:id/recommendations',
  expensiveLimiter,
  requirePermission('recommendations:generate'),
  validate(recommendationGenerate),
  enforceScope('project', { resource: 'recommendations' }),
  audit('RECOMMENDATION_GENERATE'),
  recommendations.generate,
);
router.patch(
  '/recommendations/:id/status',
  requirePermission('recommendations:manage'),
  validate(recommendationStatus),
  enforceScope('recommendation'),
  audit('RECOMMENDATION_STATUS_UPDATE', { subject: 'recommendation' }),
  recommendations.updateStatus,
);

// --- Users ------------------------------------------------------------------
router.get('/users/roles', requirePermission('users:read'), users.roles);
router.get('/users', requirePermission('users:read'), validate(userList), users.list);
router.get('/users/:id', requirePermission('users:read'), validate(idParam), users.get);
router.post('/users', expensiveLimiter, requirePermission('users:create'), validate(userCreate), audit('USER_CREATE'), users.create);
router.patch('/users/:id', requirePermission('users:update'), validate(userUpdate), audit('USER_UPDATE'), users.update);
router.post('/users/:id/deactivate', requirePermission('users:deactivate'), validate(idParam), audit('USER_DEACTIVATE'), users.deactivate);

// --- Audit logs -------------------------------------------------------------
// Reading the audit trail is itself an audited action.
router.get('/audit-logs', requirePermission('auditLogs:read'), validate(auditLogList), audit('AUDIT_LOG_READ'), auditLogs.list);

export default router;
