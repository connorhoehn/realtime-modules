// realtime-modules/src/client/useAttachmentSrc.ts
//
// useAttachmentSrc — resolve bearer-authenticated attachment URLs into
// something an <img> can actually render.
//
// WHY THIS IS NEEDED AT ALL
// -------------------------
// The gateway's download route requires `Authorization: Bearer <token>`, and
// a browser will not attach a header to an `<img src>`. So the obvious thing
// — point the image at the download URL — returns 401 for every attachment.
//
// The two ways out are a signed query-string token or an authenticated fetch
// into an object URL. This takes the second. A token in the URL is a
// credential that lands in browser history, in the Referer header of anything
// the page loads next, and in any log that records query strings; it also has
// to be given a lifetime, which means a link that silently rots. Fetching with
// the header keeps the credential in the one place it belongs and costs a
// single extra round trip that the browser cache absorbs.
//
// LIFECYCLE
// ---------
// Object URLs are a genuine leak if you forget them: each one pins its blob in
// memory until revoked or the document unloads, and a long-lived chat view
// scrolling through image history would accumulate every one it ever saw. The
// hook revokes on unmount and on eviction, and caps how many it holds.
//
// WHERE THE TOKEN MAY GO (0.146.0)
// --------------------------------
// The attachment URL is written by whoever sent the message. Before 0.146.0
// the hook attached the viewer's bearer token to ANY image URL, so a sender
// who pointed an attachment at their own server collected the token of every
// person who scrolled past it. The header now goes only to the gateway's
// download route: a bare `/api/uploads/<id>` path, or a URL on this page's
// origin (or an origin listed in `trustedOrigins`) whose path ends in
// `/api/uploads/<id>`. Any other URL is still fetched, without the header.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAttachmentSrcOptions {
  /** Returns a fresh bearer token per fetch. */
  getToken?: () => string | null | undefined;
  /**
   * Maximum number of decoded attachments held at once. Older entries are
   * revoked when the cap is exceeded — a scrollback of hundreds of images
   * would otherwise pin every blob it ever rendered.
   */
  maxCached?: number;
  /**
   * Origins besides the page's own that may receive the bearer token, for a
   * gateway whose HTTP origin differs from the app's (`FILEUPLOAD_PUBLIC_BASE`).
   * Exact origins (`https://gateway.example.com`). Even on these the token is
   * sent only to a path ending in `/api/uploads/<id>`.
   */
  trustedOrigins?: readonly string[];
}

const UPLOAD_PATH = /(^|\/)api\/uploads\/[^/?#]+$/;

/**
 * Whether `url` is the gateway's download route on an origin allowed to see
 * the viewer's token: a bare `/api/uploads/<id>` path, or the same path on the
 * page's origin or one of `trustedOrigins`. Protocol-relative (`//host/…`)
 * and every other form are not.
 */
export function mayCarryAttachmentToken(url: string, trustedOrigins: readonly string[] = []): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\')) {
    const path = url.split(/[?#]/)[0];
    return path.startsWith('/api/uploads/') && UPLOAD_PATH.test(path);
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const pageOrigin = typeof window !== 'undefined' && window.location ? window.location.origin : null;
  const allowed = parsed.origin === pageOrigin || trustedOrigins.includes(parsed.origin);
  return allowed && parsed.username === '' && parsed.password === '' && UPLOAD_PATH.test(parsed.pathname);
}

export interface UseAttachmentSrcResult {
  /**
   * Renderable src for an attachment, or undefined while it is still being
   * fetched (callers fall back to the inline preview so the reader sees the
   * blurred placeholder rather than an empty box).
   */
  srcFor: (attachment: { id: string; url: string; contentType?: string }) => string | undefined;
}

export function useAttachmentSrc(options: UseAttachmentSrcOptions = {}): UseAttachmentSrcResult {
  const { maxCached = 40 } = options;
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const [, force] = useState(0);
  const cache = useRef<Map<string, string>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    const held = cache.current;
    return () => {
      for (const url of held.values()) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);

  const srcFor = useCallback(
    (attachment: { id: string; url: string; contentType?: string }): string | undefined => {
      const cached = cache.current.get(attachment.id);
      if (cached) return cached;
      if (inFlight.current.has(attachment.id)) return undefined;
      // Only images are worth materialising: a document is opened on demand,
      // and pre-fetching every PDF in a thread would waste the user's
      // bandwidth on files they may never open.
      if (attachment.contentType && !attachment.contentType.startsWith('image/')) return undefined;

      inFlight.current.add(attachment.id);
      const trusted = mayCarryAttachmentToken(attachment.url, optionsRef.current.trustedOrigins);
      const token = trusted ? optionsRef.current.getToken?.() : undefined;
      void fetch(attachment.url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        // An untrusted URL gets no cookies either.
        ...(trusted ? {} : { credentials: 'omit' as RequestCredentials }),
      })
        .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((blob) => {
          const objectUrl = URL.createObjectURL(blob);
          cache.current.set(attachment.id, objectUrl);
          while (cache.current.size > maxCached) {
            const oldest = cache.current.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            const stale = cache.current.get(oldest);
            if (stale) URL.revokeObjectURL(stale);
            cache.current.delete(oldest);
          }
          force((n) => n + 1);
        })
        .catch(() => {
          // A failed fetch leaves the caller on the inline preview, which is
          // a better outcome than a broken-image glyph.
        })
        .finally(() => {
          inFlight.current.delete(attachment.id);
        });

      return undefined;
    },
    [maxCached],
  );

  return { srcFor };
}
