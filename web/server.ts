#!/usr/bin/env node
// Task board: read-only views over the DB plus approve/reject.
// Zero dependencies; serves HTML only (no assets, no JS framework).
//
// Usage: node dist/web/server.js [--db agent.db|postgres://...] [--port 8787]
//   GET  /                task list with status; ?tenant=<name> filters
//   GET  /tasks/<id>      task detail: runs, diff, findings, decision buttons
//   GET  /threads/<id>    thread lineage
//   GET  /anomalies       anomaly findings (pure reader of events)
//   POST /runs/<id>/decision   body: decision=approve|reject
import http from 'node:http';
import { open } from '../lib/db.js';
import type { Db } from '../lib/db.js';
import { approveRun } from '../orchestrator/approve.js';
import { findings } from '../gateway/anomaly.js';
import { errMessage } from '../lib/errors.js';
import type { ApprovalPayload, RunRow, TaskStatus, TaskWithTenant } from '../lib/types.js';

const argv = process.argv.slice(2);
const dbFlag = argv.indexOf('--db');
const portFlag = argv.indexOf('--port');
const dbSpec = dbFlag >= 0 ? (argv[dbFlag + 1] ?? 'agent.db') : 'agent.db';
const port = portFlag >= 0 ? Number(argv[portFlag + 1] ?? 8787) : 8787;

/** Row of the task list query: a subset of `tasks` plus the tenant name. */
interface TaskListRow {
  id: string;
  goal: string;
  status: TaskStatus;
  created_at: string;
  tenant: string | null;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: .4rem .6rem; text-align: left; }
