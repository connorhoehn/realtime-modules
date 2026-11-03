"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CALL_MEDIA_EFFECTS_KEY = void 0;
exports.useCallMediaEffects = useCallMediaEffects;
const react_1 = require("react");
const useMediaEffects_1 = require("../media-effects/useMediaEffects");
const listeners = new Set();
exports.CALL_MEDIA_EFFECTS_KEY = 'call-media-effects.v1';
function useCallMediaEffects() {
    const effects = (0, useMediaEffects_1.useMediaEffects)({ persistKey: exports.CALL_MEDIA_EFFECTS_KEY });
    const current = (0, react_1.useRef)(effects);
    current.current = effects;
    const receive = (0, react_1.useCallback)((change) => {
        const e = current.current;
        if (change.kind === 'filter')
            e.setFilter(change.value);
        else if (change.kind === 'background')
            e.setBackgroundMode(change.value);
        else if (change.kind === 'image')
            e.setBackgroundImageUrl(change.value);
        else
            e.setFaceSpriteId(change.value);
    }, []);
    (0, react_1.useEffect)(() => { listeners.add(receive); return () => { listeners.delete(receive); }; }, [receive]);
    const change = (0, react_1.useCallback)((next) => {
        receive(next);
        for (const listener of listeners)
            if (listener !== receive)
                listener(next);
    }, [receive]);
    const controls = (0, react_1.useMemo)(() => ({
        setFilter: (value) => change({ kind: 'filter', value }),
        setBackgroundMode: (value) => change({ kind: 'background', value }),
        setBackgroundImageUrl: (value) => change({ kind: 'image', value }),
        setFaceSpriteId: (value) => change({ kind: 'face', value }),
    }), [change]);
    return { ...effects, ...controls };
}
//# sourceMappingURL=useCallMediaEffects.js.map