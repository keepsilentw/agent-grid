#!/bin/sh
# One-shot sandbox lifecycle: build -> run -> destroy.
# Usage: run.sh <claude|codex> "<prompt>" [workspace_dir]
# The workspace is bind-mounted at /workspace; the container is removed
# after the agent exits (exit code propagates).
set -eu

AGENT_KIND="${1:?usage: run.sh <claude|codex> \"<prompt>\" [workspace_dir]}"
PROMPT="${2:?usage: run.sh <claude|codex> \"<prompt>\" [workspace_dir]}"
WORKSPACE="${3:-$PWD}"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(dirname -- "$SCRIPT_DIR")

# Build context is the repo root: the image also bakes in gateway/hook.js.
docker build -t agent-grid-sandbox:latest -f "$SCRIPT_DIR/Dockerfile" "$REPO_ROOT"

exec docker run --rm \
  -e AGENT_KIND="$AGENT_KIND" \
  -v "$WORKSPACE":/workspace \
  agent-grid-sandbox:latest \
  "$PROMPT"
