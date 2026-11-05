import type { Actor } from '../core/actor.js';
import { createPrismaClient } from '../../plugins/database.js';
import { AnswerRepository } from '../../src/answers/AnswerRepository.js';
import { AnswerService } from '../../src/answers/AnswerService.js';
import { UserRepository } from '../../src/users/UserRepository.js';

/** The answers CLI: the same AnswerService as HTTP, acting as the active user found by email. */
export function createAnswerCli(databaseUrl: string) {
  const prisma = createPrismaClient(databaseUrl);
  const users = new UserRepository(prisma);
  return {
    answers: new AnswerService(new AnswerRepository(prisma)),
    async activeUser(email: string): Promise<Actor | null> {
      const found = await users.findByEmail(email.trim().toLowerCase());
      return found && !found.disabled ? { id: found.user.id, role: found.user.role } : null;
    },
    close: () => prisma.$disconnect(),
  };
}
