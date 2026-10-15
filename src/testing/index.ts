// Subpath export: `@connorhoehn/realtime-modules/testing`.
//
// Test doubles for hosts of the realtime gateway. Nothing here is for
// production use; import it from test code only.
export { RowsChatStore, RowsReadReceiptStore, createRowsChatBackend } from './rowsChatBackend';
export type { RowsChatBackend, RowsChatBackendOptions } from './rowsChatBackend';
export { FakeClusterRedis, isRenew, isAcquire, isRegister } from './FakeClusterRedis';
export { TestIdentityDirectory } from './testIdentities';
export type { TestIdentity, TestIdentityDirectoryOptions } from './testIdentities';
