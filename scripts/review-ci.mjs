#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git } from './review-gate.mjs';

async function stableRevision() {
  if (process.env.REVIEW_BASE_SHA) {
    if (!/^[a-f0-9]{40}$/.test(process.env.REVIEW_BASE_SHA)) throw new Error('Invalid explicit baseline');
    return process.env.REVIEW_BASE_SHA;
  }
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Missing repository');
  // Read one trusted stable-channel identity. No retries; any non-404 failure
  // stops publication. The timeout also bounds response-body consumption.
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    signal: AbortSignal.timeout(12_000), redirect: 'error',
    headers: { Accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) },
  });
  if (response.status === 404) return '0'.repeat(40);
  if (!response.ok) throw new Error('Stable channel unavailable');
  const release = await response.json();
  const match = /^deploy-([a-f0-9]{40})$/.exec(release.tag_name ?? '');
  if (!match || release.draft || release.prerelease) throw new Error('Invalid stable channel');
  return match[1];
}

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const sha = value => { if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw new Error('Invalid SHA'); return value; };
  const emptyTree = () => git(['mktree'], { input: '' }).trim();
  const name = process.env.GITHUB_EVENT_NAME;
  let range;
  if (name === 'pull_request') {
    const base = sha(event.pull_request?.base?.sha), head = sha(event.pull_request?.head?.sha);
    range = `${git(['merge-base', base, head]).trim()}..${head}`;
  } else if (name === 'push') {
    const head = sha(event.after), before = sha(event.before);
    const stable = await stableRevision();
    if (!/^0+$/.test(stable)) git(['merge-base', '--is-ancestor', stable, head]);
    range = `${/^0+$/.test(stable) ? emptyTree() : stable}..${head}`;
  } else if (name === 'workflow_dispatch') {
    const head = sha(process.env.GITHUB_SHA);
    const stable = await stableRevision();
    if (!/^0+$/.test(stable)) git(['merge-base', '--is-ancestor', stable, head]);
    range = `${/^0+$/.test(stable) ? emptyTree() : stable}..${head}`;
  } else throw new Error('Unsupported event');
  console.info(`CI 审查范围：${range}`);
  for (const script of ['review-gate.mjs', 'review-message.mjs']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), '--range', range], { stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) { process.exitCode = result.status || 2; break; }
  }
} catch {
  console.error('无法确定 CI 审查范围，停止门禁；请核对事件、完整 Git 历史和正式版本通道。');
  process.exitCode = 2;
}
