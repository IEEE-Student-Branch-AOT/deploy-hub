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
  [deploy] upload source; Vercel builds it remotely  ─────────► Vercel sandbox
  token: VERCEL_TOKEN                                           npm ci, next build
  runs: an upload, no repo code                                 (student code runs HERE)
      │
      ▼
  [record] merge results into registry.json, post commit statuses
```

### The one rule

**Student code must never execute in a job that holds a credential.** `npm ci`
runs student-authored `postinstall` scripts and `next.config.js` is student-
authored code. If `VERCEL_TOKEN` were present alongside them, any student could
exfiltrate it in three lines and take over the admin's Vercel account.

That is why the build happens on Vercel rather than on the runner. Vercel builds
in its own sandbox, where the only credentials present are that project's own
environment variables — never the account token.

> An earlier design built locally with `vercel build` and shipped
> `.vercel/output` via `--prebuilt`, isolating the build in a secretless job.
> **That does not work:** the Vercel CLI requires authentication even for a
> local build. Do not reintroduce it. Remote builds are both simpler and
> strictly safer.

For the same reason, `VERCEL_TOKEN` **must not** be an organization secret
exposed to student repos. Anyone with write access to a repo that can see an org
secret can push a workflow that prints it. It lives in this repo's `production`
environment, reachable only from `main`.

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
| Concurrent builds | 1 | `max-parallel: 3` keeps the queue polite; deploys serialise |
| Team members | 0 (single owner) | by design — students never need access |
| Commercial use | not permitted | fine for a student community; revisit if that changes |

Because builds run on Vercel, they consume Vercel's build concurrency rather
than GitHub Actions minutes. This repo is public specifically so that its own
Actions minutes are unlimited — a private hub on a Free org exhausts the
2,000 min/month quota within about a week of 10-minute cron runs.

## Public URLs

Each project's stable URL is normally `<project>-<account-slug>.vercel.app`,
**not** `<project>.vercel.app` — the short form is frequently already claimed by
an unrelated Vercel account, in which case it returns 404. The scan job asks the
Vercel API which domains are actually assigned and records the answer as
`stableUrl` in `registry.json`. Never derive the URL from the CLI's
`Production:` banner; it prints hostnames the project may not own.

If you outgrow these, the same architecture ports to Cloudflare Pages (more
generous free tier, and it allows team members) by replacing only the `deploy`
job.
