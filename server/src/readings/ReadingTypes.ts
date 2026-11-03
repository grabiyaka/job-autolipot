import type { Actor, RecordedActor } from '../../framework/core/actor.js';
import type { SubscriberSnapshot } from '../subscribers/SubscriberTypes.js';

export type ReadingInput = Readonly<{ subscriberId: string; reading: string }>;
export type SubmitReadingInput = ReadingInput & Readonly<{ expectedVersion: number }>;

export type ReadingCalculation = Readonly<{
  subscriberId: string;
  accountNumber: string;
  previousReadingHundredths: number;
  newReadingHundredths: number;
  consumptionHundredths: number;
  waterTariffKopeks: number;
  drainageTariffKopeks: number;
  effectiveTariffKopeks: number;
  hasWater: boolean;
  hasDrainage: boolean;
  chargeKopeks: number;
  balanceBeforeKopeks: number;
  balanceAfterKopeks: number;
  subscriberVersion: number;
  policyVersion: string;
}>;

export type ReadingRecord = Readonly<{
  id: string;
  idempotencyKey: string;
  originalInput: SubmitReadingInput;
  actor: RecordedActor;
  source: 'demo-api';
  createdAt: string;
  subscriberBefore: SubscriberSnapshot;
  calculation: ReadingCalculation;
}>;

export type SubmitReadingResult = Readonly<{ record: ReadingRecord; replayed: boolean }>;

export interface ReadingApi {
  preview(input: ReadingInput, actor: Actor): Promise<ReadingCalculation>;
  submit(input: SubmitReadingInput, actor: Actor, idempotencyKey: string): Promise<SubmitReadingResult>;
  history(subscriberId: string, actor: Actor): Promise<ReadingRecord[]>;
}
