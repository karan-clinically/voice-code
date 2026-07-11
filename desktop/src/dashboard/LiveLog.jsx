import React, { useEffect, useRef } from 'react';

export default function LiveLog({ logs }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <span className="label">Live log</span>
      <div className="logbox" ref={ref}>
        {logs.length ? logs.map((l) => `[${l.level}] ${l.message}`).join('\n') : 'waiting for activity…'}
      </div>
    </div>
  );
}
