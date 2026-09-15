import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  MessageFlags,
  ActivityType,
  AttachmentBuilder,
  Options,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import {
  SeedanceClient,
  Sd2Error,
  SD2_MODEL,
  SD2_DEFAULT_DURATION,
  SD2_DEFAULT_RESOLUTION,
  SD2_DEFAULT_RATIO,
  SD2_MAX_IMAGES,
  SD2_MAX_VIDEOS,
  SD25_MODEL,
  SD25_DEFAULT_DURATION,
  SD25_DEFAULT_RESOLUTION,
  SD25_DEFAULT_RATIO,
  SD25_MAX_IMAGES,
  SD25_MAX_VIDEOS,
} from './sd2.js';
import { createSlotManager } from './slots.js';
import { createJobStore } from './jobstore.js';

const {
  DISCORD_TOKEN,
  DISCORD_GUILD_ID,
  GEN_POLL_INTERVAL_MS = '15000',
  GEN_VIDEO_TIMEOUT_MS = '1200000',
  GEN_MAX_CONCURRENT_PER_USER = '3',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing. Fill it in .env');
  process.exit(1);
}
if (!DISCORD_GUILD_ID) {
  console.error('DISCORD_GUILD_ID is missing. The bot is restricted to a single server.');
  process.exit(1);
}

const sd2 = new SeedanceClient({ model: SD2_MODEL });
const sd25 = new SeedanceClient({ model: SD25_MODEL });
const jobStore = createJobStore({ dir: process.env.GEN_JOB_STORE_DIR || './.jobs' });

const safeUnlink = (p) => (p ? unlink(p).catch(() => {}) : Promise.resolve());

// Terminal-outcome tombstone: written the instant a job's user-facing outcome
// lands (video sent, over-limit notice, or error shown). If the process dies
// between that moment and the job-store cleanup, boot-resume sees the flag and
// drops the record instead of delivering a second copy of the video.
const markJobDelivered = (jobId, kind = 'sd2') =>
  jobStore.save({ jobId, kind, delivered: true, deliveredAt: Date.now() })
    .catch((err) => console.error(`Could not write delivered tombstone for ${jobId}: ${err?.message ?? err}`));

const POLL_MS = Number(GEN_POLL_INTERVAL_MS);
const VIDEO_TIMEOUT = Number(GEN_VIDEO_TIMEOUT_MS);
const MAX_PER_USER = Number(GEN_MAX_CONCURRENT_PER_USER);

const UPLOAD_LIMIT_BY_TIER = { 0: 10, 1: 25, 2: 50, 3: 100 };
const uploadLimitBytes = (guild) => {
  const explicit = guild?.maximumUploadLimit;
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const tier = Number(guild?.premiumTier ?? 0);
  return (UPLOAD_LIMIT_BY_TIER[tier] ?? 10) * 1024 * 1024;
};

const slots = createSlotManager({
  maxPerUser: MAX_PER_USER,
  maxJobAgeMs: VIDEO_TIMEOUT + 60_000,
});
// User IDs exempt from the per-user concurrency cap (comma-separated in .env,
// plus a hardcoded default).
const UNLIMITED_USER_IDS = new Set(
  ['1242996784301740032', ...String(process.env.GEN_UNLIMITED_USER_IDS || '').split(',')]
    .map((s) => s.trim())
    .filter(Boolean),
);
const isUnlimited = (userId) => UNLIMITED_USER_IDS.has(String(userId));

// User who gets the multi-generation flow on /sd2 (modal â†’ fire N gens).
const SD2_MULTI_USER_ID = '1242996784301740032';
const isSd2MultiUser = (userId) => String(userId) === SD2_MULTI_USER_ID;

const takeSlot = (userId) => slots.take(userId, isUnlimited(userId));
const releaseSlot = (userId, jobId) => slots.release(userId, jobId);
const runningCount = (userId) => slots.running(userId);

// Gateway replays / double-emitted interactions share one id, and one id is
// always one user action — so run each id once and ignore the echo. Without
// this a replayed INTERACTION_CREATE runs the whole generation a second time
// (new provider task, second video, second ping) for a command the user only
// sent once.
const seenInteractions = new Set();
const MAX_SEEN_INTERACTIONS = 500;
const claimInteraction = (interaction) => {
  const id = interaction?.id;
  if (!id || seenInteractions.has(id)) return false;
  seenInteractions.add(id);
  if (seenInteractions.size > MAX_SEEN_INTERACTIONS) {
    seenInteractions.delete(seenInteractions.values().next().value);
  }
  return true;
};

const COLOR_WORKING = 0x5865f2;
const COLOR_DONE = 0x57f287;
const COLOR_BLOCKED = 0xfee75c;
const COLOR_ERROR = 0xed4245;

const fmtElapsed = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

const truncate = (s, n = 1000) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}\u2026` : str;
};

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const isImageAttachment = (a) =>
  Boolean(a) && (a.contentType?.startsWith('image/') || IMAGE_EXT.test(a.name ?? ''));

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const isVideoAttachment = (a) =>
  Boolean(a) && (a.contentType?.startsWith('video/') || VIDEO_EXT.test(a.name ?? ''));

const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * MB;
const MAX_VIDEO_BYTES = 100 * MB;
const fmtMB = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  // Large video uploads (10-40 MB) take longer than discord.js's 15s default
  // REST timeout — the client aborted the request ("This operation was
  // aborted") AFTER Discord had already received the file, and every retry
  // stacked another copy of the same video. 120s lets uploads finish.
  rest: { timeout: 120_000 },
  // Bounded caches so a long-running bot on a small host doesn't slowly OOM.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 15,
    UserManager: { maxSize: 40, keepOverLimit: (user) => user.id === client.user?.id },
    GuildMemberManager: { maxSize: 40, keepOverLimit: (member) => member.id === client.user?.id },
    PresenceManager: 0,
    ThreadManager: 0,
    ReactionManager: 0,
    ReactionUserManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 300, lifetime: 600 },
    users: { interval: 3600, filter: () => (user) => user.id !== client.user?.id },
  },
});

client.once('clientReady', async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Server: ${DISCORD_GUILD_ID} (locked)`);
  console.log(`Limit:  ${MAX_PER_USER} concurrent per user (cleared on restart)`);
  c.user.setActivity('/sd2 + /sd2-5', { type: ActivityType.Listening });
  resumePendingJobs().catch((err) => console.error('Resume sweep failed:', err));
});

