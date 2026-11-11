# YouTube Scanner

Node.js 20+ application that scans YouTube channel uploads, playlists, and Shorts sources with yt-dlp metadata only. Matching videos are stored once in MongoDB for an independent TubeArchivist importer. This project does not download video files or call TubeArchivist.

## Install and run

Requirements: Node.js 20+, MongoDB, and yt-dlp available on `PATH` (or set `YT_DLP_PATH`).

```sh
npm install
cp .env.example .env
# Edit .env for your MongoDB URI and settings
npm start
```

Open `http://localhost:3000`. The server listens on `0.0.0.0` for LAN access. There is no authentication; only expose it on a trusted LAN and restrict access with your firewall or reverse proxy. Do not port-forward it to the public internet.

Run discovery independently with `npm run scan`; this scans every enabled source and exits. Cron or a systemd timer can invoke `node /path/to/youtubeascanner/scanner.js`. Per-source MongoDB leases prevent overlapping scans across server/scanner processes; the lease expires after six minutes if a process exits unexpectedly.

`VIDEOS_PER_SOURCE` controls the maximum entries scanned per source (default 50). `REQUIRE_MANUAL_APPROVAL=true` puts new discoveries in pending approval; when false, new videos are approved automatically. Existing approval decisions are kept. `MAX_RETRIES` sets the initial retry ceiling for new queue records.

The server automatically scans enabled sources every 360 minutes by default. Change the interval or pause/resume automatic scans from the Overview dashboard; settings are stored in MongoDB and survive container restarts. The interval can be set from 1 to 10080 minutes. `npm run scan` remains a one-shot scan.

## Scanner behavior

- `yt-dlp --dump-json --playlist-end N --ignore-errors --no-warnings --skip-download` retrieves metadata only. The scanner stores title, description, thumbnail, upload date, duration, and YouTube ID.
- Include/exclude keywords are case-insensitive and search title plus description. Exclusions take precedence. Empty include rules accept any non-excluded video. ANY means at least one include term; ALL means every include term.
- A unique index on `youtubeId` prevents duplicate queue records. Rediscovery adds the source contribution and matched terms, while `$setOnInsert` preserves approval, import status, retries, and original discovery time.
- Queue priority is the highest priority among discovery sources: HIGH, then NORMAL, then LOW. `priorityRank` (1/2/3) is stored and importer queries should sort by it, then oldest `discoveredAt`.
- Source deletion does not remove queue records or scan history.
- Channel URLs should point to the channel root or `/videos` tab. Playlist URLs can be regular playlist URLs. For Shorts, use the channel Shorts tab URL (for example `https://www.youtube.com/@handle/shorts`) or a Shorts playlist URL accepted by yt-dlp. yt-dlp behavior can vary with YouTube changes and may require updating yt-dlp.

## API

Sources: `GET/POST /api/sources`, `PUT/DELETE /api/sources/:id`. A source POST accepts `name`, `url`, `type` (`channel`, `playlist`, `shorts`), `keywords`, `excludeKeywords`, `matchMode` (`ANY`/`ALL`), `priority` (`HIGH`/`NORMAL`/`LOW`), `enabled`, and channel-only `autoApproveVideos`. When enabled, matching videos from that channel are approved automatically and bypass the manual approval step.

Queue: `GET /api/queue` accepts `status`, `approvalStatus`, `priority`, `q`, `page`, and `limit` (maximum 100). Approval: `POST /api/queue/:id/approve`, `/reject`, and `/api/queue/bulk-approve` with `{ "ids": ["..."] }`. Retry: `POST /api/queue/:id/retry` or `/api/queue/bulk-retry` for eligible failures. `POST /api/queue/:id/reset` manually resets a non-rejected failed record and its retry counter. Scanning: `POST /api/scan`, `POST /api/scan/:sourceId`. History: `GET /api/scan-history` and `/api/scan-history/:sourceId`. Scan scheduling: `GET/PUT /api/settings/scan` (`autoScanEnabled`, `scanIntervalMinutes`, valid range 1–10080). Statistics: `GET /api/stats`. All API responses are JSON.

## MongoDB example documents

`sources`:

```json
{
  "_id": "665000000000000000000001",
  "name": "Space news",
  "url": "https://www.youtube.com/@example/videos",
  "type": "channel",
  "keywords": ["astronomy", "spaceflight"],
  "excludeKeywords": ["reaction"],
  "matchMode": "ANY",
  "priority": "HIGH",
  "enabled": true,
  "lastScannedAt": null
}
```

