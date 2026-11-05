import type { Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { AnswerRepository } from './AnswerRepository.js';
import { answerFields } from './AnswerRules.js';
import type { Answer, AnswerApi, AnswerOrigin } from './AnswerTypes.js';

export { ANSWER_MAX_LENGTH, QUESTION_MAX_LENGTH } from './AnswerRules.js';
export type { Answer, AnswerOrigin } from './AnswerTypes.js';

export type AnswerInput = Readonly<{ question: string; answer: string }>;

/** The owner's answer bank. Every query is scoped to the owner, so another user's answer behaves as missing. */
export class AnswerService implements AnswerApi {
  constructor(private readonly answers: AnswerRepository) {}

  // ── Owner's actions over HTTP and CLI ──

  list(actor: Actor): Promise<Answer[]> {
    return this.listForUser(actor.id);
  }

  /** What the owner types is `manual`; the same key replaces the earlier answer. */
  put(actor: Actor, input: AnswerInput): Promise<Answer> {
    return this.upsert(actor.id, input.question, input.answer, 'manual');
  }

  async remove(actor: Actor, id: string): Promise<void> {
    if (!(await this.answers.delete(actor.id, id))) {
      throw new ApplicationError('ANSWER_NOT_FOUND', 'Ответ не найден.', 404);
    }
  }

  // ── AnswerApi for applying and the bot ──

  listForUser(ownerId: string): Promise<Answer[]> {
    return this.answers.list(ownerId);
  }

  upsert(ownerId: string, question: string, answer: string, origin: AnswerOrigin): Promise<Answer> {
    return this.answers.upsert(ownerId, answerFields(question, answer), origin);
  }
}
