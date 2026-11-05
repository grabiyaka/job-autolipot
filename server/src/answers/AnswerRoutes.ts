import type { FastifyInstance } from 'fastify';
import { errors } from '../../framework/http/error-schema.js';
import { authenticatedAccess } from '../../middlewares/authenticatedAccess.js';
import { ANSWER_MAX_LENGTH, QUESTION_MAX_LENGTH } from './AnswerService.js';
import type { AnswerInput, AnswerService } from './AnswerService.js';
import { AnswerController } from './AnswerController.js';
import { answerOrigins } from './AnswerTypes.js';

const date = { type: 'string', format: 'date-time' } as const;
const answerProperties = {
  id: { type: 'string' }, question: { type: 'string' }, answer: { type: 'string' },
  origin: { type: 'string', enum: answerOrigins }, createdAt: date, updatedAt: date,
} as const;
const answerSchema = {
  type: 'object', additionalProperties: false, required: Object.keys(answerProperties), properties: answerProperties,
} as const;

const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } } as const;

export function registerAnswerRoutes(server: FastifyInstance, answers: AnswerService): void {
  const controller = new AnswerController(answers);
  const tags = ['Answers'];

  server.get('/api/answers', {
    preHandler: authenticatedAccess,
    schema: { tags, summary: 'Свой банк ответов на вопросы форм', response: { 200: { type: 'array', items: answerSchema }, ...errors } },
  }, controller.list);

  server.put<{ Body: AnswerInput }>('/api/answers', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Записать ответ: тот же вопрос в другой формулировке заменяет прежний',
      body: {
        type: 'object', additionalProperties: false, required: ['question', 'answer'],
        properties: {
          question: { type: 'string', minLength: 1, maxLength: QUESTION_MAX_LENGTH },
          answer: { type: 'string', minLength: 1, maxLength: ANSWER_MAX_LENGTH },
        },
      },
      response: { 200: answerSchema, ...errors },
    },
  }, controller.put);

  server.delete<{ Params: { id: string } }>('/api/answers/:id', {
    preHandler: authenticatedAccess,
    schema: { tags, summary: 'Удалить ответ', params: idParams, response: { 204: { type: 'null' }, ...errors } },
  }, controller.remove);
}
