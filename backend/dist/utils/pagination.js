export const pagination = (query) => {
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20)));
    return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};
export const pageResult = (items, total, page, pageSize) => ({ items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
