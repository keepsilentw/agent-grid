#!/bin/sh
# Dispatch to the selected agent CLI in non-interactive mode.
# Usage: entrypoint.sh "<prompt>"
#
# Phase 1 note: the tool gateway does not intercept yet, so both agents run
# with approvals disabled. Safety comes from the disposable sandbox itself;
# the human gate is diff approval on artifacts after the run.
set -eu

PROMPT="${1:?usage: entrypoint.sh \"<prompt>\"}"

case "${AGENT_KIND}" in
  claude)
    # --allow- flag is required on newer CLI builds; without it the skip
    # permission check is silently ignored.
    exec claude -p "$PROMPT" \
      --allow-dangerously-skip-permissions \
      --dangerously-skip-permissions \
      --settings /usr/local/bin/hooks-settings.json
    ;;
  codex)
    # Codex has no hooks system; phase 1 runs it without event capture.
    exec codex exec --full-auto "$PROMPT"
    ;;
  *)
    echo "unknown AGENT_KIND: ${AGENT_KIND}" >&2
    exit 2
    ;;
esac
