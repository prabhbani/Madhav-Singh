export const pagination = (query: Record<string, unknown>) => {
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20)));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

export const pageResult = <T>(items: T[], total: number, page: number, pageSize: number) => ({ items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
