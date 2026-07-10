import React, { useState, useEffect, useRef } from 'react';
import { marked } from 'marked';
import { api } from '../lib/api';

export function ProjectModal({ initial, onClose, onSave, onDelete, categories }) {
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

export function ScanModal({ onClose, onImport }) {
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

export function ObsoleteModal({ project, onClose, onConfirm }) {
  const [ack, setAck] = useState(false);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Clean node_modules?</h2>
        <p className="hint">
          This permanently deletes the <code>node_modules</code> folder inside
          <br /><b>{project.cwd}</b>
          <br />You’ll need to reinstall dependencies before running again. Source files are untouched.
        </p>
        <label className="ack">
          <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
          I understand the risk, don’t remind me again
        </label>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="danger solid" onClick={() => onConfirm(ack)}>Delete node_modules</button>
        </div>
      </div>
    </div>
  );
}

export function DocViewer({ pid, docs, onClose }) {
  const [file, setFile] = useState(docs[0]);
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const bodyRef = useRef(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.readDoc(pid, file).then(res => {
      if (!alive) return;
      setHtml(res && typeof res.content === 'string' ? marked.parse(res.content) : '<p>Could not load this file.</p>');
      setLoading(false);
    }).catch(() => { if (alive) { setHtml('<p>Could not load this file.</p>'); setLoading(false); } });
    return () => { alive = false; };
  }, [pid, file]);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noreferrer noopener'; });
  }, [html]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal lg doc-modal" onClick={e => e.stopPropagation()}>
        <div className="doc-head">
          {docs.length > 1
            ? <select value={file} onChange={e => setFile(e.target.value)}>{docs.map(d => <option key={d} value={d}>{d}</option>)}</select>
            : <h2>{file}</h2>}
          <button className="iconbtn" title="Close" onClick={onClose}>✕</button>
        </div>
        <div className="md-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: loading ? '<p class="hint">Loading…</p>' : html }} />
      </div>
    </div>
  );
}

export function RemoveModal({ project, onClose, onConfirm }) {
  const [ack, setAck] = useState(false);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Remove project?</h2>
        <p className="hint">
          This removes <b>{project.name}</b> from the launcher’s list. The folder and
          your files at
          <br /><b>{project.cwd}</b>
          <br />are left untouched — only this entry is deleted.
        </p>
        <label className="ack">
          <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
          I understand the risk, don’t remind me again
        </label>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="danger solid" onClick={() => onConfirm(ack)}>Remove project</button>
        </div>
      </div>
    </div>
  );
}

// Generic destructive-confirm modal with an optional "don't remind me" checkbox.
export function ConfirmModal({ title, children, confirmLabel, ackLabel, onConfirm, onClose }) {
  const [ack, setAck] = useState(false);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="hint">{children}</p>
        {ackLabel && (
          <label className="ack">
            <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
            {ackLabel}
          </label>
        )}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="danger solid" onClick={() => onConfirm(ack)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// Apply a category and/or add tags to several projects at once.
export function BulkTagModal({ count, categories, onClose, onApply }) {
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Edit {count} project{count === 1 ? '' : 's'}</h2>
        <p className="hint">Leave a field blank to leave it unchanged. Tags are added to each project (existing tags are kept).</p>
        <div className="field">
          <label>Category</label>
          <input value={category} onChange={e => setCategory(e.target.value)} placeholder="(leave blank to keep)" list="cat-list" />
          <datalist id="cat-list">{(categories || []).map(c => <option key={c} value={c} />)}</datalist>
        </div>
        <div className="field">
          <label>Add tags (comma-separated)</label>
          <input value={tags} onChange={e => setTags(e.target.value)} placeholder="frontend, client-x" />
        </div>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!category.trim() && !tags.trim()} onClick={() => onApply({ category, tags: tags.split(',').map(t => t.trim()).filter(Boolean) })}>Apply to {count}</button>
        </div>
      </div>
    </div>
  );
}
