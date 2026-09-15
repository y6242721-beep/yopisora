import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client, GatewayIntentBits, MessagePayload } from 'discord.js';
import { createDeliveryManager, DeliveryPendingError } from '../src/delivery.js';

const time = 1_800_000_000_000;
const snowflake = (offset) => (((BigInt(time) - 1420070400000n) << 22n) + BigInt(offset)).toString();
const record = (id = 'job-1') => ({ jobId: id, kind: 'sd2', taskId: `task-${id}`, userId: 'requester', channelId: 'channel', anchorMessageId: snowflake(1), createdAt: time });
const outcome = { type: 'video', videoUrl: 'https://example.test/video.mp4', uploadLimit: 100, content: '<@requester>' };

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yopisora-delivery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const records = new Map();
  const messages = [];
  const calls = [];
  const history = [];
  let downloads = 0;
  const store = {
    get: async (id) => structuredClone(records.get(id) ?? null),
    save: async (rec) => { records.set(rec.jobId, structuredClone(rec)); },
  };
  const persist = (body) => {
    const duplicate = messages.find((message) => message.nonce === body.nonce);
    if (duplicate && body.enforceNonce) return duplicate;
    const message = {
      id: snowflake(messages.length + 100), author: { id: 'bot' }, nonce: body.nonce,
      content: body.content, embeds: body.embeds,
      reference: body.reply ? { messageId: body.reply.messageReference } : null,
      attachments: new Map((body.files ?? []).map((file) => [file.name, { name: file.name, size: 5 }])),
    };
    messages.push(message);
    return message;
  };
  const channel = {
    send: async (body) => { calls.push(body); return persist(body); },
    messages: {
      fetch: async (options) => {
        history.push(options);
        return new Map(messages.filter((message) => !options.before || BigInt(message.id) < BigInt(options.before))
          .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, options.limit).map((message) => [message.id, message]));
      },
    },
  };
  const config = {
    store, botUserId: () => 'bot', delay: async () => {}, now: () => time,
    download: async () => {
      const file = path.join(dir, `video-${downloads++}.mp4`);
      await writeFile(file, 'video');
      return { path: file, bytes: 5 };
    },
  };
  return { records, messages, calls, history, store, channel, persist, config, manager: createDeliveryManager(config), downloads: () => downloads };
}

test('concurrent completion callbacks produce one video and one targeted mention', async (t) => {
  const f = await fixture(t);
  const receipts = await Promise.all(Array.from({ length: 4 }, () => f.manager.deliver(record(), outcome, f.channel)));
  assert.equal(f.calls.length, 1);
  assert.equal(new Set(receipts.map((receipt) => receipt.deliveryMessageId)).size, 1);
  assert.deepEqual(f.calls[0].allowedMentions, { parse: [], users: ['requester'], repliedUser: false });
  assert.equal(f.calls[0].enforceNonce, true);
  assert.ok(f.calls[0].nonce.length <= 25);
  assert.equal(f.calls[0].reply.failIfNotExists, false);
  assert.equal(f.records.get('job-1').delivered, true);
});

test('a timeout AFTER Discord persists the upload is reconciled, never resent', async (t) => {
  const f = await fixture(t);
  f.channel.send = async (body) => { f.calls.push(body); f.persist(body); throw new Error('socket closed after POST'); };
  const receipt = await f.manager.deliver(record(), outcome, f.channel);
  assert.equal(f.calls.length, 1);
  assert.equal(receipt.deliveryMessageId, f.messages[0].id);
});

test('a failed upload retries with the same nonce and a reusable disk path', async (t) => {
  const f = await fixture(t);
  f.channel.send = async (body) => {
    f.calls.push(body);
    if (f.calls.length === 1) throw new Error('connection refused');
    return f.persist(body);
  };
  await f.manager.deliver(record(), outcome, f.channel);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].nonce, f.calls[1].nonce);
  assert.equal(typeof f.calls[0].files[0].attachment, 'string');
  assert.equal(f.calls[0].files[0].attachment, f.calls[1].files[0].attachment);
  assert.equal(f.messages.length, 1);
});

test('failed attempts do not poison later retries or mark the job delivered', async (t) => {
  const f = await fixture(t);
  f.channel.send = async (body) => { f.calls.push(body); throw new Error('offline'); };
  await assert.rejects(f.manager.deliver(record(), outcome, f.channel), DeliveryPendingError);
  assert.equal(f.calls.length, 3);
  assert.equal(f.records.get('job-1').delivered, undefined);
  assert.equal(f.records.get('job-1').outcome.videoUrl, outcome.videoUrl);
  f.channel.send = async (body) => { f.calls.push(body); return f.persist(body); };
  await createDeliveryManager(f.config).deliver(record(), undefined, f.channel);
  assert.equal(f.messages.length, 1);
  assert.equal(f.records.get('job-1').delivered, true);
});