// Periodic memory trace — makes a slow leak visible in Railway logs before the
// cgroup OOM-kill strikes, instead of only seeing "Killed" with no context.
const MEM_MB = 1024 * 1024;
setInterval(() => {
  const m = process.memoryUsage();
  console.log(`[mem] rss ${(m.rss / MEM_MB).toFixed(0)} MB | heap ${(m.heapUsed / MEM_MB).toFixed(0)}/${(m.heapTotal / MEM_MB).toFixed(0)} MB | external ${(m.external / MEM_MB).toFixed(0)} MB`);
}, 5 * 60_000).unref();

// â”€â”€â”€ Shared helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeAnchorFns({ interaction = null, channel = null, hidePrompt = false } = {}) {
  let anchor = null;

  const resolveChannel = async () => {
    if (channel) return channel;
    if (interaction) return interaction.channel ?? (await client.channels.fetch(interaction.channelId).catch(() => null));
    return null;
  };

  // hidePrompt: the prompt never appears in any message. Cards get their
  // description stripped on the way out — including error cards and anything
  // sent as a raw reply body.
  const stripPrompt = (embed) => {
    if (!hidePrompt || !embed) return embed;
    try { return embed.setDescription(null); } catch { return embed; }
  };

  const finalise = async (embed) => {
    embed = stripPrompt(embed);
    if (anchor) {
      try { await anchor.edit({ embeds: [embed] }); return; }
      catch (err) { console.warn(`anchor.edit failed: ${err.message}`); }
      return;
    }
    if (interaction) {
      try { await interaction.editReply({ embeds: [embed] }); }
      catch (err) { console.warn(`editReply failed: ${err.message}`); }
    }
  };

  const setAnchor = (msg) => { anchor = msg; };

  // True when this anchor already has a bot reply behind it. File deliveries
  // are matched by attachment; text deliveries (over-limit notices, error
  // cards) by reference alone. Guards the reply-fallback and the boot-resume
  // paths against sending the same video + ping twice. Needs the Read Message
  // History permission — if the fetch fails the check degrades to false, so
  // failures are logged loudly instead of silently.
  const alreadyDelivered = async ({ anyKind = false } = {}) => {
    if (!anchor) return false;
    const ch = await resolveChannel();
    if (!ch?.messages?.fetch) return false;
    try {
      const msgs = await ch.messages.fetch({ limit: 10 });
      return msgs.some((m) =>
        m.author?.id === client.user?.id
        && m.reference?.messageId === anchor.id
        && (anyKind || (m.attachments?.size ?? 0) > 0));
    } catch (err) {
      console.warn(`Delivery check failed (bot may lack Read Message History): ${err?.message ?? err}`);
      return false;
    }
  };

  // Discord error codes where the anchor itself is unusable — replying can
  // never work, so the channel.send fallback is the only route (and can't
  // duplicate anything, since no reply to this anchor could have landed).
  const REPLY_GONE_CODES = new Set([10008, 10003, 50001, 50013]);

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // Each distinct file payload goes out at most once per anchor, no matter
  // how many times this is called. Attachment names are unique per delivery
  // (per-render index in multi-fire, one call per single-gen run), so the
  // latch can never suppress a legitimate send.
  const sentFileKeys = new Set();
  const fileKeyOf = (body) =>
    body?.files?.length
      ? `file:${body.files.map((f) => f?.name ?? 'file').join(',')}`
      : null;

  // Returns true when the message actually went out, false when the send
  // was suppressed as a duplicate or failed. Callers use this so the
  // "succeeded (attached)" log line only prints when a file really sent.
  const replyToAnchor = async (body) => {
    if (hidePrompt && body?.embeds?.length) {
      body = { ...body, embeds: body.embeds.map((e) => stripPrompt(e)) };
    }
    const fkey = fileKeyOf(body);
    if (fkey) {
      if (sentFileKeys.has(fkey)) {
        console.log(`Duplicate file delivery suppressed (${fkey}).`);
        return false;
      }
      sentFileKeys.add(fkey);
    }
    // anchor.reply can throw AFTER Discord persisted the message (timeout /
    // gateway blip). Resending blindly is what duplicated the video + ping
    // (reply + retry + channel.send = up to 3 copies), so: on error, check
    // what actually landed first, retry the reply once, and if that also
    // fails, STOP instead of firing a blind channel.send. The ready embed
    // was already finalised above, so the user still sees completion + ID.
    if (anchor) {
      try { await anchor.reply(body); return true; }
      catch (err) {
        console.warn(`Could not reply to anchor: ${err.message}`);
        if (REPLY_GONE_CODES.has(err?.code)) {
          // Anchor deleted / unreachable: no reply could have landed, so
          // the channel fallback below cannot duplicate anything.
        } else {
          if (await alreadyDelivered({ anyKind: true })) {
            console.log('Delivery already landed despite the error — not sending again.');
            return false;
          }
          await delay(1500);
          try { await anchor.reply(body); return true; }
          catch (err2) {
            console.warn(`Reply retry failed: ${err2.message}`);
            if (await alreadyDelivered({ anyKind: true })) {
              console.log('Delivery landed on retry despite the error — not sending again.');
              return false;
            }
            console.error('Giving up on delivery after retry to avoid a duplicate ping — see the ready embed above for the task ID.');
            return false;
          }
        }
      }
    }
    try {
      const ch = await resolveChannel();
      await ch?.send(body);
      return true;
    } catch (err) { console.error(`Could not deliver result: ${err.message}`); return false; }
  };

  // Creates the anchor message that the whole flow edits. Normal path: defer +
  // editReply (the bot's own reply). hidePrompt: clean ephemeral "Created task!"
  // ack on the interaction, and the working card goes out as a separate public
  // message that becomes the anchor.
  const createAnchor = async (embed) => {
    embed = stripPrompt(embed);
    if (hidePrompt && interaction) {
      try {
        await interaction.reply({ content: 'Created task!', flags: MessageFlags.Ephemeral });
      } catch (err) {
        console.warn(`ephemeral ack failed: ${err.message}`);
        try { await interaction.deferReply(); } catch { /* already handled */ }
      }
      const ch = await resolveChannel();
      const msg = await ch.send({ embeds: [embed] });
      anchor = msg;
      return msg;
    }
    if (interaction) {
      if (!interaction.deferred && !interaction.replied) {
        try { await interaction.deferReply(); } catch { /* fall through to edit */ }
      }
      const msg = await interaction.editReply({ embeds: [embed] });
      anchor = msg;
      return msg;
    }
    const ch = await resolveChannel();
    const msg = await ch.send({ embeds: [embed] });
    anchor = msg;
    return msg;
  };

  return { finalise, replyToAnchor, setAnchor, createAnchor, alreadyDelivered };
}

