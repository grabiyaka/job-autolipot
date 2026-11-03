import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { checkDependency, inspectArchitecture, inspectSourceImports } from '../scripts/check-architecture.js';

const root = process.cwd();
const domain = `${root}/src/readings`;

test('controllers cannot import even their own repository or its contract', () => {
  for (const dependency of ['ReadingRepository.ts', 'ReadingContracts.ts', 'ReadingSnapshotMapper.ts', 'ReadingService.ts', 'ReadingRoutes.ts']) {
    assert.notEqual(checkDependency(`${domain}/ReadingController.ts`, `${domain}/${dependency}`).length, 0);
  }
});

test('domain routes can wire their own controllers and middleware without repository access', () => {
  assert.notEqual(checkDependency(`${domain}/ReadingRoutes.ts`, `${domain}/ReadingRepository.ts`).length, 0);
  assert.deepEqual(checkDependency(`${domain}/ReadingRoutes.ts`, `${domain}/ReadingController.ts`), []);
  assert.deepEqual(checkDependency(`${domain}/ReadingRoutes.ts`, `${root}/middlewares/access.ts`), []);
  assert.deepEqual(checkDependency(`${domain}/ReadingRoutes.ts`, `${root}/framework/http/error-schema.ts`), []);
  assert.notEqual(checkDependency(`${domain}/ReadingController.ts`, `${root}/middlewares/access.ts`).length, 0);
  assert.notEqual(checkDependency(`${domain}/ReadingRoutes.ts`, `${root}/src/subscribers/SubscriberRoutes.ts`).length, 0);
});

test('services may use their own contracts and foreign public Types modules', () => {
  assert.deepEqual(checkDependency(`${domain}/ReadingService.ts`, `${domain}/ReadingContracts.ts`), []);
  assert.deepEqual(checkDependency(`${domain}/ReadingService.ts`, `${domain}/ReadingRules.ts`), []);
  assert.deepEqual(checkDependency(`${domain}/ReadingService.ts`, `${domain}/MeterReading.ts`), []);
  assert.deepEqual(checkDependency(`${domain}/ReadingService.ts`, `${domain}/OtherService.ts`), []);
  assert.deepEqual(checkDependency(`${domain}/ReadingService.ts`, `${root}/src/subscribers/SubscriberTypes.ts`), []);
  for (const dependency of ['public.ts', 'internal/SubscriberTypes.ts', 'SubscriberTypesHelper.ts']) {
    assert.notEqual(checkDependency(`${domain}/ReadingService.ts`, `${root}/src/subscribers/${dependency}`).length, 0);
  }
  for (const dependency of ['ReadingRepository.ts', 'ReadingSnapshotMapper.ts', 'ReadingRoutes.ts', 'ReadingController.ts']) {
    assert.notEqual(checkDependency(`${domain}/ReadingService.ts`, `${domain}/${dependency}`).length, 0);
  }
  assert.notEqual(checkDependency(`${domain}/ReadingService.ts`, `${root}/src/subscribers/SubscriberContracts.ts`).length, 0);
  assert.notEqual(checkDependency(`${domain}/ReadingService.ts`, `${root}/src/subscribers/SubscriberService.ts`).length, 0);
});

test('repositories cannot reach another domain repository', () => {
  assert.notEqual(checkDependency(`${domain}/ReadingRepository.ts`, `${root}/src/subscribers/SubscriberRepository.ts`).length, 0);
  assert.notEqual(checkDependency(`${domain}/ReadingSnapshotMapper.ts`, `${root}/src/subscribers/SubscriberRepository.ts`).length, 0);
  assert.deepEqual(checkDependency(`${domain}/ReadingRepository.ts`, `${domain}/ReadingSnapshotMapper.ts`), []);
  assert.deepEqual(checkDependency(`${domain}/ReadingRepository.ts`, `${domain}/ReadingContracts.ts`), []);
});

test('Prisma is inaccessible from services even through a resolved alias', () => {
  const result = inspectSourceImports(
    `${domain}/ReadingService.ts`,
    "import type { PrismaClient } from '@database';",
    () => `${root}/generated/prisma/client.ts`,
  );
  assert.equal(result.length, 1);
  assert.match(result[0]!.reason, /Prisma/);
  assert.notEqual(checkDependency(`${domain}/ReadingService.ts`, '@prisma/client').length, 0);
  assert.deepEqual(checkDependency(`${domain}/ReadingRepository.ts`, `${root}/generated/prisma/client.ts`), []);
  assert.deepEqual(checkDependency(`${domain}/ReadingSnapshotMapper.ts`, `${root}/generated/prisma/client.ts`), []);
});

