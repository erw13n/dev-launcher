import React from 'react';
import { createRoot } from 'react-dom/client';
const { useState, useEffect, useRef, useCallback } = React;

const jsonHeaders = { 'Content-Type': 'application/json' };
const api = {
  list: () => fetch('/api/projects').then(r => r.json()),
  run: (pid, cid, force) =>
    fetch(`/api/projects/${pid}/commands/${cid}/run${force ? '?force=1' : ''}`, { method: 'POST' })
      .then(r => r.json().then(b => ({ status: r.status, body: b }))),
  stop: (pid, cid) => fetch(`/api/projects/${pid}/commands/${cid}/stop`, { method: 'POST' }),
  add: (p) => fetch('/api/projects', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(p) }),
  update: (id, p) => fetch(`/api/projects/${id}`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(p) }),
  remove: (id) => fetch(`/api/projects/${id}`, { method: 'DELETE' }),
  freePort: (port) => fetch(`/api/port/${port}/free`, { method: 'POST' }).then(r => r.json()),
  detect: (cwd) => fetch('/api/detect', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ cwd }) }).then(r => r.json()),
  scan: (root) => fetch('/api/scan', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ root }) }).then(r => r.json()),
};

function uptime(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Terminal colours for ANSI SGR codes (30-37 / 90-97), tuned to the dark theme.
const ANSI_COLORS = {
  30: '#5c6370', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b',
  34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#cfd3da',
  90: '#7f848e', 91: '#e69b92', 92: '#b5e0a0', 93: '#f0d79a',
  94: '#8fc7ff', 95: '#d7a3e8', 96: '#7fd4dd', 97: '#ffffff',
};

// Turn a chunk of text with ANSI escape codes into coloured <span>s.
// Uncoloured text inherits the stream's base colour.
function renderAnsi(text) {
  const parts = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m, key = 0;
  let cur = { color: null, bold: false, dim: false };
  const styleFor = (s) => {
    const st = {};
    if (s.color) st.color = s.color;
    if (s.bold) st.fontWeight = 700;
    if (s.dim) st.opacity = 0.65;
    return Object.keys(st).length ? st : undefined;
  };
  const push = (str) => { if (str) parts.push(<span key={key++} style={styleFor(cur)}>{str}</span>); };
  while ((m = re.exec(text)) !== null) {
    push(text.slice(last, m.index));
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (const c of codes) {
      if (c === 0) cur = { color: null, bold: false, dim: false };
      else if (c === 1) cur.bold = true;
      else if (c === 2) cur.dim = true;
      else if (c === 22) { cur.bold = false; cur.dim = false; }
      else if (c === 39) cur.color = null;
      else if (ANSI_COLORS[c]) cur.color = ANSI_COLORS[c];
    }
    last = re.lastIndex;
  }
  push(text.slice(last));
  return parts;
}

function LogPanel({ pid, cid }) {
  const [lines, setLines] = useState([]);
  const boxRef = useRef(null);
  useEffect(() => {
    const es = new EventSource(`/api/projects/${pid}/commands/${cid}/logs`);
    es.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data);
        setLines(prev => [...prev.slice(-800), line]);
      } catch {}
    };
    es.addEventListener('reset', () => setLines([]));
    es.addEventListener('exit', () => {});
    return () => es.close();
  }, [pid, cid]);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div className="logs" ref={boxRef}>
      {lines.map((l, i) => (
        <span key={i} className={`l-${l.stream}`}>{renderAnsi(l.text)}</span>
      ))}
    </div>
  );
}

function PortChip({ c }) {
  if (!c.port) return <span className="port none">no port</span>;
  let cls = 'port';
  if (c.running) cls += ' mine';
  else if (c.portBusy) cls += ' busy';
  return (
    <span className={cls} title={c.portOwner ? `In use by ${c.portOwner}` : ''}>
      <span className="dot">●</span> :{c.port}
    </span>
  );
}

