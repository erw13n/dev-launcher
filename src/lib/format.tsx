import React from 'react';

export function uptime(ts) {
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
export function renderAnsi(text) {
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
  // Emit text, turning any http(s) URL into a clickable link (new tab).
  const push = (str) => {
    if (!str) return;
    const style = styleFor(cur);
    const urlRe = /(https?:\/\/[^\s]+)/g;
    let li = 0, mm;
    while ((mm = urlRe.exec(str)) !== null) {
      // Skip truncated/elided URLs (loggers insert ".." or "…") — clicking them goes nowhere.
      if (/\.\.|…/.test(mm[0])) continue;
      if (mm.index > li) parts.push(<span key={key++} style={style}>{str.slice(li, mm.index)}</span>);
      let url = mm[0], trail = '';
      const tm = url.match(/[)\].,;:!?'"]+$/); // don't swallow trailing punctuation
      if (tm) { trail = tm[0]; url = url.slice(0, -trail.length); }
      parts.push(<a key={key++} href={url} target="_blank" rel="noreferrer noopener" className="loglink" style={style}>{url}</a>);
      if (trail) parts.push(<span key={key++} style={style}>{trail}</span>);
      li = urlRe.lastIndex;
    }
    if (li < str.length) parts.push(<span key={key++} style={style}>{str.slice(li)}</span>);
  };
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
