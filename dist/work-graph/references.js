"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeWorkReference = encodeWorkReference;
exports.decodeWorkReference = decodeWorkReference;
exports.encodeWorkReferenceV2 = encodeWorkReferenceV2;
exports.decodeAnyWorkReference = decodeAnyWorkReference;
const validationV2_1 = require("./validationV2");
const contracts_1 = require("./contracts");
const validation_1 = require("./validation");
const PREFIX = 'wg1.';
const V2_PREFIX = 'wg2.';
function toBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes)
        binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64Url(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value))
        throw new RangeError('work reference encoding is malformed');
    const standard = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
    let binary;
    try {
        binary = atob(padded);
    }
    catch {
        throw new RangeError('work reference encoding is malformed');
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        throw new RangeError('work reference is not valid UTF-8');
    }
}
/** Serialize only stable identifiers and graph context; private labels never enter the token. */
function encodeWorkReference(reference) {
    const checked = (0, validation_1.validateWorkReference)(reference);
    if (!checked.ok)
        throw new RangeError(checked.errors.join(' '));
    const json = JSON.stringify(checked.value);
    if (new TextEncoder().encode(json).byteLength > contracts_1.WORK_GRAPH_LIMITS.referenceBytes) {
        throw new RangeError('work reference exceeds its byte limit');
    }
    return `${PREFIX}${toBase64Url(json)}`;
}
function decodeWorkReference(encoded) {
    if (!encoded.startsWith(PREFIX) || encoded.length > PREFIX.length + Math.ceil(contracts_1.WORK_GRAPH_LIMITS.referenceBytes * 4 / 3) + 4) {
        throw new RangeError('work reference version or size is unsupported');
    }
    let parsed;
    try {
        parsed = JSON.parse(fromBase64Url(encoded.slice(PREFIX.length)));
    }
    catch (error) {
        if (error instanceof RangeError)
            throw error;
        throw new RangeError('work reference JSON is malformed');
    }
    const checked = (0, validation_1.validateWorkReference)(parsed);
    if (!checked.ok)
        throw new RangeError(checked.errors.join(' '));
    return checked.value;
}
/** Opt-in writer. Do not enable until the recipient resolver accepts v2. */
function encodeWorkReferenceV2(reference) {
    const checked = (0, validationV2_1.validateWorkReferenceV2)(reference);
    if (!checked.ok)
        throw new RangeError(checked.errors.join(' '));
    return `${V2_PREFIX}${toBase64Url(JSON.stringify(checked.value))}`;
}
/** Upgraded reader: old v1 readers remain strict and continue rejecting v2. */
function decodeAnyWorkReference(encoded) {
    if (encoded.startsWith(PREFIX))
        return decodeWorkReference(encoded);
    if (!encoded.startsWith(V2_PREFIX) || encoded.length > V2_PREFIX.length + Math.ceil(contracts_1.WORK_GRAPH_LIMITS.referenceBytes * 4 / 3) + 4) {
        throw new RangeError('work reference version or size is unsupported');
    }
    let parsed;
    try {
        parsed = JSON.parse(fromBase64Url(encoded.slice(V2_PREFIX.length)));
    }
    catch (error) {
        if (error instanceof RangeError)
            throw error;
        throw new RangeError('work reference JSON is malformed');
    }
    const checked = (0, validationV2_1.validateWorkReferenceV2)(parsed);
    if (!checked.ok)
        throw new RangeError(checked.errors.join(' '));
    return checked.value;
}
//# sourceMappingURL=references.js.map