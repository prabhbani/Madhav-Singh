import { useQuery } from '@tanstack/react-query';
import { getRecommendations } from '../services/recommendationService';
import type { Project } from '../types/project';

export function useRecommendations(project: Project) {
  return useQuery({
    queryKey: ['recommendations', project.id],
    queryFn: () => getRecommendations(project),
    staleTime: 60_000,
  });
}
