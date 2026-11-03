import { describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { imageMetadata, maximumImageBytes, readImage } from '../src/tools/image.js';
import type { Message } from '../src/runtime/types.js';
import { answer, call, calls, fixture, scripted, temp } from './helpers.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
// Independently encoded with Pillow; actual compressed pixels, not header-only fixtures.
const webp = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAYAAAAcQ/Y/+ByKi/wEA', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z', 'base64');
const signal = (): AbortSignal => new AbortController().signal;

describe('bounded image bytes', () => {
  it('reads the actual image independently of extension and returns byte-identical model input', async () => {
    const file = path.join(temp(), 'screenshot.data');
    writeFileSync(file, png);
    const result = await readImage(file, signal());
    expect(result).toMatchObject({ path: file, mimeType: 'image/png', width: 1, height: 1, bytes: png.length });
    expect(Buffer.from(result.image.data, 'base64')).toEqual(png);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(imageMetadata(gif)).toEqual({ mimeType: 'image/gif', width: 1, height: 1 });
    expect(imageMetadata(webp)).toEqual({ mimeType: 'image/webp', width: 2, height: 3 });
    expect(imageMetadata(jpeg)).toEqual({ mimeType: 'image/jpeg', width: 2, height: 3 });
  });

  it.each([
    ['unsupported', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['truncated PNG', png.subarray(0, png.length - 1)],
    ['header-only PNG', png.subarray(0, 33)],
    ['corrupt PNG checksum', Buffer.from(png).fill(0, 29, 33)],
    ['truncated GIF', gif.subarray(0, gif.length - 1)],
    ['header-only JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['truncated JPEG', jpeg.subarray(0, jpeg.length - 1)],
    ['truncated WebP', webp.subarray(0, webp.length - 1)],
    ['excessive WebP dimensions', Buffer.from(webp).fill(0xff, 21, 24).fill(0x0f, 24, 25)],
    ['oversize WebP chunk', Buffer.from('5249464614000000574542505650384cff0000000000000000000000', 'hex')],
  ])('rejects %s before sending any bytes to a model', async (_name, bytes) => {
    const file = path.join(temp(), 'image.png');
    writeFileSync(file, bytes);
    await expect(readImage(file, signal())).rejects.toMatchObject({ code: 'IMAGE_FORMAT' });
  });

  it('enforces byte, regular-file and cancellation bounds', async () => {
    const root = temp();
    const file = path.join(root, 'too-large.png');
    writeFileSync(file, Buffer.alloc(maximumImageBytes + 1));
    await expect(readImage(file, signal())).rejects.toMatchObject({ code: 'IMAGE_SIZE' });
    await expect(readImage(root, signal())).rejects.toThrow();
    const controller = new AbortController();
    controller.abort(new Error('image read cancelled'));
    await expect(readImage(file, controller.signal)).rejects.toThrow('image read cancelled');
  });
});

describe('image.read native authorization', () => {
  function imageFixture() {
    const result = fixture();
    const run = result.app.store.run(result.runId);
    result.app.store.updateRun(run.id, { card: { ...run.card, tools: [...run.card.tools, 'image.read'] } });
    const execute = (input: string) => result.app.coordinator.tools.execute(run.id, 'image.read', { path: input }, signal());
    return { ...result, execute };
  }

  it('enforces tool/read grants, native protected paths and run read scope', async () => {
    const { app, root, runId, execute } = imageFixture();
    mkdirSync(path.join(root, 'allowed'));
    writeFileSync(path.join(root, 'allowed', 'pixel.png'), png);
    writeFileSync(path.join(root, 'outside.png'), png);
    writeFileSync(path.join(root, '.env'), png);
    writeFileSync(path.join(root, '.state', 'private.png'), png);
    expect(await execute('allowed/pixel.png')).toMatchObject({ mimeType: 'image/png', width: 1, height: 1 });
    expect(await execute(path.join(root, 'outside.png'))).toMatchObject({ mimeType: 'image/png' });
    for (const input of ['../pixel.png', '.env', '.state/private.png']) {
      await expect(execute(input)).rejects.toMatchObject({ code: 'PATH_DENIED' });
    }
    app.store.updateRun(runId, { scope: { read: ['allowed'] } });
    await expect(execute('outside.png')).rejects.toMatchObject({ code: 'FILE_SCOPE' });
    expect(await execute('allowed/pixel.png')).toMatchObject({ mimeType: 'image/png' });
    app.store.updateRun(runId, { permissions: [] });
    await expect(execute('allowed/pixel.png')).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });

  it('rejects symlink traversal into private runtime state or outside the workspace', async () => {
    const { root, execute } = imageFixture();
    const outside = temp();
    writeFileSync(path.join(outside, 'pixel.png'), png);
    writeFileSync(path.join(root, '.state', 'private.png'), png);
    symlinkSync(outside, path.join(root, 'outside-link'), 'junction');
    symlinkSync(path.join(root, '.state'), path.join(root, 'state-link'), 'junction');
    await expect(execute('outside-link/pixel.png')).rejects.toMatchObject({ code: 'PATH_DENIED' });
    await expect(execute('state-link/private.png')).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });
});

describe('kernel vision attachment provenance', () => {
  it('attaches native image bytes while retaining a compact text tool result and durable replay data', async () => {
    let observed: Message | undefined;
    const { app, root, runId } = fixture(scripted(calls(call('image.read', { path: 'pixel.png' })), async request => {
      observed = request.messages.find(message => message.role === 'tool');
      expect(observed?.role).toBe('tool');
      expect(observed).toMatchObject({ images: [{ mimeType: 'image/png', data: png.toString('base64') }] });
      expect(observed?.content).toContain('"width":1');
      expect(observed?.content).not.toContain(png.toString('base64'));
      return answer('Inspected actual pixels.');
    }));
    writeFileSync(path.join(root, 'pixel.png'), png);
    const run = app.store.run(runId);
    const card = { ...run.card, tools: [...new Set([...run.card.tools, 'image.read'])] };
    app.store.updateRun(runId, { card, toolBindings: app.coordinator.tools.bindingSnapshot(card.tools) });
    const result = await app.run(runId);
    expect(result.status).toBe('completed');
    expect(observed).toBeDefined();
    const imageCall = app.store.calls(runId).find(entry => entry.name === 'image.read');
    expect(app.store.readBlob(imageCall!.resultRef!)).toMatchObject({ image: { mimeType: 'image/png', data: png.toString('base64') } });
  });

  it('does not promote an image-shaped custom tool result into a model attachment', async () => {
    let observed: Message | undefined;
    const { app, runId } = fixture(scripted(calls(call('custom.image', {})), async request => {
      observed = request.messages.find(message => message.role === 'tool');
      expect(observed).not.toHaveProperty('images');
      return answer('Custom result stayed textual.');
    }));
    app.registerTool({ name: 'custom.image', description: 'Return data for a provenance test.', permission: 'read', effect: 'read', parameters: { type: 'object', additionalProperties: false }, execute: () => ({ image: { mimeType: 'image/png', data: png.toString('base64') } }) });
    const run = app.store.run(runId);
    const card = { ...run.card, tools: [...run.card.tools, 'custom.image'] };
    app.store.updateRun(runId, { card, toolBindings: app.coordinator.tools.bindingSnapshot(card.tools) });
    const result = await app.run(runId);
    expect(result.status).toBe('completed');
    expect(observed).toBeDefined();
  });
});
