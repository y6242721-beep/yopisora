import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadTaskResult, signedUrlExpiresAt, ResultExpiredError } from '../src/resultdownload.js';

const expiredUrl = 'https://example.test/old.mp4?X-Tos-Date=20260913T125606Z&X-Tos-Expires=86400';
const freshUrl = 'https://example.test/fresh.mp4?X-Tos-Date=20260915T014136Z&X-Tos-Expires=86400';
const now = () => Date.parse('2026-09-15T02:00:00Z');
const record = { taskId: 'task', outcome: { videoUrl: expiredUrl } };

test('the reported task URL expired at the timestamp returned by storage', () => {
  assert.equal(signedUrlExpiresAt(expiredUrl), Date.parse('2026-09-14T12:56:06Z'));
  assert.equal(signedUrlExpiresAt('https://example.test/video.mp4'), null);
  assert.equal(signedUrlExpiresAt('not a URL'), null);
  assert.equal(signedUrlExpiresAt('https://example.test/?X-Tos-Date=bad&X-Tos-Expires=86400'), null);
});

test('expired URLs refresh first and persist the replacement before download', async () => {
  const events = [];
  const file = { path: 'video', bytes: 5 };
  const result = await downloadTaskResult({
    record, now,
    refresh: async (taskId) => { events.push(['refresh', taskId]); return { videoUrl: freshUrl }; },
    saveUrl: async (url) => events.push(['save', url]),
    download: async (url) => { events.push(['download', url]); return file; },
  });
  assert.equal(result, file);
  assert.deepEqual(events, [['refresh', 'task'], ['save', freshUrl], ['download', freshUrl]]);
});

test('a provider returning the same expired URL does not repeatedly download it', async () => {
  let downloads = 0;
  await assert.rejects(downloadTaskResult({
    record, now, refresh: async () => ({ videoUrl: expiredUrl }),
    download: async () => { downloads++; }, saveUrl: async () => {},
  }), ResultExpiredError);
  assert.equal(downloads, 0);
});

test('ordinary 403s refresh once without being misclassified as expiration', async () => {
  const urls = [];
  let refreshes = 0;
  const error = Object.assign(new Error('Forbidden'), { status: 403 });
  await assert.rejects(downloadTaskResult({
    record: { ...record, outcome: { videoUrl: freshUrl } }, now,
    refresh: async () => { refreshes++; return { videoUrl: freshUrl }; },
    download: async (url) => { urls.push(url); throw error; }, saveUrl: async () => {},
  }), (err) => err === error && !err.resultExpired);
  assert.equal(refreshes, 1);
  assert.equal(urls.length, 1);
});

test('a replacement signed URL recovers an unexpected 403 immediately', async () => {
  const urls = [];
  const originalUrl = 'https://example.test/revoked.mp4';
  const file = { path: 'video', bytes: 5 };
  const result = await downloadTaskResult({
    record: { ...record, outcome: { videoUrl: originalUrl } }, now,
    refresh: async () => ({ videoUrl: freshUrl }), saveUrl: async () => {},
    download: async (url) => {
      urls.push(url);
      if (url === originalUrl) throw Object.assign(new Error('Forbidden'), { status: 403 });
      return file;
    },
  });
  assert.equal(result, file);
  assert.deepEqual(urls, [originalUrl, freshUrl]);
});

test('temporary refresh failure retains the job rather than declaring expiration', async () => {
  const error = Object.assign(new Error('Service unavailable'), { status: 503 });
  await assert.rejects(downloadTaskResult({
    record, now, refresh: async () => { throw error; },
    download: async () => assert.fail('expired URL must not download'), saveUrl: async () => {},
  }), (err) => err === error && !err.resultExpired);
});

test('confirmed storage expiration is respected even if the local clock is behind', async () => {
  let downloads = 0;
  await assert.rejects(downloadTaskResult({
    record: { ...record, outcome: { videoUrl: freshUrl } }, now,
    refresh: async () => ({ videoUrl: freshUrl }), saveUrl: async () => {},
    download: async () => {
      downloads++;
      throw Object.assign(new Error('Request has expired'), { status: 403, resultExpired: true });
    },
  }), ResultExpiredError);
  assert.equal(downloads, 1);
});
