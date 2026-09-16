import { AppError } from '../errors/AppError.js';
import { projectRepository } from '../repositories/projectRepository.js';
import { pageResult, pagination } from '../utils/pagination.js';
import { projectScopeWhere, type AccessScope } from '../authz/scope.js';

/**
 * Project operations.
 *
 * Reads of a single project are scope-checked by the `enforceScope` middleware
 * before the handler runs. List reads are filtered here, because a filter is the
 * only way to keep out-of-scope rows out of a collection response.
 */
export const projectService = {
  async list(scope: AccessScope, query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = pagination(query);
    const filter = {
      search: typeof query.search === 'string' ? query.search : undefined,
      status: typeof query.status === 'string' ? query.status : undefined,
      scopeWhere: projectScopeWhere(scope),
    };
    const [items, total] = await Promise.all([
      projectRepository.list({ ...filter, skip, take }),
      projectRepository.count(filter),
    ]);
    return pageResult(items, total, page, pageSize);
  },
  async get(id: string) {
    const project = await projectRepository.get(id);
    if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');
    return project;
  },
  create: (data: Record<string, unknown>, createdById?: string) => projectRepository.create({ ...data, createdById }),
  update: async (id: string, data: Record<string, unknown>) => { await projectService.get(id); return projectRepository.update(id, data); },
  remove: async (id: string) => { await projectService.get(id); return projectRepository.delete(id); },
  milestones: async (id: string) => { await projectService.get(id); return projectRepository.milestones(id); },
  createMilestone: async (projectId: string, data: Record<string, unknown>) => { await projectService.get(projectId); return projectRepository.createMilestone({ ...data, projectId }); },
  updateMilestone: (id: string, data: Record<string, unknown>) => projectRepository.updateMilestone(id, data),
  exportDataset: (scope: AccessScope) => projectRepository.exportRows(projectScopeWhere(scope)),
};
