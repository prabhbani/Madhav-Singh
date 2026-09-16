/**
 * Scope subjects.
 *
 * A scope check needs the state, district, and department of the row being
 * touched. Most resources do not carry those columns themselves; they hang off a
 * project, so these loaders walk to the owning project and return its scope
 * attributes together with the resource's own id.
 */

import { prisma } from '../config/prisma.js';
import type { ScopeSubject } from './scope.js';

export type SubjectKind = 'project' | 'milestone' | 'document' | 'alert' | 'recommendation';

export type LoadedSubject = ScopeSubject & { resourceId: string; projectId: string };

const projectScopeSelect = { state: true, district: true, department: true } as const;

/** Loads the scope attributes for one resource, or null when it does not exist. */
export const loadSubject = async (kind: SubjectKind, id: string): Promise<LoadedSubject | null> => {
  switch (kind) {
    case 'project': {
      const row = await prisma.project.findUnique({ where: { id }, select: { id: true, ...projectScopeSelect } });
      return row ? { resourceId: row.id, projectId: row.id, state: row.state, district: row.district, department: row.department } : null;
    }
    case 'milestone': {
      const row = await prisma.milestone.findUnique({
        where: { id },
        select: { id: true, projectId: true, ownerDept: true, project: { select: projectScopeSelect } },
      });
      if (!row) return null;
      return {
        resourceId: row.id,
        projectId: row.projectId,
        state: row.project.state,
        district: row.project.district,
        // A milestone owned by another department still belongs to the project's
        // department for scope purposes; ownership only routes the work.
        department: row.project.department,
      };
    }
    case 'document': {
      const row = await prisma.document.findUnique({
        where: { id },
        select: { id: true, projectId: true, project: { select: projectScopeSelect } },
      });
      return row
        ? { resourceId: row.id, projectId: row.projectId, ...row.project }
        : null;
    }
    case 'alert': {
      const row = await prisma.alert.findUnique({
        where: { id },
        select: { id: true, projectId: true, project: { select: projectScopeSelect } },
      });
      return row ? { resourceId: row.id, projectId: row.projectId, ...row.project } : null;
    }
    case 'recommendation': {
      const row = await prisma.recommendation.findUnique({
        where: { id },
        select: { id: true, projectId: true, project: { select: projectScopeSelect } },
      });
      return row ? { resourceId: row.id, projectId: row.projectId, ...row.project } : null;
    }
    default:
      return null;
  }
};
