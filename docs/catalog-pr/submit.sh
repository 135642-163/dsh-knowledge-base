#!/usr/bin/env bash
# 用已登录的 gh 一键提交 catalog PR。
# 用法：bash docs/catalog-pr/submit.sh
# 需要：gh auth login（repo scope）、能访问 github.com。
set -euo pipefail

UPSTREAM="awesome-dsh-plugin/awesome-dsh-plugin"
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$HERE/data/plugins/135642-163__dsh-knowledge-base.yml"
BRANCH="add-135642-163-dsh-knowledge-base"

if ! gh auth status >/dev/null 2>&1; then
  echo "请先运行 gh auth login（需要 repo scope）" >&2
  exit 1
fi
OWNER="$(gh api user --jq .login)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/catalog-pr.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
echo "==> fork/clone $UPSTREAM"
gh repo fork "$UPSTREAM" --clone

cd awesome-dsh-plugin
git remote add upstream "https://github.com/$UPSTREAM.git" 2>/dev/null || true
git fetch upstream main
git checkout -B "$BRANCH" upstream/main

mkdir -p data/plugins
cp "$SOURCE" data/plugins/135642-163__dsh-knowledge-base.yml
git add data/plugins/135642-163__dsh-knowledge-base.yml
git commit -m "Add 135642-163/dsh-knowledge-base"

echo "==> push branch"
git push -u origin HEAD

echo "==> open PR"
gh pr create \
  --repo "$UPSTREAM" \
  --base main \
  --head "$OWNER:$BRANCH" \
  --title "Add 135642-163/dsh-knowledge-base" \
  --body-file "$HERE/PR.md"
