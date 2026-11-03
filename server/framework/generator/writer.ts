import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Only the protected region is replaced after the first generation. */
export interface GeneratedFile {
  readonly path: string;
  readonly generated: string;
  readonly extension: string;
}

export interface GenerationResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  stale: string[];
}

const opening = '// <framework:generated';
const closing = '// </framework:generated>';

interface PlannedFile {
  readonly path: string;
  readonly destination: string;
  readonly before: Buffer | undefined;
  readonly after: Buffer;
  readonly mode: number | undefined;
}

function conflict(path: string, reason: string): Error {
  return new Error(`Cannot generate ${path}: ${reason}`);
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function validatePath(path: string): void {
  if (!/^src\/[a-z][a-z0-9-]*\/[A-Za-z][A-Za-z0-9]*\.ts$/.test(path)) {
    throw conflict(path, 'expected a flat domain file src/<domain>/<EntityRole>.ts; absolute paths and traversal are forbidden.');
  }
}

function occurrences(content: Buffer, marker: string): number[] {
  const positions: number[] = [];
  let position = content.indexOf(marker);
  while (position !== -1) {
    positions.push(position);
    position = content.indexOf(marker, position + marker.length);
  }
  return positions;
}

function generatedBlock(file: GeneratedFile): Buffer {
  for (const text of [file.generated, file.extension]) {
    if (text.includes(opening) || text.includes(closing)) {
      throw conflict(file.path, 'the template contains reserved generation markers.');
    }
  }
  const body = Buffer.from(file.generated.endsWith('\n') ? file.generated : `${file.generated}\n`);
  return Buffer.concat([
    Buffer.from(`${opening} sha256=${digest(body)}>\n`),
    body,
    Buffer.from(closing),
  ]);
}

function replaceBlock(path: string, before: Buffer, block: Buffer): Buffer {
  const starts = occurrences(before, opening);
  const ends = occurrences(before, closing);
  const start = starts[0];
  const end = ends[0];
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined || end <= start) {
    throw conflict(path, 'expected exactly one protected generated region. Existing handwritten files are never overwritten; choose another domain or restore the generation markers.');
  }
  const headerEnd = before.indexOf('\n', start);
  const header = before.subarray(start, headerEnd).toString('utf8');
  const match = /^\/\/ <framework:generated sha256=([a-f0-9]{64})>$/.exec(header);
  const afterEnd = end + Buffer.byteLength(closing);
  const validEnding = afterEnd === before.length || before[afterEnd] === 10
    || (before[afterEnd] === 13 && before[afterEnd + 1] === 10);
  if (!match || headerEnd >= end || (start !== 0 && before[start - 1] !== 10)
    || before[end - 1] !== 10 || !validEnding) {
    throw conflict(path, 'the protected region markers are malformed. Restore the original marker lines.');
  }
  const body = before.subarray(headerEnd + 1, end);
  if (digest(body) !== match[1]) {
    throw conflict(path, 'the generated region was edited by hand. Move custom changes outside the markers and restore the original region before regenerating.');
  }
  return Buffer.concat([before.subarray(0, start), block, before.subarray(afterEnd)]);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Refuse symlinks at every component, including broken links and the destination. */
async function inspectDestination(root: string, path: string): Promise<{ before: Buffer | undefined; mode: number | undefined }> {
  const parts = path.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isMissing(error)) return { before: undefined, mode: undefined };
      throw error;
    }
    if (stats.isSymbolicLink()) throw conflict(path, `symlinks inside the output path are forbidden (${parts.slice(0, index + 1).join('/')}).`);
    if (index !== parts.length - 1) {
      if (!stats.isDirectory()) throw conflict(path, 'an output parent is not a directory.');
    } else {
      if (!stats.isFile()) throw conflict(path, 'the destination exists and is not a regular file.');
      return { before: await readFile(current), mode: stats.mode & 0o777 };
    }
  }
  return { before: undefined, mode: undefined };
}

async function commit(root: string, file: PlannedFile): Promise<void> {
  // Catch ordinary concurrent edits too. This is not a filesystem-wide transaction.
  const current = await inspectDestination(root, file.path);
  if (file.before === undefined ? current.before !== undefined : !current.before?.equals(file.before)) {
    throw conflict(file.path, 'the file changed after preflight. Rerun generation against the current files.');
  }
  await mkdir(dirname(file.destination), { recursive: true });
  const temporary = join(dirname(file.destination), `.${randomUUID()}.framework.tmp`);
  try {
    await writeFile(temporary, file.after, { flag: 'wx', mode: file.mode ?? 0o666 });
    await rename(temporary, file.destination);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

/**
 * Validate the complete plan before touching disk. Conflicts never partially apply a plan.
 * Each changed file is replaced atomically; I/O failures may leave earlier files updated.
 * `check` reports stale output without creating directories or changing files.
 */
export async function writeGeneratedFiles(
  root: string,
  files: readonly GeneratedFile[],
  options: { check?: boolean } = {},
): Promise<GenerationResult> {
  const resolvedRoot = await realpath(root);
  if (!(await lstat(resolvedRoot)).isDirectory()) throw new Error('Generation root must be an existing directory.');
  const seen = new Set<string>();
  const plan: PlannedFile[] = [];
  for (const file of files) {
    validatePath(file.path);
    if (seen.has(file.path)) throw conflict(file.path, 'the output plan contains this path more than once.');
    seen.add(file.path);
    const block = generatedBlock(file);
    const { before, mode } = await inspectDestination(resolvedRoot, file.path);
    const after = before === undefined
      ? Buffer.concat([block, Buffer.from(`\n${file.extension}`)])
      : replaceBlock(file.path, before, block);
    plan.push({ path: file.path, destination: join(resolvedRoot, file.path), before, after, mode });
  }

  const result: GenerationResult = { created: [], updated: [], unchanged: [], stale: [] };
  for (const file of plan) {
    if (file.before?.equals(file.after)) {
      result.unchanged.push(file.path);
    } else if (options.check) {
      result.stale.push(file.path);
    } else {
      await commit(resolvedRoot, file);
      (file.before === undefined ? result.created : result.updated).push(file.path);
    }
  }
  return result;
}
