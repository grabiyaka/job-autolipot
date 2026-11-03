import { ApplicationError } from '../../framework/core/errors.js';

const MIN_MONEY = -2_147_483_648n;
const MAX_MONEY = 2_147_483_647n;
const MAX_READING = 999_999_999n;

/** Decimal input is parsed before rounding; binary floating point never chooses a cent. */
function decimalHundredths(input: string, code: string, exact: boolean, signed: boolean): bigint {
  const pattern = signed ? /^-?\d+(?:[.,]\d+)?$/ : /^\d+(?:[.,]\d+)?$/;
  if (typeof input !== 'string' || input.length > 64 || !pattern.test(input.trim())) {
    throw new ApplicationError(code, 'Введите корректное десятичное число.');
  }
  const value = input.trim().replace(',', '.');
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  if (exact && /[1-9]/.test(fraction.slice(2))) {
    throw new ApplicationError(code, 'Сумма оплаты должна быть указана с точностью до копейки.');
  }
  const rounding = !exact && (fraction[2] ?? '0') >= '5' ? 1n : 0n;
  const magnitude = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2)) + rounding;
  return negative ? -magnitude : magnitude;
}

function money(value: bigint): number {
  if (value < MIN_MONEY || value > MAX_MONEY) {
    throw new ApplicationError('MONEY_OUT_OF_RANGE', 'Денежная сумма превышает допустимый предел.');
  }
  return Number(value);
}

export function checkedMoney(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new ApplicationError('INVALID_MONEY', 'Денежная сумма должна быть целым числом копеек.');
  }
  return money(BigInt(value));
}

export function paymentKopeks(input: string): number {
  const value = decimalHundredths(input, 'INVALID_PAYMENT', true, false);
  if (value <= 0n) throw new ApplicationError('INVALID_PAYMENT', 'Сумма оплаты должна быть положительной.');
  return money(value);
}

export function balanceKopeks(input: string): number {
  return money(decimalHundredths(input, 'INVALID_MONEY', false, true));
}

export function checkedReading(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > MAX_READING) {
    throw new ApplicationError('READING_OUT_OF_RANGE', 'Показание должно быть от 0 до 9 999 999,99 м³.');
  }
  return value;
}

export function readingHundredths(input: string): number {
  const value = decimalHundredths(input, 'INVALID_READING', false, false);
  if (value > MAX_READING) {
    throw new ApplicationError('READING_OUT_OF_RANGE', 'Показание должно быть от 0 до 9 999 999,99 м³.');
  }
  return checkedReading(Number(value));
}

export function chargeForSignedConsumption(consumption: number, tariff: number): number {
  const product = BigInt(consumption) * BigInt(tariff);
  const magnitude = product < 0n ? -product : product;
  const rounded = (magnitude + 50n) / 100n;
  return money(product < 0n ? rounded : -rounded);
}

export function decimalLabel(hundredths: number): string {
  return (hundredths / 100).toFixed(2);
}
