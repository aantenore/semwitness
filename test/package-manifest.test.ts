import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly files?: readonly string[];
  readonly exports?: Readonly<
    Record<
      string,
      {
        readonly types?: string;
        readonly import?: string;
      }
    >
  >;
  readonly scripts?: Readonly<Record<string, string>>;
}

describe('package manifest', () => {
  it('builds pinned Git dependencies without requiring the pnpm executable', async () => {
    const manifestUrl = new URL('../package.json', import.meta.url);
    const manifest = JSON.parse(
      await readFile(manifestUrl, 'utf8'),
    ) as PackageManifest;

    expect(manifest.scripts?.build).toBe(
      'tsc -p tsconfig.build.json && node scripts/build-plugin.mjs',
    );
    expect(manifest.scripts?.prepack).toBe('npm run build');
    expect(manifest.scripts?.prepare).toBe('npm run build');
  });

  it('publishes the Compact Response API and reproducible example inputs', async () => {
    const manifestUrl = new URL('../package.json', import.meta.url);
    const pluginManifestUrl = new URL(
      '../plugins/semwitness/.codex-plugin/plugin.json',
      import.meta.url,
    );
    const [manifest, pluginManifest] = await Promise.all([
      readFile(manifestUrl, 'utf8').then(
        (source) => JSON.parse(source) as PackageManifest,
      ),
      readFile(pluginManifestUrl, 'utf8').then(
        (source) => JSON.parse(source) as PackageManifest,
      ),
    ]);

    expect(manifest).toMatchObject({
      name: 'semwitness',
      version: '0.7.0-alpha.1',
    });
    expect(pluginManifest).toMatchObject({
      name: manifest.name,
      version: manifest.version,
    });
    expect(manifest.exports?.['./response']).toEqual({
      types: './dist/response/index.d.ts',
      import: './dist/response/index.js',
    });
    expect(manifest.exports?.['./ai-sdk']).toEqual({
      types: './dist/ai-sdk/index.d.ts',
      import: './dist/ai-sdk/index.js',
    });
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        'dist',
        'examples/compact-response/ai-sdk-output.mjs',
        'examples/compact-response/change-report.candidate.json',
        'examples/compact-response/change-report.contract.json',
      ]),
    );
  });
});
