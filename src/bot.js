import 'dotenv/config';
import {
  Client, GatewayIntentBits, EmbedBuilder, MessageFlags, ActivityType, Options,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} from 'discord.js';
import {
  SeedanceClient,
  SD2_MODEL, SD2_DEFAULT_DURATION, SD2_DEFAULT_RESOLUTION, SD2_DEFAULT_RATIO,
  SD2_MAX_IMAGES, SD2_MAX_VIDEOS,
  SD25_MODEL, SD25_DEFAULT_DURATION, SD25_DEFAULT_RESOLUTION, SD25_DEFAULT_RATIO,
  SD25_MAX_IMAGES, SD25_MAX_VIDEOS,
} from './sd2.js';
import { createSlotManager } from './slots.js';
import { createJobStore } from './jobstore.js';
import { createDeliveryManager } from './delivery.js';
import { createJobRunner } from './generation.js';

const { DISCORD_TOKEN, DISCORD_GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_GUILD_ID) {
  console.error('DISCORD_TOKEN and DISCORD_GUILD_ID are required in .env');
  process.exit(1);
}

const positiveNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const POLL_MS = positiveNumber(process.env.GEN_POLL_INTERVAL_MS, 15_000);
const VIDEO_TIMEOUT = positiveNumber(process.env.GEN_VIDEO_TIMEOUT_MS, 1_200_000);
const MAX_PER_USER = Math.max(1, Math.floor(positiveNumber(process.env.GEN_MAX_CONCURRENT_PER_USER, 3)));
const RETRY_MS = 60_000;
const MB = 1024 * 1024;
const COLOR_WORKING = 0x5865f2;
const COLOR_DONE = 0x57f287;
const COLOR_BLOCKED = 0xfee75c;
const COLOR_ERROR = 0xed4245;
const SD2_MULTI_USER_ID = '1242996784301740032';
const SD2_MULTI_MAX = 100;
const UNLIMITED_USER_IDS = new Set([SD2_MULTI_USER_ID, ...String(process.env.GEN_UNLIMITED_USER_IDS || '').split(',')].map((s) => s.trim()).filter(Boolean));
const providers = {
  sd2: { client: new SeedanceClient({ model: SD2_MODEL }), name: 'Seedance 2.0', duration: SD2_DEFAULT_DURATION, resolution: SD2_DEFAULT_RESOLUTION, ratio: SD2_DEFAULT_RATIO, maxImages: SD2_MAX_IMAGES, maxVideos: SD2_MAX_VIDEOS },
  sd25: { client: new SeedanceClient({ model: SD25_MODEL }), name: 'Seedance 2.5', duration: SD25_DEFAULT_DURATION, resolution: SD25_DEFAULT_RESOLUTION, ratio: SD25_DEFAULT_RATIO, maxImages: SD25_MAX_IMAGES, maxVideos: SD25_MAX_VIDEOS },
};
const jobStore = createJobStore({ dir: process.env.GEN_JOB_STORE_DIR || './.jobs' });
const slots = createSlotManager({ maxPerUser: MAX_PER_USER, maxJobAgeMs: VIDEO_TIMEOUT + 60_000 });
const activeJobs = new Set();
const seenInteractions = new Set();
const pendingSd2Multi = new Map();
let shuttingDown = false;
let sweeping = false;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  enforceNonce: true,
  // Delivery owns retries so it can reconcile ambiguous responses first.
  rest: { timeout: 120_000, retries: 0 },
  allowedMentions: { parse: [], repliedUser: false },
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 15,
    UserManager: { maxSize: 40, keepOverLimit: (user) => user.id === client.user?.id },
    GuildMemberManager: { maxSize: 40, keepOverLimit: (member) => member.id === client.user?.id },
    PresenceManager: 0, ThreadManager: 0, ReactionManager: 0, ReactionUserManager: 0,
    GuildEmojiManager: 0, GuildStickerManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 300, lifetime: 600 },
    users: { interval: 3600, filter: () => (user) => user.id !== client.user?.id },
  },
});

