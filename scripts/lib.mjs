// Shared helpers: GitHub + Vercel REST, config parsing/validation.
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';

const GH = 'https://api.github.com';
const VC = 'https://api.vercel.com';

export const ORG = req('ORG');
export const PROJECT_PREFIX = process.env.PROJECT_PREFIX || 'sbaot';
export const MAX_DEPLOYS = Number(process.env.MAX_DEPLOYS || 20);

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

async function api(url, { token, method = 'GET', body, accept } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: accept || 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

/* ------------------------------- GitHub ---------------------------------- */

export const gh = {
  token: () => req('GH_TOKEN'),

  async listRepos() {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const r = await api(`${GH}/orgs/${ORG}/repos?per_page=100&type=all&page=${page}`, { token: gh.token() });
      if (!r.ok) throw new Error(`listRepos ${r.status}: ${r.text}`);
      out.push(...r.json);
      if (r.json.length < 100) break;
    }
    return out.filter((r) => !r.archived && !r.disabled && !r.fork);
  },

  // Returns decoded file text, or null when absent.
  async getFile(repo, path, ref) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const r = await api(`${GH}/repos/${ORG}/${repo}/contents/${path}${q}`, { token: gh.token() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`getFile ${repo}/${path} ${r.status}: ${r.text}`);
    if (Array.isArray(r.json) || !r.json.content) return null;
    return Buffer.from(r.json.content, 'base64').toString('utf8');
  },

  // Head SHA of a branch, or null when the branch does not exist.
  async branchSha(repo, branch) {
    const r = await api(`${GH}/repos/${ORG}/${repo}/commits/${encodeURIComponent(branch)}`, {
      token: gh.token(),
      accept: 'application/vnd.github.sha',
    });
    if (r.status === 404 || r.status === 422) return null;
    if (!r.ok) throw new Error(`branchSha ${repo}#${branch} ${r.status}: ${r.text}`);
    return r.text.trim();
  },

  async openPulls(repo) {
    const r = await api(`${GH}/repos/${ORG}/${repo}/pulls?state=open&per_page=50`, { token: gh.token() });
    if (!r.ok) return [];
    return r.json.map((p) => ({ number: p.number, sha: p.head.sha, ref: p.head.ref }));
  },

  async setStatus(repo, sha, { state, url, context, description }) {
    const r = await api(`${GH}/repos/${ORG}/${repo}/statuses/${sha}`, {
      token: gh.token(),
      method: 'POST',
      body: { state, target_url: url || undefined, context, description: (description || '').slice(0, 140) },
    });
    if (!r.ok) console.warn(`setStatus ${repo}@${sha.slice(0, 7)} failed ${r.status}: ${r.text}`);
  },
};

/* ------------------------------- Vercel ---------------------------------- */

