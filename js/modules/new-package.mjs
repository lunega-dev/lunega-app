// usage: npm run new -- <name> [dep-name ...]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [name, ...deps] = process.argv.slice(2);
if (!name) {
  console.error('usage: npm run new -- <name> [dep-name ...]');
  process.exit(1);
}

const root = import.meta.dirname;
const dir = join(root, name);
if (existsSync(dir)) {
  console.error(`${name} already exists`);
  process.exit(1);
}

const write = (file, content) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
};

write('package.json', {
  name: `@lunega-dev/${name}`,
  version: '0.0.0',
  type: 'module',
  exports: {
    '.': {
      types: './dist/index.d.ts',
      development: './src/index.ts',
      default: './dist/index.js',
    },
  },
  files: ['dist'],
  scripts: {
    build: 'tsc -b',
    test: 'vitest run',
    prepublishOnly: 'tsc -b',
  },
  dependencies: Object.fromEntries(deps.map((d) => [`@lunega-dev/${d}`, '*'])),
  publishConfig: {
    registry: 'https://npm.pkg.github.com',
  },
});

write('tsconfig.json', {
  extends: '../tsconfig.base.json',
  compilerOptions: { rootDir: 'src', outDir: 'dist' },
  include: ['src'],
  exclude: ['src/**/*.test.ts'],
  references: deps.map((d) => ({ path: `../${d}` })),
});

write('src/index.ts', `export const name = '${name}';\n`);
write('src/index.test.ts', `import { expect, test } from 'vitest';
import { name } from './index.js';

test('exports its name', () => {
  expect(name).toBe('${name}');
});
`);

const updateJson = (file, fn) => {
  const path = join(root, file);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  fn(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
};
updateJson('package.json', (p) => p.workspaces.push(name));
updateJson('tsconfig.json', (t) => t.references.push({ path: `./${name}` }));

console.log(`created ${name}, run npm install to link it`);
