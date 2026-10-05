#!/usr/bin/env bash
# Build and deploy iit-mcp-hudu from the current commit, pinned to a git short SHA tag.
#
# Every deploy is tagged iit-mcp-hudu-iit-mcp-hudu:<short-SHA-of-HEAD>, never :latest:
# the running container is always tied to a commit, and because a rebuild cannot touch the
# previous tag, it stays resolvable in the local image store for rollback
# (README, "Rolling back").
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="$(git rev-parse --short HEAD)"
export HUDU_IMAGE_TAG="$TAG"

# The tag names a commit, so the build must be exactly that commit. A dirty worktree — modified
# tracked files, staged changes, or an untracked file (gitignored files like .env do not count)
# — would ship code the tag does not cover, and a re-run from the same checkout would overwrite
# that commit's existing tag, defeating auditability and rollback.
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy: the worktree is dirty; the ${TAG} tag would not match the build" >&2
  git status --short >&2
  echo "commit or discard the changes (and make sure the checkout matches origin/main), then re-run" >&2
  exit 1
fi

echo "deploying iit-mcp-hudu at ${TAG}"
docker compose build
docker compose up -d
docker compose ps
