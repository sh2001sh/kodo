const message = error => error instanceof Error ? error.message : String(error);

/** Preserve an observed run outcome when later harness cleanup also fails. */
export function settleHarnessExecution(execution, executionError, cleanupError) {
  if (executionError) throw executionError;
  if (!execution) throw cleanupError ?? new Error('harness ended before producing an execution outcome');
  return cleanupError ? { ...execution, cleanupError: message(cleanupError) } : execution;
}
