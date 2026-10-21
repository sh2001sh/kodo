import { stripVTControlCharacters } from 'node:util';

/** Also drops incomplete escape prefixes in streamed deltas. */
export const terminalText = (text: string): string => [...stripVTControlCharacters(text)].filter(character => {
  const code = character.codePointAt(0)!;
  return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159));
}).join('');
