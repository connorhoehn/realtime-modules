/**
 * The explorer's tree lives on the document record — `parentId` + `position`
 * — and survives every other metadata write. Before these fields a document
 * could only be GROUPED (by type), and a group is not a place a drag can land.
 */
import DocumentMetadataService from '../../src/server/DocumentMetadataService';
import type { DocumentMeta, MetadataStore } from '../../src/server/stores/MetadataStore';

class MemoryStore implements MetadataStore {
    rows = new Map<string, DocumentMeta>();
    async putDocument(meta: DocumentMeta) { this.rows.set(meta.documentId, { ...meta }); }
    async getDocument(id: string) { return this.rows.get(id) ?? null; }
    async listDocuments() { return [...this.rows.values()]; }
    async deleteDocument(id: string) { this.rows.delete(id); }
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} } as any;

function service(store: MetadataStore) {
    return new DocumentMetadataService({ metadataStore: store, logger: quiet } as any);
}

describe('a document can be moved in the tree', () => {
    it('stores a parent and a position, and answers them on the wire', async () => {
        const store = new MemoryStore();
        await store.putDocument({ documentId: 'a', title: 'A', createdAt: 1, updatedAt: 1 });
        await store.putDocument({ documentId: 'b', title: 'B', createdAt: 1, updatedAt: 1 });
        const svc = service(store);

        const wire = await svc.handleUpdateDocumentMeta('b', { parentId: 'a', position: 2 });
        expect(wire).toMatchObject({ id: 'b', parentId: 'a', position: 2 });
        expect(store.rows.get('b')).toMatchObject({ parentId: 'a', position: 2 });
    });

    it('keeps the position across an unrelated rename — the row is an upsert', async () => {
        const store = new MemoryStore();
        await store.putDocument({ documentId: 'a', title: 'A', createdAt: 1, updatedAt: 1, parentId: 'root-doc', position: 5 });
        const svc = service(store);
        await svc.handleUpdateDocumentMeta('a', { title: 'A renamed' });
        expect(store.rows.get('a')).toMatchObject({ title: 'A renamed', parentId: 'root-doc', position: 5 });
    });

    it('moves back to the root with null, which is a value and not an absence', async () => {
        const store = new MemoryStore();
        await store.putDocument({ documentId: 'a', title: 'A', createdAt: 1, updatedAt: 1, parentId: 'p', position: 1 });
        const wire = await service(store).handleUpdateDocumentMeta('a', { parentId: null });
        expect(wire?.parentId).toBeNull();
        expect(store.rows.get('a')?.parentId).toBeNull();
    });

    it('refuses a document as its own parent, and a position that would sort as NaN', async () => {
        const store = new MemoryStore();
        await store.putDocument({ documentId: 'a', title: 'A', createdAt: 1, updatedAt: 1 });
        const svc = service(store);
        await expect(svc.handleUpdateDocumentMeta('a', { parentId: 'a' })).rejects.toThrow(/parentId/);
        await expect(svc.handleUpdateDocumentMeta('a', { position: Number.NaN })).rejects.toThrow(/position/);
        await expect(svc.handleUpdateDocumentMeta('a', { parentId: 42 })).rejects.toThrow(/parentId/);
    });
});
