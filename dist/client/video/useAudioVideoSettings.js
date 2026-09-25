"use strict";
// useAudioVideoSettings — the person's local media settings (SPEC §2.3) and
// the machinery behind the settings drawer: constraints for getUserMedia, a
// camera preview, a live mic level, "Test mic" (record 3 s, play back) and
// "Test sound" (a 1 s tone through the chosen speaker).
//
// Everything here is per browser. With `rememberDevices` the settings are
// written to localStorage under `call-device-preferences` — the key the app's
// DeviceSettingsPanel already uses, extended — otherwise they live for the
// page's lifetime only.
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUDIO_VIDEO_SETTINGS_KEY = void 0;
exports.readAudioVideoSettings = readAudioVideoSettings;
exports.audioVideoConstraints = audioVideoConstraints;
exports.useAudioVideoSettings = useAudioVideoSettings;
const react_1 = require("react");
const documentCallTypes_1 = require("./documentCallTypes");
exports.AUDIO_VIDEO_SETTINGS_KEY = 'call-device-preferences';
function defaultStorage() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    }
    catch {
        return null;
    }
}
/** Parse what is stored, tolerating the older DevicePreferences shape
 *  ({ microphoneId, cameraId, speakerId }) and garbage. */
function readAudioVideoSettings(storage, key = exports.AUDIO_VIDEO_SETTINGS_KEY) {
    if (!storage)
        return { ...documentCallTypes_1.DEFAULT_AUDIO_VIDEO_SETTINGS };
    try {
        const raw = storage.getItem(key);
        const v = raw ? JSON.parse(raw) : null;
        if (!v || typeof v !== 'object')
            return { ...documentCallTypes_1.DEFAULT_AUDIO_VIDEO_SETTINGS };
        const out = { ...documentCallTypes_1.DEFAULT_AUDIO_VIDEO_SETTINGS };
        for (const k of ['microphoneId', 'speakerId', 'cameraId']) {
            if (typeof v[k] === 'string' && v[k])
                out[k] = v[k];
        }
        for (const k of ['noiseSuppression', 'echoCancellation', 'autoGainControl', 'mirrorPreview', 'rememberDevices']) {
            if (typeof v[k] === 'boolean')
                out[k] = v[k];
        }
        if (typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1)
            out.volume = v.volume;
        if (['auto', '720p', '480p', '360p'].includes(v.quality))
            out.quality = v.quality;
        if (v.frameRate === 'auto' || v.frameRate === 30 || v.frameRate === 15)
            out.frameRate = v.frameRate;
        return out;
    }
    catch {
        return { ...documentCallTypes_1.DEFAULT_AUDIO_VIDEO_SETTINGS };
    }
}
const QUALITY = {
    auto: { width: 1280, height: 720 },
    '720p': { width: 1280, height: 720 },
    '480p': { width: 854, height: 480 },
    '360p': { width: 640, height: 360 },
};
/** Pure: constraints for a settings value. `auto` quality asks for 720p as an
 *  ideal (what calls asked for before these settings existed); a fixed quality
 *  caps it. Device ids are `ideal`, so an unplugged device falls back. */
