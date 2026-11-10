/**
 * Accept or refuse the `insecureAllowAll` opt-out for `component`. Returns
 * true when the flag is set and allowed. Throws when it is set under
 * NODE_ENV=production. The first acceptance in the process logs one warning.
 */
export declare function acceptInsecureAllowAll(component: string, flag: unknown): boolean;
/**
 * True when a router was built with the opt-out, or a service accepted the
 * opt-out for it (its warning already ran). The shared channel check lets
 * such a router's channels through instead of refusing them.
 */
export declare function routerAllowsAll(router: unknown): boolean;
/**
 * Throw unless `present`, or the opt-out is accepted (`flag`, or a router built
 * with it). `hook` names what the host must pass, e.g. "an auth hook".
 */
export declare function requireHook(component: string, hook: string, present: boolean, flag: unknown, router?: unknown): void;
/** Test seam: let the next acceptance warn again. */
export declare function _resetInsecureAllowAllWarning(): void;
//# sourceMappingURL=insecureAllowAll.d.ts.map