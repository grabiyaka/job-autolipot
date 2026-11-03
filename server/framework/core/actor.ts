import { ApplicationError } from './errors.js';
import { hasGeneralAccess, userRoles, type UserRole } from './roles.js';

export type Actor = Readonly<{
  id: string;
  role: UserRole;
  subscriberId?: string;
}>;

/** Immutable evidence retains the role name used when the operation was recorded. */
export const recordedActorRoles = [...userRoles, 'operator', 'subscriber'] as const;
export type RecordedActor = Readonly<Omit<Actor, 'role'> & { role: typeof recordedActorRoles[number] }>;

/** Only compare/decode historical evidence; authentication never accepts legacy roles. */
export function normalizeRecordedActor(actor: RecordedActor): Actor {
  const role = actor.role === 'operator' ? 'manager' : actor.role === 'subscriber' ? 'guest' : actor.role;
  return { ...actor, role };
}

export function ensureSubscriberAccess(actor: Actor, subscriberId: string): void {
  if (!hasGeneralAccess(actor) && !(actor.role === 'guest' && actor.subscriberId === subscriberId)) {
    throw new ApplicationError('ACCESS_DENIED', 'Нет доступа к этому абоненту.', 403);
  }
}

export function requireActor(actor: Actor | null): Actor {
  if (!actor) throw new ApplicationError('UNAUTHENTICATED', 'Нужна авторизация.', 401);
  return actor;
}
