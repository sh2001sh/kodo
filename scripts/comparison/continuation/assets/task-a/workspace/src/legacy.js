// Frozen legacy module. The continuation fixtures keep this file unchanged and
// the acceptance script hashes it; the pager must import these constants here
// instead of redefining its own limits.
//
// MAX_PAGE_SIZE is a contractual limit of the legacy report API. It is 37 and
// must stay 37: downstream callers size their buffers from it.
export const MAX_PAGE_SIZE = 37;

// PAGE_DEFAULT is the page size used when a caller does not pass one.
export const PAGE_DEFAULT = 10;
