// Pure wire-pollution analysis (docs/kodo-golden-eval-design-20261103.md §7).
//
// One relay request pollutes a run when:
//   - the response model differs from the request model (the wire was switched),
//   - usage is missing (metering=unknown) and the request was not a client abort,
//   - the HTTP status is not 200 (429/5xx are recorded by the relay),
// plus response/request evidence is missing or the response model cannot be read
// at all (a measured 200 response without a model cannot be verified).
//
// `requests` come from wire/request-N.json, `responses` from wire/response-N.sse
// and `calls` from relay.stats.calls (index, httpStatus, metering, usage, error).

/** Parse the upstream stream for response model(s) and the reported usage object. */
export function parseResponseStream(text) {
  const models = new Set();
  let usage = null;
  let sawDone = false;
  let errorBody = false;
  for (const rawLine of String(text ?? '').replace(/\r\n?/gu, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { sawDone = true; continue; }
    let item;
    try { item = JSON.parse(payload); } catch { continue; }
    if (typeof item?.model === 'string') models.add(item.model);
    if (item?.usage && typeof item.usage === 'object') usage = item.usage;
    if (item?.error) errorBody = true;
  }
  if (!models.size && !sawDone && !usage) {
    // A non-SSE error body (relay forwards provider JSON errors verbatim).
    try {
      const parsed = JSON.parse(String(text ?? ''));
      if (parsed?.error) errorBody = true;
      if (typeof parsed?.model === 'string') models.add(parsed.model);
    } catch { /* not JSON: leave it unparsed */ }
  }
  return { models: [...models], usage, sawDone, errorBody };
}

const reason = (code, index, detail) => ({ code, call: index, detail });

/**
 * @param {{ requests?: {index:number, model?:string}[], responses?: {index:number, text:string}[], calls?: object[] }} evidence
 */
export function analyzePollution({ requests = [], responses = [], calls = [] } = {}) {
  const requestByIndex = new Map(requests.map(request => [request.index, request]));
  const responseByIndex = new Map(responses.map(response => [response.index, response]));
  const reasons = [];
  const excused = [];
  const callDetails = [];
  let unmeasured = 0;
  let modelMismatches = 0;
  let non200 = 0;

  for (const call of calls) {
    const index = call.index;
    const request = requestByIndex.get(index);
    const response = responseByIndex.get(index);
    const parsed = response ? parseResponseStream(response.text) : null;
    const responseModels = parsed?.models ?? [];
    const responseModel = responseModels.length === 1 ? responseModels[0] : responseModels[0] ?? null;
    const codes = [];

    if (call.httpStatus !== undefined && call.httpStatus !== 200) {
      non200++;
      codes.push(`HTTP_${call.httpStatus}`);
      reasons.push(reason(`HTTP_${call.httpStatus}`, index, `upstream returned HTTP ${call.httpStatus}`));
    }
    if (call.error && call.error !== 'CLIENT_ABORTED') {
      codes.push(`RELAY_ERROR_${call.error}`);
      reasons.push(reason(`RELAY_ERROR_${call.error}`, index, `relay request failed with ${call.error}`));
    }
    if (call.metering === 'unknown') {
      unmeasured++;
      if (call.error === 'CLIENT_ABORTED') excused.push(reason('USAGE_MISSING_CANCELLED', index, 'client aborted the request before usage arrived'));
      else {
        codes.push('USAGE_MISSING');
        reasons.push(reason('USAGE_MISSING', index, 'no usage was settled for this request (metering=unknown)'));
      }
    }
    if (!response) {
      codes.push('RESPONSE_MISSING');
      reasons.push(reason('RESPONSE_MISSING', index, 'no wire/response-N.sse was recorded for this relay request'));
    }
    const requestModel = request?.model;
    if (!request || request.present === false) {
      codes.push('REQUEST_MISSING');
      reasons.push(reason('REQUEST_MISSING', index, 'no wire/request-N.json was recorded for this relay request'));
    } else if (response && call.httpStatus === 200) {
      if (responseModel === null) {
        if (call.metering !== 'unknown') {
          codes.push('MODEL_UNVERIFIED');
          reasons.push(reason('MODEL_UNVERIFIED', index, 'the 200 response carries no model field, so the wire identity cannot be verified'));
        }
      } else if (typeof requestModel === 'string' && responseModel !== requestModel) {
        modelMismatches++;
        codes.push('MODEL_MISMATCH');
        reasons.push(reason('MODEL_MISMATCH', index, `request model ${requestModel} but response model ${responseModel}`));
      }
    }
    callDetails.push({
      index, requestModel: requestModel ?? null, responseModel: responseModel ?? null, responseModels,
      httpStatus: call.httpStatus ?? null, metering: call.metering ?? null,
      usagePresent: Boolean(call.usage), error: call.error ?? null, codes,
    });
  }

  return {
    polluted: reasons.length > 0,
    reasons,
    excused,
    calls: callDetails,
    counts: { calls: calls.length, unmeasured, excusedCancellations: excused.length, modelMismatches, non200 },
  };
}
