import { linkedinSource } from './LinkedinSource.js';
import type { JobSource } from './SearchTypes.js';

/**
 * Explicit registry: a new site is a `<Name>Source.ts` module in this domain plus one line here.
 * No dynamic loading, so the types and autocompletion stay intact.
 */
export const searchSources: readonly JobSource[] = [linkedinSource];
