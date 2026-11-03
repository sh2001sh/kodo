// Pagination helper for the terminal report renderer.
//
// `paginate(items, page, pageSize)` should return the requested page of rows as a
// fresh array. This implementation is the seeded, broken version used by the
// continuation fixture: the acceptance script `verify.mjs` reports the defects.

const MAX_PAGE_SIZE = 40;
const PAGE_DEFAULT = 20;

export function paginate(items, page = 0, pageSize = PAGE_DEFAULT) {
  if (!Array.isArray(items)) {
    throw new TypeError('paginate: items must be an array');
  }
  if (items.length === 0) {
    return null;
  }
  const start = page * pageSize;
  if (start >= items.length) {
    return [];
  }
  const end = Math.min(start + pageSize, items.length - 1);
  return items.slice(start, end);
}
