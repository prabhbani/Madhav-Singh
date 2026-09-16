import { permissionMatrix } from '../authz/permissions.js';
import { sessionSummary } from '../middlewares/authorize.js';
/** The caller's own role, scope, and permissions. Drives the frontend guards. */
export const me = async (request, response) => response.json(sessionSummary(request));
/** The full role-to-permission matrix, for admin screens and documentation. */
export const matrix = async (_request, response) => response.json(permissionMatrix());
