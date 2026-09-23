import type { PipelineRunTransport } from '../pipelines/usePipelineRunStatus';
export interface DocumentFolder {
    id: string;
    name: string;
    parentFolderId: string | null;
    position: number;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    version: number;
    /** Visible documents in this folder and every folder under it. */
    count: number;
    /** Visible documents directly in this folder. */
    directCount: number;
}
export interface DocumentFolderNode extends DocumentFolder {
    depth: number;
    children: DocumentFolderNode[];
    /** Ids of the visible documents directly in this folder, by position. */
    documentIds: string[];
}
export interface DocumentFolderPlacement {
    documentId: string;
    /** null = Unfiled. */
    folderId: string | null;
    position: number;
    version: number;
    /** True while an optimistic move waits for the server. */
    pending?: boolean;
}
export interface DocumentFolderMove {
    documentId: string;
    folderId: string | null;
    position?: number;
}
export interface DocumentFolderResult {
    ok: boolean;
    requestId: string;
    code?: 'conflict' | 'forbidden' | 'not_found' | 'not_empty' | 'invalid' | 'unauthenticated' | 'unavailable' | 'internal' | 'timeout' | 'disconnected' | string;
    message?: string;
    folder?: Omit<DocumentFolder, 'count' | 'directCount'>;
    folderId?: string;
    placements?: DocumentFolderPlacement[];
    results?: Array<{
        documentId: string;
        ok: boolean;
        code?: string;
        message?: string;
        placement?: DocumentFolderPlacement;
        current?: DocumentFolderPlacement;
    }>;
    replay?: boolean;
}
export interface UseDocumentFoldersOptions {
    /** A host-owned socket. Omit to use the nearest GatewaySocketProvider; `null` disables. */
    transport?: PipelineRunTransport | null;
    /** The host socket's session epoch, for a host-owned transport. */
    sessionEpoch?: number;
    /** `false` mounts nothing. Default true. */
    enabled?: boolean;
    /** The viewer's user id — folders they created stay visible while empty. */
    currentUserId?: string | null;
    /** How long a mutation waits for its answer. Default 10 s. */
    timeoutMs?: number;
}
export interface UseDocumentFoldersResult {
    /** Visible folders, flat, with live counts. */
    folders: DocumentFolder[];
    /** The same folders as a tree (roots first, siblings by position). */
    tree: DocumentFolderNode[];
    /** Every visible document's placement, by document id. */
    placements: Record<string, DocumentFolderPlacement>;
    /** The folder a document is in; null for Unfiled or unknown. */
    folderOf: (documentId: string) => string | null;
    /** The folder and its ancestors, root first — for breadcrumbs. */
    pathOf: (folderId: string | null | undefined) => DocumentFolder[];
    /** Visible documents in no folder, by position. */
    unfiled: string[];
    unfiledCount: number;
    /** Visible documents in total. */
    totalCount: number;
    /** True until the first list for this session arrives. */
    loading: boolean;
    /** The last failed mutation or read, until the next success. */
    error?: DocumentFolderResult;
    createFolder: (input: {
        name: string;
        parentFolderId?: string | null;
        position?: number;
    }) => Promise<DocumentFolderResult>;
    renameFolder: (folderId: string, name: string) => Promise<DocumentFolderResult>;
    moveFolder: (folderId: string, parentFolderId: string | null, position?: number) => Promise<DocumentFolderResult>;
    /** Only an empty folder can be deleted (`not_empty` otherwise). */
    deleteFolder: (folderId: string) => Promise<DocumentFolderResult>;
    moveDocuments: (moves: DocumentFolderMove[]) => Promise<DocumentFolderResult>;
    moveDocument: (documentId: string, folderId: string | null, position?: number) => Promise<DocumentFolderResult>;
    /** Re-read the whole picture (a fresh `list`). */
    refresh: () => void;
}
/** A position strictly between two neighbours (either may be missing), for drag-reorder. */
export declare function positionBetween(before?: number | null, after?: number | null): number;
export type DocumentFolderRecord = Omit<DocumentFolder, 'count' | 'directCount'> & {
    listed?: boolean;
};
type FolderRecord = DocumentFolderRecord;
/** The hook's raw picture: folder records + placements, before derivation. */
export interface DocumentFoldersState {
    folders: Record<string, FolderRecord>;
    placements: Record<string, DocumentFolderPlacement>;
}
type State = DocumentFoldersState;
/** Pure derivation of the visible tree and counts — exported for tests and non-React callers. */
export declare function deriveDocumentFolders(state: State, currentUserId?: string | null): {
    folders: DocumentFolder[];
    tree: DocumentFolderNode[];
    unfiled: string[];
};
export declare function useDocumentFolders(options?: UseDocumentFoldersOptions): UseDocumentFoldersResult;
/** Merge one hub event into the picture; stale versions are ignored. Exported for tests. */
export declare function mergeDocumentFolderEvent(prev: State, event: Record<string, any>): State;
export {};
//# sourceMappingURL=folders.d.ts.map