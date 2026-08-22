# Setup runbook

Replace `YOUR-ORG` with your GitHub org login throughout. Everything below is
done once, by an org owner.

---

## 1. Vercel account and token

1. Sign in to the Vercel account that will own every deployment. Use an account
   the exec team controls (a shared address), not a personal one — this is a
   single-owner Hobby account with no seats, so it is a bus factor.
2. Go to **vercel.com/account/settings/tokens** → **Create Token**.
   - Scope: your personal account
   - Expiration: 1 year (put a renewal reminder in the club calendar)
3. Copy the token. It is shown once.
4. Get the account ID — this is `VERCEL_ORG_ID` even on a personal account:

   ```bash
   curl -s -H "Authorization: Bearer YOUR_TOKEN" https://api.vercel.com/v2/user \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["user"]["id"])'
   ```

   You get a bare 24-character string like `nlfcms5d7AsdikCsDwXpm8sx` — personal
   account IDs have no `usr_` prefix. This value is not secret and does not
   change when you rotate the token.

> On a Hobby account there is no team, so `VERCEL_TEAM_ID` stays unset. Only set
> it if you later move to a Vercel Team.

---

## 2. Create the hub repository

Run `./bootstrap.sh` from this directory — it does steps 2, 4, 5, 6 and 7 for
you and stops with instructions at each step that needs a browser.

**Make the hub PUBLIC.** Every deployment in this design runs in this repo, and
public repos get unlimited free Actions minutes. A private hub on a Free org has
2,000 min/month, which a 10-minute cron exhausts in about a week. Secrets stay
secret regardless of visibility, and GitHub blocks fork PRs from reading them.
The trade is that `registry.json` becomes world-readable, exposing the names of
private org repos and their deployment URLs.

Write access must stay limited to org owners. Nobody who can push here should be
someone you would not hand the Vercel token to. Verify the org base permission is
`read` or `none` — if it is `write`, every member can push to the hub and
rewrite the workflows to print the token:

```bash
gh api /orgs/YOUR-ORG --jq .default_repository_permission
```

---

## 3. Create the GitHub App

**Org Settings → Developer settings → GitHub Apps → New GitHub App**

| Field | Value |
| --- | --- |
| Name | `YOUR-ORG deploy hub` |
| Homepage URL | your org URL (unused, any valid URL) |
| Webhook | **uncheck Active** |
| Where can this be installed | Only on this account |

**Repository permissions** — grant exactly these, nothing more:

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read-only | mandatory |
| Contents | Read-only | clone student repos |
| Pull requests | Read-only | list open PRs for preview deploys |
| Commit statuses | Read and write | post the deployment URL on each commit |

Then:

1. **Create GitHub App** → note the **App ID** at the top of the page.
2. Scroll to **Private keys** → **Generate a private key**. A `.pem` downloads.
3. Left sidebar → **Install App** → your org → **All repositories**.

> Read-only contents means the hub can never modify a student repo. It also
> means it cannot auto-open the `.deploy.yml` PR for new repos — hand students
> `templates/.deploy.yml` instead, or grant Contents: Read and write if you
> want that automation later.

---

## 4. Hub variables and secrets

**deploy-hub → Settings → Secrets and variables → Actions**

**Variables** tab (these are not secret):

| Name | Value |
| --- | --- |
| `ORG` | `YOUR-ORG` |
| `APP_ID` | the App ID from step 3 |
| `VERCEL_ORG_ID` | the account ID from step 1 (`nlfcms5d7AsdikCsDwXpm8sx`) |
| `PROJECT_PREFIX` | e.g. `sbaot` — prefixes every Vercel project name |
| `MAX_DEPLOYS` | `20` |
| `IGNORE_REPOS` | `.github,deploy-hub` |

Leave `VERCEL_TEAM_ID` unset on a Hobby account.

**Secrets** tab:

| Name | Value |
| --- | --- |
| `APP_PRIVATE_KEY` | the entire `.pem` file, including the `-----BEGIN…` and `-----END…` lines |

---

## 5. The `production` environment

`VERCEL_TOKEN` goes here rather than in repo secrets, so it is only reachable
from `main`.

**deploy-hub → Settings → Environments → New environment → `production`**

