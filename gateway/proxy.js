#!/usr/bin/env node
// Egress proxy for a run's sandbox: domain allowlist for HTTP and CONNECT
// (HTTPS tunnel), credential injection with TLS interception (phase 3, CA
// scheme) for hosts that have credential rules -- all other HTTPS traffic
// stays an untouched tunnel. Every decision is recorded as an `events` row,
// kind=network. Credential header VALUES are never written to events/logs.
//
// As a module: attachProxy(server, opts) mounts the handlers on the gateway
// daemon's http server so the daemon stays the single event writer.
// Standalone (for tests): node proxy.js --db agent.db --run <run_id>
//   [--port 0] [--credentials PATH]
//
// Trust chain: CA lives in ~/.config/agent-grid/ca/ (openssl-generated on
// first use). Agents trust it via SSL_CERT_FILE / NODE_EXTRA_CA_CERTS, which
// execute.js proxyEnv() sets.
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createEventWriter } = require('./events-db.js');

function loadPolicy() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'policy.json'), 'utf8'));
}

function hostAllowed(host, allow) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return allow.some((pat) => {
    const p = pat.toLowerCase();
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return h === base || h.endsWith('.' + base);
    }
    return h === p;
  });
}

// credentials.json shape:
//   { "rules": [ { "host": "api.example.com", "path_prefix": "/v1",
//                  "headers": { "Authorization": "Bearer ..." } } ] }
function loadCredentials(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).rules || [];
  } catch {
    return [];
  }
}

function credsFor(rules, host, reqPath) {
  const h = String(host || '').toLowerCase();
  let hit = null;
  for (const r of rules) {
    if (String(r.host).toLowerCase() === h
      && String(reqPath || '').startsWith(r.path_prefix || '')) {
      hit = { ...(hit || {}), ...(r.headers || {}) };
    }
  }
  return hit;
}

function hostHasCredentialRules(rules, host) {
  const h = String(host || '').toLowerCase();
  return rules.some((r) => String(r.host).toLowerCase() === h);
}

// --- CA / leaf certificates (openssl, generated once, cached) -------------

function caDir() {
  return path.join(os.homedir(), '.config', 'agent-grid', 'ca');
}
function getCACertPath() {
  return path.join(caDir(), 'ca.pem');
}

