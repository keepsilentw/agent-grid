# Phase-1 disposable sandbox: one container per run, destroyed afterwards.
# Agent kernels are not built in this repo -- both CLIs are installed from npm.
# Node 24 matches package.json engines; the image only runs the compiled hook.
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Build context is the compiled tree (dist/, see run.sh and execute.ts): the
# gateway hook side lands in gateway/, the recipe in sandbox/. EVENT_SINK points
# into the mounted workspace so the control-plane collector can read it after
# the run exits. The hook is copied as .mjs: with no package.json next to it,
# that extension is what marks it as an ES module for Node.
COPY gateway/hook.js /usr/local/bin/gateway-hook.mjs
COPY gateway/hooks-settings.json /usr/local/bin/hooks-settings.json
COPY sandbox/entrypoint.sh /usr/local/bin/entrypoint.sh
ENV EVENT_SINK=/workspace/.agent-grid/events.jsonl

# Run as non-root; the workspace is mounted at runtime.
RUN useradd -m agent
USER agent
WORKDIR /workspace

ENV AGENT_KIND=claude
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
