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
    entryPoints: [path.join(__dirname, 'src', 'main.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
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

// A "session" is one running command. Keyed by `${projectId}::${commandId}`.
// session: { proc, logs:[], startedAt, alive }  (replaced on every run)
const sessions = new Map();
// key -> Set<res>  (log viewers; persists across runs so re-runs keep streaming)
const subscribers = new Map();
const sk = (pid, cid) => `${pid}::${cid}`;
function subsFor(key) {
  let s = subscribers.get(key);
  if (!s) { s = new Set(); subscribers.set(key, s); }
  return s;
}
const isRunning = (key) => !!(sessions.get(key) && sessions.get(key).alive);

// ---- Registry (normalized to the multi-command shape) ----
function slug(s, fallback) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || fallback;
}
function uniqueId(base, taken) {
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}
function normalizeCommands(cmds) {
  const out = [], taken = new Set();
  for (const c of (cmds || [])) {
    const cmd = String(c.cmd || '').trim();
    if (!cmd) continue;
    const label = String(c.label || '').trim() || cmd;
    const id = uniqueId(c.id && !taken.has(c.id) ? c.id : slug(label, 'cmd'), taken);
    out.push({ id, label, cmd, port: c.port ? Number(c.port) : null });
  }
  return out;
}
function normalizeProject(p, taken) {
  const id = p.id || uniqueId(slug(p.name, 'proj'), taken);
  taken.add(id);
  // Migrate the legacy single-command shape ({ cmd, port }) transparently.
  const commands = Array.isArray(p.commands)
    ? normalizeCommands(p.commands)
    : normalizeCommands(p.cmd ? [{ id: 'run', label: p.cmd, cmd: p.cmd, port: p.port || null }] : []);
  return {
    id,
    name: String(p.name || '').trim(),
    cwd: String(p.cwd || '').trim(),
    commands,
    category: String(p.category || '').trim(),
    tags: Array.isArray(p.tags) ? [...new Set(p.tags.map(t => String(t).trim()).filter(Boolean))] : [],
    favorite: !!p.favorite,
    hidden: !!p.hidden,
    collapsed: !!p.collapsed,
    hasNodeModules: !!p.hasNodeModules,
  };
}
function loadRegistry() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); }
  catch { return []; }
  if (!Array.isArray(raw)) return [];
  const taken = new Set(raw.map(p => p.id).filter(Boolean));
  return raw.map(p => normalizeProject(p, taken));
}
function saveRegistry(list) {
  fs.writeFileSync(REGISTRY, JSON.stringify(list, null, 2));
}
function findProject(list, id) { return list.find(p => p.id === id); }

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

// Which package manager does this folder use? Prefer the explicit
// `packageManager` field (corepack), then fall back to lockfiles.
function detectPackageManager(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const name = String(pkg.packageManager || '').split('@')[0];
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return name;
  } catch {}
  const has = (f) => { try { return fs.existsSync(path.join(dir, f)); } catch { return false; } };
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('package-lock.json')) return 'npm';
  return 'npm';
}
// Format "run this script" for the given package manager.
function scriptCmd(pm, script) {
  if (pm === 'pnpm') return `pnpm ${script}`;
  if (pm === 'yarn') return `yarn ${script}`;
  if (pm === 'bun') return `bun run ${script}`;
  return `npm run ${script}`;
}

// Detect runnable commands in a folder: every package.json script + a .csproj.
function detectCommands(dir) {
  const cmds = [];
  const pm = detectPackageManager(dir);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const name of Object.keys(pkg.scripts || {})) {
      cmds.push({ label: name, cmd: scriptCmd(pm, name), port: null });
    }
  } catch {}
  try {
    if (fs.readdirSync(dir).some(f => f.endsWith('.csproj'))) {
      cmds.push({ label: 'dotnet run', cmd: 'dotnet run', port: null });
    }
  } catch {}
  return { pm, cmds };
}
// A sensible default single command for bulk-scan (user can Detect the rest later).
function primaryCommands(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const s = pkg.scripts || {};
    const pm = detectPackageManager(dir);
    const pick = s.dev ? 'dev' : s.start ? 'start' : s.serve ? 'serve' : Object.keys(s)[0];
    const commands = pick ? [{ label: pick, cmd: scriptCmd(pm, pick), port: null }] : [];
    return { name: pkg.name || path.basename(dir), commands };
  } catch { return null; }
}

