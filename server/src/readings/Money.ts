import { ApplicationError } from '../../framework/core/errors.js';

const MIN_KOPEKS = -2_147_483_648n;
const MAX_KOPEKS = 2_147_483_647n;

/** Money is stored and calculated in kopeks; no floating-point arithmetic. */
export class Money {
  private constructor(private readonly amount: bigint) {}

  static fromKopeks(amount: number | bigint): Money {
    if (typeof amount === 'number' && !Number.isSafeInteger(amount)) {
      throw new ApplicationError('INVALID_MONEY', 'Денежная сумма должна быть целым числом копеек.');
    }
    const value = BigInt(amount);
    if (value < MIN_KOPEKS || value > MAX_KOPEKS) {
      throw new ApplicationError('MONEY_OUT_OF_RANGE', 'Денежная сумма превышает допустимый предел.');
    }
    return new Money(value);
  }

  get kopeks(): number { return Number(this.amount); }

  subtract(charge: Money): Money {
    return Money.fromKopeks(this.amount - charge.amount);
  }
}
