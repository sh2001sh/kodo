import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { usageScorecard } from './real-scorecard.mjs';

// Read-only audit: retain the runner's raw results and inspect the wire evidence independently.
export async function auditEvidence(root) {
  root = path.resolve(root);
  const { results } = JSON.parse(await readFile(path.join(root, 'results.json'), 'utf8'));
  const rows = [];
  for (const row of results) {
    const directory = path.join(root, row.id);
    const relay = JSON.parse(await readFile(path.join(directory, 'wire/relay.json'), 'utf8'));
    const files = await readdir(path.join(directory, 'wire'));
    const models = new Set(), responseModels = new Set(), limits = new Set(), settings = new Set();
    const reasons = {}, statuses = {}, errors = {}, missingResponses = [], incompleteStreams = [];
    let measuredResponses = 0, mismatchedUsage = 0, upstreamMs = 0;
    for (const call of relay.calls) {
      const request = JSON.parse(await readFile(path.join(directory, `wire/request-${call.index}.json`), 'utf8'));
      models.add(request.model);
      limits.add(request.max_tokens ?? request.max_completion_tokens);
      settings.add(JSON.stringify({ temperature: request.temperature, top_p: request.top_p, reasoning_effort: request.reasoning_effort, thinking: request.thinking }));
      statuses[String(call.httpStatus)] = (statuses[String(call.httpStatus)] ?? 0) + 1;
      if (call.error) errors[call.error] = (errors[call.error] ?? 0) + 1;
      upstreamMs += call.elapsedMs ?? 0;
      let response;
      try { response = await readFile(path.join(directory, `wire/response-${call.index}.sse`), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; missingResponses.push(call.index); continue; }
      let lastUsage, finished = false;
      for (const line of response.split(/\r?\n/)) {
        if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
        let item;
        try { item = JSON.parse(line.slice(5)); } catch { continue; }
        if (item.model) responseModels.add(item.model);
        if (item.usage?.prompt_tokens !== undefined) lastUsage = item.usage;
        for (const choice of item.choices ?? []) if (choice.finish_reason) {
          reasons[choice.finish_reason] = (reasons[choice.finish_reason] ?? 0) + 1;
          finished = true;
        }
      }
      if (lastUsage) {
        measuredResponses++;
        if (JSON.stringify(lastUsage) !== JSON.stringify(call.usage)) mismatchedUsage++;
      }
      if (!finished && call.httpStatus === 200) incompleteStreams.push(call.index);
    }
    // The original inertness oracle used runtime.sqlite; the real Store creates kodo.sqlite.
    // Inspect both names in every evaluator fixture without changing that frozen oracle.
    const fixtureDatabaseFiles = [];
    if (row.task === 'package-versions') for (const fixture of (await readdir(directory)).filter(name => name.startsWith('oracle-data-'))) {
      const data = path.join(directory, fixture, 'cli-data');
      let entries;
      try { entries = await readdir(data); } catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
      for (const entry of entries.filter(name => /^(?:kodo|runtime)\.sqlite(?:-.*)?$|^owner\.lock$/.test(name))) fixtureDatabaseFiles.push(path.join(fixture, 'cli-data', entry));
    }
    rows.push({ id: row.id, requestFiles: files.filter(name => /^request-\d+\.json$/.test(name)).length,
      responseFiles: files.filter(name => /^response-\d+\.sse$/.test(name)).length, expectedRequests: relay.requests,
      requestModels: [...models], responseModels: [...responseModels], requestedOutputLimits: [...limits], samplingSettings: [...settings],
      statuses, errors, finishReasons: reasons, measuredResponses, mismatchedUsage, missingResponses, incompleteStreams,
      usageMatchesResult: JSON.stringify(usageScorecard(relay)) === JSON.stringify(row.usage), upstreamMs,
      nonModelMs: row.executionMs - upstreamMs, fixtureDatabaseFiles,
    });
  }
  return { root, trials: rows.length, rows, note: 'CLIENT_ABORTED with finish_reason and measured usage can be normal client stream closure; it is not automatically a failed request. Native completion and independent acceptance are evaluated separately. Database inspection supplements a filename defect in the original oracle; it is not a rerun or a change to raw scores.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/comparison/real-evidence.mjs <evidence-root>');
  process.stdout.write(JSON.stringify(await auditEvidence(process.argv[2]), null, 2) + '\n');
}