const delivery = createDeliveryManager({
  store: jobStore,
  download: (kind, url) => providers[kind].client.downloadFile(url),
  refreshResultUrl: (kind, taskId) => providers[kind].client.refreshResultUrl(taskId),
  botUserId: () => client.user?.id,
});
const { deliverOutcome, processRecord } = createJobRunner({
  store: jobStore, delivery, providers, pollMs: POLL_MS,
  uploadLimit: (guild) => uploadLimitBytes(guild),
  makeErrorOutcome: errorOutcome,
  showStatus: async (record, channel, status) => {
    let card;
    if (status === 'delivered') {
      card = record.outcome.unavailableContent
        ? cardFor(record, 'Video download expired', COLOR_BLOCKED).addFields({ name: 'What happened', value: record.outcome.embeds[0].description })
        : record.outcome.overLimitContent
        ? cardFor(record, 'Video exceeds upload limit', COLOR_BLOCKED)
        : record.outcome.type === 'video'
        ? cardFor(record, 'Your video is ready', COLOR_DONE).addFields({ name: 'Result', value: `[Open video](https://discord.com/channels/${record.guildId}/${record.channelId}/${record.deliveryMessageId})` })
        : new EmbedBuilder(record.outcome.embeds[0]);
    } else if (status === 'pending') {
      card = cardFor(record, 'Delivery pending — retrying', COLOR_BLOCKED)
        .addFields({ name: 'Status', value: 'Discord delivery has not been confirmed. The bot will retry automatically.' });
    } else {
      card = cardFor(record, 'Generating your video');
    }
    await editStatus(record, channel, card);
  },
});
const truncate = (value, length = 900) => {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 1)}\u2026` : text;
};
const uploadLimitBytes = (guild) => {
  if (Number.isFinite(guild?.maximumUploadLimit) && guild.maximumUploadLimit > 0) return guild.maximumUploadLimit;
  return ({ 0: 10, 1: 25, 2: 50, 3: 100 }[Number(guild?.premiumTier ?? 0)] ?? 10) * MB;
};

function cardFor(record, title, color = COLOR_WORKING) {
  const card = new EmbedBuilder()
    .setAuthor({ name: providers[record.kind]?.name ?? 'Generation' })
    .setTitle(title).setColor(color)
    .addFields({ name: 'Settings', value: [`\`${record.duration}s\``, `\`${record.ratio}\``, `\`${record.resolution}\``].join(' \u2022 ') })
    .setFooter({ text: `Requested by ${record.username || 'user'}` })
    .setTimestamp();
  if (!record.hide) card.setDescription(`>>> ${truncate(record.prompt)}`);
  const refs = [record.refImages ? `${record.refImages} image(s)` : '', record.refVideos ? `${record.refVideos} video(s)` : ''].filter(Boolean);
  if (refs.length) card.addFields({ name: 'References', value: refs.join(', ') });
  if (record.taskId) card.addFields({ name: 'Task ID', value: `\`\`\`${record.taskId}\`\`\`` });
  return card;
}

async function editStatus(record, channel, card) {
  if (record.multi || !record.anchorMessageId || !channel?.messages?.edit) return;
  try {
    await channel.messages.edit(record.anchorMessageId, { embeds: [card], allowedMentions: { parse: [], repliedUser: false } });
  } catch (err) {
    console.warn(`Status edit failed for ${record.jobId}: ${err.message}`);
  }
}

async function createAnchor(interaction, record) {
  const card = cardFor(record, record.multi ? `Firing ${record.multiTotal} generations` : 'Preparing your request');
  if (record.hide) {
    await interaction.reply({ content: 'Created task!', flags: MessageFlags.Ephemeral });
    const channel = interaction.channel ?? await client.channels.fetch(interaction.channelId);
    return channel.send({ embeds: [card], nonce: interaction.id, enforceNonce: true });
  }
  await interaction.deferReply();
  return interaction.editReply({ embeds: [card] });
}

