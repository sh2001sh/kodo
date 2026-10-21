import { Agent } from '../../.kodo/competitor-sources/pi/node_modules/@earendil-works/pi-agent-core/dist/index.js';
import { createAssistantMessageEventStream } from '../../.kodo/competitor-sources/pi/node_modules/@earendil-works/pi-ai/dist/index.js';
import { Type } from '../../.kodo/competitor-sources/pi/node_modules/typebox/build/index.mjs';
import { setTimeout, clearTimeout } from 'node:timers';

const { AbortController, AbortSignal } = globalThis;

const text = content => typeof content === 'string' ? content : (content ?? [])
  .filter(block => block.type === 'text').map(block => block.text).join('');
const emptyCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const describeError = error => `${error?.code ?? 'COMPARISON_ERROR'}: ${error?.message ?? 'operation failed'}`;

function toKodoMessage(message) {
  if (message.role === 'system' || message.role === 'user') return { role: message.role, content: text(message.content) };
  if (message.role === 'toolResult') return { role: 'tool', tool_call_id: message.toolCallId, content: text(message.content) };
  if (message.role === 'assistant') {
    const thinking = message.content.filter(block => block.type === 'thinking');
    const calls = message.content.filter(block => block.type === 'toolCall').map(block => ({
      id: block.id, name: block.name, arguments: JSON.stringify(block.arguments),
    }));
    return { role: 'assistant', content: text(message.content) || null, ...(calls.length ? { tool_calls: calls } : {}),
      ...(thinking.length ? { providerData: { protocol: 'chat-completions', reasoningContent: thinking.map(block => block.thinking).join('') } } : {}) };
  }
  throw new Error(`Unsupported Pi message role: ${message.role}`);
}

