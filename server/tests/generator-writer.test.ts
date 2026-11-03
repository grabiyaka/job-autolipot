import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeGeneratedFiles } from '../framework/generator/writer.js';
import type { GeneratedFile } from '../framework/generator/writer.js';

let root: string;
const file: GeneratedFile = {
  path: 'src/tasks/TaskService.ts',
  generated: 'export class GeneratedTaskService {}\n',
  extension: '\nexport class TaskService extends GeneratedTaskService {}\n',
};

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'framework-generator-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function content(path = file.path): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

async function put(text: string, path = file.path): Promise<void> {
  await mkdir(join(root, 'src/tasks'), { recursive: true });
  await writeFile(join(root, path), text);
}

describe('safe domain generation', () => {
  it('creates a protected region and keeps a second run byte-identical without writing', async () => {
    expect(await writeGeneratedFiles(root, [file])).toEqual({ created: [file.path], updated: [], unchanged: [], stale: [] });
    const first = await content();
    const before = await stat(join(root, file.path));
    expect(first).toMatch(/^\/\/ <framework:generated sha256=[a-f0-9]{64}>\n/);
    expect(first).toContain(`${file.generated}// </framework:generated>\n${file.extension}`);
    expect(await writeGeneratedFiles(root, [file])).toEqual({ created: [], updated: [], unchanged: [file.path], stale: [] });
    expect(await content()).toBe(first);
    expect((await stat(join(root, file.path))).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(join(root, 'src/tasks'))).toEqual(['TaskService.ts']);
  });

  it('updates only generated content while preserving every byte outside, including custom imports and invalid UTF-8', async () => {
    await writeGeneratedFiles(root, [file]);
    const original = await readFile(join(root, file.path));
    const prefix = Buffer.from('import type { Extra } from "./TaskTypes.js";\r\n');
    const suffix = Buffer.from([0x0a, 0xff, 0x00, 0xfe]);
    await writeFile(join(root, file.path), Buffer.concat([prefix, original, suffix]));
    const changed = { ...file, generated: 'export class GeneratedTaskService { updated = true; }', extension: 'DO NOT REPLACE CUSTOM CODE' };
    expect((await writeGeneratedFiles(root, [changed])).updated).toEqual([file.path]);
    const updated = await readFile(join(root, file.path));
    expect(updated.subarray(0, prefix.length).equals(prefix)).toBe(true);
    expect(updated.subarray(-suffix.length).equals(suffix)).toBe(true);
    expect(updated.toString('utf8')).toContain(file.extension);
    expect(updated.toString('utf8')).not.toContain(changed.extension);
    expect((await writeGeneratedFiles(root, [changed])).unchanged).toEqual([file.path]);
  });

  it('preflights the entire plan before writing any file if a generated block was edited', async () => {
    await writeGeneratedFiles(root, [file]);
    const edited = (await content()).replace('GeneratedTaskService {}', 'GeneratedTaskService { custom = true; }');
    await put(edited);
    const second = { ...file, path: 'src/tasks/TaskTypes.ts' };
    await expect(writeGeneratedFiles(root, [second, file])).rejects.toThrow('edited by hand');
    expect(await content()).toBe(edited);
    await expect(stat(join(root, second.path))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites an existing handwritten file or writes earlier planned updates', async () => {
    await writeGeneratedFiles(root, [file]);
    const original = await content();
    const manual = { ...file, path: 'src/tasks/TaskTypes.ts' };
    await put('export type Task = { id: string };\n', manual.path);
    await expect(writeGeneratedFiles(root, [{ ...file, generated: 'changed' }, manual])).rejects.toThrow('handwritten');
    expect(await content()).toBe(original);
    expect(await content(manual.path)).toBe('export type Task = { id: string };\n');
  });

  it.each([
    ['missing opening', (text: string) => text.replace('// <framework:generated', '// <removed')],
    ['missing closing', (text: string) => text.replace('// </framework:generated>', '')],
    ['duplicate region', (text: string) => text + text],
    ['duplicate closing', (text: string) => text + '\n// </framework:generated>'],
    ['malformed header', (text: string) => text.replace('sha256=', 'md5=')],
    ['inline opening', (text: string) => `const prefix = 1; ${text}`],
    ['inline closing', (text: string) => text.replace('\n// </framework:generated>', '// </framework:generated>')],
    ['trailing closing code', (text: string) => text.replace('// </framework:generated>', '// </framework:generated> invalid')],
  ])('rejects %s markers', async (_name, modify) => {
    await writeGeneratedFiles(root, [file]);
    const changed = modify(await content());
    await put(changed);
    await expect(writeGeneratedFiles(root, [file])).rejects.toThrow('Cannot generate');
    expect(await content()).toBe(changed);
  });

  it.each([
    '../outside.ts', '/tmp/outside.ts', 'src/../Outside.ts', 'src/tasks/../Outside.ts',
    'src/tasks/nested/TaskService.ts', 'src/tasks/TaskService.js', 'src/tasks\\TaskService.ts',
    'framework/composition/create-application.ts', 'src//TaskService.ts', 'src/./TaskService.ts',
  ])('rejects unsafe or out-of-scope output %s before creating directories', async (path) => {
    await expect(writeGeneratedFiles(root, [file, { ...file, path }])).rejects.toThrow('expected a flat domain file');
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects duplicate output paths before creating directories', async () => {
    await expect(writeGeneratedFiles(root, [file, file])).rejects.toThrow('more than once');
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['src', 'domain', 'target', 'broken target'])('refuses a symlink at %s', async (position) => {
    const actual = join(root, 'actual');
    await mkdir(actual);
    if (position === 'src') {
      await symlink(actual, join(root, 'src'));
    } else {
      await mkdir(join(root, 'src'));
      if (position === 'domain') {
        await symlink(actual, join(root, 'src/tasks'));
      } else {
        await mkdir(join(root, 'src/tasks'));
        if (position === 'target') await writeFile(join(actual, 'TaskService.ts'), 'manual');
        await symlink(join(actual, 'TaskService.ts'), join(root, file.path));
      }
    }
    await expect(writeGeneratedFiles(root, [file])).rejects.toThrow('symlinks');
    if (position === 'target') expect(await readFile(join(actual, 'TaskService.ts'), 'utf8')).toBe('manual');
  });

  it('allows an explicitly selected root directory symlink', async () => {
    await mkdir(join(root, 'actual'));
    await symlink(join(root, 'actual'), join(root, 'linked'));
    expect((await writeGeneratedFiles(join(root, 'linked'), [file])).created).toEqual([file.path]);
    expect(await readFile(join(root, 'actual', file.path), 'utf8')).toContain(file.generated);
  });

  it('rejects a directory occupying a file destination', async () => {
    await mkdir(join(root, file.path), { recursive: true });
    await expect(writeGeneratedFiles(root, [file])).rejects.toThrow('not a regular file');
  });

  it('rejects a file occupying an ancestor directory', async () => {
    await writeFile(join(root, 'src'), 'manual');
    await expect(writeGeneratedFiles(root, [file])).rejects.toThrow('not a directory');
    expect(await readFile(join(root, 'src'), 'utf8')).toBe('manual');
  });

  it('reports missing output in check mode without making directories', async () => {
    expect(await writeGeneratedFiles(root, [file], { check: true })).toEqual({ created: [], updated: [], unchanged: [], stale: [file.path] });
    expect(await readdir(root)).toEqual([]);
  });

  it('check reports generated changes while ignoring manual extension differences and never writes', async () => {
    await writeGeneratedFiles(root, [file]);
    const before = await content();
    expect((await writeGeneratedFiles(root, [{ ...file, generated: 'changed' }], { check: true })).stale).toEqual([file.path]);
    expect((await writeGeneratedFiles(root, [{ ...file, extension: 'different extension' }], { check: true })).unchanged).toEqual([file.path]);
    expect(await content()).toBe(before);
    await put(before.replace('GeneratedTaskService {}', 'EditedTaskService {}'));
    await expect(writeGeneratedFiles(root, [file], { check: true })).rejects.toThrow('edited by hand');
  });

  it('rejects reserved markers inside template data before writing', async () => {
    await expect(writeGeneratedFiles(root, [{ ...file, extension: '// </framework:generated>' }])).rejects.toThrow('reserved');
    expect(await readdir(root)).toEqual([]);
  });
});
