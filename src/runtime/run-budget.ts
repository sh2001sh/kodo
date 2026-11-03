import type { Budget, Run, Session } from './types.js';

/** Model capacities belong to each run; only explicit host ceilings constrain all models. */
export function runBudget(run: Run, session: Session): Budget {
  if (!run.modelLimits) return session.budget;
  const maxContextTokens = Math.min(run.modelLimits.context, session.modelBudgetCeilings?.maxContextTokens ?? Infinity);
  return { ...session.budget, maxContextTokens, maxOutputTokens: Math.min(run.modelLimits.output, session.modelBudgetCeilings?.maxOutputTokens ?? Infinity, maxContextTokens - 1) };
}
