export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;

// Boundary markers and the two multipart form fields need room beyond the
// uploaded file, while keeping the request cap tightly bounded.
export const MAX_IMPORT_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const MAX_IMPORT_REQUEST_BYTES = MAX_IMPORT_FILE_BYTES + MAX_IMPORT_MULTIPART_OVERHEAD_BYTES;
