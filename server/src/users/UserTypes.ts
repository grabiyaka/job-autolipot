import type { Actor } from '../../framework/core/actor.js';
import type { UserRole } from '../../framework/core/roles.js';

export type UserProfile = Readonly<{
  id: string;
  email: string;
  name: string;
  role: UserRole;
}>;

export type UserLoginInput = Readonly<{ email: string; password: string }>;
export type UserRegisterInput = UserLoginInput & Readonly<{ name: string }>;
export type UserCreateInput = UserRegisterInput & Readonly<{ role: UserRole }>;
export type UserSession = Readonly<{
  id: string;
  user: UserProfile;
  actor: Actor;
  expiresAt: string;
}>;

export interface UserApi {
  login(input: UserLoginInput): Promise<UserSession>;
  /** Public sign-up: always creates a regular user and opens a session. */
  register(input: UserRegisterInput): Promise<UserSession>;
  session(sessionId: string, userId: string): Promise<UserSession | null>;
  logout(sessionId: string): Promise<void>;
  create(input: UserCreateInput): Promise<UserProfile>;
  /** An active user's profile; null for an unknown or disabled user. */
  profile(userId: string): Promise<UserProfile | null>;
}
