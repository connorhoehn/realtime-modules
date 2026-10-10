"use strict";
// useDevicePreferences — the microphone, camera and speaker this person wants
// calls to use. Per browser, because that is where the devices are: a
// preference for "the headset" means nothing on the laptop without it.
//
// Stored under `call-device-preferences`, the key realtime-examples'
// DeviceSettingsPanel and useAudioVideoSettings already use, so the three
// agree on one record.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEVICE_PREFERENCES_KEY = void 0;
exports.readDevicePreferences = readDevicePreferences;
exports.useDevicePreferences = useDevicePreferences;
exports.deviceConstraints = deviceConstraints;
const react_1 = require("react");
exports.DEVICE_PREFERENCES_KEY = 'call-device-preferences';
function defaultStorage() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    }
    catch {
        return null;
    }
}
/** The stored preference, for code that runs outside React (session options). */
function readDevicePreferences(storage = defaultStorage()) {
    try {
        const raw = storage?.getItem(exports.DEVICE_PREFERENCES_KEY);
        const v = raw ? JSON.parse(raw) : {};
        if (!v || typeof v !== 'object')
            return {};
        const o = v;
        const out = {};
        if (typeof o.microphoneId === 'string' && o.microphoneId)
            out.microphoneId = o.microphoneId;
        if (typeof o.cameraId === 'string' && o.cameraId)
            out.cameraId = o.cameraId;
        if (typeof o.speakerId === 'string' && o.speakerId)
            out.speakerId = o.speakerId;
        return out;
    }
    catch {
        return {};
    }
}
/**
 * `[prefs, set]`. `storage` defaults to localStorage; pass `null` to keep the
 * preference in memory only. Writing merges into the stored record, so other
 * fields under the same key (useAudioVideoSettings' noise suppression, …)
 * survive.
 */
function useDevicePreferences(storage, initial) {
    const store = storage === undefined ? defaultStorage() : storage;
    const [prefs, setPrefs] = (0, react_1.useState)(() => ({ ...readDevicePreferences(store), ...(initial ?? {}) }));
    const set = (0, react_1.useCallback)((next) => {
        setPrefs(next);
        if (!store)
            return;
        try {
            const raw = store.getItem(exports.DEVICE_PREFERENCES_KEY);
            const prev = raw ? JSON.parse(raw) : {};
            const merged = { ...(prev && typeof prev === 'object' ? prev : {}) };
            for (const k of ['microphoneId', 'cameraId', 'speakerId']) {
                if (next[k])
                    merged[k] = next[k];
                else
                    delete merged[k];
            }
            store.setItem(exports.DEVICE_PREFERENCES_KEY, JSON.stringify(merged));
        }
        catch { /* per-viewer convenience */ }
    }, [store]);
    return [prefs, set];
}
/** getUserMedia constraints honouring the preference, falling back to any device. */
function deviceConstraints(p, opts) {
    return {
        audio: opts.audio === false ? false : p.microphoneId ? { deviceId: { ideal: p.microphoneId } } : true,
        // Same floor as useLVSHangout's default: a clean tile under any decoder budget.
        video: opts.video
            ? {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 24, max: 30 },
                ...(p.cameraId ? { deviceId: { ideal: p.cameraId } } : {}),
            }
            : false,
    };
}
//# sourceMappingURL=useDevicePreferences.js.map