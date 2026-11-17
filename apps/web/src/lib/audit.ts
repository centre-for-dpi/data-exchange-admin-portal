import { type Timeline, timelineSchema } from '@den/contracts';
import { ApiError, apiGet } from './api';

/**
 * Timeline of one of the active entity's objects. An object the entity cannot see returns an
 * empty timeline: the page around it already decided what to show.
 */
export async function entityTimeline(
  entityId: string,
  kind: 'subscription' | 'api',
  id: string,
): Promise<Timeline['items']> {
  try {
    return (await apiGet(`/entities/${entityId}/audit/timeline/${kind}/${id}`, timelineSchema))
      .items;
  } catch (error) {
    if (error instanceof ApiError && [403, 404].includes(error.status)) return [];
    throw error;
  }
}
