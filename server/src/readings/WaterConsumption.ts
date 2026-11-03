import { Money } from './Money.js';
import type { WaterTariff } from './WaterTariff.js';

export class WaterConsumption {
  constructor(readonly hundredths: number) {}

  chargedAt(tariff: WaterTariff): Money {
    const chargeInHundredthsOfAKopek = BigInt(this.hundredths) * BigInt(tariff.kopeksPerCubicMetre);
    // HALF_UP: volume is hundredths of a cubic metre, tariff is kopeks per cubic metre.
    return Money.fromKopeks((chargeInHundredthsOfAKopek + 50n) / 100n);
  }
}
