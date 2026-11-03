import { ensureSubscriberAccess, normalizeRecordedActor, type Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { Clock, Identifiers } from '../../framework/core/runtime.js';
import type { SubscriberApi } from '../subscribers/SubscriberTypes.js';
import { calculateWaterCharge } from './ReadingRules.js';
import type { ReadingUnitOfWork } from './ReadingContracts.js';
import type { ReadingRepositoryContract } from './ReadingContracts.js';
import type {
  ReadingCalculation, ReadingInput, ReadingRecord, ReadingApi, SubmitReadingInput, SubmitReadingResult,
} from './ReadingTypes.js';

export class ReadingService implements ReadingApi {
  constructor(
    private readonly subscribers: SubscriberApi,
    private readonly readings: ReadingRepositoryContract,
    private readonly unitOfWork: ReadingUnitOfWork,
    private readonly clock: Clock,
    private readonly identifiers: Identifiers,
  ) {}

  async preview(input: ReadingInput, actor: Actor): Promise<ReadingCalculation> {
    ensureSubscriberAccess(actor, input.subscriberId);
    const subscriber = await this.subscribers.getById(input.subscriberId);
    return calculateWaterCharge(subscriber, input.reading);
  }

  async history(subscriberId: string, actor: Actor): Promise<ReadingRecord[]> {
    ensureSubscriberAccess(actor, subscriberId);
    await this.subscribers.getById(subscriberId);
    return this.readings.historyFor(subscriberId);
  }

  async submit(input: SubmitReadingInput, actor: Actor, idempotencyKey: string): Promise<SubmitReadingResult> {
    ensureSubscriberAccess(actor, input.subscriberId);
    this.ensureValidSubmission(input, idempotencyKey);

    const existing = await this.readings.findByIdempotencyKey(idempotencyKey);
    if (existing) return this.replayMatchingSubmission(existing, input, actor);

    try {
      return await this.unitOfWork.run(async ({ subscribers, readings, transactions }) => {
        const existingInTransaction = await readings.findByIdempotencyKey(idempotencyKey);
        if (existingInTransaction) return this.replayMatchingSubmission(existingInTransaction, input, actor);

        const subscriber = await subscribers.getById(input.subscriberId);
        if (subscriber.version !== input.expectedVersion) {
          throw new ApplicationError(
            'STATE_CHANGED',
            'Данные абонента изменились после расчёта. Рассчитайте начисление заново.',
            409,
          );
        }

        const calculation = calculateWaterCharge(subscriber, input.reading);
        const record: ReadingRecord = {
          id: this.identifiers.next(),
          idempotencyKey,
          originalInput: { ...input },
          actor: { ...actor },
          source: 'demo-api',
          createdAt: this.clock.now().toISOString(),
          subscriberBefore: { ...subscriber },
          calculation,
        };

        // Cross-domain state changes use the subscriber domain's public API.
        await subscribers.applyMeterReading({
          subscriberId: subscriber.id,
          expectedVersion: subscriber.version,
          readingHundredths: calculation.newReadingHundredths,
          balanceKopeks: calculation.balanceAfterKopeks,
        });
        await readings.save(record);
        await transactions.recordReading(record);
        return { record, replayed: false };
      });
    } catch (error) {
      // A concurrent transaction may have committed the same request while ours rolled back.
      const concurrentlyCommitted = await this.readings.findByIdempotencyKey(idempotencyKey);
      if (concurrentlyCommitted) return this.replayMatchingSubmission(concurrentlyCommitted, input, actor);
      throw error;
    }
  }

  private ensureValidSubmission(input: SubmitReadingInput, idempotencyKey: string): void {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) {
      throw new ApplicationError('INVALID_IDEMPOTENCY_KEY', 'Ключ операции должен содержать от 1 до 128 символов.', 400);
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > 2_147_483_647) {
      throw new ApplicationError('INVALID_VERSION', 'Передайте версию абонента из предварительного расчёта.', 400);
    }
  }

  private replayMatchingSubmission(record: ReadingRecord, input: SubmitReadingInput, actor: Actor): SubmitReadingResult {
    const sameInput = record.originalInput.subscriberId === input.subscriberId &&
      record.originalInput.reading === input.reading &&
      record.originalInput.expectedVersion === input.expectedVersion;
    const recordedActor = normalizeRecordedActor(record.actor);
    const sameActor = recordedActor.id === actor.id && recordedActor.role === actor.role &&
      recordedActor.subscriberId === actor.subscriberId;
    if (!sameInput || !sameActor) {
      throw new ApplicationError(
        'IDEMPOTENCY_CONFLICT',
        'Этот ключ операции уже использован для другого запроса.',
        409,
      );
    }
    return { record, replayed: true };
  }
}
