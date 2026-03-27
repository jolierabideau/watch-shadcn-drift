#!/usr/bin/env node
/**
 * Refresh committed registry snapshot blobs and config/registry-snapshots.json
 * from live registry URLs (same resolution as platform-bible-react components.json).
 *
 * Usage: node scripts/update-registry-snapshots.mjs --paranext-root <path-to-paranext-core>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadComponentsJson,
  resolveRegistryUrl,
  fetchRegistryJson,
  canonicalRegistryText,
  sha256Hex,
  snapshotKeyForSpec,
} from './lib/registry-snapshot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCH_ROOT = path.join(__dirname, '..');
const SNAPSHOT_DIR = path.join(WATCH_ROOT, 'snapshots', 'registry');
const INDEX_PATH = path.join(WATCH_ROOT, 'config', 'registry-snapshots.json');

function parseArgs(argv) {
  let paranextRoot = path.join(WATCH_ROOT, 'paranext-core');
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--paranext-root' && argv[i + 1]) {
      paranextRoot = path.resolve(argv[++i]);
    }
  }
  return { paranextRoot };
}

function listShadcnUiComponents(shadcnUiDir, excludeSet) {
  if (!fs.existsSync(shadcnUiDir)) {
    throw new Error(`Missing shadcn-ui directory: ${shadcnUiDir}`);
  }
  return fs
    .readdirSync(shadcnUiDir)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => path.basename(f, '.tsx'))
    .filter((name) => !excludeSet.has(name));
}

async function main() {
  const { paranextRoot } = parseArgs(process.argv);
  const manifestPath = path.join(WATCH_ROOT, 'config', 'shadcn-drift-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const {
    excludeComponents = [],
    editorRegistryComponents = [],
    shadcnCliVersion = '',
  } = manifest;

  const componentsJson = loadComponentsJson(paranextRoot);
  const shadcnUiDir = path.join(
    paranextRoot,
    'lib',
    'platform-bible-react',
    'src',
    'components',
    'shadcn-ui',
  );
  const excludeSet = new Set(excludeComponents);
  const defaultNames = listShadcnUiComponents(shadcnUiDir, excludeSet);

  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const entries = {};
  const capturedAt = new Date().toISOString();

  for (const name of defaultNames) {
    const url = resolveRegistryUrl(componentsJson, name);
    const parsed = await fetchRegistryJson(url);
    const text = canonicalRegistryText(parsed);
    const key = snapshotKeyForSpec(name, 'default');
    const filePath = path.join(SNAPSHOT_DIR, `${key}.json`);
    fs.writeFileSync(filePath, text, 'utf8');
    entries[key] = {
      spec: name,
      kind: 'default',
      registryUrl: url,
      sha256: sha256Hex(text),
      capturedAt,
      cliVersion: shadcnCliVersion || undefined,
    };
    console.log(`updated ${key} sha256=${entries[key].sha256.slice(0, 8)}…`);
  }

  for (const spec of editorRegistryComponents) {
    const url = resolveRegistryUrl(componentsJson, spec);
    const parsed = await fetchRegistryJson(url);
    const text = canonicalRegistryText(parsed);
    const key = snapshotKeyForSpec(spec, 'editor');
    const filePath = path.join(SNAPSHOT_DIR, `${key}.json`);
    fs.writeFileSync(filePath, text, 'utf8');
    entries[key] = {
      spec,
      kind: 'editor',
      registryUrl: url,
      sha256: sha256Hex(text),
      capturedAt,
      cliVersion: shadcnCliVersion || undefined,
    };
    console.log(`updated ${key} sha256=${entries[key].sha256.slice(0, 8)}…`);
  }

  const index = {
    version: 1,
    entries,
  };
  fs.writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(`\nWrote ${INDEX_PATH}`);
  console.log(`Snapshot blobs under ${SNAPSHOT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
