# Phase-1 disposable sandbox: one container per run, destroyed afterwards.
# Agent kernels are not built in this repo -- both CLIs are installed from npm.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Build context is the repo root (see run.sh): the gateway hook side lives
# in gateway/, the recipe in sandbox/. EVENT_SINK points into the mounted
# workspace so the control-plane collector can read it after the run exits.
COPY gateway/hook.js /usr/local/bin/gateway-hook.js
COPY gateway/hooks-settings.json /usr/local/bin/hooks-settings.json
COPY sandbox/entrypoint.sh /usr/local/bin/entrypoint.sh
ENV EVENT_SINK=/workspace/.agent-grid/events.jsonl

# Run as non-root; the workspace is mounted at runtime.
RUN useradd -m agent
USER agent
WORKDIR /workspace

ENV AGENT_KIND=claude
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
