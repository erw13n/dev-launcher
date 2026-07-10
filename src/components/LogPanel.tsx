import React, { useState, useEffect, useRef } from 'react';
import { renderAnsi } from '../lib/format';

export function LogPanel({ pid, cid }) {
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