test('business rules and unrecognized modules cannot import framework, filesystem, plugins or persistence contracts', () => {
  for (const source of ['ReadingRules.ts', 'MeterReading.ts', 'unknown-helper.ts']) {
    for (const dependency of ['fastify', 'node:fs', 'undici', `${root}/generated/prisma/client.ts`, `${root}/plugins/prisma.ts`, `${root}/middlewares/access.ts`, `${root}/framework/composition/create-application.ts`, `${root}/framework/http/error-schema.ts`, `${root}/app.ts`, `${domain}/ReadingContracts.ts`, `${domain}/ReadingSnapshotMapper.ts`]) {
      assert.notEqual(checkDependency(`${domain}/${source}`, dependency).length, 0, `${source} -> ${dependency}`);
    }
  }
  assert.deepEqual(checkDependency(`${domain}/ReadingRules.ts`, `${root}/src/subscribers/SubscriberTypes.ts`), []);
  assert.deepEqual(checkDependency(`${domain}/ReadingRules.ts`, `${root}/framework/core/errors.ts`), []);
  assert.deepEqual(checkDependency(`${domain}/ReadingRules.ts`, `${domain}/WaterConsumption.ts`), []);
});

test('public contracts and core cannot launder private infrastructure dependencies', () => {
  assert.deepEqual(checkDependency(`${domain}/ReadingTypes.ts`, `${root}/src/subscribers/SubscriberTypes.ts`), []);
  assert.deepEqual(checkDependency(`${root}/plugins/system-routes.ts`, `${domain}/ReadingTypes.ts`), []);
  assert.deepEqual(checkDependency(`${root}/middlewares/access.ts`, `${domain}/ReadingTypes.ts`), []);
  assert.notEqual(checkDependency(`${domain}/ReadingTypes.ts`, `${domain}/ReadingRepository.ts`).length, 0);
  assert.notEqual(checkDependency(`${domain}/ReadingTypes.ts`, `${domain}/ReadingContracts.ts`).length, 0);
  assert.notEqual(checkDependency(`${domain}/ReadingContracts.ts`, `${domain}/ReadingRepository.ts`).length, 0);
  assert.notEqual(checkDependency(`${domain}/ReadingContracts.ts`, `${domain}/ReadingSnapshotMapper.ts`).length, 0);
  assert.notEqual(checkDependency(`${root}/framework/core/helpers.ts`, `${root}/plugins/database.ts`).length, 0);
  assert.notEqual(checkDependency(`${root}/framework/core/helpers.ts`, `${root}/framework/composition/create-application.ts`).length, 0);
  assert.notEqual(checkDependency(`${root}/framework/http/error-schema.ts`, `${root}/plugins/database.ts`).length, 0);
  assert.notEqual(checkDependency(`${root}/plugins/system-routes.ts`, `${domain}/ReadingContracts.ts`).length, 0);
  assert.notEqual(checkDependency(`${root}/middlewares/access.ts`, `${domain}/ReadingRepository.ts`).length, 0);
});

test('composition can explicitly assemble repositories and services', () => {
  assert.deepEqual(checkDependency(`${root}/framework/composition/create-services.ts`, `${domain}/ReadingRepository.ts`), []);
  assert.deepEqual(checkDependency(`${root}/framework/composition/register-routes.ts`, `${domain}/ReadingRoutes.ts`), []);
});

test('generator tooling may read Prisma metadata without depending on application modules', () => {
  const generator = `${root}/framework/generator/schema.ts`;
  for (const dependency of ['@prisma/internals', '@prisma/dmmf', 'node:fs/promises', 'typescript']) {
    assert.deepEqual(checkDependency(generator, dependency), [], dependency);
  }
  assert.deepEqual(checkDependency(generator, `${root}/framework/generator/config.ts`), []);
  assert.deepEqual(checkDependency(generator, `${root}/framework/core/errors.ts`), []);
  for (const dependency of [
    `${domain}/ReadingTypes.ts`, `${domain}/ReadingService.ts`, `${domain}/ReadingRepository.ts`,
    `${root}/framework/composition/create-application.ts`, `${root}/generated/prisma/client.ts`,
    `${root}/plugins/prisma.ts`, `${root}/middlewares/access.ts`, `${root}/app.ts`, `${root}/server.ts`,
  ]) {
    assert.notEqual(checkDependency(generator, dependency).length, 0, dependency);
  }
  // Reading metadata does not make Prisma types available to domain code.
  for (const source of ['ReadingService.ts', 'ReadingTypes.ts', 'ReadingContracts.ts', 'ReadingRules.ts']) {
    for (const dependency of ['@prisma/internals', '@prisma/dmmf']) {
      assert.notEqual(checkDependency(`${domain}/${source}`, dependency).length, 0, `${source} -> ${dependency}`);
    }
  }
});