function CommandRow({ pid, c, onRun, onStop, conflict, onResolve, onDismiss }) {
  const [showLogs, setShowLogs] = useState(false);
  useEffect(() => { if (c.running) setShowLogs(true); }, [c.running]);
  return (
    <div className={`cmd-row ${c.running ? 'running' : ''}`}>
      <div className="cmd-line">
        <span className={`lamp sm ${c.running ? 'on' : c.exited ? 'exited' : ''}`} />
        <div className="cmd-identity">
          <span className="cmd-label">{c.label}</span>
          <span className="cmd-text">{c.cmd}{c.running && c.startedAt ? `  ·  up ${uptime(c.startedAt)}` : ''}</span>
        </div>
        <PortChip c={c} />
        <div className="actions">
          {c.running
            ? <button className="danger" onClick={() => onStop(pid, c.id)}>Stop</button>
            : <button className="primary" onClick={() => onRun(pid, c.id)}>Run</button>}
          <button className="iconbtn" title="Logs" onClick={() => setShowLogs(s => !s)}>Logs</button>
        </div>
      </div>

      {conflict && (
        <div className="conflict">
          <span className="msg">
            Port <b>:{conflict.port}</b> is busy{conflict.owner ? <> — held by <b>{conflict.owner}</b></> : ''}. Free it and start anyway?
          </span>
          <div className="row">
            <button className="ghost" onClick={() => onDismiss(pid, c.id)}>Cancel</button>
            <button className="primary" onClick={() => onResolve(pid, c.id, conflict.port)}>Free :{conflict.port} &amp; run</button>
          </div>
        </div>
      )}

      {showLogs && (c.running || c.exited) && <LogPanel pid={pid} cid={c.id} />}
    </div>
  );
}

