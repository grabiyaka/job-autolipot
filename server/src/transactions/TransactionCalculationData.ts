import { hasGeneralAccess } from '../../framework/core/roles.js';
import { ensureSubscriberAccess, type Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { SubscriberSnapshot } from '../subscribers/SubscriberTypes.js';
import {
  balanceKopeks, chargeForSignedConsumption, checkedMoney, checkedReading,
  decimalLabel, paymentKopeks, readingHundredths,
} from './TransactionAmount.js';
import type {
  CreateTransactionInput, PaymentInput, ReconciliationInput, TransactionCategory,
  TransactionEffect, TransactionKind, TransactionPayment, TransactionReadingInput,
  TransactionRecord, TransactionState, TransactionTariff,
} from './TransactionTypes.js';

export const TRANSACTION_POLICY_VERSION = 'vodogon-transactions/legacy-maintenance-first-v1';

const protectedKinds = new Set<TransactionKind>([
  'origin', 'cancellation', 'description-change',
  'maintenance-fee', 'maintenance-transfer', 'maintenance-fee-reversal', 'maintenance-transfer-reversal',
  'meter-replacement-closing', 'meter-replacement-reset',
]);

function requiredText(input: string, code: string, message: string): string {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 2_000) {
    throw new ApplicationError(code, message);
  }
  return input.trim();
}

function optionalText(input: string | undefined, code: string, message: string): string | null {
  return input === undefined ? null : requiredText(input, code, message);
}

type ResultDetails = Readonly<{
  kind: TransactionKind; category: TransactionCategory; description: string;
  payment?: TransactionPayment; confirmsReading?: boolean;
}>;

/** Prepares numeric inputs and immutable evidence; scenario order lives in TransactionRules. */
export class TransactionCalculationData {
  readonly before: TransactionState;
  private readonly tariff: TransactionTariff;

  private constructor(private readonly subscriber: SubscriberSnapshot) {
    this.before = Object.freeze({
      balanceKopeks: checkedMoney(subscriber.balanceKopeks),
      maintenanceBalanceKopeks: checkedMoney(subscriber.maintenanceBalanceKopeks),
      readingHundredths: checkedReading(subscriber.readingHundredths),
    });
    const water = checkedMoney(subscriber.waterTariffKopeks);
    const drainage = checkedMoney(subscriber.drainageTariffKopeks);
    if (water < 0 || drainage < 0) throw new ApplicationError('INVALID_TARIFF', 'Тариф не может быть отрицательным.');
    this.tariff = Object.freeze({
      waterKopeks: water, drainageKopeks: drainage,
      effectiveKopeks: checkedMoney((subscriber.hasWater ? water : 0) + (subscriber.hasDrainage ? drainage : 0)),
      hasWater: subscriber.hasWater, hasDrainage: subscriber.hasDrainage,
    });
  }

  static from(subscriber: SubscriberSnapshot): TransactionCalculationData {
    return new TransactionCalculationData(subscriber);
  }

  maintenanceBalance(): number { return this.before.maintenanceBalanceKopeks; }
  tariffForEnabledServices(): TransactionTariff { return this.tariff; }

  requireAllowedOperation(input: CreateTransactionInput, actor: Actor): void {
    if (input.subscriberId !== this.subscriber.id) {
      throw new ApplicationError('TRANSACTION_SUBSCRIBER_MISMATCH', 'Операция относится к другому абоненту.', 409);
    }
    ensureSubscriberAccess(actor, input.subscriberId);
    if (!hasGeneralAccess(actor) && (input.kind !== 'reading' || input.verified)) {
      throw new ApplicationError('ACCESS_DENIED', 'Эта операция доступна администратору или менеджеру.', 403);
    }
  }

  paymentFrom(input: PaymentInput): PaymentCalculation {
    return new PaymentCalculation(input);
  }

  readingFrom(input: TransactionReadingInput): ReadingCalculation {
    return new ReadingCalculation(this.before.readingHundredths, input);
  }

  reconciliationFrom(input: ReconciliationInput): ReconciliationCalculation {
    return new ReconciliationCalculation(input);
  }

