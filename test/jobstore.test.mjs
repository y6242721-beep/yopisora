import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJobStore } from '../src/jobstore.js';

test('concurrent saves use unique temporary files and leave valid records', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yopisora-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createJobStore({ dir });
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.save({ jobId: 'same-job', value: i })));
  assert.equal((await store.get('same-job')).jobId, 'same-job');
  assert.deepEqual(await readdir(dir), ['same-job.json']);
  assert.equal((await store.list()).length, 1);
  await store.remove('same-job');
  await store.remove('same-job');
  assert.equal(await store.get('same-job'), null);
});

test('directory failures are surfaced and initialization can retry', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'yopisora-store-failure-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'jobs');
  await writeFile(dir, 'not a directory');
  const store = createJobStore({ dir });
  await assert.rejects(store.save({ jobId: 'job' }));
  await rm(dir);
  await store.save({ jobId: 'job' });
  assert.equal((await store.get('job')).jobId, 'job');
});