function requestOptions(interaction, kind) {
  const provider = providers[kind];
  const images = ['img1', 'img2', 'img3'].map((key) => interaction.options.getAttachment(key)).filter(Boolean);
  const videos = ['vid1'].map((key) => interaction.options.getAttachment(key)).filter(Boolean);
  for (const image of images) {
    if (!image.contentType?.startsWith('image/') && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(image.name ?? '')) throw new Error(`\`${image.name}\` doesn't look like an image. Upload a PNG, JPG or WEBP.`);
    if (image.size > 20 * MB) throw new Error(`\`${image.name}\` exceeds the 20 MB image limit.`);
  }
  for (const video of videos) {
    if (!video.contentType?.startsWith('video/') && !/\.(mp4|mov|m4v|webm)$/i.test(video.name ?? '')) throw new Error(`\`${video.name}\` doesn't look like a video. Upload an MP4 or MOV.`);
    if (video.size > 100 * MB) throw new Error(`\`${video.name}\` exceeds the 100 MB reference video limit.`);
  }
  return {
    kind, prompt: interaction.options.getString('prompt', true),
    duration: interaction.options.getInteger('duration') ?? provider.duration,
    resolution: interaction.options.getString('resolution') ?? provider.resolution,
    ratio: interaction.options.getString('ratio') ?? provider.ratio,
    hide: Boolean(interaction.options.getBoolean('hideprompt')),
    images: images.slice(0, provider.maxImages), videos: videos.slice(0, provider.maxVideos),
  };
}

function newRecord(interaction, options, jobId) {
  return {
    jobId, deliveryVersion: 1, kind: options.kind, userId: interaction.user.id, username: interaction.user.username,
    guildId: interaction.guildId, channelId: interaction.channelId,
    prompt: options.prompt, duration: options.duration, ratio: options.ratio, resolution: options.resolution,
    refImages: options.images.length, refVideos: options.videos.length, hide: options.hide,
    createdAt: Date.now(),
  };
}

function errorOutcome(record, err) {
  const title = err.timedOut ? 'Your video timed out' : err.blocked ? 'Prompt blocked' : 'Generation failed';
  const message = err.timedOut
    ? `The generation did not finish within ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes. Try generating it again.`
    : err.message || 'An unexpected error occurred.';
  const card = cardFor(record, title, err.timedOut || err.blocked ? COLOR_BLOCKED : COLOR_ERROR)
    .addFields({ name: err.blocked ? 'Reason' : 'What happened', value: truncate(message, 1000) });
  return { type: 'error', content: `<@${record.userId}>${record.multiIndex ? ` ${record.multiIndex}/${record.multiTotal}` : ''}`, embeds: [card.toJSON()] };
}

async function submitRecord(record, options, channel) {
  let task;
  try {
    task = await providers[record.kind].client.createTask(options);
  } catch (err) {
    console.error(`Submit ${record.jobId}: ${err.message}`);
    await deliverOutcome(record, errorOutcome(record, err), channel);
    return null;
  }
  record = { ...record, taskId: task.taskId, deadlineAt: Date.now() + VIDEO_TIMEOUT };
  // Once the provider has accepted the task, preserve its ID even when the
  // first disk write fails; never report that the generation itself failed.
  try { await jobStore.save(record); }
  catch (err) { console.error(`Could not persist task ${record.taskId}:`, err); }
  return record;
}

async function runGeneration(interaction, kind) {
  let options;
  try { options = requestOptions(interaction, kind); }
  catch (err) { await interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral }); return; }
  if (kind === 'sd2' && interaction.user.id === SD2_MULTI_USER_ID) return promptMulti(interaction, options);
  const jobId = slots.take(interaction.user.id, UNLIMITED_USER_IDS.has(interaction.user.id));
  if (!jobId) {
    await interaction.reply({ content: `You already have ${slots.running(interaction.user.id)} of ${MAX_PER_USER} generations running — wait for one to finish.`, flags: MessageFlags.Ephemeral });
    return;
  }
  activeJobs.add(jobId);
  try {
    let record = newRecord(interaction, options, jobId);
    const anchor = await createAnchor(interaction, record);
    record.anchorMessageId = anchor.id;
    const channel = anchor.channel ?? interaction.channel ?? await client.channels.fetch(interaction.channelId);
    record = await submitRecord(record, options, channel);
    if (record) await processRecord(record, channel);
  } finally {
    slots.release(interaction.user.id, jobId);
    activeJobs.delete(jobId);
  }
}

