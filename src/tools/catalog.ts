/** Standard host extensions are recognized in portable cards without granting runtime access. */
export const hostToolNames = Object.freeze([
  'agent.search', 'agent.directory', 'agent.route',
  'todo.read', 'todo.write',
  'knowledge.browse', 'knowledge.search', 'knowledge.read', 'knowledge.publish',
  'web.fetch',
  'lsp.hover', 'lsp.definition', 'lsp.references', 'lsp.symbols', 'lsp.diagnostics',
  'skill.list', 'skill.load',
  'verify.run', 'memory.write',
] as const);
