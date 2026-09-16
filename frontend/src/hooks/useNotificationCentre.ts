import { useQuery } from '@tanstack/react-query';
import { getNotificationCentre } from '../services/alertService';

export function useNotificationCentre() {
  return useQuery({
    queryKey: ['notification-centre'],
    queryFn: getNotificationCentre,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
