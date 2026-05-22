import { useState, useRef, useEffect } from 'react';
import { useChat } from '@connorhoehn/realtime-modules/client';
import { DemoCard, StatusBadge, Field, Btn } from '../components/ui';

const CHANNEL = 'demo:chat-room';

export default function ChatDemo() {
  const { messages, sendMessage, loadHistory } = useChat(CHANNEL);
  const [text, setText] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendMessage(trimmed);
    setText('');
  }

  return (
    <DemoCard title="useChat" channel={CHANNEL} hook="useChat(channel)">
      <Field label="History">
        <Btn onClick={() => loadHistory(20)}>Load last 20 messages</Btn>
      </Field>

      <Field label={`Messages (${messages.length})`}>
        <div
          style={{
            minHeight: 200,
            maxHeight: 360,
            overflowY: 'auto',
            background: '#0f1117',
            borderRadius: 6,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {messages.length === 0 && (
            <span style={{ color: '#475569', fontSize: 13 }}>
              No messages yet. Send one below or load history.
            </span>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                padding: '8px 12px',
                background: '#1e2533',
                borderRadius: 6,
                fontSize: 14,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2 }}>
                <StatusBadge color="#7dd3fc">{m.clientId.slice(0, 8)}</StatusBadge>
                <span style={{ color: '#475569', fontSize: 11 }}>
                  {new Date(m.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div style={{ color: '#e2e8f0' }}>{m.message}</div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </Field>

      <Field label="Compose">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type a message… (Enter to send)"
            style={{
              flex: 1,
              padding: '8px 12px',
              background: '#1e2533',
              border: '1px solid #334155',
              borderRadius: 6,
              color: '#e2e8f0',
              fontSize: 14,
              outline: 'none',
            }}
          />
          <Btn onClick={handleSend}>Send</Btn>
        </div>
      </Field>
    </DemoCard>
  );
}
