#!/usr/bin/env bash
# Bootstrap the deployment hub. Idempotent -- safe to re-run.
#
# Three things CANNOT be scripted (GitHub and Vercel both require a browser
# session for them). The script stops and tells you when it needs one:
#   1. creating the Vercel token
#   2. creating the GitHub App + downloading its private key
#   3. installing the GitHub App on the org
set -euo pipefail

ORG="${ORG:-IEEE-Student-Branch-AOT}"
HUB="${HUB:-deploy-hub}"
PROJECT_PREFIX="${PROJECT_PREFIX:-sbaot}"
VERCEL_ORG_ID="${VERCEL_ORG_ID:-nlfcms5d7AsdikCsDwXpm8sx}"
MAX_DEPLOYS="${MAX_DEPLOYS:-20}"
REPO="$ORG/$HUB"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m x  %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight --
say "Preflight"

command -v gh >/dev/null || die "gh CLI not installed: brew install gh"
gh auth status >/dev/null 2>&1 || die "not logged in: gh auth login"

role=$(gh api "/user/memberships/orgs/$ORG" --jq .role 2>/dev/null || echo none)
[ "$role" = "admin" ] || die "you are '$role' in $ORG; org owner (admin) is required"
echo "  org role:        owner"

base=$(gh api "/orgs/$ORG" --jq .default_repository_permission)
if [ "$base" != "read" ] && [ "$base" != "none" ]; then
  die "org base permission is '$base' -- every member could push to $HUB and steal
     the Vercel token. Fix first:
       gh api -X PATCH /orgs/$ORG -f default_repository_permission=read
     (needs the admin:org scope: gh auth refresh -h github.com -s admin:org)"
fi
echo "  base permission: $base (members cannot push to the hub)"

# ------------------------------------------------------------------- 1. repo --
say "1. Hub repository"

if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "  $REPO already exists"
else
  # PUBLIC on purpose: Actions minutes are unlimited for public repos, and every
  # deployment in this design runs here. A private hub on a Free org burns the
  # 2,000 min/month quota within days. Secrets remain secret either way.
  gh repo create "$REPO" --public \
    --description "Org deployment controller -- builds every repo and deploys to Vercel"
  echo "  created $REPO (public)"
fi

if [ ! -d .git ]; then
  git init -q && git branch -M main
  git remote add origin "https://github.com/$REPO.git" 2>/dev/null || true
fi
git add -A
git diff --quiet --cached || git commit -q -m "feat: deployment hub"
git push -u origin main
echo "  pushed"

# -------------------------------------------------------------- 2. variables --
say "2. Repository variables (not secret)"

set_var() { gh variable set "$1" --repo "$REPO" --body "$2" >/dev/null && echo "  $1 = $2"; }
set_var ORG            "$ORG"
set_var VERCEL_ORG_ID  "$VERCEL_ORG_ID"
set_var PROJECT_PREFIX "$PROJECT_PREFIX"
set_var MAX_DEPLOYS    "$MAX_DEPLOYS"
set_var IGNORE_REPOS   ".github,$HUB"
# VERCEL_TEAM_ID is intentionally unset: a Hobby account has no team.

# ---------------------------------------------------------- 3. environment ---
say "3. 'production' environment"

gh api -X PUT "/repos/$REPO/environments/production" --input - >/dev/null <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON

if ! gh api "/repos/$REPO/environments/production/deployment-branch-policies" \
      --jq '.branch_policies[].name' 2>/dev/null | grep -qx main; then
  gh api -X POST "/repos/$REPO/environments/production/deployment-branch-policies" \
    -f name=main -f type=branch >/dev/null
fi
echo "  created, restricted to branch 'main'"

# -------------------------------------------------------------- 4. GitHub App --
say "4. GitHub App"

if [ -z "${APP_ID:-}" ] || [ -z "${APP_PEM:-}" ]; then
  cat <<EOF

  This step needs a browser -- GitHub has no API for creating an App.

  Open: https://github.com/organizations/$ORG/settings/apps/new

    Name             $ORG deploy hub
    Homepage URL     https://github.com/$REPO
    Webhook          UNCHECK 'Active'

    Repository permissions -- exactly these four, nothing more:
      Metadata          Read-only     (mandatory)
      Contents          Read-only     (clone student repos)
      Pull requests     Read-only     (list open PRs for previews)
      Commit statuses   Read and write(post deployment URLs)

    Where can this be installed?   Only on this account

  Then: note the App ID -> 'Generate a private key' (a .pem downloads)
        -> sidebar 'Install App' -> $ORG -> All repositories

  Re-run with those values:

    APP_ID=123456 APP_PEM=~/Downloads/your-app.private-key.pem ./bootstrap.sh

EOF
  exit 0
fi

[ -f "${APP_PEM/#\~/$HOME}" ] || die "private key not found at $APP_PEM"
gh variable set APP_ID --repo "$REPO" --body "$APP_ID" >/dev/null
gh secret   set APP_PRIVATE_KEY --repo "$REPO" < "${APP_PEM/#\~/$HOME}"
echo "  APP_ID set, private key stored as a repo secret"

# ------------------------------------------------------------ 5. Vercel token --
say "5. Vercel token"

if gh secret list --repo "$REPO" --env production 2>/dev/null | grep -q VERCEL_TOKEN; then
  echo "  VERCEL_TOKEN already set (delete it in the UI to replace)"
else
  echo "  Create one at https://vercel.com/account/settings/tokens (scope: your account)"
  printf '  Paste it (input hidden): '
  read -rs VT; echo
  [ -n "$VT" ] || die "no token entered"
  # --env keeps it out of repo-wide scope: only jobs declaring 'environment:
  # production' on branch main can read it.
  printf '%s' "$VT" | gh secret set VERCEL_TOKEN --repo "$REPO" --env production
  unset VT
  echo "  stored as an environment secret on 'production'"
fi

# ------------------------------------------------------------------ 6. run it --
say "6. First run"
gh workflow run scan.yml --repo "$REPO"
sleep 5
gh run list --repo "$REPO" --workflow scan.yml --limit 3

cat <<EOF

  Watch it:   gh run watch --repo $REPO
  Log:        gh run view --repo $REPO --log
  Registry:   gh api /repos/$REPO/contents/registry.json --jq '.content' | base64 -d

EOF
