import type { Answer as AnswerRecord, PrismaClient } from '../../generated/prisma/client.js';
import type { AnswerFields } from './AnswerRules.js';
import type { Answer, AnswerOrigin } from './AnswerService.js';

function toAnswer(record: AnswerRecord): Answer {
  return {
    id: record.id, question: record.question, answer: record.answer, origin: record.origin,
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  };
}

/** Answers are always read and changed together with their owner. */
export class AnswerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(ownerId: string): Promise<Answer[]> {
    const records = await this.prisma.answer.findMany({ where: { userId: ownerId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return records.map(toAnswer);
  }

  /** The newest wording of the question replaces the stored one together with the answer. */
  async upsert(ownerId: string, fields: AnswerFields, origin: AnswerOrigin): Promise<Answer> {
    const data = { question: fields.question, answer: fields.answer, origin };
    return toAnswer(await this.prisma.answer.upsert({
      where: { userId_key: { userId: ownerId, key: fields.key } },
      create: { userId: ownerId, key: fields.key, ...data },
      update: data,
    }));
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.answer.deleteMany({ where: { id, userId: ownerId } });
    return count > 0;
  }
}