// Collect reference attachments and return their public URLs. The provider fetches
// directly (input.media), so there is no upload step.
function collectReferences(interaction, imageNames, maxImages, videoNames, maxVideos) {
  const imageAtts = imageNames.map((n) => interaction.options.getAttachment(n)).filter(Boolean);
  const videoAtts = videoNames.map((n) => interaction.options.getAttachment(n)).filter(Boolean);

  const badImage = imageAtts.find((a) => !isImageAttachment(a));
  if (badImage) {
    return { error: `\`${badImage.name}\` doesn't look like an image. Upload a PNG, JPG or WEBP.` };
  }
  const badVideo = videoAtts.find((a) => !isVideoAttachment(a));
  if (badVideo) {
    return { error: `\`${badVideo.name}\` doesn't look like a video. Upload an MP4 or MOV.` };
  }
  const oversizedImage = imageAtts.find((a) => a.size > MAX_IMAGE_BYTES);
  if (oversizedImage) {
    return { error: `\`${oversizedImage.name}\` is ${fmtMB(oversizedImage.size)} \u2014 images must be under ${fmtMB(MAX_IMAGE_BYTES)}.` };
  }
  const oversizedVideo = videoAtts.find((a) => a.size > MAX_VIDEO_BYTES);
  if (oversizedVideo) {
    return { error: `\`${oversizedVideo.name}\` is ${fmtMB(oversizedVideo.size)} \u2014 videos must be under ${fmtMB(MAX_VIDEO_BYTES)}.` };
  }

  const images = imageAtts.slice(0, maxImages);
  const videos = videoAtts.slice(0, maxVideos);
  const references = [
    ...images.map((a) => ({ type: 'image', url: a.url })),
    ...videos.map((a) => ({ type: 'video', url: a.url })),
  ];
  return { images, videos, references, error: null };
}

async function handleGenerationError(err, { finalise, replyToAnchor, prompt, user, idRef, commandName = 'Generation', idLabel = 'ID' }) {
  const idVal = idRef?.value;

  // Timeout gets its own clean message (works for Sd2Error).
  if (err?.timedOut) {
    const minutes = Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000));
    const card = new EmbedBuilder()
      .setColor(COLOR_BLOCKED)
      .setAuthor({ name: commandName })
      .setTitle('Your video timed out')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'What happened', value: `The generation ran for the full ${minutes} minutes without finishing. Try generating it again.` });
    if (idVal) card.addFields({ name: idLabel, value: `\`\`\`${idVal}\`\`\`` });
    card.setFooter({ text: `Requested by ${user.username} \u2022 timed out`, iconURL: user.displayAvatarURL?.() }).setTimestamp();

    await finalise(
      new EmbedBuilder()
        .setColor(COLOR_BLOCKED)
        .setAuthor({ name: commandName })
        .setTitle('Your video timed out')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL?.() })
        .setTimestamp(),
    );
    await replyToAnchor({ content: `${user} Your video has timed out \u2014 it has taken ${minutes} minutes. Try regenerating again.`, embeds: [card] });
    console.log(`${idVal ?? 'no-task'} timed out after ${minutes} minutes`);
    return;
  }

  const blocked = Boolean(err?.blocked);
  const message = err?.message || 'An unexpected error occurred.';
  if (!blocked) console.error(err);

  const failed = new EmbedBuilder()
    .setColor(blocked ? COLOR_BLOCKED : COLOR_ERROR)
    .setAuthor({ name: commandName })
    .setTitle(blocked ? 'Prompt blocked' : 'Generation failed')
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields({ name: blocked ? 'Reason' : 'What happened', value: truncate(message, 1000) });
  if (idVal) failed.addFields({ name: idLabel, value: `\`\`\`${idVal}\`\`\`` });
  failed
    .setFooter({ text: blocked ? `Requested by ${user.username} \u2022 try rephrasing` : `Requested by ${user.username}`, iconURL: user.displayAvatarURL?.() })
    .setTimestamp();

  await finalise(
    new EmbedBuilder()
      .setColor(blocked ? COLOR_BLOCKED : COLOR_ERROR)
      .setAuthor({ name: commandName })
      .setTitle(blocked ? 'Prompt blocked' : 'Generation failed')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL?.() })
      .setTimestamp(),
  );
  await replyToAnchor({ content: `${user}`, embeds: [failed] });
  console.log(`${idVal ?? 'no-task'} ${blocked ? 'blocked' : 'failed'}: ${message}`);
}

// Pending /sd2 multi-fire payloads, keyed by user id. Dropped after the modal
// is submitted or after SD2_MULTI_PENDING_TTL_MS so a dismissed modal can't
// leak attachment URLs forever.
const SD2_MULTI_PENDING_TTL_MS = 10 * 60_000;
const SD2_MULTI_MAX = 100;
const SD2_MULTI_SUBMIT_CONCURRENCY = 5;
const SD2_MULTI_DELIVER_CONCURRENCY = 3;
const pendingSd2Multi = new Map();

