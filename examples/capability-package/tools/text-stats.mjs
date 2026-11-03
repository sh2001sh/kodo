/** No host imports, dependencies, filesystem access, network access or module-load effects. */
export function execute(args) {
  if (!args || typeof args.text !== 'string' || Object.keys(args).some(key => key !== 'text')) {
    throw new TypeError('text.stats requires exactly one string field: text');
  }
  const utf8Bytes = Buffer.byteLength(args.text, 'utf8');
  if (utf8Bytes > 65536) throw new RangeError('text.stats accepts at most 65536 UTF-8 bytes');
  return {
    codePoints: [...args.text].length,
    utf8Bytes,
    whitespaceWords: args.text.match(/\S+/gu)?.length ?? 0,
    lines: args.text.length ? args.text.split(/\r\n|\r|\n/u).length : 0,
  };
}
