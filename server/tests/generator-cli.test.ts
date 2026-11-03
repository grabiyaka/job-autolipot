import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = resolve('.');
const cli = join(projectRoot, 'scripts/generate-domains.ts');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'framework-generator-cli-'));
  temporaryRoots.push(root);
  return root;
}

function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.TEST_DATABASE_URL;
  return new Promise((resolveResult, reject) => {
    execFile(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: projectRoot, env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (!error) resolveResult({ status: 0, stdout, stderr });
      else if (typeof error.code === 'number') resolveResult({ status: error.code, stdout, stderr });
      else reject(error);
    });
  });
}

function noteModel(titleType = 'String') {
  return `model Note {
  id String @id @default(uuid())
  title ${titleType}
}
`;
}

async function createFixture(root: string, provider = 'postgresql') {
  await mkdir(join(root, 'database/models'), { recursive: true });
  await mkdir(join(root, 'configuration'));
  await writeFile(join(root, 'database/schema.prisma'), `datasource db {
  provider = "${provider}"
}
`);
  await writeFile(join(root, 'database/models/note.prisma'), noteModel());
  await writeFile(join(root, 'configuration/api.json'), JSON.stringify({
    domains: [{
      model: 'Note', domain: 'notes', route: '/api/notes',
      read: ['id', 'title'], create: ['title'], update: ['title'],
    }],
  }));
  return ['--root', root, '--schema', 'database', '--config', 'configuration/api.json'];
}

async function readOutput(root: string) {
  const directory = join(root, 'src/notes');
  return Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async file => [file, await readFile(join(directory, file), 'utf8')])));
}

describe('Domain generator command line', () => {
  it('uses a custom project, config and multifile schema without database access; check reports staleness without writes', async () => {
    const root = await temporaryRoot();
    const args = await createFixture(root);

    const missing = await runCli([...args, '--check']);
    expect(missing.status, missing.stderr).toBe(1);
    expect(missing.stderr).toContain('stale');
    expect(await readdir(root)).not.toContain('src');

    const generated = await runCli(args);
    expect(generated.status, generated.stderr).toBe(0);
    const files = await readOutput(root);
    expect(Object.keys(files)).toHaveLength(6);
    expect(files['NoteTypes.ts']).toContain('title');

    const fresh = await runCli([...args, '--check']);
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.stdout).toContain('check passed');
    expect(await readOutput(root)).toEqual(files);

    await writeFile(join(root, 'database/models/note.prisma'), noteModel('Int'));
    const stale = await runCli([...args, '--check']);
    expect(stale.status, stale.stderr).toBe(1);
    expect(stale.stderr).toContain('stale');
    expect(await readOutput(root)).toEqual(files);
  }, 30_000);

  it('prints help without requiring a schema or creating project files', async () => {
    const root = await temporaryRoot();
    const result = await runCli(['--root', join(root, 'not-created'), '--schema', 'missing-schema', '--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('--check');
    expect(result.stdout).toContain('--schema');
    expect(await readdir(root)).toEqual([]);
  });

  it.each(['mysql'])('rejects a %s datasource before generating output', async provider => {
    const root = await temporaryRoot();
    const args = await createFixture(root, provider);
    const result = await runCli(args);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('PostgreSQL or SQLite');
    expect(await readdir(root)).not.toContain('src');
  });

  it('generates a domain from a SQLite datasource used by the application', async () => {
    const root = await temporaryRoot();
    const args = await createFixture(root, 'sqlite');
    const result = await runCli(args);
    expect(result.status, result.stderr).toBe(0);
    expect(Object.keys(await readOutput(root))).toHaveLength(6);
  }, 30_000);

  it('rejects a malformed schema before generating output', async () => {
    const root = await temporaryRoot();
    const args = await createFixture(root);
    await writeFile(join(root, 'database/models/note.prisma'), 'model Note {\n id ThisTypeDoesNotExist @id\n}\n');
    const result = await runCli(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ThisTypeDoesNotExist');
    expect(await readdir(root)).not.toContain('src');
  });
});
