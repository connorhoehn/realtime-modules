import { useActivity } from '@connorhoehn/realtime-modules/client';
import { DemoCard, Field, Btn } from '../components/ui';

const CHANNEL = 'demo:activity-room';

const EVENT_TYPE_COLORS: Record<string, string> = {
  'user.joined': '#22c55e',
  'user.left': '#ef4444',
  'file.uploaded': '#7dd3fc',
  'message.sent': '#a78bfa',
  'pipeline.run.completed': '#f59e0b',
};

function eventColor(type: string): string {
  return EVENT_TYPE_COLORS[type] ?? '#64748b';
}

export default function ActivityDemo() {
  const { events, loadHistory } = useActivity(CHANNEL);

  return (
    <DemoCard title="useActivity" channel={CHANNEL} hook="useActivity(channel)">
      <Field label="History">
        <Btn onClick={() => loadHistory(30)}>Load last 30 events</Btn>
      </Field>

      <Field label={`Activity feed (${events.length} events)`}>
        <div
          style={{
            minHeight: 200,
            maxHeight: 400,
            overflowY: 'auto',
            background: '#0f1117',
            borderRadius: 6,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {events.length === 0 && (
            <span style={{ color: '#475569', fontSize: 13 }}>
              No activity events yet. Gateway will push events as they occur, or load history above.
            </span>
          )}
          {[...events].reverse().map((ev, i) => (
            <div
              // eslint-disable-next-line react/no-array-index-key
              key={`${ev.timestamp}-${i}`}
              style={{
                padding: '8px 12px',
                background: '#1e2533',
                borderRadius: 6,
                borderLeft: `3px solid ${eventColor(ev.eventType)}`,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: eventColor(ev.eventType),
                    fontFamily: 'monospace',
                    letterSpacing: '0.03em',
                  }}
                >
                  {ev.eventType}
                </span>
                {ev.displayName && (
                  <span style={{ fontSize: 12, color: '#7dd3fc' }}>{ev.displayName}</span>
                )}
                <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto' }}>
                  {new Date(ev.timestamp).toLocaleTimeString()}
                </span>
              </div>
              {Object.keys(ev.detail).length > 0 && (
                <pre
                  style={{
                    fontSize: 11,
                    color: '#64748b',
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {JSON.stringify(ev.detail, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      </Field>
    </DemoCard>
  );
}