/** Run the unmodified Pi Agent core with the same Kodo provider, schemas and tool implementations. */
export async function runPiCore({ app, run, requestComplete, trace = () => {}, maxContextChars = 256000, contextWindowTokens = 256000 }) {
  const session = app.store.session(run.sessionId);
  const effectiveSession = { ...session, permissions: session.permissions.filter(permission => (run.permissions ?? session.permissions).includes(permission)) };
  const normalSpecs = app.coordinator.tools.specs(run.card.tools, effectiveSession);
  const collaborationSpecs = app.coordinator.mailbox.specs(run);
  const specs = [...normalSpecs, ...collaborationSpecs];
  const unsupported = new Set(collaborationSpecs.map(spec => spec.name));
  const initial = app.store.readBlob(run.contextRef);
  if (initial[0]?.role !== 'system' || initial.at(-1)?.role !== 'user') throw new Error('Pi comparison requires a fresh Kodo run');
  const model = { id: run.binding.model, name: run.binding.model, api: 'openai-completions', provider: 'codego',
    baseUrl: run.binding.baseURL, reasoning: false, input: ['text'], contextWindow: contextWindowTokens,
    maxTokens: session.budget.maxOutputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let modelCalls = 0, toolCalls = 0, fatalError;
  const controller = new AbortController();
  const timer = session.budget.maxDurationMs === null ? undefined : setTimeout(() => controller.abort(Object.assign(new Error('shared task execution time exhausted'), { code: 'TIME_BUDGET' })), session.budget.maxDurationMs);
  const tools = specs.map(spec => ({
    ...spec, label: spec.name, parameters: Type.Unsafe(spec.parameters),
    async execute(callId, args, signal) {
      const toolSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(session.budget.toolTimeoutMs)]);
      trace('tool.started', { callId, name: spec.name, arguments: args });
      let result, isError = false;
      try {
        toolSignal.throwIfAborted();
        if (unsupported.has(spec.name)) throw Object.assign(new Error('Pi core comparison does not implement Kodo collaboration scheduling'), { code: 'UNSUPPORTED_COLLABORATION' });
        const validated = app.coordinator.tools.validate(spec.name, JSON.stringify(args), run.card.tools, effectiveSession);
        if (session.budget.maxToolCalls !== null && toolCalls >= session.budget.maxToolCalls) {
          fatalError = 'TOOL_BUDGET: tool call budget exhausted';
          throw Object.assign(new Error('tool call budget exhausted'), { code: 'TOOL_BUDGET' });
        }
        toolCalls++;
        result = await app.coordinator.tools.execute(run.id, spec.name, validated, toolSignal);
      } catch (error) {
        isError = true;
        result = { error: toolSignal.aborted ? 'TOOL_ABORTED: operation stopped; inspect any possible side effects' : describeError(error) };
      }
      trace('tool.finished', { callId, name: spec.name, status: isError ? 'failed' : 'succeeded', result });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, isError };
    },
  }));
  const streamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: emptyCost() },
      stopReason: 'pending', timestamp: Date.now() };
    stream.push({ type: 'start', partial: message });
    void (async () => {
      try {
        const signal = AbortSignal.any([controller.signal, ...(options?.signal ? [options.signal] : [])]);
        signal.throwIfAborted();
        if (fatalError) throw new Error(fatalError);
        const messages = context.messages.map(toKodoMessage);
        // Match the runtime state message Kodo injects immediately before dispatch.
        messages.splice(1, 0, { role: 'system', content: `Current decision version: ${session.decisionVersion ?? 0}. Effective permissions: ${effectiveSession.permissions.join(', ')}. Current user decisions: ${JSON.stringify(app.store.decisions(session.id))}` });
        const contextChars = JSON.stringify({ messages, tools: specs }).length;
        if (contextChars > maxContextChars) throw Object.assign(new Error(`full history ${contextChars} exceeds ${maxContextChars} characters; Pi core has no native compaction`), { code: 'CONTEXT_BUDGET' });
        modelCalls++;
        const response = await requestComplete(messages, specs, signal);
        if (response.message.providerData?.protocol === 'chat-completions') message.content.push({ type: 'thinking', thinking: response.message.providerData.reasoningContent });
        const input = response.usage?.input ?? 0, output = response.usage?.output ?? 0;
        message.usage = { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: emptyCost() };
        if (response.message.content) message.content.push({ type: 'text', text: response.message.content });
        for (const call of response.message.tool_calls ?? []) message.content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: JSON.parse(call.arguments) });
        message.stopReason = response.finishReason === 'tool_calls' ? 'toolUse' : 'stop';
        stream.push({ type: 'done', reason: message.stopReason, message });
      } catch (error) {
        fatalError = describeError(error);
        message.stopReason = controller.signal.aborted || options?.signal?.aborted ? 'aborted' : 'error';
        message.errorMessage = fatalError;
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      } finally { stream.end(); }
    })();
    return stream;
  };
  const agent = new Agent({ initialState: {
    systemPrompt: initial[0].content, model, tools, thinkingLevel: 'off',
    messages: initial.slice(1, -1).map(message => ({ role: message.role, content: message.content, timestamp: Date.now() })),
  }, streamFn, toolExecution: 'sequential' });
  const onAbort = () => agent.abort();
  controller.signal.addEventListener('abort', onAbort, { once: true });
  trace('profile', { harness: 'pi-agent-core', version: '1.3.0', compaction: 'none', toolExecution: 'sequential', unsupportedTools: [...unsupported] });
  try {
    await agent.prompt(initial.at(-1).content);
    const messages = agent.state.messages.map(toKodoMessage);
    const last = agent.state.messages.filter(message => message.role === 'assistant').at(-1);
    const error = fatalError ?? last?.errorMessage ?? (controller.signal.aborted ? describeError(controller.signal.reason) : undefined);
    return { status: error ? 'failed' : 'completed', ...(error ? { error } : {}), text: last ? text(last.content) : '', messages, stats: { modelCalls, toolCalls } };
  } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
}