test('other renders and text replies on a shared anchor never suppress a video', async (t) => {
  const f = await fixture(t);
  const error = { type: 'error', content: '<@requester>', embeds: [{ title: 'Generation failed' }] };
  await f.manager.deliver(record('failed-sibling'), error, f.channel);
  await f.manager.deliver(record(), outcome, f.channel);
  await f.manager.deliver(record('sibling-2'), outcome, f.channel);
  assert.equal(f.messages.length, 3);
  assert.equal(new Set(f.calls.map((body) => body.nonce)).size, 3);
  assert.notEqual(f.calls[1].files[0].name, f.calls[2].files[0].name);
});

test('restart finds an accepted upload beyond the latest 100 messages', async (t) => {
  const f = await fixture(t);
  let rejectReceipt = true;
  const save = f.store.save;
  f.store.save = async (rec) => {
    if (rec.delivered && rejectReceipt) throw new Error('disk temporarily unavailable');
    return save(rec);
  };
  await assert.rejects(f.manager.deliver(record(), outcome, f.channel), DeliveryPendingError);
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 230; i++) f.messages.push({ id: snowflake(1000 + i), author: { id: 'someone-else' } });
  // Discord may no longer include the nonce on older history messages.
  delete f.messages[0].nonce;
  rejectReceipt = false;
  const receipt = await createDeliveryManager(f.config).deliver(record(), undefined, f.channel);
  assert.equal(receipt.deliveryMessageId, f.messages[0].id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.downloads(), 1);
  assert.ok(f.history.some((options) => options.before));
});

test('unreadable history after an ambiguous POST retains the result', async (t) => {
  const f = await fixture(t);
  f.channel.send = async (body) => { f.calls.push(body); throw new Error('timeout'); };
  f.channel.messages.fetch = async () => { throw new Error('Missing Read Message History'); };
  await assert.rejects(f.manager.deliver(record(), outcome, f.channel), DeliveryPendingError);
  assert.equal(f.calls.length, 1);
  assert.equal(f.records.get('job-1').delivered, undefined);
  assert.ok(f.records.get('job-1').outcome);
});

test('download failure retains the URL before any Discord POST', async (t) => {
  const f = await fixture(t);
  const manager = createDeliveryManager({ ...f.config, download: async () => { throw new Error('download timed out'); } });
  await assert.rejects(manager.deliver(record(), outcome, f.channel), DeliveryPendingError);
  assert.equal(f.calls.length, 0);
  assert.equal(f.records.get('job-1').outcome.videoUrl, outcome.videoUrl);
  await f.manager.deliver(record(), undefined, f.channel);
  assert.equal(f.messages.length, 1);
});

test('over-limit videos send one size notice without a download link', async (t) => {
  const f = await fixture(t);
  f.channel.send = async (body) => {
    f.calls.push(body);
    const message = f.persist(body);
    delete message.nonce;
    throw new Error('response lost after size notice');
  };
  const receipt = await f.manager.deliver(record(), { ...outcome, uploadLimit: 4 }, f.channel);
  assert.equal(f.calls[0].files, undefined);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].content.includes('upload limit'));
  assert.equal(f.calls[0].content.includes(outcome.videoUrl), false);
  assert.equal(f.calls[0].content.includes('Download:'), false);
  assert.ok(receipt.deliveryMessageId);
});

test('a payload-less API response is not accepted as video delivery', async (t) => {
  const f = await fixture(t);
  f.channel.send = async (body) => ({ id: snowflake(10), author: { id: 'bot' }, nonce: body.nonce, content: body.content, attachments: new Map() });
  await assert.rejects(f.manager.deliver(record(), outcome, f.channel), DeliveryPendingError);
  assert.equal(f.records.get('job-1').delivered, undefined);
});

test('an unavailable channel never counts as a successful send', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.manager.deliver(record(), outcome, null), DeliveryPendingError);
  assert.equal(f.records.get('job-1')?.delivered, undefined);
  assert.equal(f.records.get('job-1').outcome.videoUrl, outcome.videoUrl);
});

test('legacy single-job recovery requires the matching video attachment', async (t) => {
  const f = await fixture(t);
  f.messages.push({ id: snowflake(10), author: { id: 'bot' }, reference: { messageId: record().anchorMessageId }, attachments: new Map(), content: 'Your video is ready' });
  assert.equal(await f.manager.recoverLegacy(record(), f.channel), null);
  f.messages.push({ id: snowflake(11), author: { id: 'bot' }, reference: { messageId: record().anchorMessageId }, attachments: new Map([['video', { name: 'seedance2-video.mp4', size: 10 }]]) });
  const receipt = await f.manager.recoverLegacy(record(), f.channel);
  assert.equal(receipt.deliveryMessageId, snowflake(11));
  assert.equal(await f.manager.recoverLegacy({ ...record('multi'), multi: true }, f.channel), null);
  assert.equal(f.calls.length, 0);
});

