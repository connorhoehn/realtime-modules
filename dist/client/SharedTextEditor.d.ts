export interface SharedTextEditorProps {
    content: string;
    applyLocalEdit: (newText: string) => void;
    disabled?: boolean;
    hasConflict?: boolean;
    onDismissConflict?: () => void;
}
export declare function SharedTextEditor({ content, applyLocalEdit, disabled, hasConflict, onDismissConflict }: SharedTextEditorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=SharedTextEditor.d.ts.map