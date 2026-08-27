"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAttachmentSrc = useAttachmentSrc;
const react_1 = require("react");
function useAttachmentSrc(options = {}) {
    const { maxCached = 40 } = options;
    const optionsRef = (0, react_1.useRef)(options);
    (0, react_1.useEffect)(() => {
        optionsRef.current = options;
    });
    const [, force] = (0, react_1.useState)(0);
    const cache = (0, react_1.useRef)(new Map());
    const inFlight = (0, react_1.useRef)(new Set());
    (0, react_1.useEffect)(() => {
        const held = cache.current;
        return () => {
            for (const url of held.values())
                URL.revokeObjectURL(url);
            held.clear();
        };
    }, []);
    const srcFor = (0, react_1.useCallback)((attachment) => {
        const cached = cache.current.get(attachment.id);
        if (cached)
            return cached;
        if (inFlight.current.has(attachment.id))
            return undefined;
        // Only images are worth materialising: a document is opened on demand,
        // and pre-fetching every PDF in a thread would waste the user's
        // bandwidth on files they may never open.
        if (attachment.contentType && !attachment.contentType.startsWith('image/'))
            return undefined;
        inFlight.current.add(attachment.id);
        const token = optionsRef.current.getToken?.();
        void fetch(attachment.url, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
            .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`))))
            .then((blob) => {
            const objectUrl = URL.createObjectURL(blob);
            cache.current.set(attachment.id, objectUrl);
            while (cache.current.size > maxCached) {
                const oldest = cache.current.keys().next().value;
                if (oldest === undefined)
                    break;
                const stale = cache.current.get(oldest);
                if (stale)
                    URL.revokeObjectURL(stale);
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
    }, [maxCached]);
    return { srcFor };
}
//# sourceMappingURL=useAttachmentSrc.js.map