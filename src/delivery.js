import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { downloadTaskResult } from './resultdownload.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nonceFor = (record) => createHash('sha256')
  .update(`${record.channelId}:${record.kind}:${record.taskId || record.jobId}`)
  .digest('hex').slice(0, 24);
const snowflakeBefore = (time) => ((BigInt(Math.max(1420070400000, time)) - 1420070400000n) << 22n).toString();
const values = (collection) => [...collection.values()];

export class DeliveryPendingError extends Error {
  constructor(cause) {
    super('The result is saved, but Discord delivery is not confirmed yet.', { cause });
    this.name = 'DeliveryPendingError';
  }
}

export function createDeliveryManager({ store, download, refreshResultUrl, botUserId, now = Date.now, delay = sleep, attempts = 3 }) {
  const inFlight = new Map();

  const matches = (message, record) => {
    if (message.author?.id !== botUserId()) return false;
    const outcome = record.outcome;
    const attachments = values(message.attachments ?? new Map());
    const hasVideo = attachments.some((file) => file.name === outcome.filename && file.size > 0);
    const hasLink = outcome.videoUrl && message.content?.includes(outcome.videoUrl);
    const hasLimitNotice = outcome.overLimitContent && message.content === outcome.overLimitContent;
    const hasUnavailableNotice = outcome.unavailableContent && message.content === outcome.unavailableContent
      && message.embeds?.some((embed) => (embed.data ?? embed).title === 'Video download expired');
    if (outcome.type === 'video' && !hasVideo && !hasLink && !hasLimitNotice && !hasUnavailableNotice) return false;
    if (outcome.type !== 'video' && (message.content !== outcome.content
      || !message.embeds?.some((embed) => (embed.data ?? embed).title === outcome.embeds?.[0]?.title))) return false;
    return String(message.nonce ?? '') === record.delivery.nonce
      || (message.content === outcome.content && hasVideo)
      || (message.content?.includes(record.delivery.marker)
        && (hasLink || hasLimitNotice || hasUnavailableNotice || message.content === outcome.content));
  };

  async function findReceipt(channel, record, predicate = (message) => matches(message, record)) {
    if (!record.delivery?.attemptedAt) return null;
    if (!channel.messages?.fetch) throw new Error('Read Message History is required to confirm an interrupted delivery.');
    let before;
    const lowerBound = BigInt(record.delivery.after);
    while (true) {
      const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
      const messages = values(page);
      const found = messages.find(predicate);
      if (found) return found;
      if (!messages.length) return null;
      const oldest = messages.reduce((id, message) => BigInt(message.id) < BigInt(id) ? message.id : id, messages[0].id);
      if (BigInt(oldest) <= lowerBound || messages.length < 100) return null;
      if (before && BigInt(oldest) >= BigInt(before)) throw new Error('Discord history pagination did not advance.');
      before = oldest;
    }
  }

  async function confirm(record, message) {
    if (!message?.id || !matches(message, record)) throw new Error('Discord did not confirm the expected result payload.');
    const completed = { ...record, delivered: true, deliveredAt: now(), deliveryMessageId: message.id };
    // The original upload may become visible while an expiration notice is
    // being prepared. The actual video receipt wins over the pending notice.
    if (record.outcome.unavailableContent && values(message.attachments ?? new Map())
      .some((file) => file.name === record.outcome.filename && file.size > 0)) {
      completed.outcome = { ...record.outcome };
      delete completed.outcome.unavailableContent;
      delete completed.outcome.embeds;
    }
    await store.save(completed);
    return completed;
  }

  async function run(record, outcome, channel) {
    let file;
    try {
      record = (await store.get(record.jobId)) ?? record;
      if (record.delivered && record.deliveryMessageId) return record;
      if (!record.outcome) {
        if (!outcome) throw new Error('The saved result is missing.');
        const nonce = nonceFor(record);
        const marker = `Task: \`${record.taskId || record.jobId}\``;
        record = {
          ...record,
          outcome: { ...outcome, content: `${outcome.content}\n${marker}`, filename: `seedance-${nonce}.mp4` },
          delivery: { nonce, marker },
        };
        delete record.pendingOutcome;
        await store.save(record);
      }
      if (!channel?.send) throw new Error('The result channel is unavailable.');

      const existing = await findReceipt(channel, record);
      if (existing) return await confirm(record, existing);

      const result = record.outcome;
      if (result.type === 'video' && !result.overLimitContent && !result.unavailableContent) {
        try {
          file = await downloadTaskResult({
            record, now, download: (url) => download(record.kind, url),
            refresh: refreshResultUrl ? (taskId) => refreshResultUrl(record.kind, taskId) : null,
            saveUrl: async (url) => { result.videoUrl = url; await store.save(record); },
          });
          if (!file?.path || !(file.bytes > 0)) throw new Error('The downloaded video is empty.');
        } catch (err) {
          if (!err.resultExpired) throw err;
          result.unavailableContent = `${result.content}\n${err.message}`;
          result.embeds = [{ title: 'Video download expired', description: err.message, color: 0xfee75c }];
          await store.save(record);
        }
        if (file && file.bytes > result.uploadLimit) {
          result.overLimitContent = `${result.content}\nYour video rendered but it's ${(file.bytes / 1048576).toFixed(1)} MB, over this server's ${Math.round(result.uploadLimit / 1048576)} MB upload limit.`;
          await store.save(record);
        }
      }
      let lastError;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt) {
          await delay(1500 * attempt);
          const receipt = await findReceipt(channel, record);
          if (receipt) return await confirm(record, receipt);
        }
        // Save the history boundary BEFORE the POST, including the crash window.
        if (!record.delivery.attemptedAt) {
          record.delivery = { ...record.delivery, attemptedAt: now(), after: snowflakeBefore(now() - 300_000) };
          await store.save(record);
        }
        const body = {
          content: result.unavailableContent ?? result.overLimitContent ?? result.content,
          embeds: result.embeds ?? [],
          ...(file && !result.overLimitContent && !result.unavailableContent ? { files: [{ attachment: file.path, name: result.filename }] } : {}),
          nonce: record.delivery.nonce,
          enforceNonce: true,
          allowedMentions: { parse: [], users: [record.userId], repliedUser: false },
          ...(record.anchorMessageId ? { reply: { messageReference: record.anchorMessageId, failIfNotExists: false } } : {}),
        };
        try {
          const message = await channel.send(body);
          return await confirm(record, message);
        } catch (err) {
          lastError = err;
          // A rejected request cannot be fixed by repeating it. Ambiguous
          // network errors are reconciled against history before another POST.
          if (err.status >= 400 && err.status < 500 && err.status !== 429) break;
        }
      }
      const receipt = await findReceipt(channel, record);
      if (receipt) return await confirm(record, receipt);
      throw lastError ?? new Error('Discord did not return a delivery receipt.');
    } catch (err) {
      throw err instanceof DeliveryPendingError ? err : new DeliveryPendingError(err);
    } finally {
      if (file?.path) await unlink(file.path).catch(() => {});
    }
  }

  return {
    async recoverLegacy(record, channel) {
      if (record.deliveryVersion || record.delivery || record.outcome || record.multi || !record.anchorMessageId) return null;
      const filename = record.kind === 'sd25' ? 'seedance25-video.mp4' : 'seedance2-video.mp4';
      const receipt = await findReceipt(channel, {
        ...record,
        delivery: { attemptedAt: record.createdAt || now(), after: record.anchorMessageId },
      }, (message) => message.author?.id === botUserId()
        && message.reference?.messageId === record.anchorMessageId
        && values(message.attachments ?? new Map()).some((file) => file.name === filename && file.size > 0));
      if (!receipt) return null;
      const completed = {
        ...record, delivered: true, deliveredAt: now(), deliveryMessageId: receipt.id,
        outcome: { type: 'video' },
      };
      await store.save(completed);
      return completed;
    },
    deliver(record, outcome, channel) {
      if (inFlight.has(record.jobId)) return inFlight.get(record.jobId);
      const pending = run(record, outcome, channel).finally(() => inFlight.delete(record.jobId));
      inFlight.set(record.jobId, pending);
      return pending;
    },
  };
}
