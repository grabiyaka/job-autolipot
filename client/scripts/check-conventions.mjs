import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '@vue/compiler-sfc';
import scss from 'postcss-scss';

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? files(join(directory, entry.name))
    : [join(directory, entry.name)]));
  return nested.flat();
}

const violations = [];
for (const file of (await files('src')).filter((file) => file.endsWith('.vue'))) {
  const source = await readFile(file, 'utf8');
  const { descriptor, errors } = parse(source, { filename: file });
  if (errors.length) violations.push(`${file}: Vue parse failed`);
  if (descriptor.scriptSetup) violations.push(`${file}: use Options API, not script setup`);
  if (!descriptor.script?.content.includes('defineComponent(')) violations.push(`${file}: use typed defineComponent Options API`);
  if (/\b(?:setup|ref|reactive|onMounted)\s*\(/.test(descriptor.script?.content ?? '')) violations.push(`${file}: component logic belongs in Options API`);
  for (const style of descriptor.styles) {
    if (!style.scoped || style.lang !== 'scss') violations.push(`${file}: component styles must be scoped SCSS`);
    const ast = scss.parse(style.content);
    const roots = ast.nodes.filter((node) => node.type === 'rule');
    if (roots.length !== 1) violations.push(`${file}: nest component styles under one root selector`);
    ast.walkAtRules('media', () => violations.push(`${file}: use responsive mixin next to affected selector`));
    ast.walkDecls((declaration) => {
      if (/#[\da-f]{3,8}\b/i.test(declaration.value)) violations.push(`${file}: use shared color tokens or named colors`);
    });
  }
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Vue Options API and scoped SCSS conventions passed.');
}
