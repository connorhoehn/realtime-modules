"use strict";
// useMediaDevices — microphones, cameras and speakers, plus whether the
// browser lets us use them. Feeds the device selects and toggles of the
// document-call surfaces (SPEC §2.1 row 15, §2.2 rows 4–5, §2.3, §2.7).
//
// Labels are empty until the page has had a media permission, so rows fall
// back to "Microphone 1" style names rather than blank options. Permission
// comes from the Permissions API where the browser has it (Safari's is
// partial), else is inferred: labels present ⇒ granted.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSpeakerSelectionSupported = isSpeakerSelectionSupported;
exports.toDeviceOptions = toDeviceOptions;
exports.useMediaDevices = useMediaDevices;
const react_1 = require("react");
const FALLBACK_LABEL = {
    audioinput: 'Microphone',
    videoinput: 'Camera',
    audiooutput: 'Speaker',
};
function defaultMediaDevices() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices)
        return null;
    return navigator.mediaDevices;
}
function defaultPermissions() {
    if (typeof navigator === 'undefined')
        return null;
    const p = navigator.permissions;
    return p && typeof p.query === 'function' ? p : null;
}
function isSpeakerSelectionSupported() {
    if (typeof HTMLMediaElement === 'undefined')
        return false;
    return typeof HTMLMediaElement.prototype.setSinkId === 'function';
}
/** Turn a MediaDeviceInfo list into labelled options per kind. */
function toDeviceOptions(list) {
    const out = { microphones: [], cameras: [], speakers: [] };
    const counters = { audioinput: 0, videoinput: 0, audiooutput: 0 };
    for (const d of list) {
        if (d.kind !== 'audioinput' && d.kind !== 'videoinput' && d.kind !== 'audiooutput')
            continue;
        // Chrome lists "default" and "communications" aliases of a real device.
        if (d.deviceId === 'communications')
            continue;
        counters[d.kind] += 1;
        const opt = {
            deviceId: d.deviceId,
            kind: d.kind,
            label: d.label || `${FALLBACK_LABEL[d.kind]} ${counters[d.kind]}`,
            ...(d.groupId ? { groupId: d.groupId } : {}),
            ...(d.deviceId === 'default' ? { isDefault: true } : {}),
        };
        if (d.kind === 'audioinput')
            out.microphones.push(opt);
        else if (d.kind === 'videoinput')
            out.cameras.push(opt);
        else
            out.speakers.push(opt);
    }
    return out;
}
function inferPermission(options, raw, kind) {
    if (options.length === 0)
        return 'unavailable';
    return raw.some((d) => d.kind === kind && d.label) ? 'granted' : 'prompt';
}
function useMediaDevices(opts = {}) {
    const md = opts.mediaDevices ?? defaultMediaDevices();
    const perms = opts.permissions === undefined ? defaultPermissions() : opts.permissions;
    const mdRef = (0, react_1.useRef)(md);
    mdRef.current = md;
    const [devices, setDevices] = (0, react_1.useState)({ microphones: [], cameras: [], speakers: [] });
    const [inferred, setInferred] = (0, react_1.useState)({ microphone: md ? 'prompt' : 'unavailable', camera: md ? 'prompt' : 'unavailable' });
    // What the Permissions API or a refused getUserMedia said. Wins over inference.
    const [explicit, setExplicit] = (0, react_1.useState)({});
    const [loading, setLoading] = (0, react_1.useState)(!!md);
    const mounted = (0, react_1.useRef)(true);
    (0, react_1.useEffect)(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const refresh = (0, react_1.useCallback)(async () => {
        const m = mdRef.current;
        if (!m) {
            setLoading(false);
            return;
        }
        try {
            const raw = await m.enumerateDevices();
            if (!mounted.current)
                return;
            const next = toDeviceOptions(raw);
            setDevices(next);
            setInferred({
                microphone: inferPermission(next.microphones, raw, 'audioinput'),
                camera: inferPermission(next.cameras, raw, 'videoinput'),
            });
        }
        catch {
            /* enumeration refused — keep the last list */
        }
        finally {
            if (mounted.current)
                setLoading(false);
        }
    }, []);
    const requestPermission = (0, react_1.useCallback)(async (kinds) => {
        const m = mdRef.current;
        if (!m || kinds.length === 0)
            return;
        const wantAudio = kinds.includes('audio');
        const wantVideo = kinds.includes('video');
        try {
            const stream = await m.getUserMedia({ audio: wantAudio, video: wantVideo });
            stream.getTracks().forEach((t) => t.stop());
            setExplicit((e) => ({
                ...e,
                ...(wantAudio ? { microphone: 'granted' } : {}),
                ...(wantVideo ? { camera: 'granted' } : {}),
            }));
        }
        catch (err) {
            const name = err?.name ?? '';
            const state = name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unavailable' : 'denied';
            if (name === 'NotFoundError' && wantAudio && wantVideo) {
                // One of the two is missing; ask separately so the other still works.
                await Promise.all([
                    (async () => { try {
                        const s = await m.getUserMedia({ audio: true });
                        s.getTracks().forEach((t) => t.stop());
                        setExplicit((e) => ({ ...e, microphone: 'granted' }));
                    }
                    catch (e2) {
                        setExplicit((e) => ({ ...e, microphone: e2?.name === 'NotFoundError' ? 'unavailable' : 'denied' }));
                    } })(),
                    (async () => { try {
                        const s = await m.getUserMedia({ video: true });
                        s.getTracks().forEach((t) => t.stop());
                        setExplicit((e) => ({ ...e, camera: 'granted' }));
                    }
                    catch (e2) {
                        setExplicit((e) => ({ ...e, camera: e2?.name === 'NotFoundError' ? 'unavailable' : 'denied' }));
                    } })(),
                ]);
            }
            else {
                setExplicit((e) => ({
                    ...e,
                    ...(wantAudio ? { microphone: state } : {}),
                    ...(wantVideo ? { camera: state } : {}),
                }));
            }
        }
        await refresh();
    }, [refresh]);
    // Enumerate on mount and whenever a device is plugged in or removed.
    (0, react_1.useEffect)(() => {
        void refresh();
        const m = mdRef.current;
        if (!m || typeof m.addEventListener !== 'function')
            return;
        const onChange = () => { void refresh(); };
        m.addEventListener('devicechange', onChange);
        return () => { m.removeEventListener?.('devicechange', onChange); };
    }, [refresh]);
    // Permissions API, where present.
    (0, react_1.useEffect)(() => {
        if (!perms)
            return;
        const cleanups = [];
        let cancelled = false;
        const watch = async (name) => {
            try {
                const status = await perms.query({ name });
                if (cancelled)
                    return;
                const apply = () => {
                    const s = status.state;
                    const mapped = s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : s === 'prompt' ? 'prompt' : undefined;
                    if (mapped)
                        setExplicit((e) => ({ ...e, [name]: mapped }));
                    if (s === 'granted')
                        void refresh();
                };
                apply();
                if (typeof status.addEventListener === 'function') {
                    status.addEventListener('change', apply);
                    cleanups.push(() => status.removeEventListener?.('change', apply));
                }
            }
            catch { /* Firefox rejects 'camera'/'microphone' names — inference covers it */ }
        };
        void watch('microphone');
        void watch('camera');
        return () => { cancelled = true; cleanups.forEach((c) => c()); };
    }, [perms, refresh]);
    (0, react_1.useEffect)(() => {
        if (opts.requestOnMount)
            void requestPermission(['audio', 'video']);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const resolve = (kind, list) => {
        if (!md)
            return 'unavailable';
        const e = explicit[kind];
        // A granted permission with no devices is still "nothing to use".
        if (e === 'granted' && list.length === 0 && !loading)
            return 'unavailable';
        if (e && e !== 'prompt')
            return e;
        if (e === 'prompt' && inferred[kind] !== 'unavailable')
            return 'prompt';
        return inferred[kind];
    };
    return {
        microphones: devices.microphones,
        cameras: devices.cameras,
        speakers: devices.speakers,
        permission: {
            microphone: resolve('microphone', devices.microphones),
            camera: resolve('camera', devices.cameras),
        },
        speakerSelectionSupported: isSpeakerSelectionSupported(),
        loading,
        refresh,
        requestPermission,
    };
}
//# sourceMappingURL=useMediaDevices.js.map