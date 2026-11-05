import { describe, expect, it } from 'vitest';
import { answerLines, answersCommand } from '../scripts/answers-cli.js';
import { answerFields, answerKey } from '../src/answers/AnswerRules.js';

describe('answerKey', () => {
  it.each([
    ['Years of experience working with TypeScript*', 'experience typescript years'],
    ['How many years of TypeScript experience?', 'experience typescript years'],
    ['Years of experience with TypeScript', 'experience typescript years'],
    ['  YEARS   of Experience — TypeScript ** ', 'experience typescript years'],
    ['Please enter your email address', 'address email enter'],
    ['Email address*', 'address email'],
    ['Ｅｍａｉｌ ａｄｄｒｅｓｓ', 'address email'],
    ['Do you have 5+ years with Node.js?', '5 js node years'],
    ["Don't you need a visa?", 'need not visa'],
    ['Are you willing to relocate? (No relocation without support)', 'no relocate relocation support willing without'],
    ['Working hours per week', 'hours per week working'],
  ])('%s → %s', (question, key) => {
    expect(answerKey(question)).toBe(key);
  });

  it.each([
    ['Are you authorized to work in Germany?', 'Do you require sponsorship to work in Germany?'],
    ['Are you authorized to work in Germany?', 'Are you not authorized to work in Germany?'],
    ['Years of experience with TypeScript', 'Years of experience with Python'],
    ['Have you worked 2 years remotely?', 'Have you worked 3 years remotely?'],
    ['Can you start immediately?', "Can't you start immediately?"],
  ])('«%s» and «%s» stay different', (first, second) => {
    expect(answerKey(first)).not.toBe(answerKey(second));
  });

  it('rejects a question of noise alone and empty text', () => {
    expect(() => answerFields('How many do you have?', '1')).toThrow('значимых слов');
    expect(() => answerFields('Email', '   ')).toThrow('Ответ');
    expect(() => answerFields('  ', 'x')).toThrow('Вопрос');
  });

  it('keeps the question and answer trimmed, and the rule text as is', () => {
    expect(answerFields(' Expected salary ', ' base the number\non the posting ')).toEqual({
      key: 'expected salary', question: 'Expected salary', answer: 'base the number\non the posting',
    });
  });
});

describe('answers CLI', () => {
  it('parses list, set and delete', () => {
    expect(answersCommand(['--user', 'me@example.com', 'list'])).toEqual({ action: 'list', user: 'me@example.com' });
    expect(answersCommand(['--user', 'me@example.com', 'set', 'Email address', 'me@example.com']))
      .toEqual({ action: 'set', user: 'me@example.com', question: 'Email address', answer: 'me@example.com' });
    expect(answersCommand(['delete', 'a1', '--user', 'me@example.com'])).toEqual({ action: 'delete', user: 'me@example.com', id: 'a1' });
  });

  it('shows help without a user', () => {
    expect(answersCommand(['--help'])).toEqual({ action: 'help' });
  });

  it('explains wrong input', () => {
    expect(() => answersCommand(['list'])).toThrow('--user');
    expect(() => answersCommand(['--user', 'me@example.com'])).toThrow('Не указана команда');
    expect(() => answersCommand(['--user', 'me@example.com', 'add'])).toThrow('«add»');
    expect(() => answersCommand(['--user', 'me@example.com', 'set', 'Only question'])).toThrow('"<вопрос>" "<ответ>"');
    expect(() => answersCommand(['--user', 'me@example.com', 'delete'])).toThrow('<id>');
    expect(() => answersCommand(['--user', 'me@example.com', '--unknown', 'list'])).toThrow();
  });

  it('prints answers with rule lines indented', () => {
    const at = '2026-11-04T10:00:00.000Z';
    expect(answerLines([{ id: 'a1', question: 'Expected salary', answer: 'line 1\nline 2', origin: 'manual', createdAt: at, updatedAt: at }]))
      .toEqual(['a1  [manual]', '  Expected salary', '    line 1\n    line 2']);
    expect(answerLines([])).toEqual(['Ответов пока нет.']);
  });
});