test('discord.js serializes the idempotency and mention controls onto the actual REST payload', async (t) => {
  const f = await fixture(t);
  await f.manager.deliver(record(), outcome, f.channel);
  const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0 } });
  t.after(() => client.destroy());
  const target = { client, messages: { resolveId: (id) => id } };
  const payload = new MessagePayload(target, f.calls[0]).resolveBody().body;
  assert.equal(payload.enforce_nonce, true);
  assert.equal(payload.nonce, f.calls[0].nonce);
  assert.equal(payload.message_reference.fail_if_not_exists, false);
  assert.deepEqual(payload.allowed_mentions, { parse: [], users: ['requester'], replied_user: false });
  assert.equal(client.rest.options.retries, 0);
});

test('unrecoverable expired results produce one confirmed notice, including lost responses', async (t) => {
  const f = await fixture(t);
  const expiredUrl = 'https://example.test/expired.mp4?X-Tos-Date=20260913T125606Z&X-Tos-Expires=86400';
  let refreshes = 0;
  const manager = createDeliveryManager({ ...f.config,
    refreshResultUrl: async () => { refreshes++; return { videoUrl: expiredUrl }; },
  });
  f.channel.send = async (body) => {
    f.calls.push(body);
    const message = f.persist(body);
    delete message.nonce;
    throw new Error('response lost after expiry notice');
  };
  const receipt = await manager.deliver(record(), { ...outcome, videoUrl: expiredUrl }, f.channel);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].files, undefined);
  assert.equal(f.calls[0].embeds[0].title, 'Video download expired');
  assert.equal(f.calls[0].content.includes(expiredUrl), false);
  assert.equal(f.downloads(), 0);
  assert.equal(refreshes, 1);
  assert.equal(receipt.delivered, true);
  assert.ok(receipt.outcome.unavailableContent);
  await manager.deliver(record(), undefined, f.channel);
  assert.equal(f.calls.length, 1);
});

test('an already delivered attachment is reconciled before trying an expired URL', async (t) => {
  const f = await fixture(t);
  await f.manager.deliver(record(), outcome, f.channel);
  const saved = f.records.get('job-1');
  delete saved.delivered;
  delete saved.deliveryMessageId;
  saved.outcome.videoUrl = 'https://example.test/expired.mp4?X-Tos-Date=20260913T125606Z&X-Tos-Expires=86400';
  const manager = createDeliveryManager({ ...f.config, refreshResultUrl: async () => assert.fail('receipt must be checked first') });
  const receipt = await manager.deliver(record(), undefined, f.channel);
  assert.equal(f.calls.length, 1);
  assert.equal(f.downloads(), 1);
  assert.equal(receipt.outcome.unavailableContent, undefined);
});

test('refreshed URLs preserve the task delivery identity and survive restart', async (t) => {
  const f = await fixture(t);
  const originalDownload = f.config.download;
  const oldUrl = 'https://example.test/revoked.mp4';
  const newUrl = 'https://example.test/refreshed.mp4';
  let savedNonce;
  const manager = createDeliveryManager({ ...f.config,
    refreshResultUrl: async () => {
      savedNonce = f.records.get('job-1').delivery.nonce;
      return { videoUrl: newUrl };
    },
    download: async (kind, url) => {
      if (url === oldUrl) throw Object.assign(new Error('Forbidden'), { status: 403 });
      assert.equal(f.records.get('job-1').outcome.videoUrl, newUrl);
      return originalDownload(kind, url);
    },
  });
  const receipt = await manager.deliver(record(), { ...outcome, videoUrl: oldUrl }, f.channel);
  assert.equal(receipt.outcome.videoUrl, newUrl);
  assert.equal(f.calls[0].nonce, savedNonce);
  assert.equal(f.calls.length, 1);
});

test('a late video receipt overrides an expiration notice prepared during recovery', async (t) => {
  const f = await fixture(t);
  await f.manager.deliver(record(), outcome, f.channel);
  const saved = f.records.get('job-1');
  delete saved.delivered;
  delete saved.deliveryMessageId;
  saved.outcome.unavailableContent = `${saved.outcome.content}\nThe video link expired.`;
  saved.outcome.embeds = [{ title: 'Video download expired' }];
  const receipt = await f.manager.deliver(record(), undefined, f.channel);
  assert.equal(receipt.outcome.unavailableContent, undefined);
  assert.equal(receipt.outcome.embeds, undefined);
  assert.equal(f.calls.length, 1);
});
