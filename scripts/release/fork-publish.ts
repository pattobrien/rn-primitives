import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const UPSTREAM_SCOPE = '@rn-primitives/';
const FORK_SCOPE = '@pattobrien/rn-primitives-';
const UPSTREAM_DIST_DIR = '.upstream-dist';
const REGISTRY = 'https://npm.pkg.github.com';
const REPOSITORY = 'git+https://github.com/pattobrien/rn-primitives.git';
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

interface WorkspacePackage {
  readonly dir: string;
  readonly text: string;
  readonly name: string;
  readonly version: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

interface Planned {
  readonly spec: string;
  readonly tarball: string;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const run = (cmd: string, args: readonly string[], cwd?: string, quiet = false) => {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

const runOrThrow = (cmd: string, args: readonly string[], cwd?: string, quiet = false) => {
  const result = run(cmd, args, cwd, quiet);
  if (result.exitCode !== 0) {
    throw new Error(
      `${[cmd, ...args].join(' ')} failed (exit ${result.exitCode}) ${result.stderr.trim()} ${result.stdout.trim()}`
    );
  }
  return result;
};

const readPackage = (root: string, dir: string): WorkspacePackage => {
  const text = readFileSync(join(root, dir, 'package.json'), 'utf8');
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.version !== 'string') {
    return fail(`${dir}/package.json has no string name and version`);
  }
  return { dir, text, name: raw.name, version: raw.version, raw };
};

const publishablePackages = (root: string) =>
  readdirSync(join(root, 'packages'))
    .sort()
    .map((entry) => join('packages', entry))
    .filter((dir) => existsSync(join(root, dir, 'package.json')))
    .map((dir) => readPackage(root, dir))
    .filter((pkg) => pkg.raw.private !== true);

const highestVersion = (versions: readonly string[]) => {
  const invalid = versions.find((version) => !/^\d+\.\d+\.\d+$/.test(version));
  if (invalid !== undefined) fail(`${invalid} is not a major.minor.patch version`);
  return versions.toSorted((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
};

const forkName = (text: string) => text.replaceAll(UPSTREAM_SCOPE, FORK_SCOPE);

const forkDependencies = (dependencies: unknown, version: string) =>
  isRecord(dependencies)
    ? Object.fromEntries(
        Object.entries(dependencies).map(([name, range]) =>
          name.startsWith(UPSTREAM_SCOPE) ? [forkName(name), version] : [name, range]
        )
      )
    : dependencies;

const forkManifest = ({ dir, name, raw }: WorkspacePackage, version: string) => ({
  ...raw,
  name: forkName(name),
  version,
  ...Object.fromEntries(
    DEPENDENCY_FIELDS.filter((field) => field in raw).map((field) => [
      field,
      forkDependencies(raw[field], version),
    ])
  ),
  repository: { type: 'git', url: REPOSITORY, directory: dir },
  publishConfig: { registry: REGISTRY },
});

const forkFiles = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .forEach((path) => {
      const text = readFileSync(path, 'utf8');
      if (text.includes(UPSTREAM_SCOPE)) writeFileSync(path, forkName(text));
    });

const pack = (
  root: string,
  destination: string,
  pkg: WorkspacePackage,
  version: string
): Planned => {
  const dir = join(root, pkg.dir);
  const dist = join(dir, 'dist');
  const upstreamDist = join(destination, UPSTREAM_DIST_DIR, basename(pkg.dir));
  const manifest = forkManifest(pkg, version);
  renameSync(dist, upstreamDist);
  try {
    cpSync(upstreamDist, dist, { recursive: true });
    forkFiles(dist);
    writeFileSync(join(dir, 'package.json'), `${forkName(JSON.stringify(manifest, null, 2))}\n`);
    const { stdout } = runOrThrow('pnpm', ['pack', '--pack-destination', destination], dir, true);
    const tarball = stdout.trim().split('\n').at(-1) ?? '';
    if (!tarball.endsWith('.tgz') || !existsSync(tarball)) {
      throw new Error(`pnpm pack printed no tarball path for ${pkg.dir}: ${stdout}`);
    }
    return { spec: `${manifest.name}@${version}`, tarball };
  } finally {
    rmSync(dist, { recursive: true, force: true });
    renameSync(upstreamDist, dist);
    writeFileSync(join(dir, 'package.json'), pkg.text);
  }
};

const publish = ({ spec, tarball }: Planned) => {
  const existing = run('npm', ['view', spec, 'version', '--registry', REGISTRY], undefined, true);
  if (existing.exitCode === 0 && existing.stdout.trim() !== '') {
    console.log(`${spec} skipped, already published`);
    return;
  }
  runOrThrow('pnpm', [
    'publish',
    tarball,
    '--registry',
    REGISTRY,
    '--tag',
    'latest',
    '--no-git-checks',
  ]);
  console.log(`${spec} published`);
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { 'dry-run': { type: 'boolean', default: false } },
});
const [version] = positionals;
if (positionals.length !== 1 || version === undefined) {
  fail('Usage: node scripts/release/fork-publish.ts <upstream version>-fork.N [--dry-run]');
}

const root = resolve(import.meta.dirname, '../..');
const destination = join(root, 'release-packages');
const packages = publishablePackages(root);
const upstream = highestVersion(packages.map((pkg) => pkg.version)) ?? fail('No packages found');
if (/^(.+)-fork\.\d+$/.exec(version)?.[1] !== upstream) {
  const leaders = packages.filter((pkg) => pkg.version === upstream).map((pkg) => pkg.name);
  fail(
    `${version} is not ${upstream}-fork.N; ${upstream} is the highest upstream version (${leaders.join(', ')})`
  );
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(join(destination, UPSTREAM_DIST_DIR), { recursive: true });
const planned = packages.map((pkg) => pack(root, destination, pkg, version));
rmSync(join(destination, UPSTREAM_DIST_DIR), { recursive: true });

if (values['dry-run']) {
  planned.forEach(({ spec }) => console.log(spec));
  console.log(`${planned.length} packages planned, nothing published`);
} else {
  planned.forEach(publish);
}
