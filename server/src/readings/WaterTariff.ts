import { ApplicationError } from '../../framework/core/errors.js';
import { Money } from './Money.js';

type WaterServices = Readonly<{
  hasWater: boolean;
  hasDrainage: boolean;
  waterTariffKopeks: number;
  drainageTariffKopeks: number;
}>;

/** The charge uses the sum of enabled tariffs, rounded once after multiplication. */
export class WaterTariff {
  private constructor(readonly kopeksPerCubicMetre: number) {}

  static forEnabledServices(services: WaterServices): WaterTariff {
    const water = Money.fromKopeks(services.waterTariffKopeks);
    const drainage = Money.fromKopeks(services.drainageTariffKopeks);
    if (water.kopeks < 0 || drainage.kopeks < 0) {
      throw new ApplicationError('INVALID_TARIFF', 'Тариф не может быть отрицательным.');
    }
    const effective = Money.fromKopeks(
      (services.hasWater ? water.kopeks : 0) +
      (services.hasDrainage ? drainage.kopeks : 0),
    );
    return new WaterTariff(effective.kopeks);
  }
}
