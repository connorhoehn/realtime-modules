import { useRef, useState } from 'react';
import { useFileUpload } from '@connorhoehn/realtime-modules/client';
import type { FileUploadState } from '@connorhoehn/realtime-modules/client';
import { DemoCard, Field, Btn, StatusBadge } from '../components/ui';

const CHANNEL = 'demo:upload-room';

const STATUS_COLORS: Record<FileUploadState['status'], string> = {
  pending: '#64748b',
  uploading: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
  scanning: '#f59e0b',
  clean: '#22c55e',
  infected: '#dc2626',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FileUploadDemo() {
  const { uploads, upload, cancel, removeCompleted } = useFileUpload(CHANNEL);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFiles(files: FileList | null) {
    if (!files) return;
    for (const file of files) {
      upload(file).catch(() => {
        // Status already reflected in uploads state — swallow the error here.
      });
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  }

  const hasCompleted = uploads.some(
    (u) => u.status === 'completed' || u.status === 'clean' || u.status === 'infected',
  );

  return (
    <DemoCard title="useFileUpload" channel={CHANNEL} hook="useFileUpload(channel)">
      <Field label="Drop zone">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          style={{
            border: `2px dashed ${dragging ? '#3b82f6' : '#334155'}`,
            borderRadius: 8,
            padding: '32px 24px',
            textAlign: 'center',
            cursor: 'pointer',
            background: dragging ? '#1e3a5f' : '#0f1117',
            transition: 'background 0.15s, border-color 0.15s',
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 8 }}>📁</div>
          <p style={{ color: '#94a3b8', fontSize: 14 }}>
            Drag &amp; drop files here, or click to select
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      </Field>

      <Field label={`Upload queue (${uploads.length})`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {uploads.length === 0 && (
            <span style={{ color: '#475569', fontSize: 13 }}>
              No uploads yet. Drop a file above (gateway will issue presigned URL).
            </span>
          )}
          {uploads.map((u) => (
            <div
              key={u.id}
              style={{
                padding: '10px 14px',
                background: '#1e2533',
                borderRadius: 6,
                borderLeft: `3px solid ${STATUS_COLORS[u.status]}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 13, color: '#e2e8f0', flex: 1, wordBreak: 'break-all' }}>
                  {u.filename}
                </span>
                <span style={{ fontSize: 11, color: '#64748b' }}>{formatBytes(u.size)}</span>
                <StatusBadge color={STATUS_COLORS[u.status]}>{u.status}</StatusBadge>
                {(u.status === 'pending' || u.status === 'uploading') && (
                  <button
                    onClick={() => cancel(u.id)}
                    style={{
                      padding: '2px 8px',
                      background: '#334155',
                      border: 'none',
                      borderRadius: 4,
                      color: '#ef4444',
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>

              {/* Progress bar */}
              {(u.status === 'uploading' || u.status === 'pending') && (
                <div style={{ background: '#0f1117', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${u.progress ?? 0}%`,
                      background: '#3b82f6',
                      transition: 'width 0.2s',
                    }}
                  />
                </div>
              )}

              {/* Error message */}
              {u.error && (
                <p style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>{u.error}</p>
              )}

              {/* Download link if available */}
              {u.downloadUrl && (
                <a
                  href={u.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 11, color: '#7dd3fc', marginTop: 4, display: 'block' }}
                >
                  Download
                </a>
              )}
            </div>
          ))}
        </div>
      </Field>

      {hasCompleted && (
        <Btn onClick={removeCompleted} style={{ alignSelf: 'flex-start' }}>
          Clear completed
        </Btn>
      )}
    </DemoCard>
  );
}
