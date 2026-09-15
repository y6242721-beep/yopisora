import test from 'node:test';
import assert from 'node:assert/strict';
import { SeedanceClient } from '../src/sd2.js';

test('expired recovered tasks are checked once and can still return a completed video', async () => {
  let calls = 0;
  const client = new SeedanceClient({ fetchImpl: async () => {
    calls++;
    return Response.json({ status: 'succeeded', content: { video_url: 'https://example.test/result.mp4' } });
  } });
  const result = await client.waitForTask('task', { timeoutMs: 0 });
  assert.equal(result.videoUrl, 'https://example.test/result.mp4');
  assert.equal(calls, 1);
});

test('provider terminal failures are distinguished from recoverable status errors', async () => {
  const client = new SeedanceClient({ fetchImpl: async () => Response.json({ status: 'failed', error: { message: 'Renderer failed', code: 'RenderError' } }) });
  await assert.rejects(client.waitForTask('task'), (err) => err.terminal === true && err.blocked === false);
  const unavailable = new SeedanceClient({ fetchImpl: async () => Response.json({}, { status: 403 }) });
  await assert.rejects(unavailable.waitForTask('task'), (err) => err.terminal === false);
});

test('an expired task that is still running times out after its recovery check', async () => {
  const client = new SeedanceClient({ fetchImpl: async () => Response.json({ status: 'running' }) });
  await assert.rejects(client.waitForTask('task', { timeoutMs: 0, intervalMs: 15_000 }), (err) => err.timedOut === true);
});

test('download errors identify an expired storage signature without logging signed URLs', async () => {
  const client = new SeedanceClient({ fetchImpl: async () => Response.json({
    Code: 'AccessDenied', Message: 'Request has expired', Expires: '2026-09-14T12:56:06Z',
  }, { status: 403 }) });
  await assert.rejects(client.downloadFile('https://example.test/video.mp4'), (err) => {
    assert.equal(err.status, 403);
    assert.equal(err.resultExpired, true);
    assert.equal(err.expiresAt, '2026-09-14T12:56:06Z');
    assert.match(err.message, /expired/);
    assert.equal(err.body, undefined);
    return true;
  });
});

test('access denied without expiry evidence stays recoverable', async () => {
  const client = new SeedanceClient({ fetchImpl: async () => Response.json({ Code: 'AccessDenied', Message: 'Access denied' }, { status: 403 }) });
  await assert.rejects(client.downloadFile('https://example.test/video.mp4'), (err) => err.status === 403 && !err.resultExpired);
});

test('refresh performs one no-cache status lookup and never starts another generation', async () => {
  const requests = [];
  const client = new SeedanceClient({ baseUrl: 'https://example.test', fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ status: 'succeeded', content: { video_url: 'https://example.test/refreshed.mp4' } });
  } });
  assert.equal((await client.refreshResultUrl('existing-task')).videoUrl, 'https://example.test/refreshed.mp4');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.test/api/task/existing-task');
  assert.equal(requests[0].options.headers['Cache-Control'], 'no-cache');
  assert.equal(requests[0].options.method, undefined);
});