async function runPool(count, limit, worker) {
  let next = 0;
  const n = Math.max(0, count);
  const width = Math.min(Math.max(1, limit), Math.max(1, n));
  await Promise.all(Array.from({ length: n === 0 ? 0 : width }, async () => {
    while (true) {
      const i = next++;
      if (i >= n) return;
      await worker(i);
    }
  }));
}

client.on('interactionCreate', async (interaction) => {
  if (!claimInteraction(interaction)) {
    console.log(`Ignoring duplicate delivery of interaction ${interaction?.id} (${interaction?.commandName ?? interaction?.customId}).`);
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId === 'sd2-multi-count') {
    return handleSd2MultiModal(interaction);
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'sd2') return runSd2Generation(interaction);
  if (interaction.commandName === 'sd2-5') return runSd25Generation(interaction);
});

// â”€â”€â”€ /sd2 multi-fire (user 1242996784301740032 only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Modal asks how many to fire. Same prompt + references go on every request.
// Submit is pooled so 100 gens don't open 100 sockets at once.

async function promptSd2Multi(interaction) {
  const prompt = interaction.options.getString('prompt', true);
  const duration = interaction.options.getInteger('duration') ?? SD2_DEFAULT_DURATION;
  const resolution = interaction.options.getString('resolution') ?? SD2_DEFAULT_RESOLUTION;
  const ratio = interaction.options.getString('ratio') ?? SD2_DEFAULT_RATIO;

  const { images: imgAtts, videos: vidAtts, error: refError } = collectReferences(
    interaction, ['img1', 'img2', 'img3'], SD2_MAX_IMAGES, ['vid1'], SD2_MAX_VIDEOS,
  );
  if (refError) {
    await interaction.reply({ content: refError, flags: MessageFlags.Ephemeral });
    return;
  }

  pendingSd2Multi.set(interaction.user.id, {
    prompt,
    duration,
    resolution,
    ratio,
    hidePrompt: Boolean(interaction.options.getBoolean('hideprompt')),
    refImages: imgAtts ?? [],
    refVideos: vidAtts ?? [],
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    expiresAt: Date.now() + SD2_MULTI_PENDING_TTL_MS,
  });

  const modal = new ModalBuilder()
    .setCustomId('sd2-multi-count')
    .setTitle('Seedance 2.0')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('count')
          .setLabel('How many generations do you want to fire?')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(3)
          .setPlaceholder(`1â€“${SD2_MULTI_MAX}`),
      ),
    );

  await interaction.showModal(modal);
}

