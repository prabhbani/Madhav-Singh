import { authService } from '../services/authService.js';
export const login = async (request, response) => response.json(await authService.login(request, request.body.email, request.body.password));
export const logout = async (request, response) => {
    await authService.logout(request);
    response.status(204).send();
};