th { background: #f4f4f4; }
pre { background: #f8f8f8; padding: 1rem; overflow-x: auto; }
form { display: inline; }
button { padding: .3rem .8rem; }
.status-awaiting_approval { color: #b45309; font-weight: 600; }
.status-failed { color: #b91c1c; }
.status-done, .status-succeeded { color: #15803d; }
.risk-low { color: #15803d; }
.risk-medium { color: #b45309; }
.risk-high { color: #b91c1c; font-weight: 600; }
.sev-low { color: #b45309; }
.sev-medium { color: #b45309; font-weight: 600; }
.sev-high { color: #b91c1c; font-weight: 600; }
</style></head><body>${body}</body></html>`;
}

async function taskList(db: Db, tenant: string | null): Promise<string> {
  const rows = tenant
    ? await db.prepare(`SELECT t.id, t.goal, t.status, t.created_at, tn.name AS tenant
        FROM tasks t JOIN tenants tn ON tn.id = t.tenant_id
        WHERE tn.name = ? ORDER BY t.created_at DESC`).all<TaskListRow>(tenant)
    : await db.prepare(`SELECT t.id, t.goal, t.status, t.created_at, tn.name AS tenant
        FROM tasks t LEFT JOIN tenants tn ON tn.id = t.tenant_id
        ORDER BY t.created_at DESC`).all<TaskListRow>();
  const trs = rows.map((t) => `<tr>
<td><a href="/tasks/${esc(t.id)}">${esc(t.id.slice(0, 8))}</a></td>
<td>${esc(t.goal)}</td>
<td>${esc(t.tenant ?? '')}</td>
<td class="status-${esc(t.status)}">${esc(t.status)}</td>
<td>${esc(t.created_at)}</td></tr>`).join('');
  const filterHtml = tenant
    ? `<p>租户过滤: ${esc(tenant)} · <a href="/">全部</a></p>`
    : '';
  return page('agent-grid 任务台', `<h1>任务台</h1>
<p><a href="/anomalies">异常检测</a></p>${filterHtml}
<table><tr><th>task</th><th>goal</th><th>tenant</th><th>status</th><th>created_at</th></tr>${trs || '<tr><td colspan=5>暂无任务</td></tr>'}</table>`);
}

async function anomaliesPage(db: Db): Promise<string> {
  const rows = await findings(db);
  const trs = rows.map((f) => `<tr>
<td class="sev-${esc(f.severity)}">${esc(f.severity)}</td>
<td>${esc(f.rule)}</td>
<td>${f.run_id ? `<a href="/tasks/${esc(f.task_id || '')}">${esc(f.run_id.slice(0, 8))}</a>` : ''}</td>
<td>${esc(f.detail)}</td>
<td>${esc(f.ts ?? '')}</td></tr>`).join('');
  return page('异常检测', `<p><a href="/">← 返回任务台</a></p>
<h1>异常检测</h1>
<table><tr><th>severity</th><th>rule</th><th>run</th><th>detail</th><th>ts</th></tr>${trs || '<tr><td colspan=5>no anomalies</td></tr>'}</table>`);
}

async function taskDetail(db: Db, taskId: string): Promise<string | null> {
  const task = await db.prepare(
    'SELECT t.*, tn.name AS tenant FROM tasks t LEFT JOIN tenants tn ON tn.id = t.tenant_id WHERE t.id = ?'
  ).get<TaskWithTenant>(taskId);
  if (!task) return null;
  const runs = await db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at').all<RunRow>(taskId);
  const allFindings = await findings(db);
  let runHtml = '';
  for (const r of runs) {
    const diff = await db.prepare(
      "SELECT content FROM artifacts WHERE run_id = ? AND kind = 'diff' ORDER BY ts DESC LIMIT 1"
    ).get<{ content: string }>(r.id);
    // COUNT(*) always yields a row.
    const evRow = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ?').get<{ n: number }>(r.id);
    const approval = await db.prepare(
      "SELECT payload FROM events WHERE run_id = ? AND kind = 'approval' ORDER BY seq DESC LIMIT 1"
    ).get<{ payload: string }>(r.id);
    const ap = approval ? JSON.parse(approval.payload) as ApprovalPayload : null;
    const riskHtml = ap
      ? `<p class="risk-${esc(ap.risk)}">语义预审: ${esc(ap.risk)} — ${esc(ap.reason)}</p>`
      : '';
    const buttons = r.status === 'awaiting_approval'
      ? `<form method="post" action="/runs/${esc(r.id)}/decision">
<input type="hidden" name="decision" value="approve"><button>批准</button></form>
<form method="post" action="/runs/${esc(r.id)}/decision">
<input type="hidden" name="decision" value="reject"><button>驳回</button></form>`
      : '';
    const thread = r.thread_id
      ? `<p>thread: <a href="/threads/${esc(r.thread_id)}">${esc(r.thread_id.slice(0, 8))}</a></p>`
      : '';
    const runFindings = allFindings.filter((f) => f.run_id === r.id);
    const findingsHtml = runFindings.length
      ? `<ul>${runFindings.map((f) => `<li class="sev-${esc(f.severity)}">${esc(f.rule)}: ${esc(f.detail)}</li>`).join('')}</ul>`
      : '';
    runHtml += `<h2>run ${esc(r.id.slice(0, 8))} — <span class="status-${esc(r.status)}">${esc(r.status)}</span> (${esc(r.agent_kind)})</h2>
<p>events: ${evRow!.n} 条</p>${thread}${riskHtml}${findingsHtml}${buttons}
${diff ? `<pre>${esc(diff.content)}</pre>` : '<p>无 diff 产物</p>'}`;
  }
  return page(`task ${taskId.slice(0, 8)}`, `<p><a href="/">← 返回任务台</a></p>
<h1>task ${esc(taskId.slice(0, 8))} — <span class="status-${esc(task.status)}">${esc(task.status)}</span></h1>
<p>goal: ${esc(task.goal)} · tenant: ${esc(task.tenant ?? '')}</p>${runHtml}`);
}

async function threadDetail(db: Db, threadId: string): Promise<string | null> {
  const runs = await db.prepare(
    'SELECT r.*, t.goal FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.thread_id = ? ORDER BY r.started_at'
  ).all<RunRow & { goal: string }>(threadId);
  if (runs.length === 0) return null;
  const rows = runs.map((r) => `<tr>
<td><a href="/tasks/${esc(r.task_id)}">${esc(r.id.slice(0, 8))}</a></td>
<td>${esc(r.goal)}</td>
<td class="status-${esc(r.status)}">${esc(r.status)}</td>
<td>${esc(r.started_at ?? '')}</td></tr>`).join('');
  return page(`thread ${threadId.slice(0, 8)}`, `<p><a href="/">← 返回任务台</a></p>
<h1>thread ${esc(threadId.slice(0, 8))}</h1>
<table><tr><th>run</th><th>goal</th><th>status</th><th>started_at</th></tr>${rows}</table>`);
}

async function start(): Promise<void> {
  const db = await open(dbSpec);
  const server = http.createServer((req, res) => { void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Routing captures are always present for the patterns below.
    const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
    const threadMatch = url.pathname.match(/^\/threads\/([^/]+)$/);
    const decisionMatch = url.pathname.match(/^\/runs\/([^/]+)\/decision$/);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await taskList(db, url.searchParams.get('tenant')));
    } else if (req.method === 'GET' && url.pathname === '/anomalies') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await anomaliesPage(db));
    } else if (req.method === 'GET' && taskMatch) {
      const html = await taskDetail(db, taskMatch[1]!);
      if (!html) { res.writeHead(404); res.end('task not found'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } else if (req.method === 'GET' && threadMatch) {
      const html = await threadDetail(db, threadMatch[1]!);
      if (!html) { res.writeHead(404); res.end('thread not found'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } else if (req.method === 'POST' && decisionMatch) {
      const body = await new Promise<string>((resolve, reject) => {
        let b = '';
        req.on('data', (d: Buffer) => (b += d));
        req.on('end', () => resolve(b));
        req.on('error', reject);
      });
      const decision = new URLSearchParams(body).get('decision');
      if (decision !== 'approve' && decision !== 'reject') {
        res.writeHead(400); res.end('bad decision'); return;
      }
      try {
        const runId = decisionMatch[1]!;
        await approveRun(db, runId, decision);
        const run = await db.prepare('SELECT task_id FROM runs WHERE id = ?').get<{ task_id: string }>(runId);
        res.writeHead(303, { location: `/tasks/${run!.task_id}` });
        res.end();
      } catch (e) {
        res.writeHead(409); res.end(esc(errMessage(e)));
      }
    } else {
      res.writeHead(404); res.end('not found');
    }
  })().catch((e) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(esc(errMessage(e)));
  }); });

  server.listen(port, () => console.log(`agent-grid board on http://localhost:${port} (db: ${dbSpec})`));
}

start().catch((e) => { console.error(e); process.exit(1); });
