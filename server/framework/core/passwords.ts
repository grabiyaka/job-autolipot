/** Technical capability injected into account scenarios; no crypto implementation leaks in. */
export interface Passwords {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string | null): Promise<boolean>;
}
