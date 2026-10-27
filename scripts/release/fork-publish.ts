import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const UPSTREAM_SCOPE = '@rn-primitives/';
const FORK_SCOPE = '@pattobrien/rn-primitives-';
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

const forkName = (name: string) => name.replace(UPSTREAM_SCOPE, FORK_SCOPE);

const aliasDependencies = (dependencies: unknown, version: string) =>
  isRecord(dependencies)
    ? Object.fromEntries(
        Object.entries(dependencies).map(([name, range]) => [
          name,
          name.startsWith(UPSTREAM_SCOPE) ? `npm:${forkName(name)}@${version}` : range,
        ])
      )
    : dependencies;

const forkManifest = ({ dir, name, raw }: WorkspacePackage, version: string) => ({
  ...raw,
  name: forkName(name),
  version,
  ...Object.fromEntries(
    DEPENDENCY_FIELDS.filter((field) => field in raw).map((field) => [
      field,
      aliasDependencies(raw[field], version),
    ])
  ),
  repository: { type: 'git', url: REPOSITORY, directory: dir },
  publishConfig: { registry: REGISTRY },
});

const pack = (
  root: string,
  destination: string,
  pkg: WorkspacePackage,
  version: string
): Planned => {
  const manifestPath = join(root, pkg.dir, 'package.json');
  const manifest = forkManifest(pkg, version);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    const { stdout } = runOrThrow(
      'pnpm',
      ['pack', '--pack-destination', destination],
      join(root, pkg.dir),
      true
    );
    const tarball = stdout.trim().split('\n').at(-1) ?? '';
    if (!tarball.endsWith('.tgz') || !existsSync(tarball)) {
      return fail(`pnpm pack printed no tarball path for ${pkg.dir}: ${stdout}`);
    }
    return { spec: `${manifest.name}@${version}`, tarball };
  } finally {
    writeFileSync(manifestPath, pkg.text);
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
mkdirSync(destination, { recursive: true });
const planned = packages.map((pkg) => pack(root, destination, pkg, version));

if (values['dry-run']) {
  planned.forEach(({ spec }) => console.log(spec));
  console.log(`${planned.length} packages planned, nothing published`);
} else {
  planned.forEach(publish);
}
