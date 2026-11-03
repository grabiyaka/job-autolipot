import type { PrismaClient, User } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { UserCredentials, UserRepositoryContract } from './UserContracts.js';
import type { UserCreateInput, UserProfile, UserSession } from './UserTypes.js';

function profile(user: User): UserProfile {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

function session(id: string, user: User, expiresAt: Date): UserSession {
  return {
    id,
    user: profile(user),
    actor: { id: user.id, role: user.role, ...(user.subscriberId ? { subscriberId: user.subscriberId } : {}) },
    expiresAt: expiresAt.toISOString(),
  };
}

export class UserRepository implements UserRepositoryContract {
  constructor(private readonly prisma: PrismaClient) {}

  async findByEmail(email: string): Promise<UserCredentials | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    return user ? { user: profile(user), passwordHash: user.passwordHash, disabled: user.disabled, subscriberId: user.subscriberId } : null;
  }

  async create(input: Omit<UserCreateInput, 'password'>, passwordHash: string): Promise<UserProfile> {
    try {
      return profile(await this.prisma.user.create({ data: { ...input, passwordHash } }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') throw new ApplicationError('EMAIL_EXISTS', 'Пользователь с таким email уже существует.', 409);
        if (error.code === 'P2003') throw new ApplicationError('INVALID_SUBSCRIBER', 'Указанный абонент не существует.', 400);
      }
      throw error;
    }
  }

  async createSession(id: string, userId: string, expiresAt: Date): Promise<UserSession> {
    const result = await this.prisma.authSession.create({ data: { id, userId, expiresAt }, include: { user: true } });
    return session(result.id, result.user, result.expiresAt);
  }

  async findSession(id: string, userId: string, now: Date): Promise<UserSession | null> {
    const result = await this.prisma.authSession.findFirst({
      where: { id, userId, expiresAt: { gt: now }, user: { disabled: false } }, include: { user: true },
    });
    return result ? session(result.id, result.user, result.expiresAt) : null;
  }

  async deleteSession(id: string): Promise<void> {
    await this.prisma.authSession.deleteMany({ where: { id } });
  }
}
