import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

interface PackageManifest {
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
});
