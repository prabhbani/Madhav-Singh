import { userService, assignableRoles } from '../services/userService.js';
import { currentScope } from '../middlewares/authorize.js';
import { AppError } from '../errors/AppError.js';
const actor = (request) => {
    if (!request.user)
        throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required');
    return request.user;
};
export const list = async (request, response) => response.json(await userService.list(currentScope(request), request.query));
export const get = async (request, response) => response.json(await userService.get(currentScope(request), String(request.params.id)));
export const create = async (request, response) => response.status(201).json(await userService.create(currentScope(request), actor(request).role, request.body));
export const update = async (request, response) => response.json(await userService.update(currentScope(request), actor(request).role, String(request.params.id), request.body));
export const deactivate = async (request, response) => response.json(await userService.deactivate(currentScope(request), actor(request).role, actor(request).id, String(request.params.id)));
/** The roles the caller may assign, so an admin UI cannot offer an invalid one. */
export const roles = async (request, response) => response.json({ assignable: assignableRoles(actor(request).role) });