// ---- Projects ----
app.get('/api/projects', async (req, res) => {
  const list = loadRegistry();

  // Which ports are currently held by a running command (for ownership labels)?
  const runningPorts = [];
  for (const p of list) for (const c of p.commands) {
    if (c.port && isRunning(sk(p.id, c.id))) runningPorts.push({ key: sk(p.id, c.id), name: p.name, label: c.label, port: c.port });
  }
  // Probe each distinct configured port once.
  const ports = [...new Set(list.flatMap(p => p.commands.map(c => c.port).filter(Boolean)))];
  const busy = new Map(await Promise.all(ports.map(async pt => [pt, await isPortInUse(pt)])));

  // Keep the persisted node_modules flag in sync with the filesystem, but only
  // write registry.json back when something actually changed.
  let dirty = false;
  for (const p of list) {
    const has = fs.existsSync(path.join(p.cwd, 'node_modules'));
    if (p.hasNodeModules !== has) { p.hasNodeModules = has; dirty = true; }
  }
  if (dirty) saveRegistry(list);

  const out = list.map(p => ({
    ...p,
    docs: listDocs(p.cwd),
    commands: p.commands.map(c => {
      const key = sk(p.id, c.id);
      const running = isRunning(key);
      const s = sessions.get(key);
      const owner = c.port ? runningPorts.find(r => r.port === c.port && r.key !== key) : null;
      return {
        ...c,
        running,
        portBusy: c.port ? !!busy.get(c.port) : false,
        portOwner: owner ? `${owner.name}${owner.label ? ' · ' + owner.label : ''}` : null,
        startedAt: running && s ? s.startedAt : null,
        exited: !!(s && !s.alive),
      };
    }),
  }));
  res.json(out);
});

app.post('/api/projects', (req, res) => {
  const { name, cwd, commands, category, tags, favorite, hidden, collapsed } = req.body || {};
  if (!name || !cwd) return res.status(400).json({ error: 'name and cwd are required' });
  const list = loadRegistry();
  const taken = new Set(list.map(p => p.id));
  const project = normalizeProject({ name, cwd, commands, category, tags, favorite, hidden, collapsed }, taken);
  list.push(project);
  saveRegistry(list);
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const list = loadRegistry();
  const p = findProject(list, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const { name, cwd, commands, category, tags, favorite, hidden, collapsed } = req.body || {};
  if (name !== undefined) p.name = String(name).trim();
  if (cwd !== undefined) p.cwd = String(cwd).trim();
  if (category !== undefined) p.category = String(category).trim();
  if (tags !== undefined) p.tags = Array.isArray(tags) ? [...new Set(tags.map(t => String(t).trim()).filter(Boolean))] : [];
  if (favorite !== undefined) p.favorite = !!favorite;
  if (hidden !== undefined) p.hidden = !!hidden;
  if (collapsed !== undefined) p.collapsed = !!collapsed;
  if (commands !== undefined) {
    const next = normalizeCommands(commands);
    // Stop any running command that was removed or renamed out of existence.
    const keepIds = new Set(next.map(c => c.id));
    for (const c of p.commands) {
      const key = sk(p.id, c.id);
      if (!keepIds.has(c.id) && isRunning(key)) {
        const s = sessions.get(key);
        if (s && s.proc && s.proc.pid) treeKill(s.proc.pid, 'SIGTERM');
      }
    }
    p.commands = next;
  }
  saveRegistry(list);
  res.json(p);
});

app.delete('/api/projects/:id', (req, res) => {
  const list = loadRegistry();
  const p = findProject(list, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  for (const c of p.commands) {
    const key = sk(p.id, c.id);
    const s = sessions.get(key);
    if (s && s.alive && s.proc && s.proc.pid) treeKill(s.proc.pid, 'SIGTERM');
    sessions.delete(key);
    subscribers.delete(key);
  }
  saveRegistry(list.filter(x => x.id !== p.id));
  res.json({ ok: true });
});

// List Markdown files in a project's root folder (README first).
function listDocs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /\.md$/i.test(e.name))
      .map(e => e.name)
      .sort((a, b) => {
        const ar = a.toLowerCase() === 'readme.md', br = b.toLowerCase() === 'readme.md';
        return ar && !br ? -1 : br && !ar ? 1 : a.localeCompare(b);
      })
      .slice(0, 25);
  } catch { return []; }
}

