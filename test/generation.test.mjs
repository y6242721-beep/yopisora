import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobRunner } from '../src/generation.js';
import { DeliveryPendingError } from '../src/delivery.js';

const record = { jobId: 'job', taskId: 'task', kind: 'sd25', userId: 'requester', deadlineAt: 2000 };
const video = { type: 'video', videoUrl: 'https://example.test/video.mp4', content: '<@requester>', uploadLimit: 100 };

function setup(overrides = {}) {
  const events = [];
  const saved = new Map();
  const config = {
    store: {
      get: async (id) => saved.get(id),
      save: async (rec) => saved.set(rec.jobId, structuredClone(rec)),
      remove: async (id) => events.push(['remove', id]),
    },
    delivery: { deliver: async (rec, outcome) => {
      events.push(['send', outcome.type]);
      return { ...rec, outcome, deliveryMessageId: 'message', delivered: true };
    } },
    providers: { sd25: { client: { waitForTask: async () => {
      events.push(['poll']);
      return { videoUrl: video.videoUrl };
    } } } },
    uploadLimit: () => 100,
    showStatus: async (_rec, _channel, status) => events.push(['status', status]),
    makeErrorOutcome: (_rec, err) => ({ type: 'error', message: err.message }),
    pollMs: 1, now: () => 1000,
    logger: { log() {}, warn() {}, error() {} },
    ...overrides,
  };
  return { events, saved, config, runner: createJobRunner(config) };
}

test('the ready status and cleanup happen only after the upload receipt', async () => {
  let acknowledge;
  const gate = new Promise((resolve) => { acknowledge = resolve; });
  const f = setup({ delivery: { deliver: async (rec, outcome) => {
    await gate;
    return { ...rec, outcome, delivered: true, deliveryMessageId: 'message' };
  } } });
  const pending = f.runner.processRecord(record, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.events, [['status', 'generating'], ['poll']]);
  acknowledge();
  assert.equal(await pending, true);
  assert.deepEqual(f.events.slice(-2), [['status', 'delivered'], ['remove', 'job']]);
});

test('upload failure shows pending, retains the job, and sends no generation error', async () => {
  let attempts = 0;
  const f = setup({ delivery: { deliver: async (_rec, outcome) => {
    attempts++;
    assert.equal(outcome.type, 'video');
    throw new DeliveryPendingError(new Error('Discord unavailable'));
  } } });
  assert.equal(await f.runner.processRecord(record, {}), false);
  assert.equal(attempts, 1);
  assert.deepEqual(f.events, [['status', 'generating'], ['poll'], ['status', 'pending']]);
});

test('a saved video is delivered after its generation deadline without repolling', async () => {
  const f = setup();
  assert.equal(await f.runner.processRecord({ ...record, deadlineAt: 0, outcome: video }, {}), true);
  assert.deepEqual(f.events, [['send', 'video'], ['status', 'delivered'], ['remove', 'job']]);
});

test('transient provider errors leave the task for recovery without failure pings', async () => {
  const f = setup({ providers: { sd25: { client: { waitForTask: async () => { throw new Error('network unavailable'); } } } } });
  assert.equal(await f.runner.processRecord(record, {}), false);
  assert.deepEqual(f.events, [['status', 'generating']]);
});

test('terminal provider errors use the same confirmed-delivery path', async () => {
  const f = setup({ providers: { sd25: { client: { waitForTask: async () => { throw Object.assign(new Error('Render failed'), { terminal: true }); } } } } });
  assert.equal(await f.runner.processRecord(record, {}), true);
  assert.deepEqual(f.events, [['status', 'generating'], ['send', 'error'], ['status', 'delivered'], ['remove', 'job']]);
});

test('cleanup or cosmetic failures cannot reclassify a delivered result', async () => {
  let sends = 0;
  const statuses = [];
  const f = setup({
    store: { remove: async () => { throw new Error('disk unavailable'); } },
    showStatus: async (_rec, _channel, status) => { statuses.push(status); throw new Error('anchor deleted'); },
    delivery: { deliver: async (rec, outcome) => { sends++; return { ...rec, outcome, delivered: true, deliveryMessageId: 'message' }; } },
  });
  assert.equal(await f.runner.deliverOutcome(record, video, {}), true);
  assert.equal(sends, 1);
  assert.deepEqual(statuses, ['delivered']);
});

test('temporary delivery failures persist increasing retry delays across restarts', async () => {
  let now = 1000;
  let attempts = 0;
  const f = setup({ now: () => now, delivery: { deliver: async () => {
    attempts++;
    throw new DeliveryPendingError(Object.assign(new Error('Storage unavailable'), { status: 503 }));
  } } });
  await f.runner.processRecord({ ...record, outcome: video }, {});
  let saved = f.saved.get(record.jobId);
  assert.equal(saved.retry.nextAttemptAt, 61_000);
  const resumed = createJobRunner(f.config);
  now = 30_000;
  assert.equal(await resumed.processRecord(saved, {}), false);
  assert.equal(attempts, 1);
  now = 61_000;
  await resumed.processRecord(saved, {});
  saved = f.saved.get(record.jobId);
  assert.equal(saved.retry.nextAttemptAt, 181_000);
  assert.equal(saved.retry.failures, 2);
  assert.equal(saved.outcome.videoUrl, video.videoUrl);
});