export const vercel = {
  token: () => req('VERCEL_TOKEN'),
  // Hobby accounts have no team; TEAM_ID stays empty and the param is omitted.
  scope: () => (process.env.VERCEL_TEAM_ID ? `?teamId=${process.env.VERCEL_TEAM_ID}` : ''),

  async findProject(name) {
    const r = await api(`${VC}/v9/projects/${encodeURIComponent(name)}${vercel.scope()}`, { token: vercel.token() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`findProject ${name} ${r.status}: ${r.text}`);
    return { id: r.json.id, name: r.json.name };
  },

  async createProject(name, { nodeVersion } = {}) {
    const r = await api(`${VC}/v9/projects${vercel.scope()}`, {
      token: vercel.token(),
      method: 'POST',
      // framework: null lets Vercel auto-detect from the prebuilt output.
      // nodeVersion is rejected here -- it can only be PATCHed after creation.
      body: { name, framework: null },
    });
    if (r.status === 409) return vercel.findProject(name);
    if (!r.ok) throw new Error(`createProject ${name} ${r.status}: ${r.text}`);
    const project = { id: r.json.id, name: r.json.name };
    if (nodeVersion) await vercel.setNodeVersion(project.id, nodeVersion);
    return project;
  },

  /**
   * Domains actually assigned to the project, shortest first.
   *
   * The CLI's "Production:" line is not trustworthy for this: it can print
   * <project>.vercel.app even when that hostname belongs to a different Vercel
   * account, in which case it 404s. Only this list reflects reality. Typically
   * the real one is <project>-<account-slug>.vercel.app.
   */
  async projectDomains(projectId) {
    const r = await api(`${VC}/v9/projects/${projectId}/domains${vercel.scope()}`, { token: vercel.token() });
    if (!r.ok) return [];
    return (r.json.domains || [])
      .filter((d) => !d.redirect && d.verified !== false)
      .map((d) => d.name)
      .sort((a, b) => a.length - b.length);
  },

  /**
   * Return the first domain that actually serves the site.
   *
   * Being listed on the project is not enough: Vercel registers
   * <project>.vercel.app to the project even when no deployment is aliased
   * there, and it then answers 404 with an `x-vercel-error` header. The real
   * host is usually <project>-<account-slug>.vercel.app.
   *
   * A 404 WITHOUT that header is the application's own 404 page, which means
   * the host is live and the app simply has no route at `/` -- that counts as
   * live. Returns null when nothing serves yet (e.g. before the first deploy);
   * the next scan retries.
   */
  async pickLiveDomain(domains) {
    for (const name of domains) {
      try {
        const res = await fetch(`https://${name}`, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
        if (!res.headers.get('x-vercel-error')) return name;
      } catch { /* DNS or timeout: treat as not live, try the next */ }
    }
    return null;
  },

  /**
   * Upsert a plaintext build/runtime environment variable onto the project.
   * These come from .deploy.yml, so they are public by definition -- real
   * secrets are added by an admin in the dashboard and are never touched here.
   * Setting them via the API (rather than passing --build-env on the CLI) keeps
   * student-controlled strings out of any shell command line.
   */
  async setEnv(projectId, key, value) {
    const sep = vercel.scope() ? '&' : '?';
    const r = await api(`${VC}/v10/projects/${projectId}/env${vercel.scope()}${sep}upsert=true`, {
      token: vercel.token(),
      method: 'POST',
      body: { key, value, type: 'plain', target: ['production', 'preview'] },
    });
    if (!r.ok) console.warn(`    note: could not set env ${key} (${r.status}: ${r.text.slice(0, 120)})`);
  },

  // Best effort: affects the serverless runtime only. Never fail a deploy over it.
  async setNodeVersion(projectId, nodeVersion) {
    const r = await api(`${VC}/v9/projects/${projectId}${vercel.scope()}`, {
      token: vercel.token(),
      method: 'PATCH',
      body: { nodeVersion },
    });
    if (!r.ok) console.warn(`    note: could not set nodeVersion=${nodeVersion} (${r.status})`);
  },
};

/* ------------------------------- Config ---------------------------------- */

const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
const ENV_RE = /^[a-z][a-z0-9-]{0,20}$/;
const ENVVAR_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ENVIRONMENTS = 3;

export const DEFAULT_CONFIG = {
  enabled: true,
  root: '.',
  node: '22.x',
  environments: { production: { branch: 'main' } },
  previews: { pull_requests: false },
  build: { env: {} },
};

/**
 * Parse and validate a student-supplied .deploy.yml.
 * Anything not on this allowlist is rejected -- in particular there is no way
 * for a repo to name the Vercel project it deploys to. That is always derived
 * from the repo name so one repo can never overwrite another's deployment.
 */
export function parseConfig(text) {
  if (!text) return { config: DEFAULT_CONFIG, errors: [] };

  let raw;
  try {
    raw = parseYaml(text); // yaml@2 is data-only: no code execution on parse
  } catch (e) {
    return { config: null, errors: [`.deploy.yml is not valid YAML: ${e.message}`] };
  }
  if (raw == null) return { config: DEFAULT_CONFIG, errors: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: null, errors: ['.deploy.yml must be a mapping'] };
  }

  const errors = [];
  const cfg = structuredClone(DEFAULT_CONFIG);

  const known = ['version', 'enabled', 'root', 'node', 'environments', 'previews', 'build'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) errors.push(`unknown key "${k}"`);

  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') errors.push('enabled must be true or false');
    else cfg.enabled = raw.enabled;
  }

  if ('root' in raw) {
    const root = String(raw.root);
    // Must stay inside the checkout: no absolute paths, no traversal.
    if (root.startsWith('/') || root.split('/').includes('..') || !/^[A-Za-z0-9._\/-]+$/.test(root)) {
      errors.push(`root "${root}" must be a relative path inside the repository`);
    } else cfg.root = root.replace(/\/+$/, '') || '.';
  }

  if ('node' in raw) {
    const node = String(raw.node);
    if (!/^(18|20|22|24)(\.x)?$/.test(node)) errors.push('node must be one of 18, 20, 22, 24');
    else cfg.node = node.endsWith('.x') ? node : `${node}.x`;
  }

  if ('environments' in raw) {
    const envs = raw.environments;
    if (typeof envs !== 'object' || envs === null || Array.isArray(envs)) {
      errors.push('environments must be a mapping');
    } else {
      const names = Object.keys(envs);
      if (names.length === 0) errors.push('environments must define at least one environment');
      if (names.length > MAX_ENVIRONMENTS) errors.push(`at most ${MAX_ENVIRONMENTS} environments are allowed`);
      const out = {};
      for (const name of names.slice(0, MAX_ENVIRONMENTS)) {
        if (!ENV_RE.test(name)) { errors.push(`invalid environment name "${name}"`); continue; }
        const spec = envs[name];
        const branch = typeof spec === 'string' ? spec : spec && spec.branch;
        if (!branch || !BRANCH_RE.test(String(branch))) {
          errors.push(`environment "${name}" needs a valid branch`); continue;
        }
        out[name] = { branch: String(branch) };
      }
      if (Object.keys(out).length) cfg.environments = out;
    }
  }

  if ('previews' in raw && raw.previews && typeof raw.previews === 'object') {
    cfg.previews.pull_requests = raw.previews.pull_requests === true;
  }

  if ('build' in raw && raw.build && typeof raw.build === 'object') {
    const env = raw.build.env;
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      for (const [k, v] of Object.entries(env)) {
        if (!ENVVAR_RE.test(k)) { errors.push(`invalid build env name "${k}"`); continue; }
        if (v === null || typeof v === 'object') { errors.push(`build env "${k}" must be a scalar`); continue; }
        cfg.build.env[k] = String(v);
      }
    }
  }

  return errors.length ? { config: null, errors } : { config: cfg, errors: [] };
}

