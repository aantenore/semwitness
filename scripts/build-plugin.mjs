import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = resolve(root, 'plugins/semwitness');
const outfile = resolve(pluginRoot, 'dist/cli.mjs');

async function assertReleaseMetadata() {
  const packageJson = JSON.parse(
    await readFile(resolve(root, 'package.json'), 'utf8'),
  );
  const pluginJson = JSON.parse(
    await readFile(resolve(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'),
  );
  const cliSource = await readFile(
    resolve(root, 'src/entrypoints/cli.ts'),
    'utf8',
  );
  if (packageJson.name !== pluginJson.name) {
    throw new Error('Package and plugin names must match');
  }
  if (packageJson.version !== pluginJson.version) {
    throw new Error('Package and plugin versions must match');
  }
  if (!cliSource.includes(`const VERSION = '${packageJson.version}';`)) {
    throw new Error('Package and CLI versions must match');
  }
}

function packageNameFromInput(input) {
  const normalized = input.replaceAll('\\', '/');
  const marker = 'node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }

  const packagePath = normalized.slice(markerIndex + marker.length);
  const parts = packagePath.split('/');
  return parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

async function readLicense(packageRoot) {
  const candidates = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENCE',
    'LICENCE.md',
    'LICENCE.txt',
  ];

  for (const candidate of candidates) {
    try {
      return await readFile(resolve(packageRoot, candidate), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  throw new Error(`Bundled package is missing a license file: ${packageRoot}`);
}

async function writePluginNotices(metafile) {
  const packageNames = [
    ...new Set(
      Object.keys(metafile.inputs)
        .map(packageNameFromInput)
        .filter((name) => name !== undefined),
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  if (packageNames.length === 0) {
    throw new Error(
      'Plugin bundle unexpectedly contains no third-party packages',
    );
  }

  const notices = [
    'THIRD-PARTY NOTICES',
    '',
    'The SemWitness Codex plugin bundles the following software. Each package',
    'remains subject to its own license, reproduced below.',
  ];

  for (const packageName of packageNames) {
    const packageRoot = resolve(root, 'node_modules', packageName);
    const packageJson = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    );
    const licenseText = (await readLicense(packageRoot)).trim();

    notices.push(
      '',
      '-'.repeat(78),
      `${packageJson.name} ${packageJson.version} (${packageJson.license})`,
      `Package: https://www.npmjs.com/package/${encodeURIComponent(packageJson.name)}/v/${encodeURIComponent(packageJson.version)}`,
      '-'.repeat(78),
      '',
      licenseText,
    );
  }

  await copyFile(resolve(root, 'LICENSE'), resolve(pluginRoot, 'LICENSE'));
  await writeFile(
    resolve(pluginRoot, 'THIRD_PARTY_NOTICES'),
    `${notices.join('\n')}\n`,
    { mode: 0o644 },
  );
}

await assertReleaseMetadata();
await mkdir(dirname(outfile), { recursive: true });
const result = await build({
  banner: {
    js: [
      "import { createRequire as __semwitnessCreateRequire } from 'node:module';",
      'const require = __semwitnessCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  bundle: true,
  entryPoints: [resolve(root, 'src/entrypoints/cli.ts')],
  format: 'esm',
  metafile: true,
  minifyWhitespace: true,
  outfile,
  packages: 'bundle',
  platform: 'node',
  sourcemap: false,
  target: 'node24',
});
await writePluginNotices(result.metafile);
const artifact = await readFile(outfile, 'utf8');
if (
  !artifact.startsWith('#!/usr/bin/env node\n') ||
  artifact.slice('#!/usr/bin/env node\n'.length).includes('\n#!')
) {
  throw new Error('Plugin runtime must contain exactly one leading shebang');
}
await chmod(outfile, 0o755);

console.log(`Built Codex plugin runtime: ${outfile}`);
