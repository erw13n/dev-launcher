import React from 'react';
import { createRoot } from 'react-dom/client';
const { useState, useEffect, useRef, useCallback } = React;

const api = {
  list: () => fetch('/api/projects').then(r => r.json()),
  run: (id, force) => fetch(`/api/projects/${id}/run${force ? '?force=1' : ''}`, { method: 'POST' }).then(r => r.json().then(b => ({ status: r.status, body: b }))),
  stop: (id) => fetch(`/api/projects/${id}/stop`, { method: 'POST' }),
  add: (p) => fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  update: (id, p) => fetch(`/api/projects/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }),
  remove: (id) => fetch(`/api/projects/${id}`, { method: 'DELETE' }),
  freePort: (port) => fetch(`/api/port/${port}/free`, { method: 'POST' }).then(r => r.json()),
  scan: (root) => fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root }) }).then(r => r.json()),
};

function uptime(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function LogPanel({ id, alive }) {
  const [lines, setLines] = useState([]);
  const boxRef = useRef(null);
  useEffect(() => {
    const es = new EventSource(`/api/projects/${id}/logs`);
    es.onmessage = (e) => {
      try {
        const line = JSON.parse(e.data);
        setLines(prev => [...prev.slice(-800), line]);
      } catch {}
    };
    es.addEventListener('exit', () => {});
    return () => es.close();
  }, [id]);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div className="logs" ref={boxRef}>
      {lines.map((l, i) => (
        <span key={i} className={`l-${l.stream}`}>{l.text}</span>
      ))}
    </div>
  );
}

function PortChip({ p }) {
  if (!p.port) return <span className="port none">no port</span>;
  let cls = 'port';
  if (p.running) cls += ' mine';
  else if (p.portBusy) cls += ' busy';
  return (
    <span className={cls} title={p.portOwner ? `In use by ${p.portOwner}` : ''}>
      <span className="dot">●</span> :{p.port}
    </span>
  );
}

function Strip({ p, onRun, onStop, onEdit, onDelete, conflict, onResolve, onDismiss }) {
  const [showLogs, setShowLogs] = useState(false);
  useEffect(() => { if (p.running) setShowLogs(true); }, [p.running]);
  return (
    <div className={`strip ${p.running ? 'running' : ''}`}>
      <div className="strip-row">
        <span className={`lamp ${p.running ? 'on' : p.exited ? 'exited' : ''}`} />
        <div className="identity">
          <div className="name">{p.name}</div>
          <div className="cmd">{p.cmd}{p.running && p.startedAt ? `  ·  up ${uptime(p.startedAt)}` : ''}</div>
          <div className="path" title={p.cwd}>{p.cwd}</div>
        </div>
        <PortChip p={p} />
        <div className="actions">
          {p.running
            ? <button className="danger" onClick={() => onStop(p.id)}>Stop</button>
            : <button className="primary" onClick={() => onRun(p.id)}>Run</button>}
          <button className="iconbtn" title="Logs" onClick={() => setShowLogs(s => !s)}>Logs</button>
          <button className="iconbtn" title="Edit" onClick={() => onEdit(p)}>Edit</button>
          <button className="iconbtn" title="Remove" onClick={() => onDelete(p)}>✕</button>
        </div>
      </div>

      {conflict && (
        <div className="conflict">
          <span className="msg">
            Port <b>:{conflict.port}</b> is busy{conflict.owner ? <> — held by <b>{conflict.owner}</b></> : ''}. Free it and start anyway?
          </span>
          <div className="row">
            <button className="ghost" onClick={() => onDismiss(p.id)}>Cancel</button>
            <button className="primary" onClick={() => onResolve(p.id, conflict.port)}>Free :{conflict.port} &amp; run</button>
          </div>
        </div>
      )}

      {showLogs && (p.running || p.exited) && <LogPanel id={p.id} alive={p.running} />}
    </div>
  );
}

function ProjectModal({ initial, onClose, onSave }) {
  const [f, setF] = useState(initial || { name: '', cwd: '', cmd: 'npm run dev', port: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const valid = f.name.trim() && f.cwd.trim() && f.cmd.trim();
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{initial ? 'Edit project' : 'Add project'}</h2>
        <p className="hint">Point it at a folder and the command you'd normally type there.</p>
        <div className="field">
          <label>Name</label>
          <input value={f.name} onChange={set('name')} placeholder="WebQMS" autoFocus />
        </div>
        <div className="field">
          <label>Folder (working directory)</label>
          <input value={f.cwd} onChange={set('cwd')} placeholder="C:\dev\WebQMS" />
        </div>
        <div className="field row2">
          <div>
            <label>Command</label>
            <input value={f.cmd} onChange={set('cmd')} placeholder="npm run dev" />
          </div>
          <div>
            <label>Port</label>
            <input value={f.port || ''} onChange={set('port')} placeholder="5173" />
          </div>
        </div>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!valid} onClick={() => onSave(f)}>{initial ? 'Save' : 'Add'}</button>
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
        <p className="hint">Finds every folder with a package.json or .csproj, so you can bulk-add scattered projects.</p>
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
                  <div className="c-name">{c.name} <span style={{ color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 11 }}>{c.cmd}</span></div>
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
  const [conflicts, setConflicts] = useState({}); // id -> {port, owner}
  const [modal, setModal] = useState(null);        // {type:'add'|'edit', project?}
  const [scan, setScan] = useState(false);
  const [toast, setToast] = useState(null);

  const flash = (text, err) => { setToast({ text, err }); setTimeout(() => setToast(null), 2600); };

  const refresh = useCallback(async () => {
    try { setProjects(await api.list()); } catch {}
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (id, force) => {
    setConflicts(c => { const n = { ...c }; delete n[id]; return n; });
    const { status, body } = await api.run(id, force);
    if (status === 409 && body.error === 'port_in_use') {
      setConflicts(c => ({ ...c, [id]: { port: body.port, owner: body.owner } }));
    } else if (status >= 400) {
      flash(body.detail || body.error || 'Could not start', true);
    }
    refresh();
  };

  const resolve = async (id, port) => {
    await api.freePort(port);
    setTimeout(() => run(id, true), 500);
  };

  const stop = async (id) => { await api.stop(id); refresh(); };

  const save = async (f) => {
    const payload = { name: f.name, cwd: f.cwd, cmd: f.cmd, port: f.port };
    if (modal.type === 'edit') await api.update(modal.project.id, payload);
    else await api.add(payload);
    setModal(null);
    refresh();
  };

  const del = async (p) => {
    if (!confirm(`Remove "${p.name}" from the launcher? (This only removes it from this list — your files are untouched.)`)) return;
    await api.remove(p.id);
    refresh();
  };

  const importScan = async (items) => {
    for (const it of items) await api.add(it);
    setScan(false);
    flash(`Added ${items.length} project${items.length === 1 ? '' : 's'}`);
    refresh();
  };

  const liveCount = projects.filter(p => p.running).length;

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

      {projects.length === 0 ? (
        <div className="empty">
          <h3>No projects yet</h3>
          <p>Add one by hand, or scan a folder like <code>C:\dev</code> to pull them all in.</p>
        </div>
      ) : (
        <div className="board">
          {projects.map(p => (
            <Strip
              key={p.id}
              p={p}
              onRun={run}
              onStop={stop}
              onEdit={(proj) => setModal({ type: 'edit', project: proj })}
              onDelete={del}
              conflict={conflicts[p.id]}
              onResolve={resolve}
              onDismiss={(id) => setConflicts(c => { const n = { ...c }; delete n[id]; return n; })}
            />
          ))}
        </div>
      )}

      {modal && (
        <ProjectModal
          initial={modal.type === 'edit' ? modal.project : null}
          onClose={() => setModal(null)}
          onSave={save}
        />
      )}
      {scan && <ScanModal onClose={() => setScan(false)} onImport={importScan} />}
      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.text}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
