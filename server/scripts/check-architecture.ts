import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export type ArchitectureViolation = Readonly<{
  file: string;
  dependency: string;
  reason: string;
}>;

type DomainRole = 'public' | 'routes' | 'controller' | 'service' | 'repository' | 'contracts' | 'mapper' | 'business';
type DomainLocation = Readonly<{ name: string; role: DomainRole }>;

const normalize = (value: string): string => value.replaceAll('\\', '/');

function sourcePath(file: string, root: string): string | undefined {
  const normalized = normalize(path.relative(root, path.resolve(root, file)));
  if (/(?:^|\/)node_modules\//.test(normalized)) return undefined;
  return /^(?:src|framework|plugins|middlewares|generated)\//.test(normalized)
    || /^(?:app|server)\.[cm]?[jt]s$/.test(normalized)
    ? normalized
    : undefined;
}

function domainLocation(file: string | undefined): DomainLocation | undefined {
  const match = file?.match(/^src\/([^/]+)\/(.+)$/);
  if (!match) return undefined;
  if (isPublic(file)) return { name: match[1]!, role: 'public' };

  const suffix = path.basename(match[2]!).match(/(Routes|Controller|Service|Repository|Contracts|Mapper)\.[cm]?[jt]sx?$/)?.[1];
  // Unrecognized names remain pure; renaming a file cannot grant database or HTTP access.
  const role = suffix ? suffix.toLowerCase() as DomainRole : 'business';
  return { name: match[1]!, role };
}

function isPublic(file: string | undefined): boolean {
  return /^src\/[^/]+\/[^/]+Types\.[cm]?[jt]s$/.test(file ?? '');
}

function isComposition(file: string): boolean {
  return /^framework\/composition(?:\/|\.[cm]?[jt]s$)/.test(file);
}

function isGenerator(file: string | undefined): boolean {
  return file?.startsWith('framework/generator/') ?? false;
}

function isPrisma(dependency: string, specifier: string, target: string | undefined): boolean {
  return /^@prisma\//.test(specifier)
    || /^(?:prisma|\.prisma)(?:\/|$)/.test(specifier)
    || /\/node_modules\/(?:@prisma|\.prisma|prisma)\//.test(normalize(dependency))
    || /^generated(?:\/|$)/.test(target ?? '');
}

function isFastify(dependency: string, specifier: string): boolean {
  return /^(?:fastify|@fastify\/[^/]+)(?:\/|$)/.test(specifier)
    || /\/node_modules\/(?:fastify|@fastify\/[^/]+)\//.test(normalize(dependency));
}

/** Check resolved paths, so tsconfig aliases obey the same rules as relative imports. */
export function checkDependency(file: string, dependency: string, specifier = dependency, root = process.cwd()): string[] {
  const source = sourcePath(file, root);
  if (!source) return [];
  const target = sourcePath(dependency, root);
  // Tooling can read Prisma metadata, but must never become a runtime dependency or
  // an alternate route from application code to otherwise forbidden infrastructure.
  if (isGenerator(target) && !isGenerator(source)) {
    return ['Generator tooling is available only to development scripts, tests and other generator modules, not application runtime modules.'];
  }
  if (isGenerator(source)) {
    return target && !isGenerator(target) && !target.startsWith('framework/core/')
      ? ['Generator tooling must remain application-independent: only generator modules, pure core and external libraries are allowed.']
      : [];
  }
  if (source.startsWith('generated/') || isComposition(source)) return [];

  const from = domainLocation(source);
  const to = domainLocation(target);
  const isInfrastructure = from?.role === 'repository' || from?.role === 'mapper';
  const isPlugin = source.startsWith('plugins/');

  if (isPrisma(dependency, specifier, target) && !isInfrastructure && !isPlugin) {
    return ['Prisma and generated database types are private to Repository/Mapper modules, plugins and composition.'];
  }

  // Core is shared with pure business rules; it must not become an infrastructure back door.
  if (source.startsWith('framework/core/')) {
    return target?.startsWith('framework/core/') ? [] : ['Core may depend only on other core modules.'];
  }

  if (source.startsWith('framework/http/')) {
    return target?.startsWith('framework/core/') || target?.startsWith('framework/http/')
      ? []
      : ['Shared HTTP schemas may depend only on pure core and other shared HTTP schemas.'];
  }

  if ((isPlugin || source.startsWith('middlewares/')) && to && !isPublic(target)) {
    return ['Plugins and middleware may access domains only through their *Types.ts contracts.'];
  }

  if (!from) return [];

  if (to && to.name !== from.name && !isPublic(target)) {
    return ['Other domains may be accessed only through their *Types.ts contracts.'];
  }

  if (isFastify(dependency, specifier) && !['routes', 'controller'].includes(from.role) && !isInfrastructure) {
    return ['Fastify is allowed only in Routes/Controller modules and infrastructure, not domain services or rules.'];
  }

  const ownDomain = to?.name === from.name;
  const publicContract = isPublic(target);
  const core = target?.startsWith('framework/core/');

  if (from.role === 'business') {
    return core || publicContract || (ownDomain && to.role === 'business')
      ? []
      : ['Business rules may import only business rules, public contracts and pure core modules.'];
  }

  // A small domain may be just Routes → Controller → Service → Repository: each layer may use
  // the next one of its own domain. Skipping a layer (Routes/Controller → Repository) stays forbidden.
  if (from.role === 'service') {
    return core || publicContract || (ownDomain && ['service', 'contracts', 'business', 'repository'].includes(to.role))
      ? []
      : ['Services may import only their own Service/Contracts/Repository modules, business rules, public contracts and core.'];
  }

  if (from.role === 'contracts' || from.role === 'public') {
    const allowedRoles = from.role === 'public' ? ['business'] : ['contracts', 'business'];
    return core || publicContract || (ownDomain && allowedRoles.includes(to.role))
      ? []
      : ['Domain contracts may not expose HTTP, infrastructure or application implementations.'];
  }

  if (from.role === 'routes') {
    return core || publicContract || (ownDomain && ['controller', 'service'].includes(to.role))
      || target?.startsWith('framework/http/') || target?.startsWith('middlewares/')
      || isFastify(dependency, specifier)
      ? []
      : ['Routes may import their own Controller/Service modules, public contracts, shared HTTP schemas, middleware, core and Fastify.'];
  }

  if (from.role === 'controller') {
    return core || publicContract || (ownDomain && to.role === 'service') || isFastify(dependency, specifier)
      ? []
      : ['Controllers may import only their own Service, public contracts, core and Fastify; repositories and middleware belong outside controllers.'];
  }

  // Infrastructure can implement its own ports and use libraries; foreign internals remain private.
  if (isInfrastructure) return [];

  return ['Unrecognized domain role.'];
}

/** Parse every dependency form instead of searching source text for import keywords. */
export function inspectSourceImports(
  file: string,
  text: string,
  resolve: (specifier: string) => string | undefined,
  root = process.cwd(),
): ArchitectureViolation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const violations: ArchitectureViolation[] = [];
  const inDomain = Boolean(domainLocation(sourcePath(file, root)));

  function inspectSpecifier(expression: ts.Node | undefined): void {
    if (!expression || (!ts.isStringLiteral(expression) && !ts.isNoSubstitutionTemplateLiteral(expression))) {
      if (inDomain) {
        violations.push({ file, dependency: '<dynamic>', reason: 'Domain dependency paths must be string literals so boundaries can be checked.' });
      }
      return;
    }

    const specifier = expression.text;
    const resolved = resolve(specifier);
    if (!resolved && (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#'))) {
      violations.push({ file, dependency: specifier, reason: 'Cannot resolve this local dependency. Run generation and check the import path.' });
      return;
    }
    // Unresolved package names such as "framework/core/helpers" are not local modules.
    const dependency = resolved ?? path.join(root, 'node_modules', specifier);
    for (const reason of checkDependency(file, dependency, specifier, root)) {
      violations.push({ file, dependency: specifier, reason });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) inspectSpecifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      inspectSpecifier(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      inspectSpecifier(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isImport || isRequire) inspectSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

export function inspectArchitecture(root: string): ArchitectureViolation[] {
  root = path.resolve(root);
  const configurationPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configurationPath) throw new Error(`No tsconfig.json found in ${root}`);
  const configuration = ts.readConfigFile(configurationPath, ts.sys.readFile);
  if (configuration.error) throw new Error(ts.flattenDiagnosticMessageText(configuration.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, path.dirname(configurationPath));
  if (parsed.errors.length) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }
  const cache = ts.createModuleResolutionCache(root, (file) => file, parsed.options);

  function inspectFile(file: string): ArchitectureViolation[] {
    return inspectSourceImports(file, readFileSync(file, 'utf8'), (specifier) => {
      return ts.resolveModuleName(specifier, file, parsed.options, ts.sys, cache).resolvedModule?.resolvedFileName;
    }, root);
  }

  function inspectDirectory(directory: string): ArchitectureViolation[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return inspectDirectory(file);
      if (!/\.[cm]?tsx?$/.test(entry.name)) return [];
      return inspectFile(file);
    });
  }

  return [
    ...['src', 'framework', 'plugins', 'middlewares'].flatMap((directory) => inspectDirectory(path.join(root, directory))),
    ...['app.ts', 'server.ts'].flatMap((name) => {
      const file = path.join(root, name);
      return existsSync(file) ? inspectFile(file) : [];
    }),
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const violations = inspectArchitecture(root);
  for (const violation of violations) {
    console.error(`${path.relative(root, violation.file)} -> ${violation.dependency}: ${violation.reason}`);
  }
  if (violations.length) {
    console.error(`Architecture check failed: ${violations.length} forbidden dependencies.`);
    process.exitCode = 1;
  } else {
    console.log('Architecture check passed: domain, repository and business-rule boundaries are intact.');
  }
}
