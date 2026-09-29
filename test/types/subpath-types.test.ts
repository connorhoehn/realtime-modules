// The published types reach a consumer as types, not `any`.
//
// aws-agentcore's ts-jest config compiles with `moduleResolution: "node"`
// (node10), which ignores package.json `exports`. Without `typesVersions`,
// `@connorhoehn/realtime-modules/server` resolved to nothing; the consumer
// masks TS2307, so `ChannelAuthorize` silently became `any`.
//
// This compiles a consumer file against the BUILT package (dist/, which is
// committed) under both node10 and node16 resolution and requires zero
// diagnostics, including "is not any" assertions.

import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const CONSUMER = `
import type { ChannelAuthorize, WsAuthContext, ResolveSender, AuthSender } from '${pkg.name}/server';
import type { WsAuthContext as WsAuthContext2 } from '${pkg.name}/server-ws';
import type { ChatServiceOpts } from '${pkg.name}/chat';
type IsAny<T> = 0 extends 1 & T ? true : false;
export const a: IsAny<ChannelAuthorize> = false;
export const b: IsAny<WsAuthContext> = false;
export const c: IsAny<WsAuthContext2> = false;
export const d: IsAny<ResolveSender> = false;
export const e: IsAny<AuthSender> = false;
export const f: IsAny<ChatServiceOpts['trustFrameSender']> = false;
export const authorize: ChannelAuthorize = ({ kind, ctx }) => kind === 'subscribe' || ctx?.userId === 'x';
// @ts-expect-error — a real ChannelAuthorize rejects a wrong return type
export const bad: ChannelAuthorize = () => 'yes';
`;

let dir: string;
beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-types-'));
    const scope = path.join(dir, 'node_modules', ...pkg.name.split('/').slice(0, -1));
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(ROOT, path.join(dir, 'node_modules', pkg.name), 'dir');
    fs.writeFileSync(path.join(dir, 'consumer.ts'), CONSUMER);
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const cases: Array<[string, ts.CompilerOptions]> = [
    ['moduleResolution node10 (ts-jest / CommonJS consumers)', { module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10 }],
    ['moduleResolution node16', { module: ts.ModuleKind.Node16, moduleResolution: ts.ModuleResolutionKind.Node16 }],
];

test.each(cases)('%s: /server types resolve and are not any', (_name, opts) => {
    const program = ts.createProgram([path.join(dir, 'consumer.ts')], {
        ...opts,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
        target: ts.ScriptTarget.ES2022,
        types: [],
    });
    const diags = ts.getPreEmitDiagnostics(program)
        .filter((d) => d.file?.fileName.endsWith('consumer.ts') || !d.file)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diags).toEqual([]);
}, 60_000);