async function runPool(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await worker(item); }
      catch (err) { console.error('Job worker failed:', err); }
    }
  }));
}

async function promptMulti(interaction, options) {
  const key = `sd2-multi-count:${interaction.id}`;
  pendingSd2Multi.set(key, { options, userId: interaction.user.id, channelId: interaction.channelId, expiresAt: Date.now() + 600_000 });
  const modal = new ModalBuilder().setCustomId(key).setTitle('Seedance 2.0').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('count')
      .setLabel('How many generations do you want to fire?').setStyle(TextInputStyle.Short)
      .setRequired(true).setMinLength(1).setMaxLength(3).setPlaceholder(`1–${SD2_MULTI_MAX}`)),
  );
  await interaction.showModal(modal);
}

async function handleMulti(interaction) {
  const pending = pendingSd2Multi.get(interaction.customId);
  if (interaction.user.id !== SD2_MULTI_USER_ID || !pending || pending.expiresAt < Date.now() || pending.userId !== interaction.user.id || pending.channelId !== interaction.channelId) {
    await interaction.reply({ content: 'That request expired — run /sd2 again.', flags: MessageFlags.Ephemeral });
    return;
  }
  pendingSd2Multi.delete(interaction.customId);
  const raw = interaction.fields.getTextInputValue('count').trim();
  const count = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(count) || count < 1 || count > SD2_MULTI_MAX) {
    await interaction.reply({ content: `Need a whole number between 1 and ${SD2_MULTI_MAX}.`, flags: MessageFlags.Ephemeral });
    return;
  }
  const { options } = pending;
  const template = { ...newRecord(interaction, options, interaction.id), multi: true, multiTotal: count };
  const anchor = await createAnchor(interaction, template);
  const channel = anchor.channel ?? interaction.channel ?? await client.channels.fetch(interaction.channelId);
  const submitted = [];
  let confirmed = 0;
  try {
    await runPool(Array.from({ length: count }, (_, i) => i + 1), 5, async (index) => {
      const jobId = slots.take(interaction.user.id, true);
      activeJobs.add(jobId);
      let handedOff = false;
      try {
        const record = await submitRecord({ ...template, jobId, anchorMessageId: anchor.id, multiIndex: index }, options, channel);
        if (record) { submitted.push(record); handedOff = true; }
      } finally {
        if (!handedOff) { activeJobs.delete(jobId); slots.release(interaction.user.id, jobId); }
      }
    });
    await editStatus({ ...template, multi: false, anchorMessageId: anchor.id }, channel,
      cardFor(template, `${submitted.length} of ${count} generations submitted`));
    await runPool(submitted, 3, async (record) => {
      try { if (await processRecord(record, channel)) confirmed++; }
      finally { activeJobs.delete(record.jobId); slots.release(record.userId, record.jobId); }
    });
  } finally {
    for (const record of submitted) { activeJobs.delete(record.jobId); slots.release(record.userId, record.jobId); }
  }
  await editStatus({ ...template, multi: false, anchorMessageId: anchor.id }, channel,
    cardFor(template, confirmed === submitted.length ? `Finished ${submitted.length} generations` : 'Results pending — retrying', confirmed === submitted.length ? COLOR_DONE : COLOR_BLOCKED)
      .addFields({ name: 'Status', value: `${confirmed}/${submitted.length} submitted task results delivered. ${count - submitted.length} could not be submitted.` }));
}

