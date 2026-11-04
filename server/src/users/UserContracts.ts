import type { UserCreateInput, UserProfile, UserSession } from './UserTypes.js';

export type UserCredentials = Readonly<{
  user: UserProfile;
  passwordHash: string;
  disabled: boolean;
}>;

export interface UserRepositoryContract {
  findByEmail(email: string): Promise<UserCredentials | null>;
  findById(id: string): Promise<UserCredentials | null>;
  create(input: Omit<UserCreateInput, 'password'>, passwordHash: string): Promise<UserProfile>;
  createSession(id: string, userId: string, expiresAt: Date): Promise<UserSession>;
  findSession(id: string, userId: string, now: Date): Promise<UserSession | null>;
  deleteSession(id: string): Promise<void>;
}
