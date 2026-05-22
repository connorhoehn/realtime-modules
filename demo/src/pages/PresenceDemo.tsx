import { useState } from 'react';
import { usePresence } from '@connorhoehn/realtime-modules/client';
import { DemoCard, StatusBadge, Field, Btn, Select } from '../components/ui';

const CHANNEL = 'demo:presence-room';

type PresenceStatus = 'online' | 'away' | 'busy' | 'offline';

const STATUS_OPTIONS: PresenceStatus[] = ['online', 'away', 'busy', 'offline'];

const STATUS_COLORS: Record<PresenceStatus, string> = {
  online: '#22c55e',
  away: '#eab308',
  busy: '#ef4444',
  offline: '#475569',
};

export default function PresenceDemo() {
  const { roster, setStatus, updateMetadata } = usePresence(CHANNEL);
  const [selectedStatus, setSelectedStatus] = useState<PresenceStatus>('online');
  const [metaKey, setMetaKey] = useState('displayName');
  const [metaValue, setMetaValue] = useState('');

  function handleSetStatus() {
    setStatus(selectedStatus);
  }

  function handleUpdateMeta() {
    if (!metaKey.trim()) return;
    updateMetadata({ [metaKey.trim()]: metaValue });
  }

  return (
    <DemoCard title="usePresence" channel={CHANNEL} hook="usePresence(channel)">
      <Field label={`Roster — ${roster.length} online`}>
        <div
          style={{
            minHeight: 120,
            maxHeight: 300,
            overflowY: 'auto',
            background: '#0f1117',
            borderRadius: 6,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {roster.length === 0 && (
            <span style={{ color: '#475569', fontSize: 13 }}>
              No presence entries yet — presence:subscribe is sent automatically on connect.
            </span>
          )}
          {roster.map((p) => (
            <div
              key={p.clientId}
              style={{
                padding: '8px 12px',
                background: '#1e2533',
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: STATUS_COLORS[p.status] ?? '#475569',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 13, fontFamily: 'monospace', color: '#7dd3fc' }}>
                {p.clientId.slice(0, 12)}
              </span>
              <StatusBadge color={STATUS_COLORS[p.status] ?? '#475569'}>{p.status}</StatusBadge>
              {Object.keys(p.metadata).length > 0 && (
                <span style={{ fontSize: 11, color: '#64748b', marginLeft: 'auto' }}>
                  {JSON.stringify(p.metadata)}
                </span>
              )}
            </div>
          ))}
        </div>
      </Field>

      <Field label="Set your status">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Select
            value={selectedStatus}
            onChange={(v) => setSelectedStatus(v as PresenceStatus)}
            options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
          />
          <Btn onClick={handleSetStatus}>Apply</Btn>
        </div>
      </Field>

      <Field label="Update metadata">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={metaKey}
            onChange={(e) => setMetaKey(e.target.value)}
            placeholder="key"
            style={inputStyle}
          />
          <input
            type="text"
            value={metaValue}
            onChange={(e) => setMetaValue(e.target.value)}
            placeholder="value"
            style={inputStyle}
          />
          <Btn onClick={handleUpdateMeta}>Update</Btn>
        </div>
        <p style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
          Merges into your presence entry's metadata field.
        </p>
      </Field>
    </DemoCard>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 80,
  padding: '8px 10px',
  background: '#1e2533',
  border: '1px solid #334155',
  borderRadius: 6,
  color: '#e2e8f0',
  fontSize: 13,
  outline: 'none',
};
