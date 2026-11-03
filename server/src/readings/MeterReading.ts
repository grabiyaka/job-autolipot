import { ApplicationError } from '../../framework/core/errors.js';
import { WaterConsumption } from './WaterConsumption.js';

const MAX_READING_HUNDREDTHS = 999_999_999;

export class MeterReading {
  private constructor(readonly hundredths: number) {}

  static fromHundredths(value: number): MeterReading {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_READING_HUNDREDTHS) {
      throw new ApplicationError('READING_OUT_OF_RANGE', 'Показание должно быть от 0 до 9 999 999,99 м³.');
    }
    return new MeterReading(value);
  }

  static fromInput(input: string): MeterReading {
    if (typeof input !== 'string' || input.length > 64 || !/^\d+(?:[.,]\d+)?$/.test(input.trim())) {
      throw new ApplicationError('INVALID_READING', 'Введите неотрицательное показание, например 125,35.');
    }
    const [wholePart = '0', fractionalPart = ''] = input.trim().replace(',', '.').split('.');
    const whole = wholePart.replace(/^0+/, '') || '0';
    if (whole.length > 7) {
      throw new ApplicationError('READING_OUT_OF_RANGE', 'Показание должно быть от 0 до 9 999 999,99 м³.');
    }
    // Parse the decimal string exactly before HALF_UP normalization to two places.
    const fraction = fractionalPart.padEnd(2, '0').slice(0, 2);
    const rounding = (fractionalPart[2] ?? '0') >= '5' ? 1n : 0n;
    const hundredths = BigInt(whole) * 100n + BigInt(fraction) + rounding;
    return MeterReading.fromHundredths(Number(hundredths));
  }

  ensureGreaterThan(previous: MeterReading): void {
    if (this.hundredths <= previous.hundredths) {
      throw new ApplicationError(
        'READING_MUST_INCREASE',
        'Новое показание после округления должно быть больше предыдущего.',
      );
    }
  }

  consumptionSince(previous: MeterReading): WaterConsumption {
    this.ensureGreaterThan(previous);
    return new WaterConsumption(this.hundredths - previous.hundredths);
  }
}
