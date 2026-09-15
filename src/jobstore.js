/**
 * Durable job store for in-flight generations.
 *
 * A generation is persisted to disk the moment it's submitted to the provider,
 * and removed only after Discord confirms delivery of its result. If the
 * process is killed mid-render — an OOM SIGKILL, a deploy, a
 * host reap — the record survives, and on the next boot the bot re-polls the
 * generation and delivers it to the original message instead of losing it.
 *
 * One JSON file per job, written atomically (write temp + rename) so a kill
 * during a write can never leave a half-written, unparseable record.
 *
 * Completed renders retain their result URL and delivery receipt so recovery
 * can distinguish a pending upload from a completed generation.
 */
import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createJobStore({ dir = './.jobs' } = {}) {
  let ready = null;
  const mutations = new Map();
  const mutate = (jobId, operation) => {
    const pending = (mutations.get(jobId) ?? Promise.resolve()).catch(() => {}).then(operation);
    mutations.set(jobId, pending);
    const cleanup = () => { if (mutations.get(jobId) === pending) mutations.delete(jobId); };
    pending.then(cleanup, cleanup);
    return pending;
  };
  const ensure = () => {
    ready ??= mkdir(dir, { recursive: true }).catch((err) => {
      ready = null;
      throw err;
    });
    return ready;
  };

  const fileFor = (jobId) => path.join(dir, `${encodeURIComponent(jobId)}.json`);

  return {
    /** Persist (or overwrite) a job record. Atomic. */
    async save(record) {
      if (!record?.jobId) throw new Error('job record needs a jobId');
      const json = JSON.stringify(record);
      return mutate(record.jobId, async () => {
        await ensure();
        const file = fileFor(record.jobId);
        const tmp = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(tmp, json, 'utf8');
          await rename(tmp, file); // atomic on the same filesystem
        } finally {
          await unlink(tmp).catch(() => {});
        }
      });
    },

    async get(jobId) {
      await mutations.get(jobId);
      try { return JSON.parse(await readFile(fileFor(jobId), 'utf8')); }
      catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    /** Remove a job record. Safe to call for an unknown / already-gone id. */
    async remove(jobId) {
      return mutate(jobId, async () => {
        try { await unlink(fileFor(jobId)); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
      });
    },

    /** Every persisted job record. Corrupt files are skipped, not fatal. */
    async list() {
      await ensure();
      let names;
      names = await readdir(dir);
      const records = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const raw = await readFile(path.join(dir, name), 'utf8');
          records.push(JSON.parse(raw));
        } catch { /* skip a corrupt / partial record */ }
      }
      return records;
    },
  };
}
