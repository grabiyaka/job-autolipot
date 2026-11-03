import type { Actor } from './actor.js';
import { ApplicationError } from './errors.js';

export const userRoles = ['admin', 'manager', 'guest', 'foreign'] as const;
export type UserRole = typeof userRoles[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && userRoles.some((role) => role === value);
}

export function hasGeneralAccess(actor: Actor): boolean {
  return actor.role === 'admin' || actor.role === 'manager';
}

/** Shared by HTTP middleware and services so another entry point cannot bypass access. */
export function requireRole(actor: Actor | null, ...allowedRoles: [UserRole, ...UserRole[]]): Actor {
  if (!actor) throw new ApplicationError('UNAUTHENTICATED', 'Нужна авторизация.', 401);
  if (!allowedRoles.includes(actor.role)) {
    throw new ApplicationError('ACCESS_DENIED', 'Недостаточно прав для этого действия.', 403);
  }
  return actor;
}
