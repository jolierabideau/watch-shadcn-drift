/**
 * Fetch canonical shadcn registry JSON and stable serialization for snapshot hashing.
 * URL resolution matches lib/platform-bible-react/components.json (style + registries).
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_REGISTRY_TEMPLATE = 'https://ui.shadcn.com/r/styles/{style}/{name}.json';

/** Recursive JSON stringify with sorted object keys (stable across parses). */
export function stableStringify(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function loadComponentsJson(paranextRoot) {
  const p = path.join(paranextRoot, 'lib', 'platform-bible-react', 'components.json');
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

/**
 * @param {Record<string, unknown>} componentsJson
 * @param {string} spec - bare name e.g. "button", or namespaced "@shadcn-editor/foo"
 */
export function resolveRegistryUrl(componentsJson, spec) {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash === -1) {
      throw new Error(`Invalid namespaced spec (missing /): ${spec}`);
    }
    const ns = spec.slice(0, slash);
    const name = spec.slice(slash + 1);
    const registries = componentsJson.registries ?? {};
    const template = registries[ns];
    if (!template || typeof template !== 'string') {
      throw new Error(`Unknown registry namespace "${ns}" in components.json registries`);
    }
    return template.replace(/\{name\}/g, name);
  }
  const style = componentsJson.style ?? 'default';
  return DEFAULT_REGISTRY_TEMPLATE.replace('{style}', style).replace('{name}', spec);
}

export async function fetchRegistryJson(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return JSON.parse(text);
}

export function canonicalRegistryText(parsed) {
  return `${stableStringify(parsed)}\n`;
}

/** Snapshot file key for filesystem (no slashes). */
export function snapshotKeyForSpec(spec, kind) {
  if (kind === 'default') {
    return `default--${spec}`;
  }
  return `editor--${spec.replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
}

/** Unified diff via system `diff` (temp files). */
export function unifiedDiffSync(labelOld, labelNew, textOld, textNew) {
  const tmp = os.tmpdir();
  const a = path.join(tmp, `snap-a-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const b = path.join(tmp, `snap-b-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(a, textOld, 'utf8');
    fs.writeFileSync(b, textNew, 'utf8');
    const r = spawnSync('diff', ['-u', a, b], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const out = r.stdout || '';
    if (!out.trim() && r.status === 0) return '';
    if (!out.trim() && r.status !== 0) {
      return `--- ${labelOld}\n+++ ${labelNew}\n(no diff output; exit ${r.status})\n`;
    }
    const lines = out.split('\n');
    if (lines.length >= 2) {
      lines[0] = `--- ${labelOld}`;
      lines[1] = `+++ ${labelNew}`;
    }
    return lines.join('\n');
  } finally {
    try {
      fs.unlinkSync(a);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(b);
    } catch {
      /* ignore */
    }
  }
}
