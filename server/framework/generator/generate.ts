import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import prismaInternals from '@prisma/internals';
import type { MultipleSchemas } from '@prisma/internals';
import { normalizeDomains } from './model.js';
import { renderDomain } from './templates.js';
import { writeGeneratedFiles } from './writer.js';

export interface GenerateDomainsOptions {
  root?: string;
  schema?: string;
  config?: string;
  check?: boolean;
}

async function checkOrphanedOutput(root: string, expected: ReadonlySet<string>): Promise<void> {
  const source = path.join(root, 'src');
  let domains;
  try {
    domains = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const orphans: string[] = [];
  for (const domain of domains) {
    if (!domain.isDirectory()) continue;
    for (const file of await readdir(path.join(source, domain.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.ts')) continue;
      const relative = `src/${domain.name}/${file.name}`;
      if (expected.has(relative)) continue;
      const content = await readFile(path.join(root, relative), 'utf8');
      if (content.includes('// <framework:generated sha256=')) orphans.push(relative);
    }
  }
  if (orphans.length) {
    throw new Error(`Generated files have no matching domain configuration:\n${orphans.sort().join('\n')}\nRemove their application wiring and retire or move these files explicitly. Generation never deletes domains.`);
  }
}

async function readSchema(schemaPath: string): Promise<string | MultipleSchemas> {
  const entry = await lstat(schemaPath);
  if (entry.isSymbolicLink()) throw new Error(`Schema path must not be a symlink: ${schemaPath}`);
  if (entry.isFile()) return readFile(schemaPath, 'utf8');
  if (!entry.isDirectory()) throw new Error(`Expected a Prisma schema file or directory: ${schemaPath}`);

  const schemas: MultipleSchemas = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const item of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error(`Schema directory must not contain symlinks: ${file}`);
      if (item.isDirectory()) await visit(file);
      else if (item.isFile() && item.name.endsWith('.prisma')) schemas.push([file, await readFile(file, 'utf8')]);
    }
  }
  await visit(schemaPath);
  if (!schemas.length) throw new Error(`No .prisma files found in ${schemaPath}`);
  return schemas;
}

/** Generate from Prisma metadata without connecting to a database or applying migrations. */
export async function generateDomains(options: GenerateDomainsOptions = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const schemaPath = path.resolve(root, options.schema ?? 'prisma/schema.prisma');
  const configPath = path.resolve(root, options.config ?? 'prisma/domains.json');
  const [datamodel, configuration] = await Promise.all([
    readSchema(schemaPath),
    readFile(configPath, 'utf8'),
  ]);
  let config: unknown;
  try {
    config = JSON.parse(configuration);
  } catch {
    throw new Error(`Invalid JSON in domain configuration: ${configPath}`);
  }
  // Pinned to the same Prisma version as the client. No handwritten schema parser.
  const schemaConfig = await prismaInternals.getConfig({ datamodel });
  if (schemaConfig.datasources.length !== 1 || !['postgresql', 'sqlite'].includes(schemaConfig.datasources[0]?.provider ?? '')) {
    throw new Error('Domain generation currently supports a single PostgreSQL or SQLite datasource.');
  }
  const metadata = await prismaInternals.getDMMF({ datamodel });
  const domains = normalizeDomains(metadata.datamodel, config);
  const files = domains.flatMap(renderDomain);
  await checkOrphanedOutput(root, new Set(files.map((file) => file.path)));
  return writeGeneratedFiles(root, files, { check: options.check ?? false });
}
