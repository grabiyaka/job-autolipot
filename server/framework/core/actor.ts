import { ApplicationError } from './errors.js';
import type { UserRole } from './roles.js';

export type Actor = Readonly<{
  id: string;
  role: UserRole;
}>;

export function requireActor(actor: Actor | null): Actor {
  if (!actor) throw new ApplicationError('UNAUTHENTICATED', 'Нужна авторизация.', 401);
  return actor;
}
