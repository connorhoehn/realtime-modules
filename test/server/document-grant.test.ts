import { generateKeyPairSync } from 'node:crypto';
import { createDocumentGrant, verifyDocumentGrant, documentGrantAllows, createDocumentSessionEpochResolver } from '../../src/server/documentGrant';
const keys = generateKeyPairSync('ed25519');
const claims = { iss: 'assessment', sub: 'alice', tenantId: 'acme', documentId: '11111111-1111-4111-8111-111111111111', operations: ['read'] as ['read'], sessionId: 'session', sessionEpoch: 3 };
const now = () => 1_000_000;
const token = () => createDocumentGrant(claims, { privateKey: keys.privateKey, keyId: 'one', now });
const options = { issuer: 'assessment', now, resolvePublicKey: (kid: string) => { if (kid !== 'one') throw Error(); return keys.publicKey; }, getSessionEpoch: async () => 3 };
it('binds verified identity, document, tenant and exact operation', async () => {
  const grant = await verifyDocumentGrant(token(), options);
  expect(documentGrantAllows(grant, { tenantId: 'acme', documentId: claims.documentId, operation: 'read' })).toBe(true);
  expect(documentGrantAllows(grant, { tenantId: 'other', documentId: claims.documentId, operation: 'read' })).toBe(false);
  expect(documentGrantAllows(grant, { tenantId: 'acme', documentId: 'other', operation: 'read' })).toBe(false);
  expect(documentGrantAllows(grant, { tenantId: 'acme', documentId: claims.documentId, operation: 'edit' })).toBe(false);
});
it.each([null, 4])('rejects revoked session epoch %s', async epoch => {
  await expect(verifyDocumentGrant(token(), { ...options, getSessionEpoch: async () => epoch })).rejects.toThrow('revoked');
});
it('rejects expired, wrong-audience, unavailable policy and forged grants', async () => {
  await expect(verifyDocumentGrant(token(), { ...options, now: () => 1_120_000 })).rejects.toThrow();
  await expect(verifyDocumentGrant(token(), { ...options, audience: 'other' })).rejects.toThrow();
  await expect(verifyDocumentGrant(token(), { ...options, getSessionEpoch: async () => { throw Error('offline'); } })).rejects.toThrow();
  const parts = token().split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...claims, operations: ['manage'] })).toString('base64url');
  await expect(verifyDocumentGrant(parts.join('.'), options)).rejects.toThrow();
});
it('epoch transport carries service authentication only to configured endpoint', async () => {
  const request = jest.fn(async () => ({ ok: true, json: async () => ({ epoch: 3 }) })) as any;
  const resolve = createDocumentSessionEpochResolver({ url: 'http://localhost/internal/document-grants/session', secret: 'service-key', fetch: request });
  expect(await resolve(claims)).toBe(3);
  expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { 'x-document-policy-key': 'service-key' } });
  request.mockResolvedValueOnce({ ok: true, json: async () => ({ epoch: '3' }) });
  await expect(resolve(claims)).rejects.toThrow();
});
it('only a seed-only signed grant can assign an explicit source steward', async () => {
  expect(() => createDocumentGrant({ ...claims, seedOwnerSub: 'steward' }, { privateKey: keys.privateKey, keyId: 'one', now })).toThrow();
  const seeded = createDocumentGrant({ ...claims, operations: ['seed'], seedOwnerSub: 'steward' }, { privateKey: keys.privateKey, keyId: 'one', now });
  expect((await verifyDocumentGrant(seeded, options)).seedOwnerSub).toBe('steward');
});