  paymentResult(payment: PaymentCalculation, maintenanceCredit: number, waterCredit: number): TransactionEffect {
    return this.result({
      balanceKopeks: waterCredit, maintenanceBalanceKopeks: maintenanceCredit, readingHundredths: 0,
    }, {
      kind: 'payment', category: payment.method,
      description: `Оплата${payment.method === 'bank' ? ' банк' : ''} ${decimalLabel(payment.amountKopeks)} грн.`,
      payment: Object.freeze({
        amountKopeks: payment.amountKopeks, waterKopeks: waterCredit, maintenanceKopeks: maintenanceCredit,
        method: payment.method, externalReference: payment.externalReference, purpose: payment.purpose,
      }),
    });
  }

  readingResult(reading: ReadingCalculation, consumption: number, charge: number): TransactionEffect {
    const confirmsReading = reading.verified;
    return this.result({ balanceKopeks: charge, maintenanceBalanceKopeks: 0, readingHundredths: consumption }, {
      kind: confirmsReading ? 'meter-reconciliation' : 'meter-reading',
      category: consumption > 0 ? 'system' : 'recalculation',
      description: `${consumption > 0 ? 'Нараховано:' : 'Перерахунок'} ${decimalLabel(Math.abs(consumption))} м³.`,
      confirmsReading,
    });
  }

  reconciliationResult(reconciliation: ReconciliationCalculation, target: TransactionState): TransactionEffect {
    const movement = target.readingHundredths !== this.before.readingHundredths;
    return this.result({
      balanceKopeks: checkedMoney(target.balanceKopeks - this.before.balanceKopeks),
      maintenanceBalanceKopeks: checkedMoney(target.maintenanceBalanceKopeks - this.before.maintenanceBalanceKopeks),
      readingHundredths: target.readingHundredths - this.before.readingHundredths,
    }, {
      kind: movement ? 'meter-reconciliation' : 'recalculation', category: 'recalculation',
      description: reconciliation.reason, confirmsReading: movement,
    });
  }

  noteResult(description: string): TransactionEffect {
    return this.unchangedResult('note', requiredText(description, 'DESCRIPTION_REQUIRED', 'Укажите описание операции.'));
  }

  requireOwnSource(source: TransactionRecord): void {
    if (source.subscriberId !== this.subscriber.id) {
      throw new ApplicationError('TRANSACTION_SUBSCRIBER_MISMATCH', 'Операция относится к другому абоненту.', 409);
    }
  }

  requireOrdinaryOperation(source: TransactionRecord): void {
    if (protectedKinds.has(source.effect.kind)) {
      throw new ApplicationError('TRANSACTION_REQUIRES_DEDICATED_WORKFLOW', 'Для этой операции требуется отдельный сценарий изменения.', 409);
    }
  }

  requireNotCancelled(source: TransactionRecord, history: readonly TransactionRecord[]): void {
    if (history.some(record => record.subscriberId === source.subscriberId && record.reversesId === source.id)) {
      throw new ApplicationError('TRANSACTION_ALREADY_CANCELLED', 'Эта операция уже отменена.', 409);
    }
  }

  requireNoLaterMaintenance(source: TransactionRecord, history: readonly TransactionRecord[]): void {
    const reversed = new Set(history.filter(record => record.subscriberId === source.subscriberId).map(record => record.reversesId));
    const laterMaintenance = history.some(record => record.subscriberId === source.subscriberId
      && (Date.parse(record.effectiveAt) - Date.parse(source.effectiveAt)
        || record.sequence - source.sequence || record.id.localeCompare(source.id)) > 0
      && (record.effect.kind === 'maintenance-fee' || record.effect.kind === 'maintenance-transfer')
      && !reversed.has(record.id));
    if (laterMaintenance) {
      throw new ApplicationError('TRANSACTION_HAS_LATER_MAINTENANCE', 'После операции есть действующее начисление обслуживания. Требуется отдельная отмена.', 409);
    }
  }

  reverseOriginalChanges(source: TransactionRecord): TransactionState {
    return {
      balanceKopeks: checkedMoney(-source.effect.change.balanceKopeks),
      maintenanceBalanceKopeks: checkedMoney(-source.effect.change.maintenanceBalanceKopeks),
      readingHundredths: 0 - source.effect.change.readingHundredths,
    };
  }

