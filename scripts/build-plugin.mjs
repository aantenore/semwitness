import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
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

function packageRootFromInput(input) {
  const normalized = input.replaceAll('\\', '/');
  const marker = 'node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }

  const packagePath = normalized.slice(markerIndex + marker.length);
  const parts = packagePath.split('/');
  const packagePartCount = parts[0]?.startsWith('@') ? 2 : 1;
  if (
    parts.length < packagePartCount ||
    parts.slice(0, packagePartCount).some((part) => part.length === 0)
  ) {
    return undefined;
  }
  const relativeRoot = normalized.slice(
    0,
    markerIndex +
      marker.length +
      parts.slice(0, packagePartCount).join('/').length,
  );
  return resolve(root, relativeRoot);
}

async function readLicense(packageRoot, packageJson) {
  const candidates = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENCE',
    'LICENCE.md',
    'LICENCE.txt',
  ];

  let primary;
  for (const candidate of candidates) {
    try {
      primary = {
        source: candidate,
        text: await readFile(resolve(packageRoot, candidate), 'utf8'),
      };
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  if (primary === undefined) {
    if (packageJson.license !== 'Apache-2.0') {
      throw new Error(
        `Bundled package is missing its declared license file: ${packageRoot}`,
      );
    }
    primary = {
      source: 'SPDX Apache-2.0 standard text',
      text: await readFile(resolve(root, 'LICENSE'), 'utf8'),
    };
  }

  const nestedLicensePattern = /^licen[cs]e(?:\.(?:md|txt))?$/iu;
  const nested = [];
  for (const entry of await readdir(packageRoot, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !nestedLicensePattern.test(entry.name)) continue;
    const path = resolve(entry.parentPath, entry.name);
    if (path === resolve(packageRoot, primary.source)) continue;
    nested.push({
      source: path.slice(packageRoot.length + 1).replaceAll('\\', '/'),
      text: await readFile(path, 'utf8'),
    });
  }
  nested.sort((left, right) =>
    left.source < right.source ? -1 : left.source > right.source ? 1 : 0,
  );

  const seen = new Set();
  return [primary, ...nested]
    .filter(({ text }) => {
      const normalized = text.trim();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .map(({ source, text }) => `License source: ${source}\n\n${text.trim()}`)
    .join('\n\n');
}

async function writePluginNotices(metafile) {
  const packageRoots = [
    ...new Set(
      Object.keys(metafile.inputs)
        .map(packageRootFromInput)
        .filter((packageRoot) => packageRoot !== undefined),
    ),
  ];

  if (packageRoots.length === 0) {
    throw new Error(
      'Plugin bundle unexpectedly contains no third-party packages',
    );
  }

  const packages = await Promise.all(
    packageRoots.map(async (packageRoot) => ({
      packageRoot,
      packageJson: JSON.parse(
        await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
      ),
    })),
  );
  packages.sort((left, right) => {
    const leftKey = `${left.packageJson.name}\0${left.packageJson.version}\0${left.packageRoot}`;
    const rightKey = `${right.packageJson.name}\0${right.packageJson.version}\0${right.packageRoot}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  const notices = [
    'THIRD-PARTY NOTICES',
    '',
    'The SemWitness Codex plugin bundles the following software. Each package',
    'remains subject to its own license, reproduced below.',
  ];

  for (const { packageRoot, packageJson } of packages) {
    const licenseText = await readLicense(packageRoot, packageJson);

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
