'use strict';
require('dotenv').config();
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { connectDB } = require('./db');
const { Source, QueuedVideo, ScanHistory } = require('./models');
const logger = require('./logger');
const imagekit = require('./imagekit');

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
  if (excludes.some(k => k && text.includes(k.toLocaleLowerCase()))) return { accepted: false, matches: [], excluded: true };
  const includes = (source.keywords || []).filter(Boolean);
  if (!includes.length) return { accepted: true, matches: [], excluded: false };
  const matches = includes.filter(k => text.includes(k.toLocaleLowerCase()));
  return { accepted: source.matchMode === 'ALL' ? matches.length === includes.length : matches.length > 0, matches, excluded: false };
}
async function thumbnailTextFromUrl(url, visualReference = null) {
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
  const parts = [{ text: visualReference
    ? 'Compare the reference image with the YouTube thumbnail. Ignore all people and faces completely; do not compare or identify anyone. Decide whether the same non-person object or a distinctive scene shown in the reference is visibly present in the thumbnail. Also transcribe visible thumbnail text. Return JSON with boolean visual_match and string thumbnail_text. Set visual_match true only for a clear match of the same object or distinctive scene, not merely a similar category.'
    : 'Read and transcribe every word visible in this YouTube thumbnail. Preserve the original scripts and wording. Return only the visible text, without explanation.' }];
  if (visualReference) parts.push({ inline_data: { mime_type: visualReference.mimeType, data: visualReference.image.toString('base64') } });
  parts.push({ inline_data: { mime_type: mimeType, data: image.toString('base64') } });
  const requestBody = { contents: [{ parts }] };
  if (visualReference) requestBody.generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: { type: 'OBJECT', properties: { visual_match: { type: 'BOOLEAN' }, thumbnail_text: { type: 'STRING' } }, required: ['visual_match', 'thumbnail_text'] }
  };
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent';
  const result = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(requestBody)
  });
  const payload = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(`${payload.error?.message || 'Gemini API request failed'} (HTTP ${result.status})`);
  const responseText = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n').trim();
  if (responseText === undefined) throw new Error('Gemini returned no thumbnail analysis');
  if (!visualReference) return { text: responseText, visualMatch: false };
  const analysis = JSON.parse(responseText);
  if (typeof analysis.visual_match !== 'boolean' || typeof analysis.thumbnail_text !== 'string') throw new Error('Gemini returned an invalid visual match result');
  return { text: analysis.thumbnail_text, visualMatch: analysis.visual_match };
}
async function scanNewGeminiThumbnails(source, entries) {
  const results = new Map();
  let visualReference = null;
  if (source.visualMatchEnabled) {
    try {
      const storedSource = await Source.findById(source._id).select('+visualReferenceImage +visualReferenceFileId +visualReferenceUrl visualReferenceMimeType');
      let fileId = storedSource?.visualReferenceFileId || '';
      let imageUrl = storedSource?.visualReferenceUrl || '';
      if ((!fileId || !imageUrl) && storedSource?.visualReferenceImage?.length && storedSource.visualReferenceMimeType) {
        const legacyImage = Buffer.from(storedSource.visualReferenceImage);
        const uploaded = await imagekit.uploadReferenceImage({ image: legacyImage, mimeType: storedSource.visualReferenceMimeType, sourceId: source._id });
        await Source.updateOne({ _id: source._id }, {
          $set: { visualReferenceFileId: uploaded.fileId, visualReferenceUrl: uploaded.url },
          $unset: { visualReferenceImage: 1 }
        });
        fileId = uploaded.fileId;
        imageUrl = uploaded.url;
        logger.info('visual_reference_image_migrated_to_imagekit', { sourceId: String(source._id), sourceName: source.name, provider: 'imagekit', fileId, mimeType: storedSource.visualReferenceMimeType, bytes: legacyImage.length });
      }
      if (!fileId || !imageUrl || !storedSource?.visualReferenceMimeType) {
        logger.error('visual_reference_image_missing', { sourceId: String(source._id), sourceName: source.name, provider: 'imagekit', fileId: fileId || null, urlPresent: Boolean(imageUrl), mimeType: storedSource?.visualReferenceMimeType || null, hint: 'Visual matching is enabled but no saved ImageKit reference is available. Re-upload the reference image in source settings.' });
        throw new Error('Visual matching is enabled but its saved ImageKit reference image is missing');
      }
      visualReference = await imagekit.downloadReferenceImage(imageUrl);
      logger.info('visual_reference_image_loaded', { sourceId: String(source._id), sourceName: source.name, provider: 'imagekit', fileId, mimeType: visualReference.mimeType, bytes: visualReference.image.length });
    } catch (err) {
      if (!err.message.includes('saved ImageKit reference image is missing')) logger.error('visual_reference_image_load_failed', { sourceId: String(source._id), sourceName: source.name, provider: 'imagekit', message: err.message });
      return { results, skippedIds: new Set(), attempted: 0, error: { youtubeId: null, message: err.message } };
    }
  }
  const cursor = source.geminiLastScannedVideoId || '';
  const cursorIndex = cursor ? entries.findIndex(entry => videoId(entry) === cursor) : -1;
  let candidates; let skippedEntries = [];
  if (source.type === 'playlist') {
    candidates = cursorIndex >= 0 ? entries.slice(cursorIndex + 1) : entries.slice();
    skippedEntries = cursorIndex >= 0 ? entries.slice(0, cursorIndex + 1) : [];
  } else {
    candidates = cursorIndex >= 0 ? entries.slice(0, cursorIndex).reverse() : entries.slice().reverse();
    skippedEntries = cursorIndex >= 0 ? entries.slice(cursorIndex) : [];
  }
  const skippedIds = new Set(skippedEntries.map(videoId).filter(Boolean));
  let attempted = 0; let error = null;
  for (const entry of candidates) {
    const id = videoId(entry);
    if (!id) continue;
    const thumbnail = entry.thumbnail || (Array.isArray(entry.thumbnails) && entry.thumbnails.at(-1)?.url);
    try {
      if (!thumbnail) throw new Error('No thumbnail URL in video metadata');
      attempted++;
      logger.gemini('REQUEST', { model: 'gemini-3.1-flash-lite', sourceId: String(source._id), sourceName: source.name, youtubeId: id, title: String(entry.title || '').slice(0, 180) });
      const analysis = await thumbnailTextFromUrl(thumbnail, visualReference);
      const keywordMatch = findMatches(source, entry, entry.description || '', analysis.text);
      const hasIncludes = (source.keywords || []).some(Boolean);
      const accepted = keywordMatch.excluded ? false : source.visualMatchEnabled
        ? analysis.visualMatch || (hasIncludes && keywordMatch.accepted)
        : keywordMatch.accepted;
      const matches = [...keywordMatch.matches];
      if (analysis.visualMatch) matches.push('visual-reference-match');
      const match = { accepted, matches, excluded: keywordMatch.excluded };
      if (match.accepted) await upsertVideo(source, entry, match.matches);
      await Source.updateOne({ _id: source._id }, { $set: { geminiLastScannedVideoId: id } });
      source.geminiLastScannedVideoId = id;
      results.set(id, { accepted: match.accepted, matches: match.matches, text: analysis.text });
      logger.gemini(match.accepted ? 'ACCEPTED' : 'REJECTED', { model: 'gemini-3.1-flash-lite', sourceId: String(source._id), sourceName: source.name, youtubeId: id, title: String(entry.title || '').slice(0, 180), extractedText: analysis.text, visualMatch: analysis.visualMatch, matchedKeywords: match.matches, matchMode: source.matchMode || 'ANY' });
    } catch (err) {
      error = { youtubeId: id, message: err.message };
      logger.gemini('ERROR', { model: 'gemini-3.1-flash-lite', sourceId: String(source._id), sourceName: source.name, youtubeId: id, title: String(entry.title || '').slice(0, 180), message: err.message });
      // Don't let one unsupported/corrupt thumbnail block all later videos.
      // Mark it scanned so periodic scans can progress without repeatedly
      // spending a Gemini request on the same image. Visual mode fails closed
      // in scanSource when this ID has no successful comparison result.
      await Source.updateOne({ _id: source._id }, { $set: { geminiLastScannedVideoId: id } });
      source.geminiLastScannedVideoId = id;
    }
  }
  return { results, skippedIds, attempted, error };
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
  const visualAutoApprove = source.visualMatchEnabled && source.visualMatchAutoApprove && matches.includes('visual-reference-match');
  const autoApprove = source.autoApproveVideos || visualAutoApprove;
  const approval = autoApprove || String(process.env.REQUIRE_MANUAL_APPROVAL || 'true').toLowerCase() !== 'true' ? 'APPROVED' : 'PENDING';
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
    if (autoApprove) await QueuedVideo.updateOne({ youtubeId: id, approvalStatus: 'PENDING', status: { $in: ['AWAITING_APPROVAL', 'PENDING'] } }, { $set: { approvalStatus: 'APPROVED', status: 'PENDING' } });
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Another scan inserted this ID between our lookup/upsert attempt. Add our
    // source contribution to that winning record without touching its status.
    await QueuedVideo.updateOne({ youtubeId: id }, {
      $addToSet: { discoveredSources: contribution, matchedKeywords: { $each: matches } },
      $min: { priorityRank: PRIORITY_RANK[priority] || 2 }
    });
    await QueuedVideo.updateOne({ youtubeId: id, priorityRank: PRIORITY_RANK[priority] || 2 }, { $set: { priority } });
    if (autoApprove) await QueuedVideo.updateOne({ youtubeId: id, approvalStatus: 'PENDING', status: { $in: ['AWAITING_APPROVAL', 'PENDING'] } }, { $set: { approvalStatus: 'APPROVED', status: 'PENDING' } });
  }
}
async function scanSource(source) {
  const sourceKey = String(source._id);
  if (activeSources.has(sourceKey)) return { skipped: true, reason: 'source scan already running' };
  const lockToken = randomUUID();
  const lockUntil = new Date(Date.now() + 6 * 60 * 1000);
  const lock = await Source.findOneAndUpdate({ _id: source._id, $or: [{ scanLockUntil: null }, { scanLockUntil: { $lt: new Date() } }] }, { $set: { scanLockUntil: lockUntil, scanLockToken: lockToken } }, { new: true, select: '+scanLockUntil +scanLockToken' });
  if (!lock) {
    logger.warn('source_scan_skipped_locked', { sourceId: sourceKey, sourceName: source.name });
    return { sourceId: sourceKey, skipped: true, reason: 'source scan already running' };
  }
  activeSources.add(sourceKey);
  const startedAt = new Date();
  const history = await ScanHistory.create({ sourceId: source._id, sourceName: source.name, sourceType: source.type, startedAt });
  const limit = Number.isInteger(source.videosPerScan) ? Math.min(10000, Math.max(1, source.videosPerScan)) : LIMIT;
  let inspected = 0, matched = 0, rejected = 0, geminiAttempted = 0; const errors = [];
  const lockHeartbeat = setInterval(() => {
    Source.updateOne({ _id: source._id, scanLockToken: lockToken }, { $set: { scanLockUntil: new Date(Date.now() + 6 * 60 * 1000) } })
      .catch(err => logger.warn('source_scan_lock_heartbeat_failed', { sourceId: sourceKey, sourceName: source.name, message: err.message }));
  }, 60_000);
  logger.info('source_scan_started', { sourceId: sourceKey, sourceName: source.name, sourceType: source.type, maxEntries: limit, scanDescription: source.scanDescription !== false, generateNfo: source.generateNfo === true, thumbnailGeminiEnabled: source.thumbnailGeminiEnabled === true, visualMatchEnabled: source.visualMatchEnabled === true });
  try {
    const entries = await runYtDlp(source, limit);
    let geminiResults = { results: new Map(), skippedIds: new Set(), attempted: 0, error: null };
    if (source.thumbnailGeminiEnabled === true || source.visualMatchEnabled === true) {
      geminiResults = await scanNewGeminiThumbnails(source, entries.slice(0, limit));
      geminiAttempted = geminiResults.attempted;
      if (geminiResults.error) logger.warn('thumbnail_gemini_failed', { sourceId: sourceKey, sourceName: source.name, youtubeId: geminiResults.error.youtubeId, message: geminiResults.error.message, hint: 'This thumbnail was skipped and the cursor advanced. Toggle Gemini off and on to reset the cursor and retry it; verify GEMINI_API_KEY and Gemini API access.' });
    }
    for (const entry of entries.slice(0, limit)) {
      const id = videoId(entry); if (!id) continue;
      inspected++;
      if (geminiResults.skippedIds.has(id)) continue;
      try {
        const geminiResult = geminiResults.results.get(id);
        // Visual matching must fail closed: a Gemini error or an unprocessed
        // entry cannot be accepted based only on title/description keywords.
        const description = source.generateNfo === true && !source.visualMatchEnabled ? await descriptionFromNfo(source, entry, id) : (entry.description || '');
        const result = geminiResult || (source.visualMatchEnabled ? { accepted: false, matches: [] } : findMatches(source, entry, description));
        if (!result.accepted) {
          rejected++;
          logger.debug(source.visualMatchEnabled && !geminiResult ? 'video_rejected_visual_comparison_unavailable' : 'video_rejected_by_keywords', { sourceId: sourceKey, youtubeId: id, descriptionChecked: source.scanDescription !== false, nfoUsed: source.generateNfo === true });
          continue;
        }
        if (!geminiResults.results.has(id)) await upsertVideo(source, entry, result.matches);
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
    logger.info('source_scan_completed', { sourceId: sourceKey, sourceName: source.name, status: errors.length ? (inspected ? 'PARTIAL' : 'FAILED') : 'COMPLETED', inspected, matched, rejected, thumbnailGeminiAttempted: geminiAttempted, thumbnailGeminiSkipped: geminiResults.skippedIds.size, geminiLastScannedVideoId: source.geminiLastScannedVideoId || null, errors: errors.length, durationMs: completedAt.getTime() - startedAt.getTime() });
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
    clearInterval(lockHeartbeat);
    activeSources.delete(sourceKey);
    await Source.updateOne({ _id: source._id, scanLockToken: lockToken }, { $set: { scanLockUntil: null, scanLockToken: null } }).catch(() => {});
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
