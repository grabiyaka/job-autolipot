import type { FastifyInstance } from 'fastify';
import { userRoles } from '../../framework/core/roles.js';
import { errors } from '../../framework/http/error-schema.js';
import { authenticatedAccess } from '../../middlewares/authenticatedAccess.js';
import { publicAccess } from '../../middlewares/publicAccess.js';
import type { UserApi, UserLoginInput } from './UserTypes.js';
import { UserController } from './UserController.js';
import type { UserCookieOptions } from './UserController.js';

const userSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'email', 'name', 'role'],
  properties: {
    id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' },
    role: { type: 'string', enum: userRoles },
  },
} as const;

export function registerUserRoutes(server: FastifyInstance, users: UserApi, cookie: UserCookieOptions): void {
  const controller = new UserController(users, cookie);
  server.post<{ Body: UserLoginInput }>('/api/auth/login', {
    preHandler: publicAccess,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['Auth'], summary: 'Вход по email и паролю; JWT в HttpOnly cookie', security: [],
      body: {
        type: 'object', additionalProperties: false, required: ['email', 'password'],
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 254 },
          password: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['user', 'expiresAt'],
          properties: { user: userSchema, expiresAt: { type: 'string', format: 'date-time' } },
        }, ...errors,
      },
    },
  }, controller.login);
  server.get('/api/auth/me', {
    preHandler: authenticatedAccess,
    schema: {
      tags: ['Auth'], summary: 'Текущий пользователь',
      response: { 200: { type: 'object', additionalProperties: false, required: ['user'], properties: { user: userSchema } }, ...errors },
    },
  }, controller.me);
  server.post('/api/auth/logout', {
    preHandler: publicAccess,
    schema: { tags: ['Auth'], summary: 'Отозвать текущую сессию', security: [], response: { 204: { type: 'null' }, ...errors } },
  }, controller.logout);
}
