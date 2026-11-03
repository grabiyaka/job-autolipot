import { ApplicationError } from '../../framework/core/errors.js';
import { isUserRole } from '../../framework/core/roles.js';
import type { UserCreateInput } from './UserTypes.js';

export function requireAccountDetails(input: UserCreateInput): void {
  if (input.password.length < 12 || input.password.length > 128) {
    throw new ApplicationError('INVALID_PASSWORD', 'Пароль должен содержать от 12 до 128 символов.', 400);
  }
  if (!input.name.trim() || input.name.trim().length > 120) {
    throw new ApplicationError('INVALID_NAME', 'Имя должно содержать от 1 до 120 символов.', 400);
  }
  if (!isUserRole(input.role)) {
    throw new ApplicationError('INVALID_ROLE', 'Неизвестная роль пользователя.', 400);
  }
  if (input.subscriberId !== undefined && (input.role !== 'guest' || !input.subscriberId.trim())) {
    throw new ApplicationError('INVALID_SUBSCRIBER', 'Связь с абонентом доступна только роли guest и требует непустой ID.', 400);
  }
}
