import { ApplicationError } from '../../framework/core/errors.js';
import type { Passwords } from '../../framework/core/passwords.js';
import type { Clock, Identifiers } from '../../framework/core/runtime.js';
import type { UserRepositoryContract } from './UserContracts.js';
import type { UserApi, UserCreateInput, UserLoginInput, UserProfile, UserRegisterInput, UserSession } from './UserTypes.js';
import { normalizedEmail } from './UserEmail.js';
import { requireAccountDetails } from './UserRules.js';

export class UserService implements UserApi {
  constructor(
    private readonly users: UserRepositoryContract,
    private readonly passwords: Passwords,
    private readonly clock: Clock,
    private readonly identifiers: Identifiers,
    private readonly sessionTtlSeconds: number,
  ) {}

  async login(input: UserLoginInput): Promise<UserSession> {
    const account = await this.users.findByEmail(normalizedEmail(input.email));
    const validPassword = await this.passwords.verify(input.password, account?.passwordHash ?? null);
    if (!account || !validPassword || account.disabled) {
      throw new ApplicationError('INVALID_CREDENTIALS', 'Неверный email или пароль.', 401);
    }
    return this.openSession(account.user.id);
  }

  async register(input: UserRegisterInput): Promise<UserSession> {
    const user = await this.create({ ...input, role: 'user' });
    return this.openSession(user.id);
  }

  session(sessionId: string, userId: string): Promise<UserSession | null> {
    return this.users.findSession(sessionId, userId, this.clock.now());
  }

  logout(sessionId: string): Promise<void> {
    return this.users.deleteSession(sessionId);
  }

  async create(input: UserCreateInput): Promise<UserProfile> {
    requireAccountDetails(input);
    const email = normalizedEmail(input.email);
    const passwordHash = await this.passwords.hash(input.password);
    const { password: _password, ...account } = input;
    return this.users.create({ ...account, email, name: input.name.trim() }, passwordHash);
  }

  async profile(userId: string): Promise<UserProfile | null> {
    const account = await this.users.findById(userId);
    return account && !account.disabled ? account.user : null;
  }

  private openSession(userId: string): Promise<UserSession> {
    const expiresAt = new Date(this.clock.now().getTime() + this.sessionTtlSeconds * 1000);
    return this.users.createSession(this.identifiers.next(), userId, expiresAt);
  }
}
