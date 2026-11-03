import type { Actor } from '../../framework/core/actor.js';
import type { UserRole } from '../../framework/core/roles.js';

export type UserProfile = Readonly<{
  id: string;
  email: string;
  name: string;
  role: UserRole;
}>;

export type UserLoginInput = Readonly<{ email: string; password: string }>;
export type UserCreateInput = UserLoginInput & Readonly<{
  name: string;
  role: UserRole;
  subscriberId?: string;
}>;
export type UserSession = Readonly<{
  id: string;
  user: UserProfile;
  actor: Actor;
  expiresAt: string;
}>;

export interface UserApi {
  login(input: UserLoginInput): Promise<UserSession>;
  session(sessionId: string, userId: string): Promise<UserSession | null>;
  logout(sessionId: string): Promise<void>;
  create(input: UserCreateInput): Promise<UserProfile>;
}
