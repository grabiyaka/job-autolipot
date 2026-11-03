import type { SubscriberSnapshot } from '../subscribers/SubscriberTypes.js';
import { AccountBalance } from './AccountBalance.js';
import { MeterReading } from './MeterReading.js';
import type { Money } from './Money.js';
import type { ReadingCalculation } from './ReadingTypes.js';
import type { WaterConsumption } from './WaterConsumption.js';
import type { WaterTariff } from './WaterTariff.js';

type ChargeResult = Readonly<{
  tariff: WaterTariff;
  consumption: WaterConsumption;
  charge: Money;
  balanceAfterCharge: AccountBalance;
}>;

/** Converts input and output representations without choosing or applying billing rules. */
export class ReadingCalculationData {
  private constructor(
    private readonly subscriber: SubscriberSnapshot,
    readonly previous: MeterReading,
    readonly reading: MeterReading,
  ) {}

  static from(subscriber: SubscriberSnapshot, input: string): ReadingCalculationData {
    return new ReadingCalculationData(
      subscriber,
      MeterReading.fromHundredths(subscriber.readingHundredths),
      MeterReading.fromInput(input),
    );
  }

  get balance(): AccountBalance {
    return AccountBalance.fromKopeks(this.subscriber.balanceKopeks);
  }

  result(calculated: ChargeResult, policyVersion: string): ReadingCalculation {
    const { tariff, consumption, charge, balanceAfterCharge } = calculated;
    return {
      subscriberId: this.subscriber.id,
      accountNumber: this.subscriber.accountNumber,
      previousReadingHundredths: this.previous.hundredths,
      newReadingHundredths: this.reading.hundredths,
      consumptionHundredths: consumption.hundredths,
      waterTariffKopeks: this.subscriber.waterTariffKopeks,
      drainageTariffKopeks: this.subscriber.drainageTariffKopeks,
      effectiveTariffKopeks: tariff.kopeksPerCubicMetre,
      hasWater: this.subscriber.hasWater,
      hasDrainage: this.subscriber.hasDrainage,
      chargeKopeks: charge.kopeks,
      balanceBeforeKopeks: this.subscriber.balanceKopeks,
      balanceAfterKopeks: balanceAfterCharge.kopeks,
      subscriberVersion: this.subscriber.version,
      policyVersion,
    };
  }
}
