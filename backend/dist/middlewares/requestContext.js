import { randomUUID } from 'node:crypto';
export const requestContext = (request, response, next) => {
    request.requestId = request.header('x-request-id') ?? randomUUID();
    response.setHeader('x-request-id', request.requestId);
    next();
};
