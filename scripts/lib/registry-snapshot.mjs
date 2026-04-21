/**
 * Fetch canonical shadcn registry JSON and stable serialization for snapshot hashing.
 * URL resolution matches lib/platform-bible-react/components.json (style + registries).
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createTwoFilesPatch } from 'diff';
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
 * Stable snapshot of style + registry URL templates for drift vs index.
 * @param {Record<string, unknown>} componentsJson
 */
export function extractPbrContract(componentsJson) {
  const style = typeof componentsJson.style === 'string' ? componentsJson.style : 'default';
  const raw = componentsJson.registries ?? {};
  const keys = Object.keys(raw).sort();
  const registries = {};
  for (const k of keys) {
    if (typeof raw[k] === 'string') registries[k] = raw[k];
  }
  return { style, registries };
}

export function pbrContractsEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

/**
 * @param {string | { spec: string, snapshotKey?: string }} raw
 * @returns {{ spec: string, snapshotKey?: string }}
 */
export function normalizeEditorRegistryEntry(raw) {
  if (typeof raw === 'string') {
    return { spec: raw, snapshotKey: undefined };
  }
  if (raw && typeof raw === 'object' && typeof raw.spec === 'string') {
    return {
      spec: raw.spec,
      snapshotKey: typeof raw.snapshotKey === 'string' ? raw.snapshotKey : undefined,
    };
  }
  throw new Error(`Invalid editorRegistryComponents entry: ${JSON.stringify(raw)}`);
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

/**
 * @param {string} spec
 * @param {'default'|'editor'} kind
 * @param {string} [explicitEditorKey] - filesystem-safe id when kind==='editor'
 */
export function snapshotKeyForSpec(spec, kind, explicitEditorKey) {
  if (kind === 'default') {
    return `default--${spec}`;
  }
  if (explicitEditorKey) {
    if (!/^[a-zA-Z0-9._-]+$/.test(explicitEditorKey)) {
      throw new Error(
        `snapshotKey must match /^[a-zA-Z0-9._-]+$/: got "${explicitEditorKey}"`,
      );
    }
    return `editor--${explicitEditorKey}`;
  }
  return `editor--${spec.replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
}

function relabelUnifiedDiffHeader(out, labelOld, labelNew) {
  const lines = out.split('\n');
  if (lines.length >= 2) {
    lines[0] = `--- ${labelOld}`;
    lines[1] = `+++ ${labelNew}`;
  }
  return lines.join('\n');
}

function lineOrientedFallback(labelOld, labelNew, textOld, textNew) {
  const a = textOld.split('\n');
  const b = textNew.split('\n');
  const max = Math.max(a.length, b.length);
  const parts = [`--- ${labelOld}`, `+++ ${labelNew}`, '(line count differs or binary diff failed; first 80 lines each)'];
  parts.push('@@ snapshot @@');
  for (let i = 0; i < Math.min(80, max); i++) {
    const left = a[i] ?? '';
    const right = b[i] ?? '';
    if (left !== right) {
      parts.push(`-${i + 1}: ${left}`);
      parts.push(`+${i + 1}: ${right}`);
    }
  }
  return `${parts.join('\n')}\n`;
}

/**
 * Prefer system `diff -u`; fall back to `diff` npm `createTwoFilesPatch`; then line-oriented delta.
 */
export function unifiedDiffBestEffort(labelOld, labelNew, textOld, textNew) {
  const tmp = os.tmpdir();
  const a = path.join(tmp, `snap-a-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const b = path.join(tmp, `snap-b-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(a, textOld, 'utf8');
    fs.writeFileSync(b, textNew, 'utf8');
    const r = spawnSync('diff', ['-u', a, b], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const out = r.stdout || '';
    // diff returns 0 identical, 1 different, 2 error
    if (r.status === 0 && !out.trim()) return '';
    if ((r.status === 1 || r.status === 0) && out.trim()) {
      return relabelUnifiedDiffHeader(out, labelOld, labelNew);
    }
  } catch {
    /* fall through */
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

  try {
    const patch = createTwoFilesPatch(labelOld, labelNew, textOld, textNew, '', '', {
      context: 3,
    });
    if (patch && patch.trim()) {
      return `fallback: system diff unavailable; JS unified patch (diff package)\n\n${patch}`;
    }
  } catch (e) {
    return `fallback: JS unified patch failed (${e.message})\n\n${lineOrientedFallback(labelOld, labelNew, textOld, textNew)}`;
  }

  return `fallback: unified diff unavailable; line-oriented delta\n\n${lineOrientedFallback(labelOld, labelNew, textOld, textNew)}`;
}

/** @deprecated Use unifiedDiffBestEffort */
export function unifiedDiffSync(labelOld, labelNew, textOld, textNew) {
  return unifiedDiffBestEffort(labelOld, labelNew, textOld, textNew);
}
