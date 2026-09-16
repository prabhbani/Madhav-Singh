/**
 * Notification fan-out.
 *
 * The early warning engine decides *whether* an alert notifies; this service
 * only delivers what it is given. Delivery adapters for email, SMS, or a
 * government messaging bus subscribe here.
 */
import { logger } from '../config/logger.js';
export const notificationService = {
    async publish(event) {
        // Identifiers and severity only. The description and recommended action
        // describe a real case, and a log sink is a wider audience than the people
        // authorized to read that case.
        logger.info({
            channel: 'notification-event',
            type: event.type,
            projectId: event.projectId,
            alertId: event.alertId ?? null,
            alertType: event.alertType ?? null,
            severity: event.severity ?? null,
            recipientCount: event.recipientIds.length,
            occurredAt: event.occurredAt ?? new Date().toISOString(),
        });
    },
    /** Publishes a batch, isolating a failing adapter from the rest. */
    async publishAll(events) {
        let published = 0;
        let failed = 0;
        for (const event of events) {
            try {
                await notificationService.publish(event);
                published += 1;
            }
            catch (error) {
                failed += 1;
                logger.error({ channel: 'notification-error', type: event.type }, error);
            }
        }
        return { published, failed };
    },
};
