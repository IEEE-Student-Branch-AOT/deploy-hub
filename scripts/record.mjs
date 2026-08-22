/**
 * Merge the per-deployment result artifacts back into registry.json and post a
 * commit status on each deployed SHA. Runs once, after the whole matrix, so
 * parallel jobs never fight over the registry file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gh, readJson, writeJson } from './lib.mjs';

const REGISTRY = 'registry.json';
const RESULTS_DIR = process.env.RESULTS_DIR || 'results';

const registry = readJson(REGISTRY, { repos: {} });

function collect(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) found.push(...collect(full));
    else if (name.endsWith('.json')) found.push(full);
  }
  return found;
}

const files = collect(RESULTS_DIR);
console.log(`merging ${files.length} result file(s)`);

for (const file of files) {
  const r = readJson(file, null);
  if (!r || !r.repo || !r.key) { console.warn(`skipping unreadable ${file}`); continue; }

  const rec = (registry.repos[r.repo] ||= { environments: {} });
  const state = (rec.environments[r.key] ||= {});

  state.lastSha = r.sha;
  state.lastStatus = r.status;
  state.lastRun = new Date().toISOString();
  if (r.url) state.deploymentUrl = r.url; // immutable, unique to this push

  // Point people at the project's stable alias when we know it; the per-push
  // deployment URL is the fallback.
  const success = r.status === 'success';
  const link = success ? (state.stableUrl || r.url) : r.runUrl;

  await gh.setStatus(r.repo, r.sha, {
    state: success ? 'success' : 'failure',
    url: link,
    context: `deploy/${r.key}`,
    description: success ? `Deployed to ${link}` : 'Build failed - see the hub run log',
  });

  console.log(`  ${r.repo}/${r.key} ${r.status}${link ? ` ${link}` : ''}`);
}

writeJson(REGISTRY, registry);
