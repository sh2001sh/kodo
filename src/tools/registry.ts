import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { createHash } from 'node:crypto';
import { KodoError } from '../runtime/types.js';
import type { Permission, Run, Session, ToolRecoveryVerifier, ToolSpec } from '../runtime/types.js';

/** Trusted host callbacks still execute inside the runtime's authorization/effect boundary. */
export interface ToolExecutionContext {
  /** Detached storage snapshots: editing these records does not persist or grant capabilities. */
  run: Run;
  session: Session;
  signal: AbortSignal;
  markEffectStarted: () => void;
}
/** Host decisions over validated input. Missing declarations always take the conservative path. */
export type InputFlag = boolean | ((input: Readonly<Record<string, unknown>>) => boolean);
export interface ToolRegistration extends ToolSpec {
  permission: Permission;
  effect: 'read' | 'write';
  /** Bump when trusted callback semantics change without changing its public schema. */
  version?: string;
  /** False for an unavailable host service: retain its pinned identity, omit its model schema. */
  available?: boolean;
  readOnly?: InputFlag;
  /** Scheduling never widens permissions; only calls classified as read-only may share a batch. */
  concurrencySafe?: InputFlag;
  destructive?: InputFlag;
  /** Relative workspace roots, contained within the run's existing write scope. */
  writeScope?: (input: Readonly<Record<string, unknown>>) => readonly string[];
  interrupt?: 'cancel' | 'block';
  maxResultBytes?: number;
  /** Additional synchronous validation, after the mandatory JSON schema check and before starting IO. */
  validate?: (input: Readonly<Record<string, unknown>>) => boolean | string | void;
  execute(context: ToolExecutionContext, args: Record<string, unknown>): unknown | Promise<unknown>;
  recover?: ToolRecoveryVerifier;
}
export interface RegisteredTool extends Omit<ToolRegistration, 'validate'> { validate: ValidateFunction; validateInput?: ToolRegistration['validate'] }
export type ToolBindingDefinition = Pick<ToolRegistration, 'name' | 'description' | 'parameters' | 'permission' | 'effect' | 'version' | 'available' | 'readOnly' | 'destructive' | 'writeScope' | 'interrupt' | 'maxResultBytes'>;

/** Stable public contract identity; hosts version callback semantics explicitly. */
export function toolFingerprint(definition: ToolBindingDefinition): string {
  const value = {
    name: definition.name, description: definition.description, parameters: definition.parameters,
    permission: definition.permission, effect: definition.effect,
    ...(definition.version === undefined ? {} : { version: definition.version }),
    ...(definition.available === undefined ? {} : { available: definition.available }),
    ...(definition.readOnly === undefined ? {} : { readOnly: typeof definition.readOnly === 'function' ? 'input' : definition.readOnly }),
    ...(definition.destructive === undefined ? {} : { destructive: typeof definition.destructive === 'function' ? 'input' : definition.destructive }),
    ...(definition.writeScope === undefined ? {} : { writeScope: 'input' }),
    ...(definition.interrupt === undefined ? {} : { interrupt: definition.interrupt }),
    ...(definition.maxResultBytes === undefined ? {} : { maxResultBytes: definition.maxResultBytes }),
  };
  return createHash('sha256').update(JSON.stringify(canonical(jsonSnapshot(value)))).digest('hex');
}

const coordinationNames = ['spawn_agent', 'followup_task', 'list_agents', 'inspect_run', 'send_message', 'wait_for_events', 'ask_user', 'cancel_agent', 'interrupt_agent', 'update_progress', 'exploration.plan', 'report.submit'];
const wireName = (name: string): string => name.replaceAll('.', '_');

