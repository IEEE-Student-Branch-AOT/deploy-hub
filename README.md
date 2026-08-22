# deploy-hub

Central deployment controller for the org. Every repo in the org gets built and
deployed to a single admin-owned Vercel account, with **no student ever holding
a Vercel credential** and **no secret ever living in a student repo**.

## How it works

```
cron (10 min)                                  ┌──────────── Vercel (admin account)
      │                                        │             one project per repo+env
      ▼                                        │
  [scan]   list org repos, read .deploy.yml,   │
  token: GH + Vercel                           │
  runs: API calls only  ──── provisions ───────┘
      │
      │ matrix of {repo, branch, sha, project}
      ▼
  [fetch]  checkout student repo at SHA -> tarball artifact
  token: GitHub App (read-only)
  runs: checkout only, no repo code
      │
      ▼
  [build]  npm ci + vercel build -> .vercel/output artifact
  token: NONE                      ← arbitrary student code runs here
      │
      ▼
  [deploy] vercel deploy --prebuilt
  token: VERCEL_TOKEN
  runs: an upload, no repo code
      │
      ▼
  [record] merge results into registry.json, post commit statuses
```

### The one rule

**Never merge `build` and `deploy` into a single job.** `npm ci` executes
`postinstall` scripts and `vercel build` evaluates `next.config.js`, both
authored by students. If `VERCEL_TOKEN` were present in that job, any student
could exfiltrate it in three lines and gain full control of the admin's Vercel
account. The job split is the entire security model.

For the same reason, the org-wide `VERCEL_TOKEN` **must not** be an
organization secret exposed to student repos. Anyone with write access to a
repo that can see an org secret can push a workflow that prints it.

## Setup

See `SETUP.md` for the step-by-step runbook.

## Repo configuration

Students optionally add `.deploy.yml` to their repo root — see
`templates/.deploy.yml`. Without it, the default branch deploys to production.

The Vercel project name is **derived** from the repo name and cannot be set in
`.deploy.yml`. This is deliberate: otherwise one repo could target another
repo's project and overwrite its site.

## Operational limits (Vercel Hobby)

| Limit | Value | Mitigation in this repo |
| --- | --- | --- |
| Deployments per day | 100, account-wide | `MAX_DEPLOYS` per scan; SHA diffing skips unchanged repos |
| Concurrent builds | 1 | builds run on GitHub runners, only the upload touches Vercel |
| Team members | 0 (single owner) | by design — students never need access |
| Commercial use | not permitted | fine for a student community; revisit if that changes |

If you outgrow these, the same architecture ports to Cloudflare Pages (more
generous free tier, and it allows team members) by replacing only the `deploy`
job.
