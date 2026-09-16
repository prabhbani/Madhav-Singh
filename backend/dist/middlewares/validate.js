export const validate = (schema) => (request, _response, next) => {
    const result = schema.safeParse({ body: request.body, params: request.params, query: request.query });
    if (!result.success)
        return next(result.error);
    const data = result.data;
    request.body = data.body;
    request.params = data.params;
    request.query = data.query;
    next();
};
