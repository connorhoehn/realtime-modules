// Minimal inline UI primitives for the demo showcase.
// Zero external dependencies — no component library needed.

import type { ReactNode, CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// DemoCard
// ---------------------------------------------------------------------------

export function DemoCard({
  title,
  channel,
  hook,
  children,
}: {
  title: string;
  channel: string;
  hook: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        maxWidth: 720,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 4 }}>
          {title}
        </h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <code
            style={{
              fontSize: 12,
              padding: '2px 8px',
              background: '#1e3a5f',
              borderRadius: 4,
              color: '#7dd3fc',
              fontFamily: 'monospace',
            }}
          >
            {hook}
          </code>
          <code
            style={{
              fontSize: 12,
              padding: '2px 8px',
              background: '#1e2533',
              borderRadius: 4,
              color: '#64748b',
              fontFamily: 'monospace',
            }}
          >
            channel: {channel}
          </code>
        </div>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#64748b',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Btn
// ---------------------------------------------------------------------------

export function Btn({
  onClick,
  children,
  disabled,
  style,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '7px 16px',
        background: disabled ? '#1e2533' : '#1d4ed8',
        border: '1px solid transparent',
        borderRadius: 6,
        color: disabled ? '#475569' : '#e2e8f0',
        fontSize: 13,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.15s',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

export function StatusBadge({ children, color }: { children: ReactNode; color: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        padding: '2px 6px',
        borderRadius: 4,
        background: `${color}22`,
        color,
        border: `1px solid ${color}55`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '8px 12px',
        background: '#1e2533',
        border: '1px solid #334155',
        borderRadius: 6,
        color: '#e2e8f0',
        fontSize: 13,
        outline: 'none',
        cursor: 'pointer',
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
