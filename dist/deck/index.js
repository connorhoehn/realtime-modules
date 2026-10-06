"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
// Deck engine: the DeckSpec contract and strict validator, authoring constraints,
// themes, SVG slide preview and .pptx rendering. Server-side; `renderPptx` needs
// the optional peer `pptxgenjs` (everything else is dependency-free).
__exportStar(require("./DeckSpec"), exports);
__exportStar(require("./deckConstraints"), exports);
__exportStar(require("./theme"), exports);
__exportStar(require("./preview"), exports);
__exportStar(require("./renderPptx"), exports);
__exportStar(require("./renderSlideSvg"), exports);
//# sourceMappingURL=index.js.map