/** Registrations are append-only: a persisted tool name must keep its host-approved meaning. */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly encodedNames: Set<string>;
  constructor(reservedNames: readonly string[] = []) {
    this.encodedNames = new Set([...coordinationNames, ...reservedNames].map(wireName));
  }
  register(registration: ToolRegistration): void {
    if (!registration || typeof registration !== 'object' || typeof registration.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(registration.name)) {
      throw new KodoError('TOOL_REGISTRATION', 'tool name must use 1-64 protocol-safe letters, digits, dots, underscores or hyphens');
    }
    if (this.encodedNames.has(wireName(registration.name))) throw new KodoError('TOOL_REGISTRATION', 'tool name is reserved or collides after protocol conversion');
    if (typeof registration.description !== 'string' || !registration.description.trim() || registration.description.length > 16_000) throw new KodoError('TOOL_REGISTRATION', 'provide a nonempty tool description of at most 16000 characters');
    if (registration.version !== undefined && (typeof registration.version !== 'string' || !registration.version.trim() || registration.version.length > 200)) throw new KodoError('TOOL_REGISTRATION', 'tool version must be a nonempty string of at most 200 characters');
    if (registration.available !== undefined && typeof registration.available !== 'boolean') throw new KodoError('TOOL_REGISTRATION', 'tool availability must be a host boolean');
    if (!['read', 'write', 'exec'].includes(registration.permission) || !['read', 'write'].includes(registration.effect)) throw new KodoError('TOOL_REGISTRATION', 'tool permission or effect is invalid');
    if (registration.effect === 'write' && registration.permission === 'read') throw new KodoError('TOOL_REGISTRATION', 'write effects require write or exec permission');
    for (const field of ['readOnly', 'concurrencySafe', 'destructive'] as const) if (registration[field] !== undefined && !['boolean', 'function'].includes(typeof registration[field])) throw new KodoError('TOOL_REGISTRATION', `${field} must be a boolean or an input predicate`);
    if (registration.concurrencySafe && registration.effect !== 'read' && !registration.readOnly) throw new KodoError('TOOL_REGISTRATION', 'concurrencySafe write tools must declare which inputs are read-only');
    if (registration.writeScope !== undefined && typeof registration.writeScope !== 'function') throw new KodoError('TOOL_REGISTRATION', 'writeScope must be an input function');
    if (registration.interrupt !== undefined && !['cancel', 'block'].includes(registration.interrupt)) throw new KodoError('TOOL_REGISTRATION', 'interrupt must be cancel or block');
    if (registration.maxResultBytes !== undefined && (!Number.isSafeInteger(registration.maxResultBytes) || registration.maxResultBytes < 1024 || registration.maxResultBytes > 16 * 1024 * 1024)) throw new KodoError('TOOL_REGISTRATION', 'maxResultBytes must be between 1024 and 16777216');
    if (registration.validate !== undefined && typeof registration.validate !== 'function') throw new KodoError('TOOL_REGISTRATION', 'validate must be a synchronous input function');
    if (typeof registration.execute !== 'function' || (registration.recover !== undefined && typeof registration.recover !== 'function')) throw new KodoError('TOOL_REGISTRATION', 'tool execution and optional recovery must be functions');
    let parameters: Record<string, unknown>;
    let validate: ValidateFunction;
    try {
      parameters = jsonSnapshot(registration.parameters) as Record<string, unknown>;
      if (!parameters || Array.isArray(parameters) || typeof parameters !== 'object' || parameters.type !== 'object') throw new Error('object schema required');
      // Isolate schema IDs between tools and never coerce/default/remove caller arguments.
      validate = new Ajv({ allErrors: true }).compile(parameters);
      freeze(parameters);
    } catch {
      throw new KodoError('TOOL_REGISTRATION', 'tool parameters must be a valid JSON schema with object type');
    }
    const definition: RegisteredTool = Object.freeze({
      name: registration.name,
      description: registration.description,
      parameters,
      permission: registration.permission,
      effect: registration.effect,
      ...(registration.version === undefined ? {} : { version: registration.version }),
      ...(registration.available === undefined ? {} : { available: registration.available }),
      ...Object.fromEntries((['readOnly', 'concurrencySafe', 'destructive', 'writeScope', 'interrupt', 'maxResultBytes'] as const).filter(field => registration[field] !== undefined).map(field => [field, registration[field]])),
      ...(registration.validate ? { validateInput: registration.validate } : {}),
      execute: registration.execute,
      ...(registration.recover ? { recover: registration.recover } : {}),
      validate,
    });
    this.tools.set(definition.name, definition);
    this.encodedNames.add(wireName(definition.name));
  }
  get(name: string): RegisteredTool | undefined { return this.tools.get(name); }
  definitions(): RegisteredTool[] { return [...this.tools.values()]; }
  specs(): ToolSpec[] {
    return this.definitions().filter(tool => tool.available !== false).map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
}

/** Reject lossy/non-JSON schema values instead of silently dropping their constraints. */
function jsonSnapshot(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('schema must be JSON');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('schema must use plain objects');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => jsonSnapshot(item, ancestors));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSnapshot(item, ancestors)]));
  } finally { ancestors.delete(value); }
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
