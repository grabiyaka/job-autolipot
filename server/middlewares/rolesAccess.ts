import type { FastifyRequest } from 'fastify';
import { isUserRole, requireRole } from '../framework/core/roles.js';
import type { UserRole } from '../framework/core/roles.js';

export function rolesAccess(...allowedRoles: [UserRole, ...UserRole[]]): (request: FastifyRequest) => Promise<void> {
  if (!allowedRoles.length || allowedRoles.some((role) => !isUserRole(role))) {
    throw new Error('rolesAccess requires at least one known role.');
  }
  return async (request): Promise<void> => {
    requireRole(request.actor, ...allowedRoles);
  };
}
