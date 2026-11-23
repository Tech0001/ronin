import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const targetIdx = process.argv.indexOf('--target');
const explicitTarget = targetIdx >= 0 ? process.argv[targetIdx + 1] : undefined;

const hostTriple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  .match(/^host:\s*(.+)$/m)?.[1]
  ?.trim();

const triple = explicitTarget || hostTriple;
if (!triple) {
  throw new Error('Could not determine Rust target triple.');
}

const isWindows = triple.includes('windows');
const ext = isWindows ? '.exe' : '';

const cargoArgs = [
  'build',
  '--release',
  '--manifest-path',
  join(root, 'src-tauri', 'Cargo.toml'),
  '-p',
  'ronin-daemon',
];
if (explicitTarget) {
  cargoArgs.push('--target', explicitTarget);
}

execFileSync('cargo', cargoArgs, { stdio: 'inherit' });

const builtBin = explicitTarget
  ? join(root, 'src-tauri', 'target', explicitTarget, 'release', `ronin-daemon${ext}`)
  : join(root, 'src-tauri', 'target', 'release', `ronin-daemon${ext}`);

const binariesDir = join(root, 'src-tauri', 'binaries');
mkdirSync(binariesDir, { recursive: true });
const dest = join(binariesDir, `ronin-daemon-${triple}${ext}`);
copyFileSync(builtBin, dest);
if (!isWindows) chmodSync(dest, 0o755);

console.log(`Prepared sidecar: ${dest}`);
