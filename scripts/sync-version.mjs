#!/usr/bin/env node
// After `changeset version` bumps package.json, copy the version to
// src/version.ts (the User-Agent and ICS PRODID use it; test/version.test.mjs
// checks they match) and to the root entries of package-lock.json. No network.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');
const { version } = JSON.parse(read('package.json'));
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`Unexpected version in package.json: ${version}`);

const source = read('src/version.ts');
const next = source.replace(/export const VERSION = "[^"]*";/, `export const VERSION = "${version}";`);
if (next === source && !source.includes(`"${version}"`)) throw new Error('src/version.ts has no VERSION constant');
writeFileSync(new URL('src/version.ts', root), next);

const lock = JSON.parse(read('package-lock.json'));
lock.version = version;
if (lock.packages?.['']) lock.packages[''].version = version;
writeFileSync(new URL('package-lock.json', root), `${JSON.stringify(lock, null, 2)}\n`);

console.log(`sync-version: ${version} → src/version.ts, package-lock.json`);