async function handleSd2MultiModal(interaction) {
  const user = interaction.user;
  if (!isSd2MultiUser(user.id)) {
    await interaction.reply({ content: 'This flow is not available for your account.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const pending = pendingSd2Multi.get(user.id);
  pendingSd2Multi.delete(user.id);
  if (!pending || pending.expiresAt < Date.now()) {
    await interaction.reply({ content: 'That request expired â€” run /sd2 again.', flags: MessageFlags.Ephemeral });
    return;
  }

  const raw = (interaction.fields.getTextInputValue('count') || '').trim();
  const count = Number.parseInt(raw, 10);
  if (!Number.isInteger(count) || count < 1 || count > SD2_MULTI_MAX) {
    await interaction.reply({
      content: `Need a whole number between 1 and ${SD2_MULTI_MAX}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const commandName = 'Seedance 2.0';
  const { prompt, duration, resolution, ratio, refImages, refVideos, hidePrompt } = pending;
  const refCount = (refImages?.length ?? 0) + (refVideos?.length ?? 0);
  const sd2Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');

  const { finalise, replyToAnchor, createAnchor } = makeAnchorFns({ interaction, hidePrompt });

  const firing = new EmbedBuilder()
    .setColor(COLOR_WORKING)
    .setAuthor({ name: commandName })
    .setTitle(`Firing ${count} generation${count === 1 ? '' : 's'}`)
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields({ name: 'Settings', value: sd2Settings(duration, ratio, resolution) })
    .setFooter({ text: `Requested by ${user.username} \u2022 submitting\u2026`, iconURL: user.displayAvatarURL() })
    .setTimestamp();
  if (refCount) {
    const refSummary = [
      refImages.length ? `${refImages.length} image${refImages.length > 1 ? 's' : ''}` : null,
      refVideos.length ? `${refVideos.length} video${refVideos.length > 1 ? 's' : ''}` : null,
    ].filter(Boolean).join(', ');
    firing.addFields({ name: 'References', value: refSummary });
    if (refImages.length) firing.setThumbnail(refImages[0].url);
  }

  const anchor = await createAnchor(firing);

  const submitted = [];
  const submitErrors = [];

  await runPool(count, SD2_MULTI_SUBMIT_CONCURRENCY, async (i) => {
    try {
      const { taskId } = await sd2.createTask({
        prompt, duration, resolution, ratio,
        images: refImages ?? [], videos: refVideos ?? [],
      });
      const jobId = takeSlot(user.id);
      submitted.push({ i, taskId, jobId });
      if (jobId) {
        try {
          await jobStore.save({
            jobId, kind: 'sd2', userId: user.id, guildId: interaction.guildId,
            channelId: interaction.channelId, anchorMessageId: anchor.id,
            prompt, duration, ratio, resolution,
            refImages: refImages?.length ?? 0, refVideos: refVideos?.length ?? 0, hide: hidePrompt, taskId,
            deadlineAt: Date.now() + VIDEO_TIMEOUT, createdAt: Date.now(),
          });
        } catch (err) {
          console.warn(`Could not persist sd2 multi job ${jobId}: ${err?.message ?? err}`);
        }
      }
    } catch (err) {
      submitErrors.push({ i, err });
      console.error(`[sd2-multi] submit ${i + 1}/${count} failed: ${err?.message ?? err}`);
    }
  });

  const live = new EmbedBuilder()
    .setColor(COLOR_WORKING)
    .setAuthor({ name: commandName })
    .setTitle(submitted.length ? 'All of them are generating!' : 'Could not start generations')
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields({
      name: 'Status',
      value: submitted.length
        ? `Submitted ${submitted.length} of ${count}. Waiting on the renders.`
        : 'Every submit failed \u2014 nothing is running.',
    })
    .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
    .setTimestamp();
  if (refCount && refImages.length) live.setThumbnail(refImages[0].url);
  await finalise(live);

  if (!submitted.length) {
    const first = submitErrors[0]?.err;
    await handleGenerationError(first ?? new Error('Could not start any generations.'), {
      finalise, replyToAnchor, prompt, user, idRef: { value: null }, commandName, idLabel: 'Task ID',
    });
    return;
  }

  // Each render is independent â€” one failure must not cancel the rest.
  await runPool(submitted.length, SD2_MULTI_DELIVER_CONCURRENCY, async (idx) => {
    const item = submitted[idx];
    const idRef = { value: item.taskId };
    const startedAt = Date.now();
    try {
      const { videoUrl } = await sd2.waitForTask(item.taskId, {
        intervalMs: POLL_MS, timeoutMs: VIDEO_TIMEOUT, onUpdate: () => {},
      });
      const file = await sd2.downloadFile(videoUrl);
      try {
        const limit = uploadLimitBytes(interaction.guild);
        const mb = (file.bytes / MB).toFixed(1);
        let sent = false;
        if (file.bytes >= limit) {
          await replyToAnchor({
            content: `${user} ${idx + 1}/${submitted.length} rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.`,
          });
          sent = true;
          if (item.jobId) await markJobDelivered(item.jobId, 'sd2');
        } else {
          sent = await replyToAnchor({
            content: `${user} ${idx + 1}/${submitted.length}`,
            files: [new AttachmentBuilder(createReadStream(file.path), { name: `seedance2-${idx + 1}.mp4` })],
          });
          if (item.jobId) await markJobDelivered(item.jobId, 'sd2');
        }
        console.log(`${item.taskId} (sd2-multi ${idx + 1}/${submitted.length}) ${sent ? `succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB)` : 'already delivered — resend suppressed'}`);
      } finally {
        await safeUnlink(file.path);
      }
    } catch (err) {
      try {
        await handleGenerationError(err, {
          finalise: async () => {},
          replyToAnchor, prompt, user, idRef, commandName, idLabel: 'Task ID',
        });
      } catch (fatal) {
        console.error(`[sd2-multi] deliver ${idx + 1} failed:`, fatal);
      }
    } finally {
      if (item.jobId) {
        releaseSlot(user.id, item.jobId);
        await jobStore.remove(item.jobId);
      }
    }
  });

  const doneTitle = submitErrors.length
    ? `Fired ${submitted.length} of ${count}`
    : `Fired ${submitted.length} generation${submitted.length === 1 ? '' : 's'}`;
  await finalise(new EmbedBuilder()
    .setColor(submitErrors.length ? COLOR_BLOCKED : COLOR_DONE)
    .setAuthor({ name: commandName })
    .setTitle(doneTitle)
    .setDescription(`>>> ${truncate(prompt, 900)}`)
    .addFields({ name: 'Settings', value: sd2Settings(duration, ratio, resolution) })
    .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
    .setTimestamp());
}

// â”€â”€â”€ /sd2 generation handler (Seedance 2.0 via Volcengine ARK) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runSd2Generation(interaction) {
  const commandName = 'Seedance 2.0';

  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.user;

  if (isSd2MultiUser(user.id)) {
    return promptSd2Multi(interaction);
  }

  const jobId = takeSlot(user.id);
  if (!jobId) {
    await interaction.reply({
      content: `You already have ${runningCount(user.id)} of ${MAX_PER_USER} generations running \u2014 wait for one to finish.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const idRef = { value: null };
  const startedAt = Date.now();
  const hidePrompt = Boolean(interaction.options.getBoolean('hideprompt'));
  const { finalise, replyToAnchor, createAnchor } = makeAnchorFns({ interaction, hidePrompt });
  const sd2Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');

  try {
    const prompt = interaction.options.getString('prompt', true);
    const duration = interaction.options.getInteger('duration') ?? SD2_DEFAULT_DURATION;
    const resolution = interaction.options.getString('resolution') ?? SD2_DEFAULT_RESOLUTION;
    const ratio = interaction.options.getString('ratio') ?? SD2_DEFAULT_RATIO;

    const { images: imgAtts, videos: vidAtts, error: refError } = collectReferences(
      interaction, ['img1', 'img2', 'img3'], SD2_MAX_IMAGES, ['vid1'], SD2_MAX_VIDEOS,
    );
    if (refError) {
      await interaction.reply({ content: refError, flags: MessageFlags.Ephemeral });
      return;
    }
    const refCount = (imgAtts?.length ?? 0) + (vidAtts?.length ?? 0);

    const preparing = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Preparing your request')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: sd2Settings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 submitting\u2026`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) {
      const refSummary = [
        imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
        vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join(', ');
      preparing.addFields({ name: 'References', value: refSummary });
      if (imgAtts.length) preparing.setThumbnail(imgAtts[0].url);
    }
    const anchor = await createAnchor(preparing);

    const { taskId } = await sd2.createTask({
      prompt, duration, resolution, ratio,
      images: imgAtts ?? [], videos: vidAtts ?? [],
    });
    idRef.value = taskId;

    try {
      await jobStore.save({
        jobId, kind: 'sd2', userId: user.id, guildId: interaction.guildId,
        channelId: interaction.channelId, anchorMessageId: anchor.id,
        prompt, duration, ratio, resolution,
        refImages: imgAtts?.length ?? 0, refVideos: vidAtts?.length ?? 0, hide: hidePrompt, taskId,
        deadlineAt: startedAt + VIDEO_TIMEOUT, createdAt: startedAt,
      });
    } catch (err) {
      console.warn(`Could not persist sd2 job ${jobId}: ${err?.message ?? err}`);
    }

    const working = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Generating your video')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: sd2Settings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 this takes a few minutes`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) {
      const refSummary = [
        imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
        vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join(', ');
      working.addFields({ name: 'References', value: refSummary });
      if (imgAtts.length) working.setThumbnail(imgAtts[0].url);
    }
    await finalise(working);

    const { videoUrl } = await sd2.waitForTask(taskId, { intervalMs: POLL_MS, timeoutMs: VIDEO_TIMEOUT, onUpdate: () => {} });

    const file = await sd2.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(interaction.guild);
      const mb = (file.bytes / MB).toFixed(1);

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: commandName })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: sd2Settings(duration, ratio, resolution, [`\`${fmtElapsed(Date.now() - startedAt)}\``]) },
          { name: 'Task ID', value: `\`\`\`${idRef.value ?? ''}\`\`\`` },
        )
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
        .setTimestamp();
      if (refCount) {
        const refSummary = [
          imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
          vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
        ].filter(Boolean).join(', ');
        done.addFields({ name: 'References', value: refSummary });
      }
      await finalise(done);

      if (file.bytes >= limit) {
        await replyToAnchor({ content: `${user}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        await markJobDelivered(jobId, 'sd2');
        console.log(`${idRef.value} (sd2) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, over limit)`);
      } else {
        const sent = await replyToAnchor({ content: `${user}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'seedance2-video.mp4' })] });
        await markJobDelivered(jobId, 'sd2');
        console.log(sent
          ? `${idRef.value} (sd2) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, attached)`
          : `${idRef.value} (sd2) already delivered — resend suppressed`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor,
        prompt: interaction.options.getString('prompt') ?? '',
        user, idRef, commandName, idLabel: 'Task ID',
      });
      await markJobDelivered(jobId, 'sd2');
    } catch (fatal) {
      console.error(`Unhandled error in ${commandName} for ${user.tag}:`, fatal);
      try {
        const body = { content: 'Something went wrong starting that generation.' };
        if (interaction.deferred || interaction.replied) await interaction.editReply(body);
        else await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
      } catch { /* interaction unusable */ }
    }
  } finally {
    releaseSlot(user.id, jobId);
    await jobStore.remove(jobId);
  }
}

