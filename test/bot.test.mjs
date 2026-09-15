import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'discord.js';
import { SeedanceClient } from '../src/sd2.js';

test('both commands, hidden prompts, and multi-render commands complete through the real bot handlers', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yopisora-bot-test-'));
  const originalEnv = { token: process.env.DISCORD_TOKEN, guild: process.env.DISCORD_GUILD_ID, store: process.env.GEN_JOB_STORE_DIR };
  const originals = { login: Client.prototype.login, create: SeedanceClient.prototype.createTask, wait: SeedanceClient.prototype.waitForTask, download: SeedanceClient.prototype.downloadFile, fetch: globalThis.fetch };
  let client;
  let sequence = 0;
  const id = () => (((BigInt(Date.now()) - 1420070400000n) << 22n) + BigInt(++sequence)).toString();
  const messages = new Map();
  const edits = [];
  const submissions = [];
  const results = [];
  const order = [];
  let loseResponse = false;
  let diskFile = 0;
  const beforeSignals = Object.fromEntries(['SIGINT', 'SIGTERM', 'unhandledRejection'].map((event) => [event, process.listeners(event)]));
  process.env.DISCORD_TOKEN = 'offline-test-token';
  process.env.DISCORD_GUILD_ID = 'home';
  process.env.GEN_JOB_STORE_DIR = path.join(dir, 'jobs');
  globalThis.fetch = async () => { throw new Error('Unexpected network request in offline bot test'); };
  Client.prototype.login = async function () { client = this; return 'offline'; };
  SeedanceClient.prototype.createTask = async (options) => {
    submissions.push(options);
    return { taskId: `test-task-${submissions.length}` };
  };
  SeedanceClient.prototype.waitForTask = async (taskId) => ({ videoUrl: `https://example.test/${taskId}.mp4` });
  SeedanceClient.prototype.downloadFile = async () => {
    const file = path.join(dir, `video-${++diskFile}.mp4`);
    await writeFile(file, 'video');
    return { path: file, bytes: 5 };
  };
  t.after(async () => {
    Client.prototype.login = originals.login;
    SeedanceClient.prototype.createTask = originals.create;
    SeedanceClient.prototype.waitForTask = originals.wait;
    SeedanceClient.prototype.downloadFile = originals.download;
    globalThis.fetch = originals.fetch;
    for (const [key, value] of [['DISCORD_TOKEN', originalEnv.token], ['DISCORD_GUILD_ID', originalEnv.guild], ['GEN_JOB_STORE_DIR', originalEnv.store]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const event of Object.keys(beforeSignals)) {
      for (const listener of process.listeners(event)) if (!beforeSignals[event].includes(listener)) process.removeListener(event, listener);
    }
    await client?.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  const channel = {
    id: 'channel', guild: { maximumUploadLimit: 100 },
    messages: {
      edit: async (messageId, body) => {
        edits.push(body);
        order.push(body.embeds[0].data.title);
        return messages.get(messageId);
      },
      fetch: async () => new Map(messages),
    },
    send: async (body) => {
      const message = {
        id: id(), channel, author: { id: 'bot' }, content: body.content, nonce: body.nonce,
        embeds: body.embeds ?? [], attachments: new Map((body.files ?? []).map((file) => [file.name, { name: file.name, size: 5 }])),
        reference: body.reply ? { messageId: body.reply.messageReference } : null,
      };
      messages.set(message.id, message);
      if (body.files) {
        results.push(body);
        order.push('video sent');
        if (loseResponse) { loseResponse = false; throw new Error('response lost after Discord accepted upload'); }
      }
      return message;
    },
  };
  await import('../src/bot.js');
  client.user = { id: 'bot' };
  client.channels.fetch = async () => channel;
  const handler = client.listeners('interactionCreate')[0];
  const interaction = (commandName, userId = 'normal-user', hide = false) => ({
    id: id(), commandName, guildId: 'home', channelId: 'channel', channel,
    user: { id: userId, username: 'test-user' },
    options: {
      getString: (name) => name === 'prompt' ? 'private test prompt' : null,
      getInteger: () => null, getBoolean: () => hide, getAttachment: () => null,
    },
    isChatInputCommand: () => true, isModalSubmit: () => false,
    async deferReply() { this.deferred = true; },
    async reply(body) { this.replied = true; this.replyBody = body; },
    async editReply(body) { return channel.send(body); },
    async showModal(modal) { this.modal = modal; this.replied = true; },
  });

  const first = interaction('sd2-5');
  loseResponse = true;
  await Promise.all([handler(first), handler(first), handler(first), handler(first)]);
  assert.equal(submissions.length, 1);
  assert.equal(results.length, 1);
  assert.ok(order.indexOf('Your video is ready') > order.indexOf('video sent'));

  await handler(interaction('sd2'));
  assert.equal(results.length, 2);

  const editStart = edits.length;
  const hidden = interaction('sd2-5', 'normal-user', true);
  await handler(hidden);
  assert.equal(hidden.replyBody.content, 'Created task!');
  assert.equal(results.length, 3);
  for (const edit of edits.slice(editStart)) assert.equal(edit.embeds[0].data.description, undefined);

  const multi = interaction('sd2', '1242996784301740032');
  await handler(multi);
  assert.ok(multi.modal.data.custom_id.startsWith('sd2-multi-count:'));
  const modal = {
    ...interaction(undefined, '1242996784301740032'), customId: multi.modal.data.custom_id,
    isChatInputCommand: () => false, isModalSubmit: () => true,
    fields: { getTextInputValue: () => '2' },
  };
  await handler(modal);
  assert.equal(results.length, 5);
  assert.equal(new Set(results.map((body) => body.nonce)).size, 5);
  assert.equal(results[3].reply.messageReference, results[4].reply.messageReference);
  assert.notEqual(results[3].files[0].name, results[4].files[0].name);
  assert.deepEqual(await readdir(path.join(dir, 'jobs')), []);
});
