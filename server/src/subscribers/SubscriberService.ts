import { hasGeneralAccess } from '../../framework/core/roles.js';
import type { Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { SubscriberRepositoryContract } from './SubscriberContracts.js';
import type { ApplyLedgerState, ApplyMeterReading, SubscriberLedgerWriter, SubscriberMeterStateWriter, SubscriberSnapshot, SubscriberApi } from './SubscriberTypes.js';

export class SubscriberService implements SubscriberApi, SubscriberMeterStateWriter, SubscriberLedgerWriter {
  constructor(private readonly subscribers: SubscriberRepositoryContract) {}

  async listFor(actor: Actor): Promise<SubscriberSnapshot[]> {
    if (hasGeneralAccess(actor)) return this.subscribers.list();
    if (actor.role !== 'guest') {
      throw new ApplicationError('ACCESS_DENIED', 'Нет доступа к абонентам.', 403);
    }
    if (!actor.subscriberId) return [];
    const subscriber = await this.subscribers.findById(actor.subscriberId);
    return subscriber ? [subscriber] : [];
  }

  async getById(subscriberId: string): Promise<SubscriberSnapshot> {
    const subscriber = await this.subscribers.findById(subscriberId);
    if (!subscriber) {
      throw new ApplicationError('SUBSCRIBER_NOT_FOUND', 'Абонент не найден.', 404);
    }
    return subscriber;
  }

  async applyMeterReading(change: ApplyMeterReading): Promise<void> {
    if (!await this.subscribers.updateMeterState(change)) {
      throw new ApplicationError(
        'STATE_CHANGED',
        'Данные абонента изменились. Рассчитайте начисление заново.',
        409,
      );
    }
  }

  async applyLedgerState(change: ApplyLedgerState): Promise<void> {
    if (!await this.subscribers.updateLedgerState(change)) {
      throw new ApplicationError('STATE_CHANGED', 'Данные абонента изменились. Обновите расчёт.', 409);
    }
  }
}