// ─── /sd2-5 generation handler (Seedance 2.5) ────────────────────────────────
// Reference images and video are uploaded to the proxy and passed as
// reference_images / reference_videos.

async function runSd25Generation(interaction) {
  const commandName = 'Seedance 2.5';

  if (interaction.guildId !== DISCORD_GUILD_ID) {
    await interaction.reply({ content: 'This bot only works in its home server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const user = interaction.user;
  const jobId = takeSlot(user.id);
  if (!jobId) {
    await interaction.reply({
      content: `You already have ${runningCount(user.id)} of ${MAX_PER_USER} generations running \u2014 wait for one to finish.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const idRef = { value: null };
  const startedAt = Date.now();
  const hidePrompt = Boolean(interaction.options.getBoolean('hideprompt'));
  const { finalise, replyToAnchor, createAnchor } = makeAnchorFns({ interaction, hidePrompt });
  const sd25Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');

  try {
    const prompt = interaction.options.getString('prompt', true);
    const duration = interaction.options.getInteger('duration') ?? SD25_DEFAULT_DURATION;
    const resolution = interaction.options.getString('resolution') ?? SD25_DEFAULT_RESOLUTION;
    const ratio = interaction.options.getString('ratio') ?? SD25_DEFAULT_RATIO;

    const { images: imgAtts, videos: vidAtts, error: refError } = collectReferences(
      interaction, ['img1', 'img2', 'img3'], SD25_MAX_IMAGES, ['vid1'], SD25_MAX_VIDEOS,
    );
    if (refError) {
      await interaction.reply({ content: refError, flags: MessageFlags.Ephemeral });
      return;
    }
    const refCount = (imgAtts?.length ?? 0) + (vidAtts?.length ?? 0);

    const preparing = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Preparing your request')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: sd25Settings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 submitting\u2026`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) {
      const refSummary = [
        imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
        vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join(', ');
      preparing.addFields({ name: 'References', value: refSummary });
      if (imgAtts.length) preparing.setThumbnail(imgAtts[0].url);
    }
    const anchor = await createAnchor(preparing);

    const { taskId } = await sd25.createTask({
      prompt, duration, resolution, ratio,
      images: imgAtts ?? [], videos: vidAtts ?? [],
    });
    idRef.value = taskId;

    try {
      await jobStore.save({
        jobId, kind: 'sd25', userId: user.id, guildId: interaction.guildId,
        channelId: interaction.channelId, anchorMessageId: anchor.id,
        prompt, duration, ratio, resolution,
        refImages: imgAtts?.length ?? 0, refVideos: vidAtts?.length ?? 0, hide: hidePrompt, taskId,
        deadlineAt: startedAt + VIDEO_TIMEOUT, createdAt: startedAt,
      });
    } catch (err) {
      console.warn(`Could not persist sd25 job ${jobId}: ${err?.message ?? err}`);
    }

    const working = new EmbedBuilder()
      .setColor(COLOR_WORKING)
      .setAuthor({ name: commandName })
      .setTitle('Generating your video')
      .setDescription(`>>> ${truncate(prompt, 900)}`)
      .addFields({ name: 'Settings', value: sd25Settings(duration, ratio, resolution) })
      .setFooter({ text: `Requested by ${user.username} \u2022 this takes a few minutes`, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    if (refCount) {
      const refSummary = [
        imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
        vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
      ].filter(Boolean).join(', ');
      working.addFields({ name: 'References', value: refSummary });
      if (imgAtts.length) working.setThumbnail(imgAtts[0].url);
    }
    await finalise(working);

    const { videoUrl } = await sd25.waitForTask(taskId, { intervalMs: POLL_MS, timeoutMs: VIDEO_TIMEOUT, onUpdate: () => {} });

    const file = await sd25.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(interaction.guild);
      const mb = (file.bytes / MB).toFixed(1);

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: commandName })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: sd25Settings(duration, ratio, resolution, [`\`${fmtElapsed(Date.now() - startedAt)}\``]) },
          { name: 'Task ID', value: `\`\`\`${idRef.value ?? ''}\`\`\`` },
        )
        .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() })
        .setTimestamp();
      if (refCount) {
        const refSummary = [
          imgAtts.length ? `${imgAtts.length} image${imgAtts.length > 1 ? 's' : ''}` : null,
          vidAtts.length ? `${vidAtts.length} video${vidAtts.length > 1 ? 's' : ''}` : null,
        ].filter(Boolean).join(', ');
        done.addFields({ name: 'References', value: refSummary });
      }
      await finalise(done);

      if (file.bytes >= limit) {
        await replyToAnchor({ content: `${user}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        await markJobDelivered(jobId, 'sd25');
        console.log(`${idRef.value} (sd2-5) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, over limit)`);
      } else {
        const sent = await replyToAnchor({ content: `${user}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'seedance25-video.mp4' })] });
        await markJobDelivered(jobId, 'sd25');
        console.log(sent
          ? `${idRef.value} (sd2-5) succeeded in ${fmtElapsed(Date.now() - startedAt)} (${mb} MB, attached)`
          : `${idRef.value} (sd2-5) already delivered — resend suppressed`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, {
        finalise, replyToAnchor,
        prompt: interaction.options.getString('prompt') ?? '',
        user, idRef, commandName, idLabel: 'Task ID',
      });
      await markJobDelivered(jobId, 'sd25');
    } catch (fatal) {
      console.error(`Unhandled error in ${commandName} for ${user.tag}:`, fatal);
      try {
        const body = { content: 'Something went wrong starting that generation.' };
        if (interaction.deferred || interaction.replied) await interaction.editReply(body);
        else await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
      } catch { /* interaction unusable */ }
    }
  } finally {
    releaseSlot(user.id, jobId);
    await jobStore.remove(jobId);
  }
}

