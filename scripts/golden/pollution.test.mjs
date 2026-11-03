import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzePollution, parseResponseStream } from './pollution.mjs';

const sse = (model, extra = '') => `data: {"id":"x","model":"${model}","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: {"model":"${model}","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}${extra}\n\ndata: [DONE]\n\n`;
const call = (overrides = {}) => ({ index: 1, httpStatus: 200, metering: 'measured', usage: { prompt_tokens: 10, completion_tokens: 2 }, ...overrides });
const request = { index: 1, model: 'deepseek-v4.1-flash' };

test('parseResponseStream collects response model(s) and usage', () => {
  const parsed = parseResponseStream(sse('deepseek-v4.1-flash'));
  assert.deepEqual(parsed.models, ['deepseek-v4.1-flash']);
  assert.equal(parsed.usage.completion_tokens, 2);
  assert.equal(parsed.sawDone, true);
  const error = parseResponseStream('{"error":{"type":"overloaded_error"}}');
  assert.equal(error.errorBody, true);
  assert.deepEqual(error.models, []);
});

test('a clean 200 measured call is not polluted', () => {
  const analysis = analyzePollution({ requests: [request], responses: [{ index: 1, text: sse('deepseek-v4.1-flash') }], calls: [call()] });
  assert.equal(analysis.polluted, false);
  assert.deepEqual(analysis.reasons, []);
  assert.equal(analysis.counts.calls, 1);
  assert.equal(analysis.calls[0].responseModel, 'deepseek-v4.1-flash');
});

test('a response model that differs from the request model pollutes the cell', () => {
  const analysis = analyzePollution({ requests: [request], responses: [{ index: 1, text: sse('deepseek-v4.1-pro') }], calls: [call()] });
  assert.equal(analysis.polluted, true);
  assert.equal(analysis.reasons[0].code, 'MODEL_MISMATCH');
  assert.match(analysis.reasons[0].detail, /request model deepseek-v4\.1-flash but response model deepseek-v4\.1-pro/u);
  assert.equal(analysis.counts.modelMismatches, 1);
});

test('missing usage pollutes unless the request was a client abort', () => {
  const missing = analyzePollution({ requests: [request], responses: [{ index: 1, text: sse('deepseek-v4.1-flash') }], calls: [call({ metering: 'unknown', usage: undefined, error: undefined })] });
  assert.equal(missing.polluted, true);
  assert.ok(missing.reasons.some(entry => entry.code === 'USAGE_MISSING'));
  const aborted = analyzePollution({ requests: [request], responses: [{ index: 1, text: '' }], calls: [call({ metering: 'unknown', usage: undefined, error: 'CLIENT_ABORTED' })] });
  assert.equal(aborted.polluted, false);
  assert.equal(aborted.excused.length, 1);
  assert.equal(aborted.excused[0].code, 'USAGE_MISSING_CANCELLED');
  assert.equal(aborted.counts.excusedCancellations, 1);
});

test('non-200 relay calls and missing wire files are pollution reasons', () => {
  const http = analyzePollution({ requests: [request], responses: [{ index: 1, text: '{"error":{"type":"rate_limit"}}' }], calls: [call({ httpStatus: 429, metering: 'knownZero', usage: undefined })] });
  assert.equal(http.polluted, true);
  assert.ok(http.reasons.some(entry => entry.code === 'HTTP_429'));
  assert.equal(http.counts.non200, 1);
  const transport = analyzePollution({ requests: [request], responses: [{ index: 1, text: '' }], calls: [call({ httpStatus: undefined, error: 'UPSTREAM_TRANSPORT', metering: 'unknown', usage: undefined })] });
  assert.ok(transport.reasons.some(entry => entry.code === 'RELAY_ERROR_UPSTREAM_TRANSPORT'));
  const missingWire = analyzePollution({ requests: [{ index: 1, model: undefined, present: false }], responses: [], calls: [call()] });
  assert.ok(missingWire.reasons.some(entry => entry.code === 'RESPONSE_MISSING'));
  assert.ok(missingWire.reasons.some(entry => entry.code === 'REQUEST_MISSING'));
});

test('a measured 200 response without a model field cannot be verified', () => {
  const analysis = analyzePollution({
    requests: [request],
    responses: [{ index: 1, text: 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n' }],
    calls: [call()],
  });
  assert.equal(analysis.polluted, true);
  assert.ok(analysis.reasons.some(entry => entry.code === 'MODEL_UNVERIFIED' && /no model field/u.test(entry.detail)));
});
