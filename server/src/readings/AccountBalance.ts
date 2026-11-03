import { Money } from './Money.js';

export class AccountBalance {
  private constructor(private readonly amount: Money) {}

  static fromKopeks(amount: number): AccountBalance {
    return new AccountBalance(Money.fromKopeks(amount));
  }

  afterCharge(charge: Money): AccountBalance {
    return new AccountBalance(this.amount.subtract(charge));
  }

  get kopeks(): number { return this.amount.kopeks; }
}
