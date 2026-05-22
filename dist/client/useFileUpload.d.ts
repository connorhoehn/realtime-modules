export interface FileUploadState {
    id: string;
    filename: string;
    size: number;
    status: 'pending' | 'uploading' | 'completed' | 'failed' | 'scanning' | 'clean' | 'infected';
    progress?: number;
    uploadUrl?: string;
    downloadUrl?: string;
    error?: string;
}
export interface UseFileUploadResult {
    uploads: FileUploadState[];
    upload(file: File, opts?: {
        metadata?: Record<string, unknown>;
    }): Promise<FileUploadState>;
    cancel(id: string): void;
    removeCompleted(): void;
}
export declare function useFileUpload(channel: string): UseFileUploadResult;
//# sourceMappingURL=useFileUpload.d.ts.map