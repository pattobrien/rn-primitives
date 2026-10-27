import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const packagesDir = join(import.meta.dirname, '..', 'packages');

const exportsMap = {
  '.': {
    types: './dist/index.d.ts',
    browser: './dist/index.web.jsx',
    'react-native': './dist/index.native.jsx',
    webpack: './dist/index.web.jsx',
    default: './dist/index.js',
  },
};

const tsupConfig = `import { defineConfig, type Options } from 'tsup';

const webExtensions = ['.web.tsx', '.web.ts', '.tsx', '.ts'];

const shared: Options = {
  format: 'esm',
  banner: { js: "'use client'" },
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    dts: true,
    esbuildOptions(options) {
      options.jsx = 'transform';
      options.resolveExtensions = webExtensions;
    },
  },
  {
    ...shared,
    entry: { 'index.web': 'src/index.ts' },
    outExtension: () => ({ js: '.jsx' }),
    esbuildOptions(options) {
      options.jsx = 'preserve';
      options.resolveExtensions = webExtensions;
    },
  },
  {
    ...shared,
    entry: { 'index.native': 'src/index.ts' },
    outExtension: () => ({ js: '.jsx' }),
    esbuildOptions(options) {
      options.jsx = 'preserve';
    },
  },
]);
`;

type PackageJson = Record<string, unknown> & { scripts: Record<string, string> };

function migratePackageJson(source: string): string {
  const pkg: PackageJson = JSON.parse(source);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pkg)) {
    if (key === 'main' || key === 'module' || key === 'types') continue;
    next[key] = value;
    if (key === 'license' && !('type' in pkg)) next.type = 'module';
  }
  next.type = 'module';
  next.exports = exportsMap;
  next.scripts = { ...pkg.scripts, build: 'rm -rf dist && tsup' };
  return JSON.stringify(next, null, 2) + '\n';
}

function migrateTsconfig(source: string, path: string): string {
  const { config, error } = ts.parseConfigFileTextToJson(path, source);
  if (error) throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  config.compilerOptions = {
    ...config.compilerOptions,
    module: 'preserve',
    moduleResolution: 'bundler',
    skipLibCheck: true,
  };
  return JSON.stringify(config, null, 2) + '\n';
}

const transforms: Record<string, (source: string, path: string) => string> = {
  'package.json': migratePackageJson,
  'tsup.config.ts': () => tsupConfig,
  'tsconfig.json': migrateTsconfig,
};

const changed: string[] = [];
for (const name of readdirSync(packagesDir).sort()) {
  for (const [file, transform] of Object.entries(transforms)) {
    const path = join(packagesDir, name, file);
    const source = readFileSync(path, 'utf8');
    const output = transform(source, path);
    if (output !== source) {
      writeFileSync(path, output);
      changed.push(`packages/${name}/${file}`);
    }
  }
}

console.log(changed.length ? changed.join('\n') : 'no changes');
