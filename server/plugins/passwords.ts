import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Passwords } from '../framework/core/passwords.js';

const parameters = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const keyLength = 64;
const dummySalt = Buffer.alloc(16, 0x71);
const dummyKey = Buffer.alloc(keyLength, 0x82);

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, parameters, (error, key) => error ? reject(error) : resolve(key));
  });
}

export class ScryptPasswords implements Passwords {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt);
    return `scrypt:32768:8:1:${salt.toString('hex')}:${key.toString('hex')}`;
  }

  async verify(password: string, encoded: string | null): Promise<boolean> {
    const match = /^scrypt:32768:8:1:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(encoded ?? '');
    // Unknown accounts still perform the same expensive password operation.
    const salt = match ? Buffer.from(match[1]!, 'hex') : dummySalt;
    const expected = match ? Buffer.from(match[2]!, 'hex') : dummyKey;
    const actual = await derive(password, salt);
    return timingSafeEqual(actual, expected) && match !== null;
  }
}
