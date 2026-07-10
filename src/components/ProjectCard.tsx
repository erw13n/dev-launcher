import React, { useState, useEffect } from 'react';
import { uptime } from '../lib/format';
import { LogPanel } from './LogPanel';

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

export function ProjectCard({ p, selected, onSelect, onRun, onStop, onEdit, onRemove, conflicts, onResolve, onDismiss, onToggleFav, onToggleHide, onToggleCollapse, onTagClick, onObsolete, onOpen, onDocs }) {
  const runningCount = p.commands.filter(c => c.running).length;
  const collapsed = !!p.collapsed;
  return (
    <div className={`strip ${runningCount ? 'running' : ''} ${p.hidden ? 'is-hidden' : ''} ${selected ? 'selected' : ''}`}>
      <div className="proj-head">
        <input type="checkbox" className="sel" checked={selected} onChange={e => onSelect(p.id, e.target.checked)} title="Select project" />
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
          <div className="path">
            <span className="path-text" title={p.cwd}>{p.cwd}</span>
            <button className="openbtn" title="Open folder in file explorer" onClick={(e) => { e.stopPropagation(); onOpen(p); }}>
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6.5 3H4a1.5 1.5 0 00-1.5 1.5v7A1.5 1.5 0 004 13h7a1.5 1.5 0 001.5-1.5V9M9.5 2.5H13.5V6.5M13 3L7.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {p.tags && p.tags.length > 0 && (
            <div className="tag-row">
              {p.tags.map(t => <button key={t} className="tag" title={`Filter by #${t}`} onClick={(e) => { e.stopPropagation(); onTagClick(t); }}>#{t}</button>)}
            </div>
          )}
        </div>
        <div className="actions">
          <button className={`iconbtn star ${p.favorite ? 'on' : ''}`} title={p.favorite ? 'Unfavorite' : 'Favorite'} onClick={() => onToggleFav(p)}>{p.favorite ? '★' : '☆'}</button>
          {p.docs && p.docs.length > 0 && (
            <button className="iconbtn" title={`View ${p.docs.length > 1 ? p.docs.length + ' docs' : p.docs[0]}`} onClick={() => onDocs(p)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
                <path d="M14 2v5h5" /><path d="M9 13h6M9 17h6" />
              </svg>
            </button>
          )}
          {p.hasNodeModules && (
            <button className="iconbtn clean" title="Clean node_modules (free space)" onClick={() => onObsolete(p)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 13V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5" />
                <path d="M14 2v5a1 1 0 0 0 1 1h5" />
                <path d="M10 22v-5" /><path d="M14 19v-2" /><path d="M18 20v-3" />
                <path d="M2 13h20" /><path d="M6 20v-3" />
              </svg>
            </button>
          )}
          <button className="iconbtn trash" title="Remove project" onClick={() => onRemove(p)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" /><path d="M14 11v6" />
            </svg>
          </button>
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
