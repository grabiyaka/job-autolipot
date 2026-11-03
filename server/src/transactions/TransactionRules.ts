import type { Actor } from '../../framework/core/actor.js';
import type { SubscriberSnapshot } from '../subscribers/SubscriberTypes.js';
import { TransactionCalculationData } from './TransactionCalculationData.js';
import type { CreateTransactionInput, TransactionEffect, TransactionRecord } from './TransactionTypes.js';

/** Pure Vodogon scenarios. Parsing, precision and evidence assembly stay behind named steps. */
export function calculateTransaction(subscriber: SubscriberSnapshot, input: CreateTransactionInput, actor: Actor): TransactionEffect {
  const calculation = TransactionCalculationData.from(subscriber);
  calculation.requireAllowedOperation(input, actor);

  switch (input.kind) {
    case 'payment': {
      const payment = calculation.paymentFrom(input);
      const maintenanceCredit = payment.coverMaintenanceDebt(calculation.maintenanceBalance());
      const waterCredit = payment.creditRemainderToWater(maintenanceCredit);

      return calculation.paymentResult(payment, maintenanceCredit, waterCredit);
    }
    case 'reading': {
      const reading = calculation.readingFrom(input);
      reading.requireChangedNonzeroReading();
      reading.requireIncreaseForSubscriber(actor);
      const tariff = calculation.tariffForEnabledServices();
      const consumption = reading.consumptionSincePreviousReading();
      const charge = reading.chargedAt(consumption, tariff);

      return calculation.readingResult(reading, consumption, charge);
    }
    case 'reconciliation': {
      const reconciliation = calculation.reconciliationFrom(input);
      const requestedState = reconciliation.stateAtRequestedValues();

      return calculation.reconciliationResult(reconciliation, requestedState);
    }
    case 'note':
      return calculation.noteResult(input.description);
  }
}

export function calculateCancellation(subscriber: SubscriberSnapshot, source: TransactionRecord, history: readonly TransactionRecord[], reason: string): TransactionEffect {
  const calculation = TransactionCalculationData.from(subscriber);
  calculation.requireOwnSource(source);
  calculation.requireOrdinaryOperation(source);
  calculation.requireNotCancelled(source, history);
  calculation.requireNoLaterMaintenance(source, history);
  const reversal = calculation.reverseOriginalChanges(source);

  return calculation.cancellationResult(reversal, reason);
}

export function calculateDescriptionChange(subscriber: SubscriberSnapshot, source: TransactionRecord, description: string): TransactionEffect {
  const calculation = TransactionCalculationData.from(subscriber);
  calculation.requireOwnSource(source);
  calculation.requireOrdinaryOperation(source);

  return calculation.descriptionResult(description);
}
