import type { SubscriberSnapshot } from '../subscribers/SubscriberTypes.js';
import type { ReadingCalculation } from './ReadingTypes.js';
import { ReadingCalculationData } from './ReadingCalculationData.js';
import { WaterTariff } from './WaterTariff.js';

export const WATER_READING_POLICY_VERSION = 'water-reading/v1';

/** Pure business scenario: no database, HTTP, container, clock or side effects. */
export function calculateWaterCharge(subscriber: SubscriberSnapshot, input: string): ReadingCalculation {
  const calculation = ReadingCalculationData.from(subscriber, input);
  const { previous, reading } = calculation;
  const tariff = WaterTariff.forEnabledServices(subscriber);
  const balance = calculation.balance;

  reading.ensureGreaterThan(previous);
  const consumption = reading.consumptionSince(previous);
  const charge = consumption.chargedAt(tariff);
  const balanceAfterCharge = balance.afterCharge(charge);

  return calculation.result({ tariff, consumption, charge, balanceAfterCharge }, WATER_READING_POLICY_VERSION);
}
