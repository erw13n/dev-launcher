const express = require('express');
const { spawn, exec } = require('child_process');
const treeKill = require('tree-kill');
const esbuild = require('esbuild');
const net = require('net');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Bundle the React UI locally (no CDN, no in-browser Babel) so it works offline.
let clientBundle = '// UI not built yet';
async function buildClient() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'public', 'app.jsx')],
    bundle: true,
    write: false,
    format: 'iife',
    loader: { '.jsx': 'jsx' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  clientBundle = result.outputFiles[0].text;
}
app.get('/bundle.js', (req, res) => {
  res.type('application/javascript').send(clientBundle);
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 9000;
const REGISTRY = path.join(__dirname, 'registry.json');
const MAX_LOG_LINES = 600;

// id -> { proc, logs:[], clients:Set<res>, startedAt, alive }
const sessions = new Map();

const isRunning = (id) => !!(sessions.get(id) && sessions.get(id).alive);

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); }
  catch { return []; }
}
function saveRegistry(list) {
  fs.writeFileSync(REGISTRY, JSON.stringify(list, null, 2));
}
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proj';
}
function uniqueId(base, list) {
  let id = base, n = 2;
  while (list.some(p => p.id === id)) id = `${base}-${n++}`;
  return id;
}

// Is something already listening on this port?
function isPortInUse(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const sock = new net.Socket();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(400);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, '127.0.0.1');
  });
}

// ---- Projects ----
app.get('/api/projects', async (req, res) => {
  const list = loadRegistry();
  const out = [];
  for (const p of list) {
    const running = isRunning(p.id);
    const portBusy = await isPortInUse(p.port);
    const owner = list.find(q => q.id !== p.id && q.port && q.port === p.port && isRunning(q.id));
    const s = sessions.get(p.id);
    out.push({
      ...p,
      running,
      portBusy,
      portOwner: owner ? owner.name : null,
      startedAt: running && s ? s.startedAt : null,
      exited: !!(s && !s.alive),
    });
  }
  res.json(out);
});

app.post('/api/projects', (req, res) => {
  const { name, cwd, cmd, port } = req.body || {};
  if (!name || !cwd || !cmd) return res.status(400).json({ error: 'name, cwd and cmd are required' });
  const list = loadRegistry();
  const project = {
    id: uniqueId(slug(name), list),
    name: String(name).trim(),
    cwd: String(cwd).trim(),
    cmd: String(cmd).trim(),
    port: port ? Number(port) : null,
  };
  list.push(project);
  saveRegistry(list);
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const list = loadRegistry();
  const p = list.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const { name, cwd, cmd, port } = req.body || {};
  if (name !== undefined) p.name = String(name).trim();
  if (cwd !== undefined) p.cwd = String(cwd).trim();
  if (cmd !== undefined) p.cmd = String(cmd).trim();
  if (port !== undefined) p.port = port ? Number(port) : null;
  saveRegistry(list);
  res.json(p);
});

app.delete('/api/projects/:id', (req, res) => {
  const list = loadRegistry();
  const p = list.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (isRunning(p.id)) {
    const s = sessions.get(p.id);
    if (s && s.proc && s.proc.pid) treeKill(s.proc.pid, 'SIGTERM');
  }
  sessions.delete(p.id);
  saveRegistry(list.filter(x => x.id !== p.id));
  res.json({ ok: true });
});

// ---- Run / Stop ----
app.post('/api/projects/:id/run', async (req, res) => {
  const list = loadRegistry();
  const p = list.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (isRunning(p.id)) return res.status(409).json({ error: 'already_running' });

  if (!fs.existsSync(p.cwd)) {
    return res.status(400).json({ error: 'bad_cwd', detail: `Folder not found: ${p.cwd}` });
  }

  // Guard against port collisions unless the caller forces it.
  if (p.port && !req.query.force) {
    if (await isPortInUse(p.port)) {
      const owner = list.find(q => q.id !== p.id && q.port === p.port && isRunning(q.id));
      return res.status(409).json({ error: 'port_in_use', port: p.port, owner: owner ? owner.name : null });
    }
  }

  let proc;
  try {
    proc = spawn(p.cmd, { cwd: p.cwd, shell: true, windowsHide: true });
  } catch (e) {
    return res.status(500).json({ error: 'spawn_failed', detail: String(e) });
  }

  const entry = { proc, logs: [], clients: new Set(), startedAt: Date.now(), alive: true };
  sessions.set(p.id, entry);

  const push = (text, stream) => {
    const line = { t: Date.now(), stream, text: text.toString() };
    entry.logs.push(line);
    if (entry.logs.length > MAX_LOG_LINES) entry.logs.shift();
    for (const c of entry.clients) c.write(`data: ${JSON.stringify(line)}\n\n`);
  };

  push(`$ ${p.cmd}   (in ${p.cwd})\n`, 'sys');
  proc.stdout.on('data', d => push(d, 'out'));
  proc.stderr.on('data', d => push(d, 'err'));
  proc.on('error', (e) => {
    entry.alive = false;
    push(`\n[launcher] failed to start: ${e.message}\n`, 'err');
    for (const c of entry.clients) c.write(`event: exit\ndata: -1\n\n`);
  });
  proc.on('exit', (code, signal) => {
    entry.alive = false;
    push(`\n— process exited (${signal ? 'signal ' + signal : 'code ' + code}) —\n`, 'sys');
    for (const c of entry.clients) c.write(`event: exit\ndata: ${code}\n\n`);
  });

  res.json({ ok: true });
});

