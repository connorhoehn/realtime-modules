import { useState } from 'react';
import { GatewaySocketProvider } from '@connorhoehn/realtime-modules/client';
import ChatDemo from './pages/ChatDemo';
import PresenceDemo from './pages/PresenceDemo';
import ReactionsDemo from './pages/ReactionsDemo';
import ActivityDemo from './pages/ActivityDemo';
import FileUploadDemo from './pages/FileUploadDemo';
import VideoHangoutDemo from './pages/VideoHangoutDemo';

// ---------------------------------------------------------------------------
// Env config
// ---------------------------------------------------------------------------

// Zero-config default: same-origin /realtime, proxied by vite to the demo
// server (`npm run dev` starts both). VITE_GATEWAY_URL still overrides for
// pointing at a real gateway deployment.
const DEMO_USER = `demo-${Math.random().toString(36).slice(2, 6)}`;
const DEFAULT_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/realtime?user=${DEMO_USER}`;
const GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? DEFAULT_URL;
const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN as string | undefined;
const VERSION = '0.7.3';

// ---------------------------------------------------------------------------
// Styles (inline for zero-dependency showcase)
// ---------------------------------------------------------------------------

const css = {
  root: {
    minHeight: '100vh',
    background: '#0f1117',
    color: '#e2e8f0',
    fontFamily: 'system-ui, sans-serif',
  } as React.CSSProperties,
  header: {
    padding: '16px 24px',
    borderBottom: '1px solid #1e2533',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  } as React.CSSProperties,
  title: { fontSize: 20, fontWeight: 700, color: '#7dd3fc' } as React.CSSProperties,
  version: { fontSize: 12, color: '#64748b', background: '#1e2533', padding: '2px 8px', borderRadius: 4 } as React.CSSProperties,
  tabBar: {
    display: 'flex',
    gap: 4,
    padding: '12px 24px',
    borderBottom: '1px solid #1e2533',
    flexWrap: 'wrap' as const,
  } as React.CSSProperties,
  tab: (active: boolean): React.CSSProperties => ({
    padding: '6px 16px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
    background: active ? '#3b82f6' : '#1e2533',
    color: active ? '#fff' : '#94a3b8',
    transition: 'background 0.15s',
  }),
  content: { padding: 24 } as React.CSSProperties,
  banner: {
    margin: 24,
    padding: 20,
    background: '#1e2533',
    borderRadius: 8,
    border: '1px solid #334155',
  } as React.CSSProperties,
  bannerTitle: { fontSize: 16, fontWeight: 700, color: '#f59e0b', marginBottom: 8 } as React.CSSProperties,
  code: {
    display: 'block',
    margin: '8px 0',
    padding: '8px 12px',
    background: '#0f1117',
    borderRadius: 4,
    fontSize: 13,
    fontFamily: 'monospace',
    color: '#86efac',
  } as React.CSSProperties,
};

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

type Page = 'chat' | 'presence' | 'reactions' | 'activity' | 'fileupload' | 'videohangout';

const TABS: { id: Page; label: string }[] = [
  { id: 'chat', label: 'useChat' },
  { id: 'presence', label: 'usePresence' },
  { id: 'reactions', label: 'useReactions' },
  { id: 'activity', label: 'useActivity' },
  { id: 'fileupload', label: 'useFileUpload' },
  { id: 'videohangout', label: 'useVideoHangout' },
];

function ConfigBanner() {
  return (
    <div style={css.banner}>
      <div style={css.bannerTitle}>Gateway URL not configured</div>
      <p style={{ fontSize: 14, color: '#94a3b8', marginBottom: 12 }}>
        Set the following environment variables and restart the dev server:
      </p>
      <code style={css.code}>VITE_GATEWAY_URL=ws://localhost:4000</code>
      <code style={css.code}>VITE_AUTH_TOKEN=your-auth-token</code>
      <p style={{ fontSize: 13, color: '#64748b', marginTop: 8 }}>
        Create a <code style={{ fontFamily: 'monospace', color: '#86efac' }}>demo/.env.local</code> file with those values.
        Hooks degrade gracefully when the WS is disconnected — the UI shows a disconnected badge.
      </p>
    </div>
  );
}

function PageContent({ page }: { page: Page }) {
  switch (page) {
    case 'chat': return <ChatDemo />;
    case 'presence': return <PresenceDemo />;
    case 'reactions': return <ReactionsDemo />;
    case 'activity': return <ActivityDemo />;
    case 'fileupload': return <FileUploadDemo />;
    case 'videohangout': return <VideoHangoutDemo />;
  }
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export default function App() {
  const [page, setPage] = useState<Page>('chat');

  const missingConfig = !GATEWAY_URL;

  return (
    <div style={css.root}>
      <header style={css.header}>
        <span style={css.title}>realtime-modules showcase</span>
        <span style={css.version}>v{VERSION}</span>
        {!missingConfig && (
          <span style={{ fontSize: 12, color: '#64748b', marginLeft: 'auto' }}>
            {GATEWAY_URL}
          </span>
        )}
      </header>

      {missingConfig ? (
        <ConfigBanner />
      ) : (
        <GatewaySocketProvider
          url={GATEWAY_URL}
          token={AUTH_TOKEN}
          features={['chat', 'presence', 'reactions', 'activity', 'agent-streaming']}
        >
          <nav style={css.tabBar}>
            {TABS.map((t) => (
              <button
                key={t.id}
                style={css.tab(page === t.id)}
                onClick={() => setPage(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <main style={css.content}>
            <PageContent page={page} />
          </main>
        </GatewaySocketProvider>
      )}
    </div>
  );
}
