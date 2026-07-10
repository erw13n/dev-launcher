const jsonHeaders = { 'Content-Type': 'application/json' };

export const api = {
  list: () => fetch('/api/projects').then(r => r.json()),
  run: (pid, cid, force) =>
    fetch(`/api/projects/${pid}/commands/${cid}/run${force ? '?force=1' : ''}`, { method: 'POST' })
      .then(r => r.json().then(b => ({ status: r.status, body: b }))),
  stop: (pid, cid) => fetch(`/api/projects/${pid}/commands/${cid}/stop`, { method: 'POST' }),
  add: (p) => fetch('/api/projects', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(p) }),
  update: (id, p) => fetch(`/api/projects/${id}`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(p) }),
  remove: (id) => fetch(`/api/projects/${id}`, { method: 'DELETE' }),
  obsolete: (id) => fetch(`/api/projects/${id}/obsolete`, { method: 'POST' }).then(r => r.json().then(b => ({ status: r.status, body: b }))),
  open: (id) => fetch(`/api/projects/${id}/open`, { method: 'POST' }).then(r => r.json().then(b => ({ status: r.status, body: b }))),
  readDoc: (id, file) => fetch(`/api/projects/${id}/doc?file=${encodeURIComponent(file)}`).then(r => r.json()),
  freePort: (port) => fetch(`/api/port/${port}/free`, { method: 'POST' }).then(r => r.json()),
  detect: (cwd) => fetch('/api/detect', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ cwd }) }).then(r => r.json()),
  scan: (root) => fetch('/api/scan', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ root }) }).then(r => r.json()),
};