// Read one Markdown file from a project's root (raw content).
app.get('/api/projects/:id/doc', (req, res) => {
  const list = loadRegistry();
  const p = findProject(list, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const file = String(req.query.file || '');
  // Safety: a .md file directly inside cwd — no path segments, no traversal.
  if (!/\.md$/i.test(file) || file !== path.basename(file)) {
    return res.status(400).json({ error: 'bad_file' });
  }
  const full = path.join(p.cwd, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not_found' });
  try {
    res.json({ file, content: fs.readFileSync(full, 'utf8') });
  } catch (e) {
    res.status(500).json({ error: 'read_failed', detail: String(e && e.message ? e.message : e) });
  }
});

// Delete node_modules inside a project's folder to reclaim space.
app.post('/api/projects/:id/obsolete', (req, res) => {
  const list = loadRegistry();
  const p = findProject(list, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  // Don't yank the deps out from under a running dev server.
  if (p.commands.some(c => isRunning(sk(p.id, c.id)))) {
    return res.status(409).json({ error: 'running', detail: 'Stop this project’s commands before cleaning.' });
  }
  const target = path.join(p.cwd, 'node_modules');
  // Safety: only ever a folder literally named node_modules directly under cwd.
  if (path.basename(target) !== 'node_modules' || !fs.existsSync(target)) {
    return res.json({ ok: true, removed: false, detail: 'No node_modules folder to clean.' });
  }
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    p.hasNodeModules = false;
    saveRegistry(list);
    res.json({ ok: true, removed: true });
  } catch (e) {
    res.status(500).json({ error: 'rm_failed', detail: String(e && e.message ? e.message : e) });
  }
});

// Open a project's folder in the OS file manager.
app.post('/api/projects/:id/open', (req, res) => {
  const list = loadRegistry();
  const p = findProject(list, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  if (!fs.existsSync(p.cwd)) return res.status(400).json({ error: 'bad_cwd', detail: `Folder not found: ${p.cwd}` });
  const cmd = process.platform === 'win32' ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  try {
    // Fire and forget — explorer.exe returns a non-zero exit code even on success.
    const child = spawn(cmd, [p.cwd], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'open_failed', detail: String(e && e.message ? e.message : e) });
  }
});

// Detect commands in a folder (for the Add/Edit form).
app.post('/api/detect', (req, res) => {
  const cwd = (req.body && req.body.cwd ? String(req.body.cwd) : '').trim();
  if (!cwd || !fs.existsSync(cwd)) return res.status(400).json({ error: 'Folder not found' });
  const { pm, cmds } = detectCommands(cwd);
  res.json({ pm, commands: cmds });
});

// ---- Run / Stop (per command) ----
app.post('/api/projects/:id/commands/:cid/run', async (req, res) => {
  const list = loadRegistry();
  const p = findProject(list, req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  const c = p.commands.find(x => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Command not found' });
  const key = sk(p.id, c.id);
  if (isRunning(key)) return res.status(409).json({ error: 'already_running' });

  if (!fs.existsSync(p.cwd)) {
    return res.status(400).json({ error: 'bad_cwd', detail: `Folder not found: ${p.cwd}` });
  }

  // Guard against port collisions unless the caller forces it.
  if (c.port && !req.query.force && await isPortInUse(c.port)) {
    let owner = null;
    for (const q of list) for (const qc of q.commands) {
      if (qc.port === c.port && sk(q.id, qc.id) !== key && isRunning(sk(q.id, qc.id))) {
        owner = `${q.name}${qc.label ? ' · ' + qc.label : ''}`;
      }
    }
    return res.status(409).json({ error: 'port_in_use', port: c.port, owner });
  }

  let proc;
  try {
    proc = spawn(c.cmd, { cwd: p.cwd, shell: true, windowsHide: true });
  } catch (e) {
    return res.status(500).json({ error: 'spawn_failed', detail: String(e) });
  }

  const entry = { proc, logs: [], startedAt: Date.now(), alive: true };
  sessions.set(key, entry);

  const subs = subsFor(key);
  // Tell any open log viewers this is a fresh run so they clear stale output.
  for (const cl of subs) cl.write(`event: reset\ndata: 1\n\n`);

  const push = (text, stream) => {
    const line = { t: Date.now(), stream, text: text.toString() };
    entry.logs.push(line);
    if (entry.logs.length > MAX_LOG_LINES) entry.logs.shift();
    for (const cl of subs) cl.write(`data: ${JSON.stringify(line)}\n\n`);
  };

  push(`$ ${c.cmd}   (in ${p.cwd})\n`, 'sys');
  proc.stdout.on('data', d => push(d, 'out'));
  proc.stderr.on('data', d => push(d, 'err'));
  proc.on('error', (e) => {
    entry.alive = false;
    push(`\n[launcher] failed to start: ${e.message}\n`, 'err');
    for (const cl of subs) cl.write(`event: exit\ndata: -1\n\n`);
  });
  proc.on('exit', (code, signal) => {
    entry.alive = false;
    push(`\n— process exited (${signal ? 'signal ' + signal : 'code ' + code}) —\n`, 'sys');
    for (const cl of subs) cl.write(`event: exit\ndata: ${code}\n\n`);
  });

  res.json({ ok: true });
});

app.post('/api/projects/:id/commands/:cid/stop', (req, res) => {
  const key = sk(req.params.id, req.params.cid);
  const entry = sessions.get(key);
  if (!entry || !entry.alive) return res.status(404).json({ error: 'not_running' });
  treeKill(entry.proc.pid, 'SIGTERM', (err) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ ok: true });
  });
});

// ---- Live logs (SSE, per command) ----
app.get('/api/projects/:id/commands/:cid/logs', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();

  const key = sk(req.params.id, req.params.cid);
  const entry = sessions.get(key);
  if (entry) {
    for (const line of entry.logs) res.write(`data: ${JSON.stringify(line)}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ stream: 'sys', text: '(no session yet — press Run)' })}\n\n`);
  }
  const subs = subsFor(key);
  subs.add(res);
  const keep = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { subs.delete(res); clearInterval(keep); });
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

  function walk(dir, depth) {
    if (depth > 4 || found.length > 400) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = entries.filter(e => e.isFile()).map(e => e.name);
    const hasPkg = files.includes('package.json');
    const csproj = files.find(f => f.endsWith('.csproj'));
    if (hasPkg && !seen.has(dir)) {
      seen.add(dir);
      const meta = primaryCommands(dir) || { name: path.basename(dir), commands: [{ label: 'dev', cmd: 'npm run dev', port: null }] };
      found.push({ name: meta.name, cwd: dir, commands: meta.commands });
    } else if (csproj && !seen.has(dir)) {
      seen.add(dir);
      found.push({ name: path.basename(csproj, '.csproj'), cwd: dir, commands: [{ label: 'dotnet run', cmd: 'dotnet run', port: null }] });
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
  console.log(`\n  Stopping ${pending} running command(s)…`);
  for (const s of alive) treeKill(s.proc.pid, 'SIGTERM', () => { if (--pending === 0) process.exit(0); });
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Persist any legacy registry entries in the new normalized shape on startup.
try { saveRegistry(loadRegistry()); } catch {}

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