`youtube_queue`:

```json
{
  "youtubeId": "dQw4w9WgXcQ",
  "title": "Example video",
  "description": "Example metadata description",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  "uploadDate": "20250101",
  "duration": 120,
  "discoveredSources": [{ "sourceId": "665000000000000000000001", "name": "Space news", "type": "channel", "priority": "HIGH", "matchedKeywords": ["spaceflight"] }],
  "matchedKeywords": ["spaceflight"],
  "priority": "HIGH",
  "priorityRank": 1,
  "approvalStatus": "PENDING",
  "status": "PENDING",
  "retryCount": 0,
  "maxRetries": 3,
  "lastError": "",
  "discoveredAt": "2025-01-02T12:00:00.000Z",
  "processedAt": null
}
```

`scan_history` records a separate document per source scan, including RUNNING/COMPLETED/PARTIAL/FAILED status, timestamps, counts, and error details.

## TubeArchivist importer example

The importer can connect using its own Mongoose connection and the same queue schema, or define a compatible model targeting `youtube_queue`. Import only approved, eligible videos; `priorityRank` and the timestamp give the requested order:

```js
const videos = await QueuedVideo.find({
  status: 'PENDING',
  approvalStatus: 'APPROVED',
  $expr: { $lt: ['$retryCount', '$maxRetries'] }
}).sort({ priorityRank: 1, discoveredAt: 1 }).limit(50).lean();

// Claim each item atomically before sending it to TubeArchivist.
const claimed = await QueuedVideo.findOneAndUpdate(
  { _id: video._id, status: 'PENDING', approvalStatus: 'APPROVED',
    $expr: { $lt: ['$retryCount', '$maxRetries'] } },
  { $set: { status: 'PROCESSING' } }, { new: true }
);

// On success:
await QueuedVideo.updateOne({ _id: claimed._id, status: 'PROCESSING' },
  { $set: { status: 'PROCESSED', processedAt: new Date(), lastError: '' } });

// On importer failure:
await QueuedVideo.updateOne({ _id: claimed._id, status: 'PROCESSING' }, [
  { $set: { retryCount: { $add: ['$retryCount', 1] }, lastError: error.message,
    status: { $cond: [{ $gte: [{ $add: ['$retryCount', 1] }, '$maxRetries'] }, 'FAILED', 'PENDING'] } } }
]);
```

The queue marks permanently exhausted failures as FAILED. Rejected videos should be filtered out of importer queries and cannot be manually retried through this API. The retry endpoint applies only while below `maxRetries`; the reset endpoint clears the counter for an intentional fresh attempt.

## Operational notes

Collections are `sources`, `youtube_queue`, `scan_history`, and `scanner_settings`. Mongoose creates the unique URL and YouTube ID indexes and queue/history query indexes on startup. The app is suitable for ARM64 systems when compatible Node.js, MongoDB, and yt-dlp builds are installed.

## Run with Docker Compose

Docker Compose starts only the scanner app. It installs yt-dlp inside the app image and reads the online MongoDB connection string from `MONGODB_URI` supplied to Compose. It does not install or start MongoDB. The Compose file does not require an `env_file: .env` path, so it also works when Portainer supplies the environment file for the stack.

```sh
docker compose up -d --build --remove-orphans
docker compose ps
docker compose logs -f app
```

Open `http://localhost:3000`. Run a one-off scan with `docker compose exec app npm run scan`. Stop the app with `docker compose down`; data remains in the online MongoDB instance.

For local Compose, set `MONGODB_URI` in `.env` to your provider's full connection string; Compose automatically reads `.env` for variable substitution. In Portainer, add `MONGODB_URI` and any optional settings such as `PORT`, `VIDEOS_PER_SOURCE`, `MAX_RETRIES`, `REQUIRE_MANUAL_APPROVAL`, and `LOG_LEVEL` in the stack environment variables or uploaded environment file. Deployment fails clearly if `MONGODB_URI` is missing. Set `PORT` to change the published and container app port.

Application logs are structured JSON with ISO timestamps and are written to stdout/stderr, so they are visible with `docker compose logs -f --tail 200 app`. The default Docker `LOG_LEVEL=debug` includes per-video match/rejection records, scan counts and duration, API request status, startup/index status, and errors. Set `LOG_LEVEL=info` in `.env` to reduce per-video detail. Docker retains rotated logs using the configured `json-file` logging driver (three 10 MB files).

The Docker dashboard has no authentication; restrict the published port to a trusted LAN.
