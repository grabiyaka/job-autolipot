import { randomUUID } from 'node:crypto';
import { createPrismaClient } from '../../plugins/database.js';
import { ScryptPasswords } from '../../plugins/passwords.js';
import { UserRepository } from '../../src/users/UserRepository.js';
import { UserService } from '../../src/users/UserService.js';

export function createUserAdministration(databaseUrl: string) {
  const prisma = createPrismaClient(databaseUrl);
  const users = new UserService(
    new UserRepository(prisma), new ScryptPasswords(),
    { now: () => new Date() }, { next: randomUUID }, 3600,
  );
  return { users, close: () => prisma.$disconnect() };
}
