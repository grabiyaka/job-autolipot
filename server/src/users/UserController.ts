import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApplicationError } from '../../framework/core/errors.js';
import type { UserApi, UserLoginInput } from './UserTypes.js';

export type UserCookieOptions = Readonly<{ name: string; secure: boolean }>;

export class UserController {
  constructor(private readonly users: UserApi, private readonly cookie: UserCookieOptions) {}

  login = async (request: FastifyRequest<{ Body: UserLoginInput }>, reply: FastifyReply) => {
    const session = await this.users.login(request.body);
    const expires = new Date(session.expiresAt);
    const token = await reply.jwtSign({ sub: session.user.id, sid: session.id, exp: Math.floor(expires.getTime() / 1000) });
    reply.header('Cache-Control', 'no-store');
    reply.setCookie(this.cookie.name, token, { path: '/api', httpOnly: true, sameSite: 'lax', secure: this.cookie.secure, expires });
    return { user: session.user, expiresAt: session.expiresAt };
  };

  me = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.authSession) throw new ApplicationError('UNAUTHENTICATED', 'Нужна авторизация.', 401);
    reply.header('Cache-Control', 'no-store');
    return { user: request.authSession.user };
  };

  logout = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authSession) await this.users.logout(request.authSession.id);
    reply.header('Cache-Control', 'no-store');
    reply.clearCookie(this.cookie.name, { path: '/api', httpOnly: true, sameSite: 'lax', secure: this.cookie.secure });
    return reply.code(204).send();
  };
}
