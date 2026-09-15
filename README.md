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

- Generations are persisted to `GEN_JOB_STORE_DIR` the moment they're submitted,
  so a restart / OOM-kill / deploy mid-render resumes and delivers on next boot.
  Point it at a persistent volume if your host wipes the working dir on restart.
- The result video is streamed to disk and attached from disk to keep memory low.
- Reference images/videos are uploaded to the generation proxy and passed as
  reference media (never as a first frame).
- Provider-specific error reasons are shown to the user (e.g. reference video
  duration limits, copyright / content-policy blocks) with backend identifiers
  redacted; full raw errors go to console only.
- `npm start` caps the V8 heap (`--max-old-space-size=640`) for small (~1 GB)
  hosts; lower it to `512` if needed.
