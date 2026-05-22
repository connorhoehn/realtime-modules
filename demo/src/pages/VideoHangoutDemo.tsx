import { useState } from 'react';
import { useVideoHangout } from '@connorhoehn/realtime-modules/client';
import type { HangoutParticipant } from '@connorhoehn/realtime-modules/client';
import { DemoCard, Field, Btn, StatusBadge } from '../components/ui';

const CHANNEL = 'demo:hangout-room';

function ParticipantRow({ p }: { p: HangoutParticipant }) {
  return (
    <div
      style={{
        padding: '8px 12px',
        background: '#1e2533',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <span style={{ fontSize: 18 }}>{p.role === 'host' ? '👑' : '👤'}</span>
      <span style={{ fontSize: 13, fontFamily: 'monospace', color: '#7dd3fc', flex: 1 }}>
        {p.displayName ?? p.clientId.slice(0, 10)}
      </span>
      <StatusBadge color={p.role === 'host' ? '#f59e0b' : '#64748b'}>{p.role}</StatusBadge>
      <span title="Video" style={{ fontSize: 16 }}>{p.videoOn ? '🎥' : '📷'}</span>
      <span title="Audio" style={{ fontSize: 16 }}>{p.audioOn ? '🎙️' : '🔇'}</span>
      <span style={{ fontSize: 11, color: '#475569' }}>
        {new Date(p.joinedAt).toLocaleTimeString()}
      </span>
    </div>
  );
}

export default function VideoHangoutDemo() {
  const {
    session,
    participants,
    joinToken,
    start,
    join,
    leave,
    end,
    toggleVideo,
    toggleAudio,
  } = useVideoHangout(CHANNEL);

  const [joinSessionId, setJoinSessionId] = useState('');
  const [starting, setStarting] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      await start({ type: 'hangout' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function handleJoin() {
    if (!joinSessionId.trim()) return;
    setJoining(true);
    setError(null);
    try {
      await join(joinSessionId.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJoining(false);
    }
  }

  return (
    <DemoCard title="useVideoHangout" channel={CHANNEL} hook="useVideoHangout(channel)">
      {error && (
        <div
          style={{
            padding: '10px 14px',
            background: '#1c1111',
            border: '1px solid #ef4444',
            borderRadius: 6,
            color: '#ef4444',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {!session ? (
        <>
          <Field label="Start a new hangout">
            <Btn onClick={handleStart} disabled={starting}>
              {starting ? 'Starting…' : 'Start hangout'}
            </Btn>
          </Field>

          <Field label="Join an existing session">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={joinSessionId}
                onChange={(e) => setJoinSessionId(e.target.value)}
                placeholder="Session ID"
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  background: '#1e2533',
                  border: '1px solid #334155',
                  borderRadius: 6,
                  color: '#e2e8f0',
                  fontSize: 13,
                  outline: 'none',
                }}
              />
              <Btn onClick={handleJoin} disabled={joining || !joinSessionId.trim()}>
                {joining ? 'Joining…' : 'Join'}
              </Btn>
            </div>
          </Field>
        </>
      ) : (
        <>
          <Field label="Session">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <StatusBadge color="#22c55e">active</StatusBadge>
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#7dd3fc' }}>
                  {session.id}
                </span>
                <span style={{ fontSize: 12, color: '#64748b' }}>{session.type}</span>
              </div>
              <span style={{ fontSize: 11, color: '#475569' }}>
                Created {new Date(session.createdAt).toLocaleTimeString()}
              </span>
            </div>
          </Field>

          <Field label="Join token (pass to &lt;Stage&gt;)">
            <div
              style={{
                padding: '8px 12px',
                background: '#0f1117',
                borderRadius: 6,
                fontFamily: 'monospace',
                fontSize: 12,
                color: '#86efac',
                wordBreak: 'break-all',
              }}
            >
              {joinToken ?? <span style={{ color: '#475569' }}>— waiting for gateway —</span>}
            </div>
          </Field>

          <Field label="Media controls">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn onClick={toggleVideo}>Toggle video 🎥</Btn>
              <Btn onClick={toggleAudio}>Toggle audio 🎙️</Btn>
            </div>
          </Field>

          <Field label="Session actions">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn onClick={() => { void leave(); }}>Leave</Btn>
              <Btn
                onClick={() => { void end(); }}
                style={{ background: '#7f1d1d', borderColor: '#ef4444' }}
              >
                End hangout
              </Btn>
            </div>
          </Field>
        </>
      )}

      <Field label={`Participants (${participants.length})`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 80 }}>
          {participants.length === 0 && (
            <span style={{ color: '#475569', fontSize: 13 }}>
              {session
                ? 'No participants yet — others will appear as they join.'
                : 'Start or join a hangout to see participants.'}
            </span>
          )}
          {participants.map((p) => (
            <ParticipantRow key={p.clientId} p={p} />
          ))}
        </div>
      </Field>
    </DemoCard>
  );
}