// â”€â”€â”€ Resume after a restart â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Jobs are persisted the moment the task is submitted, so a crash / OOM-kill /
// deploy mid-render doesn't lose them: on boot we re-poll each task by its id and
// deliver the result to the original message.

function resumeUser(user, id) {
  if (user) return user;
  return { username: 'user', displayAvatarURL: () => undefined, toString: () => `<@${id}>` };
}

async function resumePendingJobs() {
  let records;
  try { records = await jobStore.list(); }
  catch (err) { console.error('Could not read job store:', err); return; }
  if (!records.length) return;
  console.log(`Resuming ${records.length} pending generation(s) from a previous run\u2026`);
  for (const rec of records) {
    resumeOne(rec).catch((err) => console.error(`Resume of ${rec.jobId} failed:`, err));
  }
}

async function resumeOne(rec) {
  let channel = null;
  let anchor = null;
  try {
    channel = await client.channels.fetch(rec.channelId);
    anchor = await channel.messages.fetch(rec.anchorMessageId);
  } catch (err) {
    console.warn(`Resume ${rec.jobId}: original message is gone (${err.message}); dropping.`);
    await jobStore.remove(rec.jobId);
    return;
  }

  const user = await client.users.fetch(rec.userId).catch(() => null);
  const prompt = rec.prompt ?? '';
  const { finalise, replyToAnchor, setAnchor, alreadyDelivered } = makeAnchorFns({ channel, hidePrompt: Boolean(rec.hide) });
  setAnchor(anchor);

  // The outcome already reached the user before a previous shutdown — never
  // deliver a second copy.
  if (rec.delivered) {
    console.log(`Resume ${rec.jobId}: already delivered before the restart; dropping.`);
    await jobStore.remove(rec.jobId);
    return;
  }

  if (rec.kind === 'sd2') return resumeSd2(rec, { user, prompt, channel, finalise, replyToAnchor, alreadyDelivered });
  if (rec.kind === 'sd25') return resumeSd25(rec, { user, prompt, channel, finalise, replyToAnchor, alreadyDelivered });

  // Unknown / removed provider — cannot resume; drop it.
  console.warn(`Resume ${rec.jobId}: unsupported kind '${rec.kind ?? 'legacy'}', dropping.`);
  await jobStore.remove(rec.jobId);
}

// â”€â”€â”€ Resilience â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
client.on('error', (err) => console.error('Client error:', err));
client.on('shardError', (err) => console.error('Shard websocket error:', err));
client.on('shardDisconnect', (event, id) =>
  console.warn(`Shard ${id} disconnected (code ${event?.code ?? '?'}) \u2014 reconnecting\u2026`));
