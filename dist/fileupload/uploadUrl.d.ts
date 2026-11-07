/** Normalise a public base URL: no trailing slash; '' means root-relative. */
export declare function normalizeUploadBase(base: string | null | undefined): string;
/** The base FileUploadService uses when no `publicBaseUrl` is passed. */
export declare function defaultUploadBase(): string;
/** `${base}/api/uploads/${encodeURIComponent(id)}` — PUT target and GET download alike. */
export declare function uploadUrlFor(base: string, uploadId: string): string;
//# sourceMappingURL=uploadUrl.d.ts.map