#!/usr/bin/env node
/**
 * Compares paranext-core vendored shadcn components and allowlisted deps against registry/npm.
 * Always exits 0 when the script completes; writes GITHUB_OUTPUT and discord-payload.json when on CI.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCH_ROOT = process.cwd();
const MANIFEST_PATH = path.join(__dirname, '..', 'config', 'shadcn-drift-manifest.json');
const DISCORD_CONTENT_MAX = 1900;

function parseArgs(argv) {
  let paranextRoot = 'paranext-core';
  let plain = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--paranext-root' && argv[i + 1]) {
      paranextRoot = argv[++i];
    } else if (argv[i] === '--plain') {
      plain = true;
    }
  }
  return { paranextRoot: path.resolve(WATCH_ROOT, paranextRoot), plain };
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
    text.includes('\n--- ') ||
    text.includes('\n+++ ') ||
    (text.includes('@@') && text.includes('-')) ||
    /^\s*[-+@]/.test(text.split('\n').find((l) => l.trim()) ?? '')
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
  // npm exits 1 when anything is outdated; stdout is still valid JSON.
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

/** Discord / webhook: markdown-friendly */
function buildDiscordMarkdown({
  ref,
  sha,
  commitUrl,
  runUrl,
  componentDrift,
  editorDrift,
  outdatedLines,
  cliLine,
}) {
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

  if (componentDrift.length) {
    lines.push('**1 · Registry drift** (`shadcn add <name> --diff`)');
    lines.push(
      '**Note:** Each name below means the registry output differed from your local file (or the CLI exited with an error). See artifact `drift-logs/default-<name>.log` for the full diff.',
    );
    lines.push('');
    lines.push(componentDrift.map((c) => `- \`${c}\``).join('\n'));
    lines.push('');
  }

  if (editorDrift.length) {
    lines.push('**1b · @shadcn-editor registry drift**');
    lines.push('**Note:** Same meaning as (1) for editor registry items.');
    lines.push('');
    lines.push(editorDrift.map((c) => `- \`${c}\``).join('\n'));
    lines.push('');
  }

  if (outdatedLines.length) {
    lines.push('**2 · Allowlisted npm packages** (`npm outdated -w platform-bible-react`)');
    lines.push(
      '**Note:** Installed versions are behind what the lockfile/workspace allows; bump dependencies in paranext-core when ready.',
    );
    lines.push('');
    lines.push(outdatedLines.map((l) => `- ${l}`).join('\n'));
    lines.push('');
  }

  if (cliLine) {
    lines.push('**3 · Shadcn CLI**');
    lines.push(`- ${cliLine}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

/** Terminal: box layout + optional ANSI */
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
    componentDrift,
    editorDrift,
    outdatedLines,
    cliLine,
    updatesNeeded,
  } = ctx;

  const w = 58;
  const bar = '═'.repeat(w);
  const sub = '─'.repeat(w);
  const out = [];

  out.push(c.cyan(bar));
  out.push(c.bold(`  Shadcn drift report  ${updatesNeeded ? c.yellow('(updates needed)') : c.green('(ok)')}`));
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

  if (componentDrift.length) {
    out.push(c.bold(`  1 · Registry drift — shadcn add <name> --diff`));
    out.push(c.dim(`  ${componentDrift.length} component(s) differ from registry output or CLI error`));
    out.push(c.dim(sub));
    out.push(
      c.dim(
        '  Meaning: upstream registry would generate different files than your repo.',
      ),
    );
    out.push(c.dim('  Details:  drift-logs/default-<name>.log'));
    out.push('');
    for (const name of componentDrift) {
      out.push(`    • ${name}`);
    }
    out.push('');
  }

  if (editorDrift.length) {
    out.push(c.bold('  1b · @shadcn-editor registry drift'));
    out.push(c.dim(sub));
    for (const name of editorDrift) {
      out.push(`    • ${name}`);
    }
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

  out.push(c.cyan(bar));
  return out.join('\n');
}

function main() {
  const { paranextRoot, plain } = parseArgs(process.argv);
  const manifest = loadManifest();
  const {
    shadcnCliVersion,
    excludeComponents = [],
    editorRegistryComponents = [],
    outdatedPackageAllowlist = [],
  } = manifest;

  const shadcnCwd = path.join(paranextRoot, 'lib', 'platform-bible-react');
  const shadcnUiDir = path.join(shadcnCwd, 'src', 'components', 'shadcn-ui');
  const logsDir = path.join(WATCH_ROOT, 'drift-logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const excludeSet = new Set(excludeComponents);
  const defaultNames = listShadcnUiComponents(shadcnUiDir, excludeSet);

  const componentDrift = [];
  const editorDrift = [];

  for (const name of defaultNames) {
    const { drift, log } = runShadcnDiff(shadcnCwd, shadcnCliVersion, name);
    fs.writeFileSync(path.join(logsDir, `default-${name}.log`), log, 'utf8');
    if (drift) componentDrift.push(name);
  }

  for (const spec of editorRegistryComponents) {
    const safe = spec.replace(/[^a-zA-Z0-9@/-]/g, '_');
    const { drift, log } = runShadcnDiff(shadcnCwd, shadcnCliVersion, spec);
    fs.writeFileSync(path.join(logsDir, `editor-${safe}.log`), log, 'utf8');
    if (drift) editorDrift.push(spec);
  }

  const outdatedLines = npmOutdatedAllowlisted(paranextRoot, outdatedPackageAllowlist);
  const latestCli = npmViewShadcnVersion();
  let cliLine = null;
  if (latestCli && versionNewer(latestCli, shadcnCliVersion)) {
    cliLine = `shadcn CLI pinned ${shadcnCliVersion}, npm latest ${latestCli} — bump manifest after testing`;
  }

  const updatesNeeded =
    componentDrift.length > 0 ||
    editorDrift.length > 0 ||
    outdatedLines.length > 0 ||
    cliLine !== null;

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
    componentDrift,
    editorDrift,
    outdatedLines,
    cliLine,
    updatesNeeded,
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
        componentDrift,
        editorDrift,
        outdatedLines,
        cliLine,
        ref,
        sha,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  appendGithubOutput('updates_needed', updatesNeeded ? 'true' : 'false');

  const useColor = !plain && process.stdout.isTTY;
  console.log(updatesNeeded ? 'updates_needed=true' : 'updates_needed=false');
  if (updatesNeeded) {
    console.log('');
    console.log(buildTerminalReport(reportCtx, useColor));
  }
}

main();
