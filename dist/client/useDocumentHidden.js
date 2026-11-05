"use strict";
// realtime-modules/src/client/useDocumentHidden.ts
//
// Whether the page is in the background, kept current (0.145.0: shared by
// usePipelineRunStatus and useLiveRefresh, which both pause polling on it).
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDocumentHidden = isDocumentHidden;
exports.useDocumentHidden = useDocumentHidden;
const react_1 = require("react");
/** True while the document is hidden (`document.hidden`). Always false outside a browser. */
function isDocumentHidden() {
    return typeof document !== 'undefined' && document.hidden === true;
}
/** Whether the document is hidden, re-rendering on `visibilitychange`. Always false outside a browser. */
function useDocumentHidden() {
    const [hidden, setHidden] = (0, react_1.useState)(isDocumentHidden);
    (0, react_1.useEffect)(() => {
        if (typeof document === 'undefined')
            return undefined;
        const update = () => setHidden(isDocumentHidden());
        update();
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    return hidden;
}
//# sourceMappingURL=useDocumentHidden.js.map