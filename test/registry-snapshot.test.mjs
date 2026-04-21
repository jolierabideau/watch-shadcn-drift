import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  stableStringify,
  sha256Hex,
  canonicalRegistryText,
  resolveRegistryUrl,
  snapshotKeyForSpec,
  normalizeEditorRegistryEntry,
  extractPbrContract,
  pbrContractsEqual,
  unifiedDiffBestEffort,
} from '../scripts/lib/registry-snapshot.mjs';

describe('stableStringify', () => {
  it('sorts object keys at each level', () => {
    assert.equal(
      stableStringify({ b: 1, a: { z: 1, y: 2 } }),
      stableStringify({ a: { y: 2, z: 1 }, b: 1 }),
    );
  });

  it('preserves array order', () => {
    assert.equal(stableStringify([3, 2, 1]), '[3,2,1]');
  });

  it('handles null and primitives', () => {
    assert.equal(stableStringify(null), 'null');
    assert.equal(stableStringify(true), 'true');
    assert.equal(stableStringify('x'), '"x"');
  });

  it('golden string for fixture', () => {
    const golden =
      '{"files":[{"content":"import x","path":"ui/a.tsx"}],"name":"button","type":"registry:ui"}';
    const obj = {
      type: 'registry:ui',
      name: 'button',
      files: [{ path: 'ui/a.tsx', content: 'import x' }],
    };
    assert.equal(stableStringify(obj), golden);
  });
});

describe('resolveRegistryUrl', () => {
  it('default style resolves to ui.shadcn styles path', () => {
    const cj = { style: 'default' };
    assert.equal(
      resolveRegistryUrl(cj, 'button'),
      'https://ui.shadcn.com/r/styles/default/button.json',
    );
  });

  it('non-default style', () => {
    const cj = { style: 'new-york' };
    assert.equal(
      resolveRegistryUrl(cj, 'card'),
      'https://ui.shadcn.com/r/styles/new-york/card.json',
    );
  });

  it('namespaced @shadcn-editor', () => {
    const cj = {
      registries: {
        '@shadcn-editor': 'https://shadcn-editor.vercel.app/r/{name}.json',
      },
    };
    assert.equal(
      resolveRegistryUrl(cj, '@shadcn-editor/rich-text'),
      'https://shadcn-editor.vercel.app/r/rich-text.json',
    );
  });

  it('errors on missing slash in namespaced spec', () => {
    assert.throws(() => resolveRegistryUrl({}, '@foo'), /missing \//);
  });

  it('errors on unknown namespace', () => {
    assert.throws(
      () => resolveRegistryUrl({ registries: {} }, '@unknown/x'),
      /Unknown registry namespace/,
    );
  });
});

describe('golden sha256', () => {
  it('canonicalRegistryText hash is stable for fixture', () => {
    const parsed = {
      type: 'registry:ui',
      name: 'button',
      files: [{ path: 'ui/a.tsx', content: 'import x' }],
    };
    const text = canonicalRegistryText(parsed);
    const hex = sha256Hex(text);
    // If stableStringify changes, this assertion must be updated intentionally.
    assert.equal(
      hex,
      'e3970df4a5dca837c3da04ab38eaddf0815bce6760cb67888655b7b2797b9db4',
    );
  });
});

describe('snapshotKeyForSpec / editor entries', () => {
  it('default key', () => {
    assert.equal(snapshotKeyForSpec('button', 'default'), 'default--button');
  });

  it('editor key derived from spec', () => {
    assert.equal(
      snapshotKeyForSpec('@shadcn-editor/foo-bar', 'editor'),
      'editor--foo-bar',
    );
  });

  it('explicit editor key', () => {
    assert.equal(
      snapshotKeyForSpec('@shadcn-editor/a', 'editor', 'my-key-v2'),
      'editor--my-key-v2',
    );
  });

  it('rejects invalid explicit key', () => {
    assert.throws(
      () => snapshotKeyForSpec('@shadcn-editor/a', 'editor', 'bad key'),
      /snapshotKey must match/,
    );
  });

  it('normalizeEditorRegistryEntry', () => {
    assert.deepEqual(normalizeEditorRegistryEntry('@shadcn-editor/x'), {
      spec: '@shadcn-editor/x',
      snapshotKey: undefined,
    });
    assert.deepEqual(
      normalizeEditorRegistryEntry({
        spec: '@shadcn-editor/x',
        snapshotKey: 'custom',
      }),
      { spec: '@shadcn-editor/x', snapshotKey: 'custom' },
    );
    assert.throws(() => normalizeEditorRegistryEntry(null), /Invalid/);
  });
});

describe('extractPbrContract', () => {
  it('sorts registry keys', () => {
    const a = extractPbrContract({
      style: 'default',
      registries: { z: 'https://z', a: 'https://a' },
    });
    const b = extractPbrContract({
      style: 'default',
      registries: { a: 'https://a', z: 'https://z' },
    });
    assert.ok(pbrContractsEqual(a, b));
  });
});

describe('unifiedDiffBestEffort', () => {
  it('returns non-empty diff when texts differ', () => {
    const out = unifiedDiffBestEffort('a.txt', 'b.txt', 'one\ntwo\n', 'one\nThree\n');
    assert.ok(out.length > 0);
    assert.ok(
      out.includes('diff') ||
        out.includes('@@') ||
        out.includes('fallback') ||
        out.includes('+'),
    );
  });
});