function audioVideoConstraints(s, video) {
    const audio = {
        noiseSuppression: s.noiseSuppression,
        echoCancellation: s.echoCancellation,
        autoGainControl: s.autoGainControl,
        ...(s.microphoneId ? { deviceId: { ideal: s.microphoneId } } : {}),
    };
    if (!video)
        return { audio, video: false };
    const q = QUALITY[s.quality];
    const v = s.quality === 'auto'
        ? { width: { ideal: q.width }, height: { ideal: q.height } }
        : { width: { ideal: q.width, max: q.width }, height: { ideal: q.height, max: q.height } };
    if (s.frameRate !== 'auto')
        v.frameRate = { ideal: s.frameRate, max: s.frameRate };
    if (s.cameraId)
        v.deviceId = { ideal: s.cameraId };
    return { audio, video: v };
}
function audioContextCtor() {
    if (typeof window === 'undefined')
        return null;
    const w = window;
    return w.AudioContext ?? w.webkitAudioContext ?? null;
}
async function playThroughSink(el, sinkId, volume) {
    el.volume = Math.max(0, Math.min(1, volume));
    const withSink = el;
    if (sinkId && typeof withSink.setSinkId === 'function') {
        try {
            await withSink.setSinkId(sinkId);
        }
        catch { /* default output */ }
    }
    await el.play();
}
function useAudioVideoSettings(opts = {}) {
    const storageKey = opts.storageKey ?? exports.AUDIO_VIDEO_SETTINGS_KEY;
    const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    const md = opts.mediaDevices ?? (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    const [settings, setSettings] = (0, react_1.useState)(() => readAudioVideoSettings(storage, storageKey));
    const settingsRef = (0, react_1.useRef)(settings);
    settingsRef.current = settings;
    const update = (0, react_1.useCallback)((patch) => {
        setSettings((prev) => {
            const next = { ...prev, ...patch };
            if (storage) {
                try {
                    if (next.rememberDevices)
                        storage.setItem(storageKey, JSON.stringify(next));
                    // Unchecking "Use these devices next time" forgets what was stored.
                    else if (prev.rememberDevices)
                        storage.removeItem(storageKey);
                }
                catch { /* a per-browser convenience */ }
            }
            return next;
        });
    }, [storage, storageKey]);
    const constraints = (0, react_1.useCallback)((video) => audioVideoConstraints(settingsRef.current, video), []);
    // ---- preview stream -------------------------------------------------
    const [previewStream, setPreviewStream] = (0, react_1.useState)(null);
    const [previewError, setPreviewError] = (0, react_1.useState)(null);
    const wantVideo = opts.previewVideo !== false;
    const acquireKey = (0, react_1.useMemo)(() => JSON.stringify([
        settings.microphoneId, settings.cameraId, settings.quality, settings.frameRate,
        settings.noiseSuppression, settings.echoCancellation, settings.autoGainControl, wantVideo,
    ]), [settings.microphoneId, settings.cameraId, settings.quality, settings.frameRate,
        settings.noiseSuppression, settings.echoCancellation, settings.autoGainControl, wantVideo]);
    (0, react_1.useEffect)(() => {
        if (!opts.preview || !md) {
            setPreviewStream(null);
            return;
        }
        let cancelled = false;
        let acquired = null;
        (async () => {
            try {
                acquired = await md.getUserMedia(audioVideoConstraints(settingsRef.current, wantVideo));
                if (cancelled) {
                    acquired.getTracks().forEach((t) => t.stop());
                    return;
                }
                setPreviewError(null);
                setPreviewStream(acquired);
            }
            catch (err) {
                if (cancelled)
                    return;
                const name = err?.name ?? '';
                setPreviewError(name === 'NotAllowedError' ? 'denied' : name === 'NotFoundError' ? 'unavailable' : err?.message || 'error');
                setPreviewStream(null);
            }
        })();
        return () => {
            cancelled = true;
            acquired?.getTracks().forEach((t) => t.stop());
        };
    }, [opts.preview, md, acquireKey, wantVideo]);
    // ---- mic level ------------------------------------------------------
    const [micLevel, setMicLevel] = (0, react_1.useState)(0);
    (0, react_1.useEffect)(() => {
        const Ctor = audioContextCtor();
        const track = previewStream?.getAudioTracks()[0];
        if (!Ctor || !track) {
            setMicLevel(0);
            return;
        }
        let ctx = null;
        let timer = null;
        try {
            ctx = new Ctor();
            const src = ctx.createMediaStreamSource(new MediaStream([track]));
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            src.connect(analyser);
            const buf = new Uint8Array(analyser.fftSize);
            timer = setInterval(() => {
                analyser.getByteTimeDomainData(buf);
                let sum = 0;
                for (let i = 0; i < buf.length; i++) {
                    const v = (buf[i] - 128) / 128;
                    sum += v * v;
                }
                // RMS scaled so normal speech reads around the middle of a 10-dot meter.
                setMicLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
            }, 100);
        }
        catch {
            setMicLevel(0);
        }
        return () => {
            if (timer)
                clearInterval(timer);
            void ctx?.close().catch(() => undefined);
        };
    }, [previewStream]);
    // ---- test mic / test sound -----------------------------------------
    const [testMicState, setTestMicState] = (0, react_1.useState)('idle');
    const testMic = (0, react_1.useCallback)(async () => {
        if (!md || typeof MediaRecorder === 'undefined' || testMicState !== 'idle')
            return;
        let stream = null;
        try {
            stream = await md.getUserMedia({ audio: audioVideoConstraints(settingsRef.current, false).audio, video: false });
            const rec = new MediaRecorder(stream);
            const chunks = [];
            rec.ondataavailable = (e) => { if (e.data.size)
                chunks.push(e.data); };
            const stopped = new Promise((resolve) => { rec.onstop = () => resolve(); });
            setTestMicState('recording');
            rec.start();
            await new Promise((r) => setTimeout(r, 3000));
            rec.stop();
            await stopped;
            stream.getTracks().forEach((t) => t.stop());
            stream = null;
            setTestMicState('playing');
            const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
            const el = new Audio(url);
            const ended = new Promise((resolve) => { el.onended = () => resolve(); el.onerror = () => resolve(); });
            await playThroughSink(el, settingsRef.current.speakerId, settingsRef.current.volume);
            await ended;
            URL.revokeObjectURL(url);
        }
        catch { /* permission or playback refused — the button just resets */ }
        finally {
            stream?.getTracks().forEach((t) => t.stop());
            setTestMicState('idle');
        }
    }, [md, testMicState]);
    const testSound = (0, react_1.useCallback)(async () => {
        const Ctor = audioContextCtor();
        if (!Ctor)
            return;
        const ctx = new Ctor();
        try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = 440;
            gain.gain.value = 0.2;
            osc.connect(gain);
            const s = settingsRef.current;
            const dest = typeof ctx.createMediaStreamDestination === 'function' ? ctx.createMediaStreamDestination() : null;
            if (dest && typeof Audio !== 'undefined') {
                // Through an element so the chosen speaker (setSinkId) applies.
                gain.connect(dest);
                const el = new Audio();
                el.srcObject = dest.stream;
                await playThroughSink(el, s.speakerId, s.volume);
            }
            else {
                gain.connect(ctx.destination);
            }
            osc.start();
            await new Promise((r) => setTimeout(r, 1000));
            osc.stop();
        }
        catch { /* autoplay refused */ }
        finally {
            void ctx.close().catch(() => undefined);
        }
    }, []);
    return { settings, update, constraints, previewStream, previewError, micLevel, testMic, testSound, testMicState };
}
//# sourceMappingURL=useAudioVideoSettings.js.map