1. **Deployment branches and tags** → *Selected branches* → add rule `main`.
2. **Environment secrets** → **Add secret** → `VERCEL_TOKEN` = the token from
   step 1.
3. Leave **Required reviewers** off for now — scans run every 10 minutes and
   would queue behind approvals. Turn it on temporarily if you ever need to
   freeze deployments.

---

## 6. Protecting `main` without blocking the bot

The hub commits `registry.json` back to itself. If you protect `main`, the push
will be rejected unless Actions can bypass.

**Settings → Rules → Rulesets → New branch ruleset**

- Target: `main`
- Rules: *Require a pull request before merging*
- **Bypass list** → add **Repository admin** *and* **Deploy keys / GitHub
  Actions** (choose the `Actions` bypass actor)

If your plan does not offer ruleset bypass actors, simply leave `main`
unprotected on this private, admin-only repo — the access restriction in step 2
is doing the real work.

---

## 7. First run

**Actions** tab → enable workflows if prompted → **scan-and-deploy** → **Run
workflow**.

Watch the `scan` job log. It prints one line per repo it considered and a
summary of what it queued:

```
found 14 candidate repos in YOUR-ORG
  robotics-site/production -> project sbaot-robotics-site (prj_…) [created]

2 deployment(s) queued
  - robotics-site/production @ a1b2c3d -> sbaot-robotics-site
notes:
  ! archive-2019: no package.json and no index.html at the repository root
```

Non-web repos are skipped with a reason recorded in `registry.json`, not
failed.

### If `vercel build` fails with a credentials error

The build job deliberately has no token. If your Vercel CLI version insists on
authentication for `vercel build`, the fix is to pin the CLI:

```yaml
- run: npm install --global vercel@39
```

Do **not** "fix" it by passing `VERCEL_TOKEN` into the build job — that
defeats the entire design. See the security note in `README.md`.

---

## 8. Verify end to end

1. Create a throwaway repo in the org: `gh repo create YOUR-ORG/deploy-test --public --clone`
2. `npx create-next-app@latest .` , commit, push to `main`.
3. Run **scan-and-deploy** manually (or wait for the cron).
4. Expect: a new `sbaot-deploy-test` project in Vercel, a green
   `deploy/production` status check on the commit, and a live
   `https://sbaot-deploy-test.vercel.app`.
5. Push a change to `main` → next scan redeploys it.
6. Add `.deploy.yml` with a `dev` environment, push a `dev` branch → a second
   project `sbaot-deploy-test-dev` appears with its own stable URL.

---

## 9. Tell students

Post this, and nothing more:

> Push to `main` and your site goes live within ~10 minutes at
> `https://sbaot-<your-repo-name>.vercel.app`. The deployment URL appears as a
> check on your commit. You do not need a Vercel account and there is nothing
> to configure. To add `dev`/`test` environments or PR previews, drop
> [`.deploy.yml`](./templates/.deploy.yml) in your repo root.
>
> Runtime secrets (API keys, database URLs) are **not** set in your repo — ask
> an admin to add them to your Vercel project.

---

## 10. Optional: drop latency from 10 minutes to seconds

The cron poller is deliberately the starting point — it needs nothing in student
repos and no extra infrastructure. When you want instant deploys:

1. Deploy a tiny webhook receiver (a single serverless function, hostable free
   on the same Vercel account).
2. **Org Settings → Webhooks → Add webhook**, pointed at it, with a secret,
   subscribed to `push`, `pull_request`, `repository`.
3. The receiver verifies the HMAC signature, then calls the GitHub API:

   ```
   POST /repos/YOUR-ORG/deploy-hub/dispatches
   { "event_type": "deploy-request", "client_payload": { … } }
   ```

`scan.yml` already listens for `repository_dispatch: [deploy-request]`, so no
workflow changes are needed — the scan simply runs on demand instead of on a
timer. Keep the cron as a safety net for missed webhooks.

---

## Maintenance

- **Rotate `VERCEL_TOKEN`** when officers change, and on its expiry date.
- **Deleted repos** leave orphaned Vercel projects. Prune them once a term.
- **Approaching 100 deploys/day?** Raise the cron interval, lower `MAX_DEPLOYS`,
  or turn off `previews.pull_requests` on the busiest repos.
