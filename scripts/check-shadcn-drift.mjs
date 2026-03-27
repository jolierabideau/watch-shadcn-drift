#!/usr/bin/env node
/**
 * Compares paranext-core against committed registry snapshots (upstream) and allowlisted deps.
 * Optionally runs legacy `shadcn add --diff` for local fork diagnostics (does not gate alerts).
 * Always exits 0 when the script completes; writes GITHUB_OUTPUT and discord-payload.json when on CI.
 */

import { spawnSync } from 'node:child_process';
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
  unifiedDiffBestEffort,
  normalizeEditorRegistryEntry,
  extractPbrContract,
  pbrContractsEqual,
} from './lib/registry-snapshot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCH_ROOT = process.cwd();
const MANIFEST_PATH = path.join(__dirname, '..', 'config', 'shadcn-drift-manifest.json');
const INDEX_PATH = path.join(__dirname, '..', 'config', 'registry-snapshots.json');
const SNAPSHOT_DIR = path.join(__dirname, '..', 'snapshots', 'registry');
const DISCORD_CONTENT_MAX = 1900;

function parseArgs(argv) {
  let paranextRoot = 'paranext-core';
  let plain = false;
  let includeLocalDiff = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--paranext-root' && argv[i + 1]) {
      paranextRoot = argv[++i];
    } else if (argv[i] === '--plain') {
      plain = true;
    } else if (argv[i] === '--include-local-diff') {
      includeLocalDiff = true;
    }
  }
  return { paranextRoot: path.resolve(WATCH_ROOT, paranextRoot), plain, includeLocalDiff };
}

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw);
}