function ensureCA() {
  const dir = caDir();
  const pem = path.join(dir, 'ca.pem');
  if (fs.existsSync(pem)) return pem;
  fs.mkdirSync(dir, { recursive: true });
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${JSON.stringify(path.join(dir, 'ca.key'))} `
    + `-out ${JSON.stringify(pem)} -days 3650 -subj "/CN=agent-grid local CA" `
    + `-addext "basicConstraints=critical,CA:TRUE"`, { stdio: 'pipe' });
  return pem;
}

function ensureHostCert(host) {
  ensureCA();
  const dir = caDir();
  const safe = host.replace(/[^a-zA-Z0-9.-]/g, '_');
  const crt = path.join(dir, `${safe}.crt`);
  const key = path.join(dir, `${safe}.key`);
  if (fs.existsSync(crt) && fs.existsSync(key)) return { cert: crt, key };
  const san = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? `IP:${host}` : `DNS:${host}`;
  const csr = path.join(dir, `${safe}.csr`);
  execSync(`openssl req -new -newkey rsa:2048 -nodes -keyout ${JSON.stringify(key)} `
    + `-out ${JSON.stringify(csr)} -subj "/CN=${host}" -addext "subjectAltName=${san}"`,
  { stdio: 'pipe' });
  execSync(`openssl x509 -req -in ${JSON.stringify(csr)} `
    + `-CA ${JSON.stringify(path.join(dir, 'ca.pem'))} -CAkey ${JSON.stringify(path.join(dir, 'ca.key'))} `
    + `-CAcreateserial -days 825 -copy_extensions copy -out ${JSON.stringify(crt)}`,
  { stdio: 'pipe' });
  fs.rmSync(csr, { force: true });
  return { cert: crt, key };
}

// --- TLS interception for credential-bearing hosts ------------------------

// One origin-form http server decrypts requests from all intercepted
// tunnels; the target host comes from the Host header.
function createMitmHandler({ writer, runId, credentials }) {
  const mitm = http.createServer((req, res) => { void (async () => {
    const [host] = splitHostPort(req.headers.host || '');
    const injected = credsFor(credentials, host, req.url);
    if (injected) {
      // Only injection events are logged inside a tunnel: logging every
      // asset request would flood the event stream.
      await writer.append(runId, 'network', {
        phase: 'allowed', host, method: req.method, path: req.url,
        credentials_injected: Object.keys(injected), tls_intercepted: true,
      });
    }
    const headers = { ...req.headers, ...(injected || {}) };
    const upstream = https.request({
      hostname: host,
      port: Number(splitHostPort(req.headers.host || '')[1]) || 443,
      path: req.url,
      method: req.method,
      headers,
      // Test topologies use self-signed upstreams; default stays verifying.
      rejectUnauthorized: process.env.AGENT_GRID_INSECURE_UPSTREAM !== '1',
    }, (ures) => {
      res.writeHead(ures.statusCode, ures.headers);
      ures.pipe(res);
    });
    upstream.on('error', (e) => {
      if (!res.headersSent) { res.writeHead(502); res.end(`upstream error: ${e.message}`); }
      else res.destroy();
    });
    req.pipe(upstream);
  })().catch((e) => {
    if (!res.headersSent) { res.writeHead(500); res.end('mitm error'); }
    console.error(`mitm request error: ${e.message}`);
  }); });
  mitm.on('clientError', (err, socket) => socket.destroy());
  return mitm;
}

// Mount HTTP-proxy + CONNECT handling onto an http.Server.
// opts: { writer, runId, allow, credentials, standalone }
function attachProxy(server, { writer, runId, allow, credentials, standalone = false }) {
  const mitm = createMitmHandler({ writer, runId, credentials });
  // Generate the CA at startup: agents must be able to read ca.pem BEFORE
  // the first CONNECT (curl --cacert / NODE_EXTRA_CA_CERTS read it at spawn).
  try { ensureCA(); } catch (e) { console.error(`CA generation failed: ${e.message}`); }

  server.on('request', (req, res) => { void (async () => {
    if (!/^https?:\/\//i.test(req.url || '')) {
      if (standalone) {
        res.writeHead(400); res.end('proxy requires absolute-form request target');
      }
      return;
    }
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); res.end('bad url'); return; }

    if (!hostAllowed(u.hostname, allow)) {
      await writer.append(runId, 'network',
        { phase: 'denied', host: u.hostname, method: req.method, path: u.pathname });
      res.writeHead(403); res.end('denied by agent-grid network policy'); return;
    }

    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const injected = credsFor(credentials, u.hostname, u.pathname);
    if (injected) Object.assign(headers, injected);
    // Log which credential rule matched, never the values.
    await writer.append(runId, 'network', {
      phase: 'allowed', host: u.hostname, method: req.method, path: u.pathname,
      credentials_injected: injected ? Object.keys(injected) : [],
    });

    const upstream = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: req.method,
      headers,
    }, (ures) => {
      res.writeHead(ures.statusCode, ures.headers);
      ures.pipe(res);
    });
    upstream.on('error', (e) => {
      if (!res.headersSent) { res.writeHead(502); res.end(`upstream error: ${e.message}`); }
      else res.destroy();
    });
    req.pipe(upstream);
  })().catch((e) => {
    if (!res.headersSent) { res.writeHead(500); res.end('proxy error'); }
    console.error(`proxy request error: ${e.message}`);
  }); });

  server.on('connect', (req, clientSocket, head) => { void (async () => {
    const [host, portStr] = splitHostPort(req.url || '');
    const port = Number(portStr) || 443;
    if (!hostAllowed(host, allow)) {
      await writer.append(runId, 'network', { phase: 'denied', host, port });
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    const plainTunnel = async () => {
      await writer.append(runId, 'network', { phase: 'allowed', host, port });
      const upstream = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    };

    // No credential rule for this host: untouched tunnel, no decryption.
    if (!hostHasCredentialRules(credentials, host)) {
      await plainTunnel();
      return;
    }

    // Credential-bearing host: intercept with a CA-signed cert for this host,
    // decrypt, inject on matching requests, re-encrypt upstream.
    let leaf;
    try {
      leaf = ensureHostCert(host);
    } catch (e) {
      // openssl unavailable/failed: fall back to an opaque tunnel (no
      // injection) rather than blocking the run.
      console.error(`cert issue for ${host}, tunneling opaquely: ${e.message}`);
      await plainTunnel();
      return;
    }
    await writer.append(runId, 'network',
      { phase: 'allowed', host, port, tls_intercepted: true });

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const ctx = tls.createSecureContext({
      key: fs.readFileSync(leaf.key),
      cert: fs.readFileSync(leaf.cert),
    });
    const ts = new tls.TLSSocket(clientSocket, { isServer: true, secureContext: ctx });
    ts.on('secure', () => {
      if (head && head.length) ts.write(head);
      mitm.emit('connection', ts);
    });
    ts.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => ts.destroy());
  })().catch((e) => {
    console.error(`proxy connect error: ${e.message}`);
    clientSocket.destroy();
  }); });
}

function splitHostPort(url) {
  const i = String(url).lastIndexOf(':');
  if (i < 0) return [url, '443'];
  return [String(url).slice(0, i), String(url).slice(i + 1)];
}

module.exports = { attachProxy, hostAllowed, loadCredentials, getCACertPath };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const dbPath = flag('--db', 'agent.db');
  const port = Number(flag('--port', '0'));
  const runId = flag('--run', '');
  const credFile = flag('--credentials',
    path.join(os.homedir(), '.config', 'agent-grid', 'credentials.json'));
  if (!runId) { console.error('usage: node proxy.js --run <run_id> [--db agent.db] [--port 0] [--credentials PATH]'); process.exit(2); }

  (async () => {
    const policy = loadPolicy();
    const writer = await createEventWriter(dbPath);
    const server = http.createServer();
    attachProxy(server, {
      writer, runId,
      allow: policy.network?.allow || [],
      credentials: loadCredentials(credFile),
      standalone: true,
    });
    server.listen(port, () => console.log(`proxy listening on ${server.address().port}`));
  })().catch((e) => { console.error(e); process.exit(1); });
}
