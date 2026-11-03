import { ApplicationError } from '../../framework/core/errors.js';

export function normalizedEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ApplicationError('INVALID_EMAIL', 'Укажите корректный email.', 400);
  }
  return normalized;
}