app.post('/api/projects/:id/stop', (req, res) => {
  const entry = sessions.get(req.params.id);
  if (!entry || !entry.alive) return res.status(404).json({ error: 'not_running' });
  treeKill(entry.proc.pid, 'SIGTERM', (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ ok: true });
  });
});

// ---- Live logs (SSE) ----
app.get('/api/projects/:id/logs', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();

  const entry = sessions.get(req.params.id);
  if (!entry) {
    res.write(`data: ${JSON.stringify({ stream: 'sys', text: '(no session yet — press Run)' })}\n\n`);
    // keep the connection open so the client can retry cheaply
    const keep = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => clearInterval(keep));
    return;
  }
  for (const line of entry.logs) res.write(`data: ${JSON.stringify(line)}\n\n`);
  entry.clients.add(res);
  const keep = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { entry.clients.delete(res); clearInterval(keep); });
});

// ---- Force-free a port ----
app.post('/api/port/:port/free', (req, res) => {
  const port = parseInt(req.params.port, 10);
  if (!port) return res.status(400).json({ error: 'bad port' });
  const cmd = process.platform === 'win32'
    ? `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`
    : `lsof -ti tcp:${port} | xargs -r kill -9`;
  exec(cmd, (err, stdout, stderr) => {
    // taskkill/lsof exit non-zero when nothing is found; that's fine.
    res.json({ ok: true, output: `${stdout || ''}${stderr || ''}`.trim() });
  });
});

// ---- Scan a folder for projects ----
app.post('/api/scan', (req, res) => {
  const root = (req.body && req.body.root ? String(req.body.root) : '').trim();
  if (!root || !fs.existsSync(root)) return res.status(400).json({ error: 'Folder not found' });

  const SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', '.next', '.vs']);
  const found = [];
  const seen = new Set();

  function suggestFromPackage(dir) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const s = pkg.scripts || {};
      const cmd = s.dev ? 'npm run dev' : s.start ? 'npm start' : s.serve ? 'npm run serve' : 'npm install';
      return { name: pkg.name || path.basename(dir), cmd };
    } catch { return { name: path.basename(dir), cmd: 'npm run dev' }; }
  }

  function walk(dir, depth) {
    if (depth > 4 || found.length > 200) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = entries.filter(e => e.isFile()).map(e => e.name);
    const hasPkg = files.includes('package.json');
    const csproj = files.find(f => f.endsWith('.csproj'));
    if (hasPkg && !seen.has(dir)) {
      seen.add(dir);
      const meta = suggestFromPackage(dir);
      found.push({ name: meta.name, cwd: dir, cmd: meta.cmd, port: null });
    } else if (csproj && !seen.has(dir)) {
      seen.add(dir);
      found.push({ name: path.basename(csproj, '.csproj'), cwd: dir, cmd: 'dotnet run', port: null });
    }
    // Don't descend into a project's own subtree once matched (keeps it clean).
    if (hasPkg || csproj) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  }

  walk(root, 0);
  res.json({ candidates: found });
});

// Kill every child dev server we spawned before we exit, so nothing is left
// orphaned holding a port.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const alive = [...sessions.values()].filter(s => s.alive && s.proc && s.proc.pid);
  if (alive.length === 0) process.exit(0);
  let pending = alive.length;
  console.log(`\n  Stopping ${pending} running project(s)…`);
  for (const s of alive) treeKill(s.proc.pid, 'SIGTERM', () => { if (--pending === 0) process.exit(0); });
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

buildClient()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  Dev Launcher  →  http://localhost:${PORT}\n`);
    });
  })
  .catch((e) => {
    console.error('Failed to build the UI bundle:', e.message);
    process.exit(1);
  });
