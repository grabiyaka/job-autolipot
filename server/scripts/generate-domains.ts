import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDomains } from '../framework/generator/generate.js';
import type { GenerateDomainsOptions } from '../framework/generator/generate.js';

const usage = `Generate typed domains from Prisma models and an explicit API field policy.

  npm run domain:generate
  npm run domain:generate -- --schema prisma/schema.prisma --config prisma/domains.json
  npm run domain:check

Options:
  --root PATH     Project directory (default: current directory)
  --schema PATH   Prisma schema file or directory, relative to project root
  --config PATH   Domain JSON configuration, relative to project root
  --check         Report stale generated blocks without changing files
  --help          Show this help

Only generated blocks are updated. Manual edits inside them cause a conflict.
Manual extensions outside those blocks are preserved. No migrations are applied.`;

export function parseArguments(args: readonly string[]): GenerateDomainsOptions & { help?: boolean } {
  const options: GenerateDomainsOptions & { help?: boolean } = {};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === '--check') options.check = true;
    else if (flag === '--help') options.help = true;
    else if (flag === '--schema' || flag === '--config' || flag === '--root') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Expected a path after ${flag}`);
      options[flag.slice(2) as 'schema' | 'config' | 'root'] = value;
    } else throw new Error(`Unknown option: ${flag}. Use --help.`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  const result = await generateDomains(options);
  if (options.check && result.stale.length) {
    console.error(`Generated domains are stale:\n${result.stale.map((file) => `  ${file}`).join('\n')}\nRun npm run domain:generate.`);
    process.exitCode = 1;
    return;
  }
  for (const file of result.created) console.log(`Created ${file}`);
  for (const file of result.updated) console.log(`Updated ${file}`);
  console.log(options.check
    ? `Domain generation check passed (${result.unchanged.length} files).`
    : `Domains generated: ${result.created.length} created, ${result.updated.length} updated, ${result.unchanged.length} unchanged.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
