import React, { useState, useEffect, useCallback } from 'react';
import { api } from './lib/api';
import { ProjectCard } from './components/ProjectCard';
import {
  ProjectModal, ScanModal, ObsoleteModal, DocViewer, RemoveModal, ConfirmModal, BulkTagModal,
} from './components/modals';

const OBSOLETE_SKIP_KEY = 'devlauncher.obsolete.skipConfirm';
const REMOVE_SKIP_KEY = 'devlauncher.remove.skipConfirm';

export function App() {
  const [projects, setProjects] = useState([]);
  const [conflicts, setConflicts] = useState({}); // "pid::cid" -> {port, owner}
  const [modal, setModal] = useState(null);        // {type:'add'|'edit', project?}
  const [scan, setScan] = useState(false);
  const [toast, setToast] = useState(null);
  const [view, setView] = useState('all');          // all | fav | hidden
  const [cat, setCat] = useState('');                // category filter ('' = any)
  const [tag, setTag] = useState('');                // tag filter ('' = any)
  const [obsoleteFor, setObsoleteFor] = useState(null); // project pending node_modules cleanup
  const [docsFor, setDocsFor] = useState(null);         // {pid, docs} for the markdown viewer
  const [removeFor, setRemoveFor] = useState(null);     // project pending removal confirmation
  const [selected, setSelected] = useState(() => new Set()); // selected project ids (bulk actions)
  const [bulkEdit, setBulkEdit] = useState(false);      // bulk category/tags modal
  const [bulkRemove, setBulkRemove] = useState(false);  // bulk remove confirm
  const [bulkClean, setBulkClean] = useState(false);    // bulk clean confirm

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

  const runRemove = async (p) => {
    await api.remove(p.id);
    setModal(null); // close the edit form too, if it was open for this project
    refresh();
  };
  const askRemove = (p) => {
    let skip = false;
    try { skip = localStorage.getItem(REMOVE_SKIP_KEY) === '1'; } catch {}
    if (skip) runRemove(p);
    else setRemoveFor(p);
  };
  const confirmRemove = (ack) => {
    const p = removeFor;
    if (ack) { try { localStorage.setItem(REMOVE_SKIP_KEY, '1'); } catch {} }
    setRemoveFor(null);
    if (p) runRemove(p);
  };

  const importScan = async (items) => {
    for (const it of items) await api.add(it);
    setScan(false);
    flash(`Added ${items.length} project${items.length === 1 ? '' : 's'}`);
    refresh();
  };

  const runObsolete = async (p) => {
    const { status, body } = await api.obsolete(p.id);
    if (status >= 400) flash(body.detail || body.error || 'Cleanup failed', true);
    else flash(body.removed ? `Cleaned node_modules · ${p.name}` : (body.detail || 'Nothing to clean'));
    refresh();
  };
  const askObsolete = (p) => {
    let skip = false;
    try { skip = localStorage.getItem(OBSOLETE_SKIP_KEY) === '1'; } catch {}
    if (skip) runObsolete(p);
    else setObsoleteFor(p);
  };
  const confirmObsolete = (ack) => {
    const p = obsoleteFor;
    if (ack) { try { localStorage.setItem(OBSOLETE_SKIP_KEY, '1'); } catch {} }
    setObsoleteFor(null);
    if (p) runObsolete(p);
  };

  const openDocs = (p) => { if (p.docs && p.docs.length) setDocsFor({ pid: p.id, docs: p.docs }); };

  const openFolder = async (p) => {
    const { status, body } = await api.open(p.id);
    if (status >= 400) flash(body.detail || body.error || 'Could not open folder', true);
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

  // ---- Bulk selection & actions ----
  const selectedProjects = projects.filter(p => selected.has(p.id));
  const toggleSelect = (id, on) => setSelected(prev => { const n = new Set(prev); if (on) n.add(id); else n.delete(id); return n; });
  const clearSelection = () => setSelected(new Set());
  const selectAllVisible = () => setSelected(new Set(visible.map(p => p.id)));

  const bulkUpdate = async (patch) => { await Promise.all(selectedProjects.map(p => api.update(p.id, patch))); refresh(); };
  const bulkFavorite = () => bulkUpdate({ favorite: true });
  const bulkHide = async () => { await bulkUpdate({ hidden: true }); clearSelection(); };
  const bulkUnhide = async () => { await bulkUpdate({ hidden: false }); clearSelection(); };
  const applyBulkTags = async ({ category, tags }) => {
    await Promise.all(selectedProjects.map(p => {
      const patch = {};
      if (category.trim()) patch.category = category.trim();
      if (tags.length) patch.tags = [...new Set([...(p.tags || []), ...tags])];
      return Object.keys(patch).length ? api.update(p.id, patch) : Promise.resolve();
    }));
    setBulkEdit(false); refresh();
  };
  const doBulkRemove = (ack) => {
    if (ack) { try { localStorage.setItem(REMOVE_SKIP_KEY, '1'); } catch {} }
    setBulkRemove(false);
    const ids = selectedProjects.map(p => p.id);
    Promise.all(ids.map(id => api.remove(id))).then(() => { clearSelection(); refresh(); });
  };
  const askBulkRemove = () => {
    let skip = false; try { skip = localStorage.getItem(REMOVE_SKIP_KEY) === '1'; } catch {}
    if (skip) doBulkRemove(false); else setBulkRemove(true);
  };
  const doBulkClean = (ack) => {
    if (ack) { try { localStorage.setItem(OBSOLETE_SKIP_KEY, '1'); } catch {} }
    setBulkClean(false);
    const targets = selectedProjects.filter(p => p.hasNodeModules && !p.commands.some(c => c.running));
    const skipped = selectedProjects.length - targets.length;
    Promise.all(targets.map(p => api.obsolete(p.id))).then(rs => {
      const removed = rs.filter(r => r && r.body && r.body.removed).length;
      flash(`Cleaned ${removed} project${removed === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped (running / none)` : ''}`);
      clearSelection(); refresh();
    });
  };
  const askBulkClean = () => {
    let skip = false; try { skip = localStorage.getItem(OBSOLETE_SKIP_KEY) === '1'; } catch {}
    if (skip) doBulkClean(false); else setBulkClean(true);
  };

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

      {selected.size > 0 && (
        <div className="bulkbar">
          <span className="bcount">{selected.size} selected</span>
          <button className="bulk-btn" onClick={selectAllVisible}>Select all ({visible.length})</button>
          <span className="bulk-sep" />
          <button className="bulk-btn" onClick={bulkFavorite}>★ Favorite</button>
          <button className="bulk-btn" onClick={bulkHide}>Hide</button>
          <button className="bulk-btn" onClick={bulkUnhide}>Unhide</button>
          <button className="bulk-btn" onClick={() => setBulkEdit(true)}>Category &amp; tags…</button>
          <button className="bulk-btn" onClick={askBulkClean}>Clean node_modules</button>
          <button className="bulk-btn danger" onClick={askBulkRemove}>Remove</button>
          <span className="bulk-sep" />
          <button className="bulk-btn ghost" onClick={clearSelection}>Clear</button>
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
              selected={selected.has(p.id)}
              onSelect={toggleSelect}
              onRun={run}
              onStop={stop}
              onEdit={(proj) => setModal({ type: 'edit', project: proj })}
              onRemove={askRemove}
              conflicts={conflicts}
              onResolve={resolve}
              onDismiss={dismiss}
              onToggleFav={toggleFav}
              onToggleHide={toggleHide}
              onToggleCollapse={toggleCollapse}
              onTagClick={setTag}
              onObsolete={askObsolete}
              onOpen={openFolder}
              onDocs={openDocs}
            />
          ))}
        </div>
      )}

      {modal && (
        <ProjectModal
          initial={modal.type === 'edit' ? modal.project : null}
          onClose={() => setModal(null)}
          onSave={save}
          onDelete={modal.type === 'edit' ? () => askRemove(modal.project) : undefined}
          categories={categories}
        />
      )}
      {scan && <ScanModal onClose={() => setScan(false)} onImport={importScan} />}
      {obsoleteFor && <ObsoleteModal project={obsoleteFor} onClose={() => setObsoleteFor(null)} onConfirm={confirmObsolete} />}
      {docsFor && <DocViewer pid={docsFor.pid} docs={docsFor.docs} onClose={() => setDocsFor(null)} />}
      {removeFor && <RemoveModal project={removeFor} onClose={() => setRemoveFor(null)} onConfirm={confirmRemove} />}
      {bulkEdit && <BulkTagModal count={selected.size} categories={categories} onClose={() => setBulkEdit(false)} onApply={applyBulkTags} />}
      {bulkRemove && (
        <ConfirmModal
          title={`Remove ${selected.size} project${selected.size === 1 ? '' : 's'}?`}
          confirmLabel="Remove"
          ackLabel="I understand the risk, don’t remind me again"
          onClose={() => setBulkRemove(false)}
          onConfirm={doBulkRemove}
        >Removes the selected projects from the launcher’s list. Your files are untouched — only the entries are deleted.</ConfirmModal>
      )}
      {bulkClean && (
        <ConfirmModal
          title={`Clean node_modules in ${selected.size} project${selected.size === 1 ? '' : 's'}?`}
          confirmLabel="Delete node_modules"
          ackLabel="I understand the risk, don’t remind me again"
          onClose={() => setBulkClean(false)}
          onConfirm={doBulkClean}
        >Permanently deletes <code>node_modules</code> in each selected project’s folder. Running projects are skipped. You’ll need to reinstall before running them again.</ConfirmModal>
      )}
      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
