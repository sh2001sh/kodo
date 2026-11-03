import type { ErrorObject } from 'ajv';

/** Compact, field-level Ajv errors the model can act on. */
export function schemaErrorText(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'invalid arguments';
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const error of errors) {
    const field = error.instancePath || '(root)';
    let detail = error.message ?? error.keyword;
    if (error.keyword === 'additionalProperties') detail = `unknown field ${JSON.stringify((error.params as { additionalProperty: string }).additionalProperty)}`;
    else if (error.keyword === 'enum') detail = `must be one of ${JSON.stringify((error.params as { allowedValues: unknown[] }).allowedValues)}`;
    else if (error.keyword === 'required') detail = `missing required field ${JSON.stringify((error.params as { missingProperty: string }).missingProperty)}`;
    const text = `${field} ${detail}`;
    if (seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
    if (parts.length >= 6) break;
  }
  return parts.join('; ');
}