client.on('shardReconnecting', (id) => console.warn(`Shard ${id} reconnecting\u2026`));
client.on('shardResume', (id) => console.log(`Shard ${id} resumed.`));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (ignored, staying up):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (ignored, staying up):', err);
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} \u2014 shutting down cleanly\u2026`);
  try { await client.destroy(); } catch (err) { console.error('Error during shutdown:', err); }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('Failed to log in to Discord:', err);
  process.exit(1);
});

async function resumeSd2(rec, { user, prompt, channel, finalise, replyToAnchor, alreadyDelivered }) {
  const idRef = { value: rec.taskId };
  const sd2Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');
  try {
    const remaining = (rec.deadlineAt ?? 0) - Date.now();
    if (remaining <= 0) {
      await handleGenerationError(
        new Sd2Error(`Generation timed out after ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes.`, { timedOut: true }),
        { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'Seedance 2.0', idLabel: 'Task ID' },
      );
      return;
    }

    try {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: 'Seedance 2.0' })
        .setTitle('Resuming your video')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Status', value: 'Picked this back up after a restart \u2014 still working on it.' })
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp());
    } catch { /* cosmetic */ }

    const { videoUrl } = await sd2.waitForTask(rec.taskId, { intervalMs: POLL_MS, timeoutMs: remaining, onUpdate: () => {} });

    const file = await sd2.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(channel.guild ?? null);
      const mb = (file.bytes / MB).toFixed(1);
      const mention = user ? `${user}` : `<@${rec.userId}>`;

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: 'Seedance 2.0' })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: sd2Settings(rec.duration, rec.ratio, rec.resolution, ['`recovered`']) },
          { name: 'Task ID', value: `\`\`\`${rec.taskId ?? ''}\`\`\`` },
        )
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp();
      if (rec.refImages || rec.refVideos) {
        const refSummary = [rec.refImages ? `${rec.refImages} image${rec.refImages > 1 ? 's' : ''}` : null, rec.refVideos ? `${rec.refVideos} video${rec.refVideos > 1 ? 's' : ''}` : null].filter(Boolean).join(', ');
        if (refSummary) done.addFields({ name: 'References', value: refSummary });
      }
      await finalise(done);

      // The live handler may have sent this result just before the restart
      // (message landed, tombstone/cleanup didn't). Never send it twice.
      if (await alreadyDelivered({ anyKind: true })) {
        console.log(`${rec.taskId} (sd2 resumed) already delivered before the restart; skipping resend.`);
      } else if (file.bytes >= limit) {
        await replyToAnchor({ content: `${mention}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        await markJobDelivered(rec.jobId, 'sd2');
        console.log(`${rec.taskId} (sd2 resumed) succeeded (${mb} MB, over limit)`);
      } else {
        const sent = await replyToAnchor({ content: `${mention}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'seedance2-video.mp4' })] });
        await markJobDelivered(rec.jobId, 'sd2');
        console.log(sent
          ? `${rec.taskId} (sd2 resumed) succeeded (${mb} MB, attached)`
          : `${rec.taskId} (sd2 resumed) already delivered — resend suppressed`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'Seedance 2.0', idLabel: 'Task ID' });
      await markJobDelivered(rec.jobId, 'sd2');
    } catch (fatal) {
      console.error(`Resume sd2 ${rec.jobId} delivery failed:`, fatal);
    }
  } finally {
    await jobStore.remove(rec.jobId);
  }
}

async function resumeSd25(rec, { user, prompt, channel, finalise, replyToAnchor, alreadyDelivered }) {
  const idRef = { value: rec.taskId };
  const sd25Settings = (d, rt, res, extra = []) => [`\`${d}s\``, `\`${rt}\``, `\`${res}\``, ...extra].join(' \u2022 ');
  try {
    const remaining = (rec.deadlineAt ?? 0) - Date.now();
    if (remaining <= 0) {
      await handleGenerationError(
        new Sd2Error(`Generation timed out after ${Math.max(1, Math.round(VIDEO_TIMEOUT / 60_000))} minutes.`, { timedOut: true }),
        { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'Seedance 2.5', idLabel: 'Task ID' },
      );
      return;
    }

    try {
      await finalise(new EmbedBuilder()
        .setColor(COLOR_WORKING)
        .setAuthor({ name: 'Seedance 2.5' })
        .setTitle('Resuming your video')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields({ name: 'Status', value: 'Picked this back up after a restart \u2014 still working on it.' })
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp());
    } catch { /* cosmetic */ }

    const { videoUrl } = await sd25.waitForTask(rec.taskId, { intervalMs: POLL_MS, timeoutMs: remaining, onUpdate: () => {} });

    const file = await sd25.downloadFile(videoUrl);
    try {
      const limit = uploadLimitBytes(channel.guild ?? null);
      const mb = (file.bytes / MB).toFixed(1);
      const mention = user ? `${user}` : `<@${rec.userId}>`;

      const done = new EmbedBuilder()
        .setColor(COLOR_DONE)
        .setAuthor({ name: 'Seedance 2.5' })
        .setTitle('Your video is ready')
        .setDescription(`>>> ${truncate(prompt, 900)}`)
        .addFields(
          { name: 'Settings', value: sd25Settings(rec.duration, rec.ratio, rec.resolution, ['`recovered`']) },
          { name: 'Task ID', value: `\`\`\`${rec.taskId ?? ''}\`\`\`` },
        )
        .setFooter({ text: user ? `Requested by ${user.username}` : 'Recovered after a restart', iconURL: user?.displayAvatarURL?.() })
        .setTimestamp();
      if (rec.refCount) {
        const refSummary = [rec.refImages ? `${rec.refImages} image${rec.refImages > 1 ? 's' : ''}` : null, rec.refVideos ? `${rec.refVideos} video${rec.refVideos > 1 ? 's' : ''}` : null].filter(Boolean).join(', ');
        if (refSummary) done.addFields({ name: 'References', value: refSummary });
      }
      await finalise(done);

      // The live handler may have sent this result just before the restart
      // (message landed, tombstone/cleanup didn't). Never send it twice.
      if (await alreadyDelivered({ anyKind: true })) {
        console.log(`${rec.taskId} (sd2-5 resumed) already delivered before the restart; skipping resend.`);
      } else if (file.bytes >= limit) {
        await replyToAnchor({ content: `${mention}\nYour video rendered but it's ${mb} MB, over this server's ${Math.round(limit / MB)} MB upload limit.` });
        await markJobDelivered(rec.jobId, 'sd25');
        console.log(`${rec.taskId} (sd2-5 resumed) succeeded (${mb} MB, over limit)`);
      } else {
        const sent = await replyToAnchor({ content: `${mention}`, files: [new AttachmentBuilder(createReadStream(file.path), { name: 'seedance25-video.mp4' })] });
        await markJobDelivered(rec.jobId, 'sd25');
        console.log(sent
          ? `${rec.taskId} (sd2-5 resumed) succeeded (${mb} MB, attached)`
          : `${rec.taskId} (sd2-5 resumed) already delivered — resend suppressed`);
      }
    } finally {
      await safeUnlink(file.path);
    }
  } catch (err) {
    try {
      await handleGenerationError(err, { finalise, replyToAnchor, prompt, user: resumeUser(user, rec.userId), idRef, commandName: 'Seedance 2.5', idLabel: 'Task ID' });
      await markJobDelivered(rec.jobId, 'sd25');
    } catch (fatal) {
      console.error(`Resume sd2-5 ${rec.jobId} delivery failed:`, fatal);
    }
  } finally {
    await jobStore.remove(rec.jobId);
  }
}