async function resumePendingJobs() {
  if (sweeping || shuttingDown) return;
  sweeping = true;
  try {
    const records = await jobStore.list();
    const anchorCounts = new Map();
    for (const record of records) {
      if (record.anchorMessageId) anchorCounts.set(record.anchorMessageId, (anchorCounts.get(record.anchorMessageId) ?? 0) + 1);
    }
    // Legacy batches shared an anchor without recording that fact. Never
    // mistake a sibling render's old attachment for this task's receipt.
    for (const record of records) {
      if (!activeJobs.has(record.jobId) && !record.multi && anchorCounts.get(record.anchorMessageId) > 1) {
        record.multi = true;
        await jobStore.save(record);
      }
    }
    await runPool(records, 3, async (snapshot) => {
      if (shuttingDown || activeJobs.has(snapshot.jobId)) return;
      activeJobs.add(snapshot.jobId);
      try {
        let record = await jobStore.get(snapshot.jobId);
        if (!record || record.retry?.nextAttemptAt > Date.now()) return;
        // Older versions wrote metadata-free terminal tombstones.
        if (record.delivered && !record.channelId) { await jobStore.remove(record.jobId); return; }
        if (!providers[record.kind]) { console.warn(`Unsupported stored job ${record.jobId}: ${record.kind}`); return; }
        const channel = await client.channels.fetch(record.channelId);
        record = await delivery.recoverLegacy(record, channel) ?? record;
        // A missing anchor is allowed: failIfNotExists delivers in-channel.
        await processRecord(record, channel);
      } catch (err) {
        console.error(`Recovery pending for ${snapshot.jobId}:`, err);
      } finally {
        activeJobs.delete(snapshot.jobId);
      }
    });
  } finally {
    sweeping = false;
  }
}

client.on('interactionCreate', async (interaction) => {
  if (shuttingDown || seenInteractions.has(interaction.id)) return;
  if (!interaction.isChatInputCommand() && !interaction.isModalSubmit()) return;
  seenInteractions.add(interaction.id);
  if (seenInteractions.size > 1000) seenInteractions.delete(seenInteractions.values().next().value);
  try {
    if (interaction.guildId !== DISCORD_GUILD_ID) {
      await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('sd2-multi-count:')) return await handleMulti(interaction);
    if (interaction.commandName === 'sd2') return await runGeneration(interaction, 'sd2');
    if (interaction.commandName === 'sd2-5') return await runGeneration(interaction, 'sd25');
  } catch (err) {
    console.error(`Interaction ${interaction.id} failed:`, err);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply({ content: 'Something went wrong starting that request. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.once('clientReady', (c) => {
  console.log(`Logged in as ${c.user.tag}; server ${DISCORD_GUILD_ID}; limit ${MAX_PER_USER} concurrent per user`);
  c.user.setActivity('/sd2 + /sd2-5', { type: ActivityType.Listening });
  resumePendingJobs().catch((err) => console.error('Recovery sweep failed:', err));
  setInterval(() => {
    for (const [key, pending] of pendingSd2Multi) if (pending.expiresAt < Date.now()) pendingSd2Multi.delete(key);
    resumePendingJobs().catch((err) => console.error('Recovery sweep failed:', err));
  }, RETRY_MS).unref();
});

setInterval(() => {
  const memory = process.memoryUsage();
  console.log(`[mem] rss ${(memory.rss / MB).toFixed(0)} MB | heap ${(memory.heapUsed / MB).toFixed(0)}/${(memory.heapTotal / MB).toFixed(0)} MB | external ${(memory.external / MB).toFixed(0)} MB`);
}, 300_000).unref();
client.on('error', (err) => console.error('Client error:', err));
client.on('shardError', (err) => console.error('Shard websocket error:', err));
client.on('shardDisconnect', (event, id) => console.warn(`Shard ${id} disconnected (${event?.code ?? '?'}) — reconnecting`));
client.on('shardReconnecting', (id) => console.warn(`Shard ${id} reconnecting`));
client.on('shardResume', (id) => console.log(`Shard ${id} resumed`));
process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — shutting down`);
  try { await client.destroy(); } catch (err) { console.error('Shutdown error:', err); }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
client.login(DISCORD_TOKEN).catch((err) => { console.error('Failed to log in to Discord:', err); process.exit(1); });