function ProjectCard({ p, onRun, onStop, onEdit, conflicts, onResolve, onDismiss, onToggleFav, onToggleHide, onToggleCollapse, onTagClick }) {
  const runningCount = p.commands.filter(c => c.running).length;
  const collapsed = !!p.collapsed;
  return (
    <div className={`strip ${runningCount ? 'running' : ''} ${p.hidden ? 'is-hidden' : ''}`}>
      <div className="proj-head">
        <span className={`lamp ${runningCount ? 'on' : ''}`} />
        <div className="identity clickable" onClick={() => onToggleCollapse(p)} title={collapsed ? 'Expand commands' : 'Collapse commands'}>
          <div className="name">
            <svg className={`chev ${collapsed ? '' : 'open'}`} width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {p.name}
            {p.category ? <span className="cat-tag">{p.category}</span> : ''}
            {runningCount ? <span className="run-badge">{runningCount} running</span> : ''}
            {collapsed ? <span className="cmd-count">{p.commands.length} command{p.commands.length === 1 ? '' : 's'}</span> : ''}
          </div>
          <div className="path" title={p.cwd}>{p.cwd}</div>
          {p.tags && p.tags.length > 0 && (
            <div className="tag-row">
              {p.tags.map(t => <button key={t} className="tag" title={`Filter by #${t}`} onClick={(e) => { e.stopPropagation(); onTagClick(t); }}>#{t}</button>)}
            </div>
          )}
        </div>
        <div className="actions">
          <button className={`iconbtn star ${p.favorite ? 'on' : ''}`} title={p.favorite ? 'Unfavorite' : 'Favorite'} onClick={() => onToggleFav(p)}>{p.favorite ? '★' : '☆'}</button>
          <button className="iconbtn" title={p.hidden ? 'Unhide' : 'Hide'} onClick={() => onToggleHide(p)}>{p.hidden ? 'Unhide' : 'Hide'}</button>
          <button className="iconbtn" title="Edit project & commands" onClick={() => onEdit(p)}>Edit</button>
        </div>
      </div>
      {!collapsed && (
        <div className="cmd-list">
          {p.commands.length === 0 ? (
            <div className="no-cmds">No commands yet — <button className="linkbtn" onClick={() => onEdit(p)}>add one</button>.</div>
          ) : p.commands.map(c => (
            <CommandRow
              key={c.id}
              pid={p.id}
              c={c}
              onRun={onRun}
              onStop={onStop}
              conflict={conflicts[`${p.id}::${c.id}`]}
              onResolve={onResolve}
              onDismiss={onDismiss}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectModal({ initial, onClose, onSave, onDelete, categories }) {
  const [name, setName] = useState(initial ? initial.name : '');
  const [cwd, setCwd] = useState(initial ? initial.cwd : '');
  const [category, setCategory] = useState(initial ? initial.category || '' : '');
  const [tags, setTags] = useState(initial ? (initial.tags || []).join(', ') : '');
  const [cmds, setCmds] = useState(() =>
    initial && initial.commands && initial.commands.length
      ? initial.commands.map(c => ({ label: c.label, cmd: c.cmd, port: c.port || '' }))
      : [{ label: '', cmd: 'npm run dev', port: '' }]
  );
  const [detecting, setDetecting] = useState(false);
  const [detectedPm, setDetectedPm] = useState('');

  const setCmd = (i, k) => (e) => setCmds(cs => cs.map((c, j) => (j === i ? { ...c, [k]: e.target.value } : c)));
  const addCmd = () => setCmds(cs => [...cs, { label: '', cmd: '', port: '' }]);
  const removeCmd = (i) => setCmds(cs => cs.filter((_, j) => j !== i));

  const detect = async () => {
    if (!cwd.trim()) return;
    setDetecting(true);
    const res = await api.detect(cwd.trim()).catch(() => ({}));
    setDetecting(false);
    if (res && res.pm) setDetectedPm(res.pm);
    const found = (res && res.commands) || [];
    if (!found.length) return;
    setCmds(cs => {
      const base = cs.filter(c => c.cmd.trim() || c.label.trim());
      const have = new Set(base.map(c => c.cmd.trim()));
      const add = found.filter(c => !have.has(c.cmd)).map(c => ({ label: c.label, cmd: c.cmd, port: '' }));
      return [...base, ...add];
    });
  };

  const validCmds = cmds.filter(c => c.cmd.trim());
  const valid = name.trim() && cwd.trim() && validCmds.length > 0;
  const save = () => onSave({
    name, cwd,
    category: category.trim(),
    tags: tags.split(',').map(t => t.trim()).filter(Boolean),
    commands: validCmds.map(c => ({ label: c.label.trim(), cmd: c.cmd.trim(), port: c.port })),
  });

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal lg" onClick={e => e.stopPropagation()}>
        <h2>{initial ? 'Edit project' : 'Add project'}</h2>
        <p className="hint">A project is a folder plus the commands you run in it. Add as many as you like — each runs on its own.</p>
        <div className="field">
          <label>Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="WebQMS" autoFocus />
        </div>
        <div className="field">
          <label>Folder (working directory)</label>
          <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="C:\dev\WebQMS" />
        </div>
        <div className="field split">
          <div>
            <label>Category</label>
            <input value={category} onChange={e => setCategory(e.target.value)} placeholder="Work / Client / Personal" list="cat-list" />
            <datalist id="cat-list">
              {(categories || []).map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div>
            <label>Tags (comma-separated)</label>
            <input value={tags} onChange={e => setTags(e.target.value)} placeholder="frontend, vite, client-x" />
          </div>
        </div>

        <div className="cmds-editor">
          <div className="cmds-head">
            <label>Commands{detectedPm ? <span className="pm-tag">{detectedPm}</span> : ''}</label>
            <div className="cmds-tools">
              <button className="ghost small" disabled={!cwd.trim() || detecting} onClick={detect}>
                {detecting ? 'Detecting…' : 'Detect from folder'}
              </button>
              <button className="ghost small" onClick={addCmd}>+ Add</button>
            </div>
          </div>
          <div className="cmd-rows">
            {cmds.map((c, i) => (
              <div className="cmd-edit" key={i}>
                <input className="ce-label" value={c.label} onChange={setCmd(i, 'label')} placeholder="label" />
                <input className="ce-cmd" value={c.cmd} onChange={setCmd(i, 'cmd')} placeholder="npm run dev   ·   tsx watch server/index.ts" />
                <input className="ce-port" value={c.port} onChange={setCmd(i, 'port')} placeholder="port" />
                <button className="iconbtn" title="Remove command" onClick={() => removeCmd(i)} disabled={cmds.length === 1}>✕</button>
              </div>
            ))}
          </div>
          <p className="hint tiny">Label is optional — the command line is used if you leave it blank. Set a port to catch collisions.</p>
        </div>

        <div className="modal-actions">
          {initial && onDelete && (
            <button className="danger remove" onClick={onDelete}>Remove</button>
          )}
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid} onClick={save}>{initial ? 'Save' : 'Add'}</button>
        </div>
      </div>
    </div>
  );
}

function ScanModal({ onClose, onImport }) {
  const [root, setRoot] = useState('');
  const [cands, setCands] = useState(null);
  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    setBusy(true);
    const res = await api.scan(root).catch(() => ({ candidates: [] }));
    setBusy(false);
    if (res.error) { setCands([]); return; }
    setCands(res.candidates || []);
    setPicked(Object.fromEntries((res.candidates || []).map((_, i) => [i, true])));
  };
  const toggle = (i) => setPicked({ ...picked, [i]: !picked[i] });
  const doImport = () => onImport(cands.filter((_, i) => picked[i]));
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Scan a folder</h2>
        <p className="hint">Finds every folder with a package.json or .csproj, so you can bulk-add scattered projects. Add more commands per project afterwards with Edit.</p>
        <div className="field row2">
          <div>
            <label>Root folder</label>
            <input value={root} onChange={e => setRoot(e.target.value)} placeholder="C:\dev" onKeyDown={e => e.key === 'Enter' && scan()} autoFocus />
          </div>
          <div>
            <label>&nbsp;</label>
            <button className="primary" style={{ width: '100%' }} disabled={!root.trim() || busy} onClick={scan}>{busy ? 'Scanning…' : 'Scan'}</button>
          </div>
        </div>
        {cands && cands.length === 0 && <p className="hint">Nothing found (or folder not reachable from this machine).</p>}
        {cands && cands.length > 0 && (
          <div className="cands">
            {cands.map((c, i) => (
              <label className="cand" key={i}>
                <input type="checkbox" checked={!!picked[i]} onChange={() => toggle(i)} />
                <div style={{ minWidth: 0 }}>
                  <div className="c-name">{c.name} <span style={{ color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 11 }}>{(c.commands[0] && c.commands[0].cmd) || 'no command'}</span></div>
                  <div className="c-path">{c.cwd}</div>
                </div>
              </label>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Close</button>
          {cands && cands.length > 0 && (
            <button className="primary" onClick={doImport}>Add {Object.values(picked).filter(Boolean).length} selected</button>
          )}
        </div>
      </div>
    </div>
  );
}

function App() {
  const [projects, setProjects] = useState([]);
  const [conflicts, setConflicts] = useState({}); // "pid::cid" -> {port, owner}
  const [modal, setModal] = useState(null);        // {type:'add'|'edit', project?}
  const [scan, setScan] = useState(false);
  const [toast, setToast] = useState(null);
  const [view, setView] = useState('all');          // all | fav | hidden
  const [cat, setCat] = useState('');                // category filter ('' = any)
  const [tag, setTag] = useState('');                // tag filter ('' = any)

  const flash = (text, err) => { setToast({ text, err }); setTimeout(() => setToast(null), 2600); };

  const refresh = useCallback(async () => {
    try { setProjects(await api.list()); } catch {}
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (pid, cid, force) => {
    const k = `${pid}::${cid}`;
    setConflicts(c => { const n = { ...c }; delete n[k]; return n; });
    const { status, body } = await api.run(pid, cid, force);
    if (status === 409 && body.error === 'port_in_use') {
      setConflicts(c => ({ ...c, [k]: { port: body.port, owner: body.owner } }));
    } else if (status >= 400) {
      flash(body.detail || body.error || 'Could not start', true);
    }
    refresh();
  };

  const resolve = async (pid, cid, port) => {
    await api.freePort(port);
    setTimeout(() => run(pid, cid, true), 500);
  };

  const dismiss = (pid, cid) => setConflicts(c => { const n = { ...c }; delete n[`${pid}::${cid}`]; return n; });

  const stop = async (pid, cid) => { await api.stop(pid, cid); refresh(); };

  const save = async (f) => {
    if (modal.type === 'edit') await api.update(modal.project.id, f);
    else await api.add(f);
    setModal(null);
    refresh();
  };

  const del = async () => {
    const p = modal.project;
    if (!confirm(`Remove "${p.name}" from the launcher? (This only removes it from this list — your files are untouched.)`)) return;
    await api.remove(p.id);
    setModal(null);
    refresh();
  };

  const importScan = async (items) => {
    for (const it of items) await api.add(it);
    setScan(false);
    flash(`Added ${items.length} project${items.length === 1 ? '' : 's'}`);
    refresh();
  };

  const toggleFav = async (p) => { await api.update(p.id, { favorite: !p.favorite }); refresh(); };
  const toggleHide = async (p) => { await api.update(p.id, { hidden: !p.hidden }); refresh(); };
  const toggleCollapse = async (p) => {
    const next = !p.collapsed;
    // Optimistic: flip immediately, then persist so it survives refresh/restart.
    setProjects(prev => prev.map(x => (x.id === p.id ? { ...x, collapsed: next } : x)));
    await api.update(p.id, { collapsed: next });
    refresh();
  };

  const liveCount = projects.reduce((n, p) => n + p.commands.filter(c => c.running).length, 0);
  const categories = [...new Set(projects.map(p => p.category).filter(Boolean))].sort();
  const counts = {
    all: projects.filter(p => !p.hidden).length,
    fav: projects.filter(p => p.favorite && !p.hidden).length,
    hidden: projects.filter(p => p.hidden).length,
  };
  const inView = (p) => view === 'hidden' ? p.hidden : view === 'fav' ? (p.favorite && !p.hidden) : !p.hidden;
  const visible = projects.filter(p => inView(p) && (!cat || p.category === cat) && (!tag || (p.tags || []).includes(tag)));

  return (
    <div className="wrap">
      <header className="masthead">
        <div className="brand">
          <h1>Dev Launcher</h1>
          <p><span className="live-count">{liveCount}</span> running · {projects.length} project{projects.length === 1 ? '' : 's'}</p>
        </div>
        <div className="toolbar">
          <button onClick={() => setScan(true)}>Scan folder</button>
          <button className="primary" onClick={() => setModal({ type: 'add' })}>Add project</button>
        </div>
      </header>

      {projects.length > 0 && (
        <div className="filterbar">
          {[['all', 'All'], ['fav', 'Fav'], ['hidden', 'Hidden']].map(([k, lbl]) => (
            <button key={k} className={`filt ${view === k ? 'active' : ''}`} onClick={() => setView(k)}>
              {lbl}<span className="fc">{counts[k]}</span>
            </button>
          ))}
          {categories.length > 0 && <span className="filt-sep" />}
          {categories.map(c => (
            <button key={c} className={`filt cat ${cat === c ? 'active' : ''}`} onClick={() => setCat(cat === c ? '' : c)}>{c}</button>
          ))}
          {tag && <button className="filt tagf active" onClick={() => setTag('')}>#{tag} ✕</button>}
        </div>
      )}

      {projects.length === 0 ? (
        <div className="empty">
          <h3>No projects yet</h3>
          <p>Add one by hand, or scan a folder like <code>C:\dev</code> to pull them all in.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <h3>Nothing here</h3>
          <p>No projects match this filter.</p>
        </div>
      ) : (
        <div className="board">
          {visible.map(p => (
            <ProjectCard
              key={p.id}
              p={p}
              onRun={run}
              onStop={stop}
              onEdit={(proj) => setModal({ type: 'edit', project: proj })}
              conflicts={conflicts}
              onResolve={resolve}
              onDismiss={dismiss}
              onToggleFav={toggleFav}
              onToggleHide={toggleHide}
              onToggleCollapse={toggleCollapse}
              onTagClick={setTag}
            />
          ))}
        </div>
      )}

      {modal && (
        <ProjectModal
          initial={modal.type === 'edit' ? modal.project : null}
          onClose={() => setModal(null)}
          onSave={save}
          onDelete={modal.type === 'edit' ? del : undefined}
          categories={categories}
        />
      )}
      {scan && <ScanModal onClose={() => setScan(false)} onImport={importScan} />}
      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.text}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
