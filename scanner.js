'use strict';
require('dotenv').config();
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs/promises');
const path = require('node:path');
const { connectDB } = require('./db');
const { Source, QueuedVideo, ScanHistory } = require('./models');
const logger = require('./logger');

const LIMIT = Math.min(10000, Math.max(1, Number.parseInt(process.env.VIDEOS_PER_SOURCE || '50', 10) || 50));
const MAX_RETRIES = Math.max(1, Number.parseInt(process.env.MAX_RETRIES || '3', 10) || 3);
const PRIORITY_RANK = { HIGH: 1, NORMAL: 2, LOW: 3 };
let activeAll = false;
const activeSources = new Set();

function runYtDlp(source, limit) {
  return new Promise((resolve, reject) => {
    const executable = process.env.YT_DLP_PATH || 'yt-dlp';
    const args = ['--dump-json', '--playlist-end', String(limit), '--ignore-errors', '--no-warnings', '--skip-download', source.url];
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const entries = [];
    let stderr = ''; let settled = false; let parseErrors = 0;
    const timeout = setTimeout(() => { child.kill(); if (!settled) { settled = true; clearInterval(heartbeat); reject(new Error('yt-dlp timed out after 5 minutes')); } }, 300000);
    const heartbeat = setInterval(() => logger.info('ytdlp_process_still_running', { sourceId: String(source._id), sourceName: source.name, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000), metadataEntriesReceived: entries.length, targetEntries: limit }), 30000);
    const startedAt = Date.now();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const outputLines = readline.createInterface({ input: child.stdout });
    outputLines.on('line', line => {
      if (!line.trim()) return;
      try {
        const entry = JSON.parse(line);
        entries.push(entry);
        logger.info('ytdlp_video_metadata_received', { sourceId: String(source._id), sourceName: source.name, videoNumber: entries.length, videoId: entry.id || null, title: String(entry.title || '').slice(0, 180), uploadDate: entry.upload_date || null, durationSeconds: entry.duration ?? null });
      } catch (err) {
        parseErrors++;
        logger.warn('ytdlp_metadata_line_invalid', { sourceId: String(source._id), sourceName: source.name, message: err.message });
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('spawn', () => logger.info('ytdlp_process_started', { sourceId: String(source._id), sourceName: source.name, executable, maxEntries: limit, metadataOnly: true, videoDownload: false }));
    child.on('error', err => { if (!settled) { settled = true; clearTimeout(timeout); clearInterval(heartbeat); reject(err); } });
    child.on('close', code => {
      clearTimeout(timeout); clearInterval(heartbeat);
      if (settled) return;
      settled = true;
      if (code !== 0 && entries.length) logger.warn('ytdlp_partial_exit', { sourceId: String(source._id), sourceName: source.name, exitCode: code, metadataEntriesReceived: entries.length, stderr: stderr.trim().slice(-2000) });
      if (code !== 0 && !entries.length) return reject(new Error((stderr.trim() || `yt-dlp exited ${code}`).slice(-2000)));
      logger.info('ytdlp_process_finished', { sourceId: String(source._id), sourceName: source.name, exitCode: code, metadataEntriesReceived: entries.length, invalidLines: parseErrors, durationMs: Date.now() - startedAt });
      resolve(entries);
    });
  });
}
function videoId(entry) { return entry.id || (entry.url && /^[\w-]{11}$/.test(entry.url) ? entry.url : null); }
function videoUrl(entry, id) { return entry.webpage_url || entry.url && /^https?:/.test(entry.url) && entry.url || `https://www.youtube.com/watch?v=${id}`; }
function findMatches(source, entry, description = entry.description || '', thumbnailText = '') {
  const includedDescription = source.scanDescription === false && source.generateNfo !== true ? '' : description;
  const text = `${entry.title || ''}\n${includedDescription}\n${thumbnailText}`.toLocaleLowerCase();
  const excludes = source.excludeKeywords || [];
  if (excludes.some(k => k && text.includes(k.toLocaleLowerCase()))) return { accepted: false, matches: [] };
  const includes = (source.keywords || []).filter(Boolean);
  if (!includes.length) return { accepted: true, matches: [] };
  const matches = includes.filter(k => text.includes(k.toLocaleLowerCase()));
  return { accepted: source.matchMode === 'ALL' ? matches.length === includes.length : matches.length > 0, matches };
}
async function thumbnailTextFromUrl(url) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !(parsed.hostname === 'i.ytimg.com' || parsed.hostname.endsWith('.googleusercontent.com'))) throw new Error('Thumbnail host is not allowed');
  const response = await fetch(parsed, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Thumbnail request returned HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== 'https:' || !(finalUrl.hostname === 'i.ytimg.com' || finalUrl.hostname.endsWith('.googleusercontent.com'))) throw new Error('Thumbnail redirect host is not allowed');
  const mimeType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error(`Unsupported thumbnail format: ${mimeType || 'unknown'}`);
  const image = Buffer.from(await response.arrayBuffer());
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent';
  const result = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [
      { text: 'Read and transcribe every word visible in this YouTube thumbnail. Preserve the original scripts and wording. Return only the visible text, without explanation.' },
      { inline_data: { mime_type: mimeType, data: image.toString('base64') } }
    ] }] })
  });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(payload.error?.message || `Gemini API returned HTTP ${result.status}`);
  const text = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n').trim();
  if (text === undefined) throw new Error('Gemini returned no thumbnail text');
  return text;
}
function xmlEscape(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function xmlUnescape(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function createNfo(entry, id) {
  const plot = entry.description || '';
  const date = entry.upload_date || entry.release_date || '';
  const year = date.length >= 4 ? date.slice(0, 4) : '';
  const runtime = Number.isFinite(entry.duration) ? Math.round(entry.duration) : '';
  const thumbnail = entry.thumbnail || (Array.isArray(entry.thumbnails) && entry.thumbnails.at(-1)?.url) || '';
  const url = videoUrl(entry, id);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<movie>\n  <title>${xmlEscape(entry.title || id)}</title>\n  <plot>${xmlEscape(plot)}</plot>\n  <uniqueid type="youtube" default="true">${xmlEscape(id)}</uniqueid>\n  <url>${xmlEscape(url)}</url>\n  <premiered>${xmlEscape(date)}</premiered>\n  <year>${xmlEscape(year)}</year>\n  <runtime>${runtime}</runtime>\n  <thumb>${xmlEscape(thumbnail)}</thumb>\n</movie>\n`;
}
async function descriptionFromNfo(source, entry, id) {
  const directory = process.env.NFO_DIRECTORY || path.join(process.cwd(), 'nfo');
  const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
  const filePath = path.join(directory, String(source._id), `${safeId}.nfo`);
  const nfo = createNfo(entry, id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, nfo, { encoding: 'utf8' });
  const contents = await fs.readFile(filePath, 'utf8');
  const plot = contents.match(/<plot>([\s\S]*?)<\/plot>/);
  const description = plot ? xmlUnescape(plot[1]) : '';
  logger.info('nfo_generated_and_read', { sourceId: String(source._id), sourceName: source.name, videoId: id, filePath, bytes: Buffer.byteLength(contents) });
  return description;
}
async function upsertVideo(source, entry, matches) {
  const id = videoId(entry);
  if (!id) return;
  const priority = source.priority || 'NORMAL';
  // Stable contribution allows $addToSet to deduplicate this source on rediscovery.
  const contribution = { sourceId: source._id, name: source.name, type: source.type, priority, matchedKeywords: matches };
  const approval = source.autoApproveVideos || String(process.env.REQUIRE_MANUAL_APPROVAL || 'true').toLowerCase() !== 'true' ? 'APPROVED' : 'PENDING';
  const url = videoUrl(entry, id);
  try {
    await QueuedVideo.updateOne({ youtubeId: id }, {
      $setOnInsert: {
        youtubeId: id, title: entry.title || '', description: entry.description || '', url,
        thumbnail: entry.thumbnail || (Array.isArray(entry.thumbnails) && entry.thumbnails.at(-1)?.url) || '',
        uploadDate: entry.upload_date || entry.release_date || '', duration: Number.isFinite(entry.duration) ? entry.duration : null,
        approvalStatus: approval, status: approval === 'APPROVED' ? 'PENDING' : 'AWAITING_APPROVAL', retryCount: 0, maxRetries: MAX_RETRIES,
        lastError: '', discoveredAt: new Date(), processedAt: null
      },
      $addToSet: { discoveredSources: contribution, matchedKeywords: { $each: matches } },
      $min: { priorityRank: PRIORITY_RANK[priority] || 2 }
    }, { upsert: true });
    // Keep display priority aligned with the highest-priority source, without changing importer/approval state.
    await QueuedVideo.updateOne({ youtubeId: id, priorityRank: PRIORITY_RANK[priority] || 2 }, { $set: { priority } });
    if (source.autoApproveVideos) await QueuedVideo.updateOne({ youtubeId: id, approvalStatus: 'PENDING', status: { $in: ['AWAITING_APPROVAL', 'PENDING'] } }, { $set: { approvalStatus: 'APPROVED', status: 'PENDING' } });
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Another scan inserted this ID between our lookup/upsert attempt. Add our
    // source contribution to that winning record without touching its status.
    await QueuedVideo.updateOne({ youtubeId: id }, {
      $addToSet: { discoveredSources: contribution, matchedKeywords: { $each: matches } },
      $min: { priorityRank: PRIORITY_RANK[priority] || 2 }
    });
    await QueuedVideo.updateOne({ youtubeId: id, priorityRank: PRIORITY_RANK[priority] || 2 }, { $set: { priority } });
    if (source.autoApproveVideos) await QueuedVideo.updateOne({ youtubeId: id, approvalStatus: 'PENDING', status: { $in: ['AWAITING_APPROVAL', 'PENDING'] } }, { $set: { approvalStatus: 'APPROVED', status: 'PENDING' } });
  }
}
async function scanSource(source) {
  const sourceKey = String(source._id);
  if (activeSources.has(sourceKey)) return { skipped: true, reason: 'source scan already running' };
  const lockUntil = new Date(Date.now() + 6 * 60 * 1000);
  const lock = await Source.findOneAndUpdate({ _id: source._id, $or: [{ scanLockUntil: null }, { scanLockUntil: { $lt: new Date() } }] }, { $set: { scanLockUntil: lockUntil } }, { new: true, select: '+scanLockUntil' });
  if (!lock) {
    logger.warn('source_scan_skipped_locked', { sourceId: sourceKey, sourceName: source.name });
    return { sourceId: sourceKey, skipped: true, reason: 'source scan already running' };
  }
  activeSources.add(sourceKey);
  const startedAt = new Date();
  const history = await ScanHistory.create({ sourceId: source._id, sourceName: source.name, sourceType: source.type, startedAt });
  const limit = Number.isInteger(source.videosPerScan) ? Math.min(10000, Math.max(1, source.videosPerScan)) : LIMIT;
  let inspected = 0, matched = 0, rejected = 0, geminiAttempted = 0, geminiWarned = false; const errors = [];
  logger.info('source_scan_started', { sourceId: sourceKey, sourceName: source.name, sourceType: source.type, maxEntries: limit, scanDescription: source.scanDescription !== false, generateNfo: source.generateNfo === true, thumbnailGeminiEnabled: source.thumbnailGeminiEnabled === true });
  try {
    const entries = await runYtDlp(source, limit);
    for (const entry of entries.slice(0, limit)) {
      const id = videoId(entry); if (!id) continue;
      inspected++;
      try {
        const description = source.generateNfo === true ? await descriptionFromNfo(source, entry, id) : (entry.description || '');
        let result = findMatches(source, entry, description);
        if (source.thumbnailGeminiEnabled === true) {
          geminiAttempted++;
          const thumbnail = entry.thumbnail || (Array.isArray(entry.thumbnails) && entry.thumbnails.at(-1)?.url);
          try {
            if (!thumbnail) throw new Error('No thumbnail URL in video metadata');
            logger.gemini('REQUEST', { model: 'gemini-3.1-flash-lite', sourceId: sourceKey, sourceName: source.name, youtubeId: id, title: String(entry.title || '').slice(0, 180) });
            const thumbnailText = await thumbnailTextFromUrl(thumbnail);
            result = findMatches(source, entry, description, thumbnailText);
            logger.gemini(result.accepted ? 'ACCEPTED' : 'REJECTED', { model: 'gemini-3.1-flash-lite', sourceId: sourceKey, sourceName: source.name, youtubeId: id, title: String(entry.title || '').slice(0, 180), extractedText: thumbnailText, matchedKeywords: result.matches, matchMode: source.matchMode || 'ANY' });
          } catch (err) {
            logger.gemini('ERROR', { model: 'gemini-3.1-flash-lite', sourceId: sourceKey, sourceName: source.name, youtubeId: id, title: String(entry.title || '').slice(0, 180), message: err.message });
            if (!geminiWarned) {
              logger.warn('thumbnail_gemini_failed', { sourceId: sourceKey, sourceName: source.name, message: err.message, hint: 'Metadata matching will continue; verify GEMINI_API_KEY and Gemini API access.' });
              geminiWarned = true;
            }
          }
        }
        if (!result.accepted) {
          rejected++;
          logger.debug('video_rejected_by_keywords', { sourceId: sourceKey, youtubeId: id, descriptionChecked: source.scanDescription !== false, nfoUsed: source.generateNfo === true });
          continue;
        }
        await upsertVideo(source, entry, result.matches);
        matched++;
        logger.debug('video_queued_or_refreshed', { sourceId: sourceKey, youtubeId: id, matchedKeywords: result.matches, descriptionChecked: source.scanDescription !== false, nfoUsed: source.generateNfo === true });
      } catch (err) {
        errors.push(`${id}: ${err.message}`);
        logger.error('video_metadata_processing_failed', { sourceId: sourceKey, sourceName: source.name, youtubeId: id, nfoUsed: source.generateNfo === true, message: err.message });
      }
    }
    const completedAt = new Date();
    await Source.updateOne({ _id: source._id }, { $set: { lastScannedAt: completedAt } });
    await ScanHistory.updateOne({ _id: history._id }, { $set: { completedAt, inspected, matched, rejected, errorCount: errors.length, errorDetails: errors, status: errors.length ? (inspected ? 'PARTIAL' : 'FAILED') : 'COMPLETED' } });
    logger.info('source_scan_completed', { sourceId: sourceKey, sourceName: source.name, status: errors.length ? (inspected ? 'PARTIAL' : 'FAILED') : 'COMPLETED', inspected, matched, rejected, thumbnailGeminiAttempted: geminiAttempted, errors: errors.length, durationMs: completedAt.getTime() - startedAt.getTime() });
    return { sourceId: sourceKey, inspected, matched, rejected, errors: errors.length };
  } catch (err) {
    errors.push(err.message);
    const completedAt = new Date();
    await Source.updateOne({ _id: source._id }, { $set: { lastScannedAt: completedAt } }).catch(() => {});
    await ScanHistory.updateOne({ _id: history._id }, { $set: { completedAt, inspected, matched, rejected, errorCount: errors.length, errorDetails: errors, status: 'FAILED' } });
    const message = err.code === 'ENOENT' ? `yt-dlp executable not found. Install yt-dlp and ensure it is on PATH, or set YT_DLP_PATH to its executable. (${process.env.YT_DLP_PATH || 'yt-dlp'})` : err.message;
    logger.error('source_scan_failed', { sourceId: sourceKey, sourceName: source.name, inspected, matched, rejected, message: err.message, hint: message, durationMs: completedAt.getTime() - startedAt.getTime() });
    return { sourceId: sourceKey, inspected, matched, rejected, errors: errors.length, error: message };
  } finally {
    activeSources.delete(sourceKey);
    await Source.updateOne({ _id: source._id }, { $set: { scanLockUntil: null } }).catch(() => {});
  }
}
async function scanAll() {
  if (activeAll) throw new Error('A full scan is already running');
  activeAll = true;
  try {
    await migrateLegacyThumbnailSetting();
    const sources = await Source.find({ enabled: true }).sort({ createdAt: 1 }).lean();
    logger.info('full_scan_started', { enabledSources: sources.length, defaultMaxEntriesPerSource: LIMIT, perSourceLimitsEnabled: true });
    const results = [];
    for (const source of sources) results.push(await scanSource(source));
    logger.info('full_scan_completed', { sourceCount: results.length, scanned: results.filter(item => !item.skipped).length, skipped: results.filter(item => item.skipped).length });
    return results;
  } finally { activeAll = false; }
}
async function scanOne(id) {
  await migrateLegacyThumbnailSetting();
  const source = await Source.findById(id).lean();
  if (!source) { const err = new Error('Source not found'); err.status = 404; throw err; }
  if (!source.enabled) { const err = new Error('Source is disabled'); err.status = 409; throw err; }
  return scanSource(source);
}
async function migrateLegacyThumbnailSetting() {
  await Source.collection.updateMany({ thumbnailOcrEnabled: true }, { $set: { thumbnailGeminiEnabled: true }, $unset: { thumbnailOcrEnabled: 1 } });
  await Source.collection.updateMany({ thumbnailOcrEnabled: { $exists: true } }, { $unset: { thumbnailOcrEnabled: 1 } });
}
module.exports = { scanAll, scanOne, runYtDlp, findMatches, migrateLegacyThumbnailSetting, LIMIT };
if (require.main === module) {
  require('dotenv').config();
  const { connectDB } = require('./db');
  connectDB().then(async () => {
    logger.info('scanner_process_started', { mongodb: 'connected' });
    const result = await scanAll();
    logger.info('scanner_process_finished', { sourceCount: result.length });
    await require('mongoose').disconnect();
  }).catch(err => { logger.error('scanner_process_failed', { message: err.message, stack: err.stack }); process.exitCode = 1; });
}
