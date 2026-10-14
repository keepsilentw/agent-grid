# agent-grid convenience targets.
#
# Package manager is pnpm. TypeScript sources compile to dist/ via
# `make build` (tsc + scripts/copy-assets.mjs) and every CLI entry point runs
# from the compiled tree: node dist/orchestrator/run.js ...
#
# Overridable variables (make <target> VAR=value):
#   DB WORKSPACE GOAL ENGINE TENANT PORT STALE RUN FORK DECISION

DB        ?= agent.db
WORKSPACE ?= $(CURDIR)
GOAL      ?=
ENGINE    ?= local
TENANT    ?= default
PORT      ?= 8787
STALE     ?= 24
RUN       ?=
FORK      ?=
DECISION  ?= approve

.PHONY: help install build typecheck clean db run queue dispatch approve fork merge web anomaly

help: ## list targets
	@grep -hE '^[a-z][a-z-]*: ## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=" ## "}{printf "  %-10s %s\n", substr($$1,1,length($$1)-1), $$2}'

install: ## install dependencies with pnpm (requires Node >= 24.2)
	pnpm install

build: ## compile sources to dist/ and copy non-TS assets into it
	pnpm run build

typecheck: ## type-check the whole tree without emitting
	pnpm run typecheck

clean: ## remove the compiled tree
	rm -rf dist

db: ## bring the sqlite schema in $(DB) up to 0004 (ALTER steps guarded, re-runnable)
	sqlite3 $(DB) < migrations/0001_init.sql
	@sqlite3 $(DB) "PRAGMA table_info(runs)"  | grep -q workspace  || sqlite3 $(DB) < migrations/0002_run_workspace.sql
	@sqlite3 $(DB) "PRAGMA table_info(tasks)" | grep -q tenant_id  || sqlite3 $(DB) < migrations/0003_tenant.sql
	@sqlite3 $(DB) "PRAGMA table_info(tasks)" | grep -q params     || sqlite3 $(DB) < migrations/0004_task_params.sql

run: ## execute one task now: make run GOAL="..." [ENGINE=local WORKSPACE=dir TENANT=name]
	@if [ -z "$(GOAL)" ]; then echo 'usage: make run GOAL="..." [ENGINE=local] [WORKSPACE=dir] [TENANT=name] [DB=agent.db]'; exit 2; fi
	node dist/orchestrator/run.js --goal "$(GOAL)" --engine $(ENGINE) --workspace $(WORKSPACE) --db $(DB) --tenant $(TENANT)

queue: ## enqueue a task for the dispatcher: make queue GOAL="..."
	@if [ -z "$(GOAL)" ]; then echo 'usage: make queue GOAL="..." [WORKSPACE=dir] [TENANT=name]'; exit 2; fi
	node dist/orchestrator/submit.js --goal "$(GOAL)" --workspace $(WORKSPACE) --db $(DB) --tenant $(TENANT)

dispatch: ## run the queue-consuming dispatcher loop
	node dist/orchestrator/dispatcher.js --db $(DB)

approve: ## decide a run: make approve RUN=<run_id> [DECISION=reject]
	@if [ -z "$(RUN)" ]; then echo 'usage: make approve RUN=<run_id> [DECISION=approve|reject]'; exit 2; fi
	node dist/orchestrator/approve.js $(RUN) $(DECISION) --db $(DB)

fork: ## fork a run's workspace: make fork RUN=<run_id> GOAL="..."
	@if [ -z "$(RUN)" ] || [ -z "$(GOAL)" ]; then echo 'usage: make fork RUN=<run_id> GOAL="..."'; exit 2; fi
	node dist/orchestrator/fork.js $(RUN) --goal "$(GOAL)" --engine $(ENGINE) --db $(DB)

merge: ## merge a fork back into the thread root: make merge FORK=<fork_run_id>
	@if [ -z "$(FORK)" ]; then echo 'usage: make merge FORK=<fork_run_id>'; exit 2; fi
	node dist/orchestrator/merge.js $(FORK) --db $(DB)

web: ## serve the approval board on http://localhost:$(PORT)
	node dist/web/server.js --db $(DB) --port $(PORT)

anomaly: ## anomaly findings over $(DB)
	node dist/gateway/anomaly.js --db $(DB) --stale-hours $(STALE)
