// Deck engine: the DeckSpec contract and strict validator, authoring constraints,
// themes, SVG slide preview and .pptx rendering. Server-side; `renderPptx` needs
// the optional peer `pptxgenjs` (everything else is dependency-free).
export * from './DeckSpec';
export * from './deckConstraints';
export * from './theme';
export * from './preview';
export * from './renderPptx';
export * from './renderSlideSvg';