function versionNewer(latest, pinned) {
  const pa = latest.replace(/^v/, '').split(/[.-]/).map((s) => parseInt(s, 10) || 0);
  const pb = pinned.replace(/^v/, '').split(/[.-]/).map((s) => parseInt(s, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const a = pa[i] ?? 0;
    const b = pb[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
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

function outputLooksLikeDiff(text) {
  if (!text || text.trim().length === 0) return false;
  return (
    text.includes('diff --git') ||
    /(?:^|\n)--- /.test(text) ||
    /(?:^|\n)\+\+\+ /.test(text)
  );
}

function runShadcnDiff(shadcnCwd, cliVersion, spec) {
  const args = ['--yes', `shadcn@${cliVersion}`, 'add', spec, '--diff', '-y'];
  const r = spawnSync('npx', args, {
    cwd: shadcnCwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const drift = r.status !== 0 || outputLooksLikeDiff(out);
  return { drift, log: `=== npx ${args.join(' ')}\nexit=${r.status}\n${out}` };
}

function getParanextSha(paranextRoot) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: paranextRoot,
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

function npmViewShadcnVersion() {
  const r = spawnSync('npm', ['view', 'shadcn', 'version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function npmOutdatedAllowlisted(paranextRoot, allowlist) {
  const allow = new Set(allowlist);
  const r = spawnSync('npm', ['outdated', '-w', 'platform-bible-react', '--json'], {
    cwd: paranextRoot,
    encoding: 'utf8',
  });
  let data = {};
  try {
    if (r.stdout?.trim()) data = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  const rows = [];
  for (const [name, info] of Object.entries(data)) {
    if (!allow.has(name)) continue;
    const current = info.current ?? info.wanted;
    const wanted = info.wanted ?? info.latest;
    const latest = info.latest;
    if (wanted && current && wanted !== current) {
      rows.push(`${name}: ${current} → ${wanted}${latest && latest !== wanted ? ` (latest ${latest})` : ''}`);
    } else if (latest && current && latest !== current && (!wanted || wanted === current)) {
      rows.push(`${name}: ${current} (latest ${latest})`);
    }
  }
  return rows.sort();
}

function truncateDiscordContent(s) {
  if (s.length <= DISCORD_CONTENT_MAX) return s;
  return `${s.slice(0, DISCORD_CONTENT_MAX)}\n\n…(truncated; see workflow artifacts for full logs)`;
}

function appendGithubOutput(key, value) {
  const p = process.env.GITHUB_OUTPUT;
  if (!p) return;
  fs.appendFileSync(p, `${key}=${value}\n`);
}

function loadSnapshotIndex() {
  try {
    if (!fs.existsSync(INDEX_PATH)) return null;
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function diffPbrContract(live, indexContract) {
  const details = [];
  if (live.style !== indexContract.style) {
    details.push(`style: index "${indexContract.style}" vs live "${live.style}"`);
  }
  const idxReg = indexContract.registries ?? {};
  const liveReg = live.registries ?? {};
  const allNs = new Set([...Object.keys(idxReg), ...Object.keys(liveReg)]);
  for (const ns of [...allNs].sort()) {
    if (idxReg[ns] !== liveReg[ns]) {
      details.push(
        `registries["${ns}"]: index ${JSON.stringify(idxReg[ns] ?? '(missing)')} vs live ${JSON.stringify(liveReg[ns] ?? '(missing)')}`,
      );
    }
  }
  return details;
}

/** Sorted unique import lines from registry item `files[].content`. */
function collectImportLines(registryJson) {
  const files = registryJson.files;
  if (!Array.isArray(files)) return [];
  const set = new Set();
  for (const f of files) {
    const c = typeof f.content === 'string' ? f.content : '';
    for (const line of c.split('\n')) {
      const t = line.trim();
      if (t.startsWith('import ')) set.add(t);
    }
  }
  return [...set].sort();
}

function summarizeImportDelta(oldJson, newJson) {
  const a = new Set(collectImportLines(oldJson));
  const b = new Set(collectImportLines(newJson));
  const added = [...b].filter((x) => !a.has(x));
  const removed = [...a].filter((x) => !b.has(x));
  if (added.length === 0 && removed.length === 0) return null;
  const lines = [];
  if (removed.length) lines.push(`removed: ${removed.join(' | ')}`);
  if (added.length) lines.push(`added: ${added.join(' | ')}`);
  return lines.join('\n');
}

function buildDiscordMarkdown(ctx) {
  const {
    ref,
    sha,
    commitUrl,
    runUrl,
    upstreamChanged,
    missingBaseline,
    upstreamFetchErrors,
    outdatedLines,
    cliLine,
    localComponentDrift,
    localEditorDrift,
    trackUpstreamSnapshots,
    pbrContractDetails,
    indexMissingPbrContract,
    notifyUpstream,
    notifyOutdated,
    notifyCli,
  } = ctx;

  const lines = [];
  lines.push('**Shadcn drift report** (paranext-core)');
  lines.push('');
  lines.push(`**Snapshot:** \`${ref}\` @ \`${sha.slice(0, 7)}\` · <${commitUrl}>`);
  if (runUrl) {
    lines.push(`**Actions run:** <${runUrl}>`);
  } else {
    lines.push('*(Workflow run link appears when this runs in GitHub Actions.)*');
  }
  lines.push('');

  if (notifyUpstream && indexMissingPbrContract) {
    lines.push('**0a · Snapshot index**');
    lines.push(
      '**Note:** `config/registry-snapshots.json` has no `pbrContract` block. Run `node scripts/update-registry-snapshots.mjs --paranext-root <path>` and commit.',
    );
    lines.push('');
  }

  if (notifyUpstream && pbrContractDetails?.length) {
    lines.push('**0c · PBR `components.json` contract vs snapshot index**');
    lines.push(
      '**Note:** `style` or `registries` in platform-bible-react changed vs the committed index. Refresh snapshots after intentional config changes; many upstream hashes may change.',
    );
    lines.push('');
    lines.push(pbrContractDetails.map((d) => `- ${d}`).join('\n'));
    lines.push('');
  }

  if (notifyUpstream && missingBaseline.length) {
    lines.push('**0 · Missing registry baselines**');
    lines.push(
      '**Note:** Run `node scripts/update-registry-snapshots.mjs --paranext-root <path>` and commit `snapshots/registry/` + `config/registry-snapshots.json`.',
    );
    lines.push('');
    lines.push(missingBaseline.map((c) => `- \`${c}\``).join('\n'));
    lines.push('');
  }

  if (notifyUpstream && upstreamFetchErrors.length) {
    lines.push('**0b · Registry fetch errors**');
    lines.push('');
    lines.push(upstreamFetchErrors.map((e) => `- ${e}`).join('\n'));
    lines.push('');
  }

  if (notifyUpstream && upstreamChanged.length) {
    lines.push('**1 · Upstream registry (since last snapshot)**');
    lines.push(
      '**Note:** Registry JSON changed vs committed `snapshots/registry/*.json`. See `drift-logs/upstream-<key>.diff` and optional `drift-logs/upstream-<key>-imports.txt`.',
    );
    lines.push('');
    lines.push(upstreamChanged.map((c) => `- \`${c}\``).join('\n'));
    lines.push('');
  }

  if (notifyOutdated && outdatedLines.length) {
    lines.push('**2 · Allowlisted npm packages** (`npm outdated -w platform-bible-react`)');
    lines.push(
      '**Note:** Installed versions are behind what the lockfile/workspace allows; bump dependencies in paranext-core when ready.',
    );
    lines.push('');
    lines.push(outdatedLines.map((l) => `- ${l}`).join('\n'));
    lines.push('');
  }

  if (notifyCli && cliLine) {
    lines.push('**3 · Shadcn CLI**');
    lines.push(`- ${cliLine}`);
    lines.push('');
  }

  if (localComponentDrift?.length || localEditorDrift?.length) {
    const title =
      trackUpstreamSnapshots === false
        ? '**4 · Registry vs local (`shadcn add --diff`)** — primary when upstream snapshots are off'
        : '**4 · Local fork (legacy `shadcn add --diff`)** — informational only';
    lines.push(title);
    lines.push(
      trackUpstreamSnapshots === false
        ? '**Note:** Vendored files differ from what the CLI would generate today.'
        : '**Note:** Compares vendored files to current registry output; expected if you customized components.',
    );
    lines.push('');
    if (localComponentDrift?.length) {
      lines.push('Default registry:');
      lines.push(localComponentDrift.map((c) => `- \`${c}\``).join('\n'));
      lines.push('');
    }
    if (localEditorDrift?.length) {
      lines.push('@shadcn-editor:');
      lines.push(localEditorDrift.map((c) => `- \`${c}\``).join('\n'));
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

function buildTerminalReport(ctx, useColor) {
  const c = {
    bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
    dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
    cyan: (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
    green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
    yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  };

  const {
    ref,
    sha,
    commitUrl,
    runUrl,
    upstreamChanged,
    missingBaseline,
    upstreamFetchErrors,
    outdatedLines,
    cliLine,
    localComponentDrift,
    localEditorDrift,
    updatesNeeded,
    trackUpstreamSnapshots,
    pbrContractDetails,
    indexMissingPbrContract,
    discordPost,
  } = ctx;

  const w = 58;
  const bar = '═'.repeat(w);
  const sub = '─'.repeat(w);
  const out = [];

  out.push(c.cyan(bar));
  out.push(c.bold(`  Shadcn drift report  ${updatesNeeded ? c.yellow('(updates needed)') : c.green('(ok)')}`));
  out.push(c.dim(`  Discord post: ${discordPost ? 'yes' : 'no'} (policy)`));
  out.push(c.cyan(bar));
  out.push('');
  out.push(c.bold('  Snapshot'));
  out.push(c.dim(sub));
  out.push(`  Ref:    ${ref}`);
  out.push(`  Commit: ${sha.slice(0, 7)} (${sha})`);
  out.push(`  ${commitUrl}`);
  if (runUrl) {
    out.push(`  ${runUrl}`);
  } else {
    out.push(c.dim('  (no Actions run URL — not running in GitHub Actions)'));
  }
  out.push('');

  if (indexMissingPbrContract) {
    out.push(c.bold('  0a · Snapshot index'));
    out.push(c.dim('  registry-snapshots.json missing pbrContract — run update-registry-snapshots.mjs'));
    out.push('');
  }

  if (pbrContractDetails?.length) {
    out.push(c.bold('  0c · PBR components.json contract vs index'));
    out.push(c.dim(sub));
    for (const d of pbrContractDetails) out.push(`    • ${d}`);
    out.push('');
  }

  if (missingBaseline.length) {
    out.push(c.bold('  0 · Missing registry baselines'));
    out.push(c.dim(sub));
    for (const name of missingBaseline) out.push(`    • ${name}`);
    out.push('');
  }

  if (upstreamFetchErrors.length) {
    out.push(c.bold('  0b · Registry fetch errors'));
    out.push(c.dim(sub));
    for (const e of upstreamFetchErrors) out.push(`    • ${e}`);
    out.push('');
  }

  if (upstreamChanged.length) {
    out.push(c.bold('  1 · Upstream registry (since last snapshot)'));
    out.push(c.dim(`  ${upstreamChanged.length} component(s) changed vs committed snapshot`));
    out.push(c.dim('  Details: drift-logs/upstream-*.diff'));
    out.push(c.dim(sub));
    for (const name of upstreamChanged) out.push(`    • ${name}`);
    out.push('');
  }

  if (outdatedLines.length) {
    out.push(c.bold('  2 · Allowlisted npm packages (outdated)'));
    out.push(
      c.dim(
        `  ${outdatedLines.length} package(s) behind wanted/latest per npm outdated`,
      ),
    );
    out.push(c.dim(sub));
    out.push('');
    for (const line of outdatedLines) {
      out.push(`    • ${line}`);
    }
    out.push('');
  }

  if (cliLine) {
    out.push(c.bold('  3 · Shadcn CLI'));
    out.push(c.dim(sub));
    out.push(`    ${cliLine}`);
    out.push('');
  }

  if (localComponentDrift?.length || localEditorDrift?.length) {
    out.push(
      c.bold(
        trackUpstreamSnapshots === false
          ? '  4 · Registry vs local (--diff, primary mode)'
          : '  4 · Local fork (legacy --diff, informational)',
      ),
    );
    out.push(c.dim(sub));
    for (const name of localComponentDrift || []) out.push(`    • ${name}`);
    for (const name of localEditorDrift || []) out.push(`    • ${name}`);
    out.push('');
  }

  out.push(c.cyan(bar));
  return out.join('\n');
}

async function main() {
  const { paranextRoot, plain, includeLocalDiff } = parseArgs(process.argv);
  const manifest = loadManifest();
  const {
    shadcnCliVersion,
    excludeComponents = [],
    editorRegistryComponents = [],
    outdatedPackageAllowlist = [],
    trackUpstreamSnapshots = true,
    legacyLocalDiff = false,
    discordNotifyOn = {},
  } = manifest;

  const notifyUpstream = discordNotifyOn.upstreamRegistry !== false;
  const notifyOutdated = discordNotifyOn.allowlistedOutdated !== false;
  const notifyCli = discordNotifyOn.newerCli !== false;

  const editorEntries = (editorRegistryComponents ?? []).map(normalizeEditorRegistryEntry);

  const runLocalDiff =
    includeLocalDiff || legacyLocalDiff || !trackUpstreamSnapshots;

  const shadcnCwd = path.join(paranextRoot, 'lib', 'platform-bible-react');
  const shadcnUiDir = path.join(shadcnCwd, 'src', 'components', 'shadcn-ui');
  const logsDir = path.join(WATCH_ROOT, 'drift-logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const excludeSet = new Set(excludeComponents);
  const defaultNames = listShadcnUiComponents(shadcnUiDir, excludeSet);

  const upstreamChanged = [];
  const upstreamHashUnchanged = [];
  const missingBaseline = [];
  const upstreamFetchErrors = [];

  let pbrContractDetails = [];
  let indexMissingPbrContract = false;

  if (trackUpstreamSnapshots) {
    const snapshotIndex = loadSnapshotIndex();
    let componentsJson;
    try {
      componentsJson = loadComponentsJson(paranextRoot);
    } catch (e) {
      upstreamFetchErrors.push(`components.json: ${e.message}`);
    }

    if (componentsJson) {
      const liveContract = extractPbrContract(componentsJson);
      if (!snapshotIndex?.pbrContract) {
        indexMissingPbrContract = true;
      } else if (!pbrContractsEqual(liveContract, snapshotIndex.pbrContract)) {
        pbrContractDetails = diffPbrContract(liveContract, snapshotIndex.pbrContract);
      }

      for (const name of defaultNames) {
        const key = snapshotKeyForSpec(name, 'default');
        const snapPath = path.join(SNAPSHOT_DIR, `${key}.json`);
        let url;
        try {
          url = resolveRegistryUrl(componentsJson, name);
        } catch (e) {
          upstreamFetchErrors.push(`${name}: ${e.message}`);
          continue;
        }
        if (!fs.existsSync(snapPath)) {
          missingBaseline.push(key);
          continue;
        }
        const baselineText = fs.readFileSync(snapPath, 'utf8');
        let parsed;
        try {
          parsed = await fetchRegistryJson(url);
        } catch (e) {
          upstreamFetchErrors.push(`${key}: ${e.message}`);
          continue;
        }
        const liveText = canonicalRegistryText(parsed);
        const baseHash = sha256Hex(baselineText);
        const liveHash = sha256Hex(liveText);
        if (baseHash === liveHash) {
          upstreamHashUnchanged.push(key);
          continue;
        }
        upstreamChanged.push(key);
        let oldParsed;
        try {
          oldParsed = JSON.parse(baselineText.trim());
        } catch {
          oldParsed = {};
        }
        const diffText = unifiedDiffBestEffort(
          `snapshots/registry/${key}.json`,
          `live (${url})`,
          baselineText,
          liveText,
        );
        fs.writeFileSync(path.join(logsDir, `upstream-${key}.diff`), diffText, 'utf8');
        const imp = summarizeImportDelta(oldParsed, parsed);
        if (imp) {
          fs.writeFileSync(path.join(logsDir, `upstream-${key}-imports.txt`), `${imp}\n`, 'utf8');
        }
      }

      for (const entry of editorEntries) {
        const { spec, snapshotKey: explicitKey } = entry;
        const key = snapshotKeyForSpec(spec, 'editor', explicitKey);
        const snapPath = path.join(SNAPSHOT_DIR, `${key}.json`);
        let url;
        try {
          url = resolveRegistryUrl(componentsJson, spec);
        } catch (e) {
          upstreamFetchErrors.push(`${spec}: ${e.message}`);
          continue;
        }
        if (!fs.existsSync(snapPath)) {
          missingBaseline.push(key);
          continue;
        }
        const baselineText = fs.readFileSync(snapPath, 'utf8');
        let parsed;
        try {
          parsed = await fetchRegistryJson(url);
        } catch (e) {
          upstreamFetchErrors.push(`${key}: ${e.message}`);
          continue;
        }
        const liveText = canonicalRegistryText(parsed);
        if (sha256Hex(baselineText) === sha256Hex(liveText)) {
          upstreamHashUnchanged.push(key);
          continue;
        }
        upstreamChanged.push(key);
        let oldParsed;
        try {
          oldParsed = JSON.parse(baselineText.trim());
        } catch {
          oldParsed = {};
        }
        const diffText = unifiedDiffBestEffort(
          `snapshots/registry/${key}.json`,
          `live (${url})`,
          baselineText,
          liveText,
        );
        fs.writeFileSync(path.join(logsDir, `upstream-${key}.diff`), diffText, 'utf8');
        const imp = summarizeImportDelta(oldParsed, parsed);
        if (imp) {
          fs.writeFileSync(path.join(logsDir, `upstream-${key}-imports.txt`), `${imp}\n`, 'utf8');
        }
      }
    }
  }

  const localComponentDrift = [];
  const localEditorDrift = [];

  if (runLocalDiff) {
    for (const name of defaultNames) {
      const { drift, log } = runShadcnDiff(shadcnCwd, shadcnCliVersion, name);
      fs.writeFileSync(path.join(logsDir, `default-${name}.log`), log, 'utf8');
      if (drift) localComponentDrift.push(name);
    }
    for (const entry of editorEntries) {
      const { spec } = entry;
      const safe = spec.replace(/[^a-zA-Z0-9@/-]/g, '_');
      const { drift, log } = runShadcnDiff(shadcnCwd, shadcnCliVersion, spec);
      fs.writeFileSync(path.join(logsDir, `editor-${safe}.log`), log, 'utf8');
      if (drift) localEditorDrift.push(spec);
    }
  }

  const outdatedLines = npmOutdatedAllowlisted(paranextRoot, outdatedPackageAllowlist);
  const latestCli = npmViewShadcnVersion();
  let cliLine = null;
  if (latestCli && versionNewer(latestCli, shadcnCliVersion)) {
    cliLine = `shadcn CLI pinned ${shadcnCliVersion}, npm latest ${latestCli} — bump manifest after testing`;
  }

  const upstreamGate =
    trackUpstreamSnapshots &&
    (upstreamChanged.length > 0 ||
      missingBaseline.length > 0 ||
      upstreamFetchErrors.length > 0 ||
      pbrContractDetails.length > 0);

  const localGate =
    !trackUpstreamSnapshots &&
    (localComponentDrift.length > 0 || localEditorDrift.length > 0);

  const updatesNeeded =
    upstreamGate ||
    localGate ||
    outdatedLines.length > 0 ||
    cliLine !== null ||
    indexMissingPbrContract;

  const discordPost =
    (notifyUpstream && upstreamGate) ||
    (notifyOutdated && outdatedLines.length > 0) ||
    (notifyCli && cliLine !== null);

  const sha = getParanextSha(paranextRoot);
  const ref = process.env.PARANEXT_REF || process.env.GITHUB_REF_NAME || 'main';
  const repo =
    process.env.PARANEXT_GITHUB_REPOSITORY || 'paranext/paranext-core';
  const commitUrl = `https://github.com/${repo}/commit/${sha}`;

  const server = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
  const watchRepo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runUrl =
    runId && watchRepo ? `${server}/${watchRepo}/actions/runs/${runId}` : '';

  const reportCtx = {
    ref,
    sha,
    commitUrl,
    runUrl,
    upstreamChanged,
    upstreamHashUnchanged,
    missingBaseline,
    upstreamFetchErrors,
    outdatedLines,
    cliLine,
    localComponentDrift,
    localEditorDrift,
    updatesNeeded,
    trackUpstreamSnapshots,
    pbrContractDetails,
    indexMissingPbrContract,
    notifyUpstream,
    notifyOutdated,
    notifyCli,
    discordPost,
  };

  const body = buildDiscordMarkdown(reportCtx);
  const content = truncateDiscordContent(body);

  const payload = { content };
  fs.writeFileSync(
    path.join(WATCH_ROOT, 'discord-payload.json'),
    `${JSON.stringify(payload)}\n`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(WATCH_ROOT, 'drift-summary.json'),
    `${JSON.stringify(
      {
        updatesNeeded,
        discordPost,
        discordNotifyOn: {
          upstreamRegistry: notifyUpstream,
          allowlistedOutdated: notifyOutdated,
          newerCli: notifyCli,
        },
        trackUpstreamSnapshots,
        upstreamChanged,
        upstreamHashUnchanged,
        missingBaseline,
        upstreamFetchErrors,
        pbrContractDetails,
        indexMissingPbrContract,
        outdatedLines,
        cliLine,
        legacyLocalDiffRun: runLocalDiff,
        localComponentDrift,
        localEditorDrift,
        ref,
        sha,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  appendGithubOutput('updates_needed', updatesNeeded ? 'true' : 'false');
  appendGithubOutput('discord_post', discordPost ? 'true' : 'false');

  const useColor = !plain && process.stdout.isTTY;
  console.log(updatesNeeded ? 'updates_needed=true' : 'updates_needed=false');
  if (updatesNeeded) {
    console.log('');
    console.log(buildTerminalReport(reportCtx, useColor));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
