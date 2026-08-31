"use strict";
// realtime-modules/src/adapters/tiptap/canvas/HeadingAnchor.ts
//
// Gives headings a stable `anchorId`.
//
// This is the single reason existing deep links survive the canvas migration.
// A legacy section had an id, and every comment, review, mention and shared URL
// in the product points at it. On a canvas the section becomes an ordinary
// `##` heading — so the id has to ride along on the heading, and it has to
// survive the markdown round trip, which it does as the pandoc / kramdown /
// Docusaurus `{#id}` trailing anchor the chassis serializer already writes.
//
// Implemented as a global attribute on `heading` rather than a forked Heading
// extension, so StarterKit's heading keeps all of its own behaviour (input
// rules, keyboard shortcuts, level attribute) untouched.
Object.defineProperty(exports, "__esModule", { value: true });
exports.HeadingAnchor = void 0;
const core_1 = require("@tiptap/core");
exports.HeadingAnchor = core_1.Extension.create({
    name: 'headingAnchor',
    addGlobalAttributes() {
        return [
            {
                types: ['heading'],
                attributes: {
                    anchorId: {
                        default: null,
                        parseHTML: (element) => element.getAttribute('id'),
                        renderHTML: (attributes) => attributes.anchorId ? { id: attributes.anchorId } : {},
                    },
                },
            },
        ];
    },
});
//# sourceMappingURL=HeadingAnchor.js.map