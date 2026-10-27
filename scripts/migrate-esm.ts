import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const packagesDir = join(import.meta.dirname, '..', 'packages');

const viteConfig = "export { default } from '../../tooling/pack-preset.ts';\n";

const exportsMap = {
  '.': {
    types: './dist/index.d.ts',
    'react-native': './dist/index.native.js',
    default: './dist/index.js',
  },
};

type PackageJson = {
  scripts: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
};

function migratePackageJson(source: string): string {
  const pkg: PackageJson = JSON.parse(source);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pkg)) {
    if (key === 'main' || key === 'module' || key === 'types') continue;
    next[key] = value;
    if (key === 'license') next.type = 'module';
  }
  next.exports = exportsMap;
  const { clean: _clean, ...scripts } = pkg.scripts;
  next.scripts = { ...scripts, build: 'vp pack', dev: 'vp pack --watch' };
  const { tsup: _tsup, ...devDependencies } = pkg.devDependencies ?? {};
  next.devDependencies = devDependencies;
  return JSON.stringify(next, null, 2) + '\n';
}

const changed: string[] = [];
function write(path: string, output: string) {
  if (existsSync(path) && readFileSync(path, 'utf8') === output) return;
  writeFileSync(path, output);
  changed.push(path);
}

for (const name of readdirSync(packagesDir).sort()) {
  const dir = join(packagesDir, name);
  const pkgPath = join(dir, 'package.json');
  write(pkgPath, migratePackageJson(readFileSync(pkgPath, 'utf8')));
  write(join(dir, 'vite.config.ts'), viteConfig);
  const tsup = join(dir, 'tsup.config.ts');
  if (existsSync(tsup)) {
    rmSync(tsup);
    changed.push(`${tsup} (deleted)`);
  }
}

console.log(changed.length ? changed.join('\n') : 'no changes');
