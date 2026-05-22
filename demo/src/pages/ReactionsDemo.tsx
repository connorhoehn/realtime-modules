import { useReactions } from '@connorhoehn/realtime-modules/client';
import { DemoCard, Field, Btn } from '../components/ui';

const CHANNEL = 'demo:reactions-room';

const EMOJI_PALETTE = ['👍', '❤️', '🎉', '😂', '🚀', '👀', '🔥', '💯', '✅', '😮', '🤔', '👏'];

export default function ReactionsDemo() {
  const { reactions, react } = useReactions(CHANNEL);

  // Build an aggregated count map from the recent reactions list
  const counts = reactions.reduce<Record<string, number>>((acc, r) => {
    acc[r.emoji] = (acc[r.emoji] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <DemoCard title="useReactions" channel={CHANNEL} hook="useReactions(channel)">
      <Field label="Emoji palette — click to react">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {EMOJI_PALETTE.map((emoji) => (
            <button
              key={emoji}
              onClick={() => react(emoji)}
              title={`Send ${emoji}`}
              style={{
                fontSize: 24,
                padding: '8px 12px',
                background: counts[emoji] ? '#1e3a5f' : '#1e2533',
                border: `1px solid ${counts[emoji] ? '#3b82f6' : '#334155'}`,
                borderRadius: 8,
                cursor: 'pointer',
                position: 'relative',
                transition: 'background 0.15s',
              }}
            >
              {emoji}
              {counts[emoji] && (
                <span
                  style={{
                    position: 'absolute',
                    top: -6,
                    right: -6,
                    background: '#3b82f6',
                    color: '#fff',
                    fontSize: 10,
                    fontWeight: 700,
                    borderRadius: '50%',
                    minWidth: 16,
                    height: 16,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 3px',
                  }}
                >
                  {counts[emoji]}
                </span>
              )}
            </button>
          ))}
        </div>
      </Field>

      <Field label={`Recent reactions stream (last ${reactions.length} of 50 max)`}>
        <div
          style={{
            minHeight: 100,
            maxHeight: 280,
            overflowY: 'auto',
            background: '#0f1117',
            borderRadius: 6,
            padding: 12,
            display: 'flex',
            flexDirection: 'column-reverse',
            gap: 6,
          }}
        >
          {reactions.length === 0 && (
            <span style={{ color: '#475569', fontSize: 13 }}>
              No reactions yet. Click an emoji above.
            </span>
          )}
          {[...reactions].reverse().map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 10px',
                background: '#1e2533',
                borderRadius: 6,
              }}
            >
              <span style={{ fontSize: 20 }}>{r.emoji}</span>
              <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#7dd3fc' }}>
                {r.clientId.slice(0, 8)}
              </span>
              <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto' }}>
                {new Date(r.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      </Field>

      <Field label="Aggregated counts">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {Object.keys(counts).length === 0 && (
            <span style={{ color: '#475569', fontSize: 13 }}>Empty</span>
          )}
          {Object.entries(counts)
            .sort(([, a], [, b]) => b - a)
            .map(([emoji, count]) => (
              <span
                key={emoji}
                style={{
                  padding: '4px 10px',
                  background: '#1e2533',
                  borderRadius: 20,
                  fontSize: 13,
                }}
              >
                {emoji} <strong style={{ color: '#7dd3fc' }}>{count}</strong>
              </span>
            ))}
        </div>
      </Field>

      <Btn onClick={() => react('🚀')} style={{ alignSelf: 'flex-start' }}>
        Quick-react: 🚀
      </Btn>
    </DemoCard>
  );
}
