import { ApplicationError } from '../../framework/core/errors.js';

export const QUESTION_MAX_LENGTH = 500;
export const ANSWER_MAX_LENGTH = 4000;

/**
 * Words that only shape a question. Negations (not, no, never, without) and numbers are meaning,
 * so they are never here: «authorized» and «not authorized» stay different questions.
 */
const noiseWords = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'and', 'or',
  'please', 'kindly', 'how', 'many', 'much', 'what', 'which', 'is', 'are', 'do', 'does', 'did',
  'you', 'your', 'have', 'has', 'any',
]);
/** Phrases dropped as a whole; their words alone may matter elsewhere («working hours»). */
const noisePhrases: readonly (readonly string[])[] = [['working', 'with']];

/** «don't» → «do not», so the negation survives punctuation removal. */
function expandNegations(text: string): string {
  return text.replace(/\bcan['’]t\b/g, 'can not').replace(/\bwon['’]t\b/g, 'will not').replace(/n['’]t\b/g, ' not');
}

function withoutPhrases(words: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const phrase = noisePhrases.find((candidate) => candidate.every((word, offset) => words[index + offset] === word));
    if (phrase) { index += phrase.length - 1; continue; }
    kept.push(words[index]!);
  }
  return kept;
}

/**
 * The lookup key of a question: NFKC, lower case, no `*` or punctuation, no noise, each word once,
 * words sorted. Sorting makes «Years of experience working with TypeScript*» and
 * «How many years of TypeScript experience?» one key: `experience typescript years`.
 */
export function answerKey(question: string): string {
  const plain = expandNegations(question.normalize('NFKC').toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, ' ');
  const words = withoutPhrases(plain.split(' ').filter(Boolean)).filter((word) => !noiseWords.has(word));
  return [...new Set(words)].sort().join(' ');
}

export type AnswerFields = Readonly<{ key: string; question: string; answer: string }>;

/** Checks a question and its answer and derives the key; a question of noise alone cannot be found again. */
export function answerFields(question: string, answer: string): AnswerFields {
  const trimmedQuestion = question.trim();
  const trimmedAnswer = answer.trim();
  if (!trimmedQuestion || trimmedQuestion.length > QUESTION_MAX_LENGTH) {
    throw new ApplicationError('INVALID_QUESTION', `Вопрос — от 1 до ${QUESTION_MAX_LENGTH} символов.`, 400);
  }
  if (!trimmedAnswer || trimmedAnswer.length > ANSWER_MAX_LENGTH) {
    throw new ApplicationError('INVALID_ANSWER', `Ответ — от 1 до ${ANSWER_MAX_LENGTH} символов.`, 400);
  }
  const key = answerKey(trimmedQuestion);
  if (!key) throw new ApplicationError('ANSWER_KEY_EMPTY', 'В вопросе нет значимых слов.', 400);
  return { key, question: trimmedQuestion, answer: trimmedAnswer };
}
