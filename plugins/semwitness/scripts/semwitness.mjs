#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));

if (!existsSync(cliPath)) {
  console.error(
    'SemWitness CLI is unavailable: expected bundled dist/cli.mjs.',
  );
  console.error('Build or package the reviewed plugin before invoking it.');
  process.exit(78);
}

const result = spawnSync(
  process.execPath,
  [cliPath, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    windowsHide: true,
  },
);

if (result.error) {
  console.error('Unable to start the bundled SemWitness CLI.');
  process.exit(70);
}

if (result.signal) {
  console.error('SemWitness CLI terminated by signal ' + result.signal);
  process.exit(1);
}

process.exit(result.status ?? 1);
