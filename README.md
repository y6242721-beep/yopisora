# Yopisora — video bot

A single-server Discord bot: `/sd2` and `/sd2-5`.

## Commands

`/sd2` — Seedance 2.0
- `prompt` (required)
- `duration` — 5, 10 (default), 15 seconds
- `resolution` — 480p, 720p (default)
- `ratio` — 16:9 (default), 9:16
- `img1`–`img3` — optional reference images
- `vid1` — optional reference video

`/sd2-5` — Seedance 2.5
- `prompt` (required)
- `duration` — 5, 10 (default), 15, 20, 25, 30 seconds
- `resolution` — 480p, 720p (default)
- `ratio` — 16:9 (default), 9:16, 21:9
- `img1`–`img3` — optional reference images
- `vid1` — optional reference video

## Setup

1. `npm install`
2. Fill `.env`: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`
   (`/sd2` and `/sd2-5` need no API key)
3. `npm run register`
4. `npm start`

## Notes

- Generations are persisted to `GEN_JOB_STORE_DIR` the moment they're submitted.
  Completed renders keep their video URL until Discord confirms a result message.
  Pending work is checked every minute and recovered after a restart. Temporary
  delivery failures back off from 1 to 30 minutes, with the schedule saved on disk.
  Point it at a persistent volume if your host wipes the working dir on restart.
- Result messages use a stable per-task Discord nonce and a saved message receipt.
  Interrupted sends are checked against paginated history for that exact task;
  another render or an error reply cannot count as its video delivery.
- Give the bot View Channel, Send Messages, Attach Files, Embed Links, and
  Read Message History (plus Send Messages in Threads where applicable).
  History access lets it confirm whether an interrupted upload reached Discord.
- The ready card is shown only after confirmed delivery. Upload failures leave
  a pending status and a recoverable job. Videos above the server upload limit
  receive a size-limit notice without a download link.
- Expired/rejected video URLs are refreshed through the existing task endpoint.
  If the provider only returns an expired link, the bot sends one expiration
  notice and completes that job instead of endlessly retrying the dead URL.
- Videos are downloaded to temporary disk files. Each upload attempt opens the
  file afresh; discord.js still buffers attachments while constructing its request.
- Reference images/videos are uploaded to the generation proxy and passed as
  reference media (never as a first frame).
- Provider-specific error reasons are shown to the user (e.g. reference video
  duration limits, copyright / content-policy blocks) with backend identifiers
  redacted; full raw errors go to console only.
- `npm start` caps the V8 heap at 512 MB for small (~1 GB) hosts.
- `npm test` runs offline regression tests for delivery, restart recovery,
  generation status handling, and job persistence. It does not generate videos
  or send Discord messages.
