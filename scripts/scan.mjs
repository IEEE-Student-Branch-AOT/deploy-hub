/**
 * Scan every repo in the org, work out what needs deploying, provision any
 * missing Vercel projects, and emit a job matrix.
 *
 * This job holds VERCEL_TOKEN but never executes repository code -- it only
 * makes API calls and parses YAML/JSON. Building happens in a separate,
 * secretless job (see .github/workflows/deploy.yml).
 */
import fs from 'node:fs';
import {
  ORG, MAX_DEPLOYS, gh, vercel, parseConfig, detectWebProject, projectNameFor, readJson, writeJson,
} from './lib.mjs';

const REGISTRY = 'registry.json';
const IGNORE = new Set((process.env.IGNORE_REPOS || '.github,deploy-hub').split(',').map((s) => s.trim()));

const registry = readJson(REGISTRY, { repos: {} });
const matrix = [];
const notes = [];

function entry(repo) {
  registry.repos[repo] ||= { environments: {} };
  registry.repos[repo].environments ||= {};
  return registry.repos[repo];
}

const repos = await gh.listRepos();
console.log(`found ${repos.length} candidate repos in ${ORG}`);

for (const r of repos) {
  const repo = r.name;
  if (IGNORE.has(repo)) continue;

  const rec = entry(repo);
  rec.defaultBranch = r.default_branch;

  // One broken repo must never block deployments for every other repo.
  try {
  // ---- config -------------------------------------------------------------
  const configText = await gh.getFile(repo, '.deploy.yml', r.default_branch);
  const { config, errors } = parseConfig(configText);
  if (!config) {
    rec.status = 'config-error';
    rec.reason = errors.join('; ');
    notes.push(`${repo}: invalid .deploy.yml -- ${rec.reason}`);
    continue;
  }
  if (!config.enabled) { rec.status = 'disabled'; rec.reason = 'enabled: false'; continue; }

  // A repo with no .deploy.yml still gets production=<default branch>.
  if (!configText) config.environments = { production: { branch: r.default_branch } };

  // ---- is this even a web project? ---------------------------------------
  const pkgPath = config.root === '.' ? 'package.json' : `${config.root}/package.json`;
  const idxPath = config.root === '.' ? 'index.html' : `${config.root}/index.html`;
  const packageJsonText = await gh.getFile(repo, pkgPath, r.default_branch);
  const hasIndexHtml = packageJsonText ? false : (await gh.getFile(repo, idxPath, r.default_branch)) !== null;
  const detected = detectWebProject({ packageJsonText, hasIndexHtml });
  if (!detected.deployable) {
    rec.status = 'skipped';
    rec.reason = detected.reason;
    continue;
  }
  rec.status = 'active';
  rec.reason = '';
  rec.framework = detected.framework;

  // ---- named environments -------------------------------------------------
  const targets = [];
  for (const [envName, spec] of Object.entries(config.environments)) {
    const sha = await gh.branchSha(repo, spec.branch);
    if (!sha) { notes.push(`${repo}: branch "${spec.branch}" for env "${envName}" does not exist`); continue; }
    targets.push({ key: envName, envName, ref: spec.branch, sha, prod: true });
  }

  // ---- pull request previews ---------------------------------------------
  if (config.previews.pull_requests) {
    for (const pr of await gh.openPulls(repo)) {
      targets.push({ key: `pr-${pr.number}`, envName: 'production', ref: pr.ref, sha: pr.sha, prod: false, pr: pr.number });
    }
  }

  // ---- provision + diff ---------------------------------------------------
  for (const t of targets) {
    const state = (rec.environments[t.key] ||= {});

    // PR previews reuse the production project; named envs get their own.
    const projectName = projectNameFor(repo, t.envName);
    if (!state.projectId || state.projectName !== projectName) {
      const existing = await vercel.findProject(projectName);
      const project = existing || (await vercel.createProject(projectName, { nodeVersion: config.node }));
      state.projectId = project.id;
      state.projectName = project.name;
      console.log(`  ${repo}/${t.key} -> project ${project.name} (${project.id})${existing ? '' : ' [created]'}`);
    }

    // Projects created before makePublic() existed still carry a login wall.
    // Clear it once, then remember so we stop calling the API every scan.
    if (!state.isPublic) {
      if (await vercel.makePublic(state.projectId)) {
        state.isPublic = true;
        console.log(`    deployment protection disabled`);
      }
    }

    // Resolve the project's stable public URL once. Deployment URLs are unique
    // per push; this is the one students should be given.
    if (!state.stableUrl) {
      // Deployment aliases first: that is where the working host usually is.
      const domains = [
        ...new Set([
          ...(await vercel.productionAliases(state.projectId)),
          ...(await vercel.projectDomains(state.projectId)),
        ]),
      ].sort((a, b) => a.length - b.length);
      const live = await vercel.pickLiveDomain(domains);
      if (live) {
        state.stableUrl = `https://${live}`;
        console.log(`    stable url ${state.stableUrl}`);
      } else if (domains.length) {
        console.log(`    no live domain yet (candidates: ${domains.join(', ')}); will retry next scan`);
      }
    }

    // Sync build env only when .deploy.yml changed it, to keep API calls down.
    const envFingerprint = JSON.stringify(config.build.env);
    if (envFingerprint !== '{}' && state.envFingerprint !== envFingerprint) {
      for (const [k, v] of Object.entries(config.build.env)) await vercel.setEnv(state.projectId, k, v);
      state.envFingerprint = envFingerprint;
      console.log(`    synced ${Object.keys(config.build.env).length} build env var(s)`);
    }

    state.branch = t.ref;
    if (state.lastSha === t.sha && state.lastStatus === 'success') continue;

    matrix.push({
      key: t.key,
      repo,
      ref: t.ref,
      sha: t.sha,
      env_name: t.key,
      project_id: state.projectId,
      project_name: state.projectName,
      root: config.root,
      prod: t.prod,
      pr: t.pr || 0,
    });
  }
  } catch (err) {
    rec.status = 'error';
    rec.reason = String(err.message || err);
    notes.push(`${repo}: ${rec.reason}`);
  }
}

// Guardrail: Vercel Hobby allows 100 deployments per day across the account.
const capped = matrix.slice(0, MAX_DEPLOYS);
if (matrix.length > capped.length) {
  notes.push(`deploy queue capped at ${MAX_DEPLOYS}; ${matrix.length - capped.length} deferred to the next scan`);
}

writeJson(REGISTRY, registry);

const out = process.env.GITHUB_OUTPUT;
if (out) {
  fs.appendFileSync(out, `matrix=${JSON.stringify({ include: capped })}\n`);
  fs.appendFileSync(out, `count=${capped.length}\n`);
}

console.log(`\n${capped.length} deployment(s) queued`);
for (const m of capped) console.log(`  - ${m.repo}/${m.key} @ ${m.sha.slice(0, 7)} -> ${m.project_name}`);
if (notes.length) console.log(`\nnotes:\n${notes.map((n) => `  ! ${n}`).join('\n')}`);
