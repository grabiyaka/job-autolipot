import { describe, expect, it } from 'vitest';
import { authenticationSettings } from '../middlewares/authentication.js';
import { ScryptPasswords } from '../plugins/passwords.js';
import { normalizedEmail } from '../src/users/UserEmail.js';
import { requireAccountDetails } from '../src/users/UserRules.js';

const secret = 'unit-tests-only-secret-at-least-thirty-two-bytes';

describe('Authentication configuration fails closed', () => {
  it.each(['', 'too-short'])('rejects an insufficient JWT secret', invalidSecret => {
    expect(() => authenticationSettings({ secret: invalidSecret, origin: 'https://app.example' })).toThrow(/32/);
  });

  it.each(['file:///tmp/app', 'https://app.example/path', 'https://app.example/', 'https://app.example?query=1', '*'])('rejects noncanonical origins: %s', origin => {
    expect(() => authenticationSettings({ secret, origin })).toThrow(/origin/i);
  });

  it('validates additional origins and defaults to secure cookies for HTTPS', () => {
    expect(authenticationSettings({ secret, origin: 'https://app.example' }).cookieSecure).toBe(true);
    expect(authenticationSettings({ secret, origin: 'http://localhost:3400' }).cookieSecure).toBe(false);
    expect(() => authenticationSettings({ secret, origin: 'https://app.example', allowedOrigins: ['*'] })).toThrow(/origin/i);
  });

  it.each([0, 59, 86_401, 60.5, Number.NaN])('rejects unsafe or invalid session lifetimes: %s', sessionTtlSeconds => {
    expect(() => authenticationSettings({ secret, origin: 'https://app.example', sessionTtlSeconds })).toThrow(/TTL/);
  });
});

describe('Account credentials', () => {
  it('normalizes email identifiers and rejects invalid addresses', () => {
    expect(normalizedEmail('  Member@Example.TEST  ')).toBe('member@example.test');
    for (const email of ['', 'no-at-sign', 'user@', '@example.test', 'user name@example.test']) {
      expect(() => normalizedEmail(email)).toThrow();
    }
  });

  it('requires a strong initial password, meaningful name, and consistent account role', () => {
    const input = { email: 'user@example.test', name: 'Test user', password: 'A-long-initial-password', role: 'manager' } as const;
    expect(() => requireAccountDetails(input)).not.toThrow();
    expect(() => requireAccountDetails({ ...input, password: 'short' })).toThrow();
    expect(() => requireAccountDetails({ ...input, password: 'a'.repeat(129) })).toThrow();
    expect(() => requireAccountDetails({ ...input, name: '   ' })).toThrow();
    for (const role of ['admin', 'manager', 'guest', 'foreign'] as const) {
      expect(() => requireAccountDetails({ ...input, role })).not.toThrow();
    }
    for (const role of ['admin', 'manager', 'foreign'] as const) {
      expect(() => requireAccountDetails({ ...input, role, subscriberId: 'a-subscriber' })).toThrow();
    }
    expect(() => requireAccountDetails({ ...input, role: 'guest', subscriberId: 'a-subscriber' })).not.toThrow();
    for (const subscriberId of ['', '   ']) {
      expect(() => requireAccountDetails({ ...input, role: 'guest', subscriberId })).toThrow();
    }
    // @ts-expect-error Unknown roles must be rejected both by TypeScript and at runtime.
    expect(() => requireAccountDetails({ ...input, role: 'owner' })).toThrow();
  });

  it('salts password hashes and rejects wrong, missing or malformed stored credentials', async () => {
    const passwords = new ScryptPasswords();
    const password = 'Test-password-with-enough-characters';
    const first = await passwords.hash(password);
    const second = await passwords.hash(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await passwords.verify(password, first)).toBe(true);
    expect(await passwords.verify(`${password}-wrong`, first)).toBe(false);
    expect(await passwords.verify(password, null)).toBe(false);
    expect(await passwords.verify(password, 'broken-stored-hash')).toBe(false);
  });
});