test('runtime code cannot reach generator tooling, including through composition or aliases', () => {
  const generator = `${root}/framework/generator/schema.ts`;
  for (const source of [
    'src/readings/ReadingRepository.ts', 'src/readings/ReadingSnapshotMapper.ts',
    'src/readings/ReadingService.ts', 'src/readings/ReadingTypes.ts', 'src/readings/ReadingController.ts',
    'framework/core/helpers.ts', 'framework/http/error-schema.ts', 'framework/composition/create-services.ts',
    'framework/composition.ts', 'framework/other.ts', 'plugins/prisma.ts', 'middlewares/access.ts',
    'app.ts', 'server.ts', 'generated/prisma/client.ts',
  ]) {
    assert.match(checkDependency(`${root}/${source}`, generator)[0] ?? '', /Generator tooling/, source);
    for (const expression of [
      "import { generate } from '@tooling';", "export * from '@tooling';",
      "type Tool = import('@tooling').Tool;", "const tool = await import('@tooling');",
      "const tool = require('@tooling');",
    ]) {
      assert.equal(inspectSourceImports(`${root}/${source}`, expression, () => generator).length, 1, `${source}: ${expression}`);
    }
  }
  for (const source of ['scripts/generate-domains.ts', 'tests/generator.test.ts']) {
    assert.deepEqual(checkDependency(`${root}/${source}`, generator), []);
  }
});

test('external packages cannot impersonate local core or public contracts', () => {
  for (const specifier of ['framework/core/helpers', 'src/subscribers/SubscriberTypes.ts']) {
    const expression = `import { value } from '${specifier}';`;
    assert.equal(inspectSourceImports(`${domain}/ReadingRules.ts`, expression, () => undefined).length, 1);
    assert.equal(inspectSourceImports(`${domain}/ReadingRules.ts`, expression, () => `${root}/node_modules/example/${specifier}`).length, 1);
  }
  assert.deepEqual(checkDependency('src/readings/ReadingRules.ts', 'framework/core/errors.ts'), []);
});

test('re-exports, type imports, dynamic imports and require obey the same boundaries', () => {
  const expressions = [
    "export * from '@private';",
    "type Database = import('@private').Database;",
    "const database = await import('@private');",
    "const database = require('@private');",
    "import database = require('@private');",
  ];
  for (const expression of expressions) {
    assert.equal(inspectSourceImports(`${domain}/ReadingController.ts`, expression, () => `${domain}/ReadingRepository.ts`).length, 1, expression);
  }
});

test('computed import paths cannot hide domain dependencies', () => {
  for (const expression of ['import(path)', 'require(path)', 'import(`./${name}.js`)']) {
    const result = inspectSourceImports(`${domain}/ReadingService.ts`, expression, () => undefined);
    assert.equal(result.length, 1);
    assert.match(result[0]!.reason, /string literals/);
  }
});

test('architecture inspection scans every source root with absolute and relative project paths', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'framework-architecture-'));
  const files: Record<string, string> = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    'src/readings/ReadingContracts.ts': 'export type Repository = {};',
    'framework/core/bad.ts': "import type { Repository } from '../../src/readings/ReadingContracts.js';",
    'plugins/bad.ts': "import type { Repository } from '../src/readings/ReadingContracts.js';",
    'middlewares/bad.ts': "import type { Repository } from '../src/readings/ReadingContracts.js';",
    'src/readings/ReadingRoutes.ts': "import type { Repository } from './ReadingContracts.js';",
    'app.ts': "import '@prisma/client';",
    'server.ts': "import '@prisma/client';",
    'framework/generator/metadata.ts': "import type { Repository } from '../../src/readings/ReadingContracts.js';",
    'framework/composition/tooling-backdoor.ts': "import '../generator/writer.js';",
    'framework/generator/writer.ts': "export const write = () => undefined;",
    'generated/prisma/client.ts': "import './missing-generated-file.js';",
  };
  try {
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(fixture, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    const expected = ['app.ts', 'framework/composition/tooling-backdoor.ts', 'framework/core/bad.ts', 'framework/generator/metadata.ts', 'middlewares/bad.ts', 'plugins/bad.ts', 'server.ts', 'src/readings/ReadingRoutes.ts'];
    for (const fixturePath of [fixture, path.relative(process.cwd(), fixture)]) {
      assert.deepEqual(inspectArchitecture(fixturePath).map(({ file }) => path.relative(fixture, file)).sort(), expected);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