/**
 * Decide whether a repo is something Vercel can serve at all.
 * Returns { deployable, framework, reason }.
 */
export function detectWebProject({ packageJsonText, hasIndexHtml }) {
  if (packageJsonText) {
    let pkg;
    try { pkg = JSON.parse(packageJsonText); } catch { return { deployable: false, reason: 'package.json is not valid JSON' }; }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const frameworks = ['next', 'nuxt', 'astro', 'vite', '@remix-run/dev', '@sveltejs/kit', 'gatsby', 'react-scripts', '@angular/cli', 'vue-cli-service'];
    const found = frameworks.find((f) => f in deps);
    if (found) return { deployable: true, framework: found };
    if (pkg.scripts && typeof pkg.scripts.build === 'string') return { deployable: true, framework: 'custom-build-script' };
    return { deployable: false, reason: 'package.json has no build script and no known web framework' };
  }
  if (hasIndexHtml) return { deployable: true, framework: 'static' };
  return { deployable: false, reason: 'no package.json and no index.html at the repository root' };
}

/** Vercel project name for a repo + environment. Derived, never user-supplied. */
export function projectNameFor(repo, envName) {
  const base = `${PROJECT_PREFIX}-${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const full = envName === 'production' ? base : `${base}-${envName}`;
  return full.slice(0, 100); // Vercel project names cap at 100 chars
}

export function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function writeJson(path, value) {
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