  cancellationResult(change: TransactionState, reason: string): TransactionEffect {
    return this.result(change, {
      kind: 'cancellation', category: 'recalculation',
      description: requiredText(reason, 'REASON_REQUIRED', 'Укажите причину отмены.'),
    });
  }

  descriptionResult(description: string): TransactionEffect {
    return this.unchangedResult('description-change', requiredText(description, 'DESCRIPTION_REQUIRED', 'Укажите новое описание.'));
  }

  private unchangedResult(kind: TransactionKind, description: string): TransactionEffect {
    return this.result({ balanceKopeks: 0, maintenanceBalanceKopeks: 0, readingHundredths: 0 }, {
      kind, category: 'note', description,
    });
  }

  private result(change: TransactionState, details: ResultDetails): TransactionEffect {
    const after = Object.freeze({
      balanceKopeks: checkedMoney(this.before.balanceKopeks + change.balanceKopeks),
      maintenanceBalanceKopeks: checkedMoney(this.before.maintenanceBalanceKopeks + change.maintenanceBalanceKopeks),
      readingHundredths: checkedReading(this.before.readingHundredths + change.readingHundredths),
    });
    return Object.freeze({
      kind: details.kind, category: details.category, description: details.description,
      before: this.before, change: Object.freeze({ ...change }), after, tariff: this.tariff,
      payment: details.payment ?? null, confirmsReading: details.confirmsReading ?? false,
      policyVersion: TRANSACTION_POLICY_VERSION,
    });
  }
}

class PaymentCalculation {
  readonly amountKopeks: number;
  readonly method: 'cash' | 'bank';
  readonly externalReference: string | null;
  readonly purpose: string | null;

  constructor(input: PaymentInput) {
    this.amountKopeks = paymentKopeks(input.amount);
    this.method = input.method;
    if (input.method !== 'cash' && input.method !== 'bank') throw new ApplicationError('INVALID_PAYMENT_METHOD', 'Выберите наличную или банковскую оплату.');
    this.externalReference = input.method === 'bank'
      ? requiredText(input.externalReference ?? '', 'BANK_REFERENCE_REQUIRED', 'Укажите идентификатор банковского платежа.')
      : optionalText(input.externalReference, 'INVALID_BANK_REFERENCE', 'Укажите корректный идентификатор платежа.');
    this.purpose = optionalText(input.purpose, 'INVALID_PAYMENT_PURPOSE', 'Укажите корректное назначение платежа.');
  }

  coverMaintenanceDebt(balance: number): number { return Math.min(this.amountKopeks, Math.max(0, -balance)); }
  creditRemainderToWater(maintenanceCredit: number): number { return this.amountKopeks - maintenanceCredit; }
}

class ReadingCalculation {
  readonly reading: number;
  readonly verified: boolean;

  constructor(private readonly previous: number, input: TransactionReadingInput) {
    this.reading = readingHundredths(input.reading);
    this.verified = input.verified ?? false;
  }

  requireChangedNonzeroReading(): void {
    if (this.reading === 0) throw new ApplicationError('INVALID_READING', 'Показание должно быть больше нуля.');
    if (this.reading === this.previous) throw new ApplicationError('READING_UNCHANGED', 'Показание после округления не изменилось.');
  }

  requireIncreaseForSubscriber(actor: Actor): void {
    if (!hasGeneralAccess(actor) && this.reading <= this.previous) {
      throw new ApplicationError('READING_MUST_INCREASE', 'Новое показание должно быть больше предыдущего.');
    }
  }

  consumptionSincePreviousReading(): number { return this.reading - this.previous; }
  chargedAt(consumption: number, tariff: TransactionTariff): number { return chargeForSignedConsumption(consumption, tariff.effectiveKopeks); }
}

class ReconciliationCalculation {
  readonly reason: string;
  private readonly target: TransactionState;

  constructor(input: ReconciliationInput) {
    this.reason = requiredText(input.reason, 'REASON_REQUIRED', 'Укажите причину перерасчёта.');
    this.target = {
      balanceKopeks: balanceKopeks(input.balance),
      maintenanceBalanceKopeks: balanceKopeks(input.maintenanceBalance),
      readingHundredths: readingHundredths(input.reading),
    };
  }

  stateAtRequestedValues(): TransactionState { return this.target; }
}
