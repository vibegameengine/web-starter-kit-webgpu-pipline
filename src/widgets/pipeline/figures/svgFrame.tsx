import type { ReactNode } from 'react';

export function Scroller({ viewBox, label, children }: { viewBox: string; label: string; children: ReactNode }) {
  return (
    <div className="scroller">
      <svg viewBox={viewBox} role="img" aria-label={label}>
        {children}
      </svg>
    </div>
  );
}

export function ArrowHeads() {
  return (
    <defs>
      <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 1 L9 5 L0 9 z" fill="currentColor" />
      </marker>
      <marker id="arb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 1 L9 5 L0 9 z" fill="var(--bake)" />
      </marker>
      <marker id="arc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 1 L9 5 L0 9 z" fill="var(--cost)" />
      </marker>
    </defs>
  );
}

export const MONO = 'IBM Plex Mono, monospace';
export const DISPLAY = 'Familjen Grotesk, sans-serif';
