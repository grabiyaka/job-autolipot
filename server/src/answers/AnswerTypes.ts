/** Where an answer came from: typed by the owner (HTTP, CLI) or given to the agent's question in Telegram. */
export const answerOrigins = ['manual', 'telegram'] as const;
export type AnswerOrigin = typeof answerOrigins[number];

/**
 * A stored answer to a form question. Rules (salary, consents) are kept as plain text too:
 * the agent receives every answer as "question → answer" and follows it as an instruction.
 */
export type Answer = Readonly<{
  id: string;
  question: string;
  answer: string;
  origin: AnswerOrigin;
  createdAt: string;
  updatedAt: string;
}>;

/** The answer bank as other domains see it: applying reads it, the bot adds what the owner answered. */
export interface AnswerApi {
  /** The owner's answers, oldest first. */
  listForUser(ownerId: string): Promise<Answer[]>;
  /** Saves the answer under the question's key; a question with the same key is replaced. */
  upsert(ownerId: string, question: string, answer: string, origin: AnswerOrigin): Promise<Answer>;
}
