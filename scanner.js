'use strict';
require('dotenv').config();
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { connectDB } = require('./db');
const { Source, QueuedVideo, ScanHistory, AdaptiveVideo, ChannelProfile, ChannelRanking, VideoStatsHistory } = require('./models');
const logger = require('./logger');
const imagekit = require('./imagekit');
const { compileSafeRegex } = require('./keyword-search');
const { computeProfile, rankVideos, median } = require('./adaptive-analytics');

const LIMIT = Math.min(10000, Math.max(1, Number.parseInt(process.env.VIDEOS_PER_SOURCE || '50', 10) || 50));
const MAX_RETRIES = Math.max(1, Number.parseInt(process.env.MAX_RETRIES || '3', 10) || 3);
const YT_DLP_TIMEOUT_MINUTES = Math.min(180, Math.max(5, Number.parseInt(process.env.YT_DLP_TIMEOUT_MINUTES || '20', 10) || 20));
const YT_DLP_TIMEOUT_MS = YT_DLP_TIMEOUT_MINUTES * 60 * 1000;
const PRIORITY_RANK = { HIGH: 1, NORMAL: 2, LOW: 3 };
const keywordRegexCache = new WeakMap();
let activeAll = false;
const activeSources = new Set();

function runYtDlp(source, limit) {
  return new Promise((resolve, reject) => {
    const executable = process.env.YT_DLP_PATH || 'yt-dlp';
    const args = ['--dump-json', '--playlist-end', String(limit), '--retries', '3', '--extractor-retries', '3', '--socket-timeout', '30', '--ignore-errors', '--no-warnings', '--skip-download', source.url];
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const entries = [];
    let stderr = ''; let settled = false; let parseErrors = 0; let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; logger.warn('ytdlp_process_timeout', { sourceId: String(source._id), sourceName: source.name, timeoutMinutes: YT_DLP_TIMEOUT_MINUTES, metadataEntriesReceived: entries.length }); child.kill(); }, YT_DLP_TIMEOUT_MS);
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
      if (timedOut) return reject(new Error(`yt-dlp timed out after ${YT_DLP_TIMEOUT_MINUTES} minutes`));
      if (code !== 0 && entries.length) logger.warn('ytdlp_partial_exit', { sourceId: String(source._id), sourceName: source.name, exitCode: code, metadataEntriesReceived: entries.length, stderr: stderr.trim().slice(-2000) });
      if (code !== 0 && !entries.length) return reject(new Error((stderr.trim() || `yt-dlp exited ${code}`).slice(-2000)));
      logger.info('ytdlp_process_finished', { sourceId: String(source._id), sourceName: source.name, exitCode: code, metadataEntriesReceived: entries.length, invalidLines: parseErrors, durationMs: Date.now() - startedAt });
      resolve(entries);
    });
  });
}
function getAdaptiveFeedUrls(url) {
  const parsed = new URL(url);
  const basePath = parsed.pathname.replace(/\/(?:videos|shorts|streams)\/?$/, '').replace(/\/$/, '');
  return ['videos', 'shorts'].map(tab => `${parsed.origin}${basePath}/${tab}`);
}
function entryPublishedAt(entry) {
  if (/^\d{8}$/.test(entry.upload_date || '')) {
    const value = entry.upload_date;
    return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
  }
  const timestamp = Number(entry.release_timestamp ?? entry.timestamp);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : null;
}
function runAdaptiveFeed(source, url, contentType, target, cutoffDate) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const executable = process.env.YT_DLP_PATH || 'yt-dlp';
    const args = ['--dump-json', '--lazy-playlist', '--retries', '3', '--extractor-retries', '3', '--socket-timeout', '30'];
    if (cutoffDate) args.push('--dateafter', cutoffDate.toISOString().slice(0, 10).replace(/-/g, ''));
    args.push('--ignore-errors', '--no-warnings', '--skip-download', url);
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const entries = []; let stderr = ''; let settled = false; let stopReason = ''; let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; logger.warn('adaptive_ytdlp_feed_timeout', { sourceId: String(source._id), sourceName: source.name, contentType, timeoutMinutes: YT_DLP_TIMEOUT_MINUTES, candidates: entries.length, stderr: stderr.trim().slice(-1000) }); child.kill(); }, YT_DLP_TIMEOUT_MS);
    const heartbeat = setInterval(() => logger.info('adaptive_ytdlp_feed_still_running', { sourceId: String(source._id), sourceName: source.name, contentType, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000), candidates: entries.length, target }), 30000);
    const outputLines = readline.createInterface({ input: child.stdout });
    outputLines.on('line', line => {
      if (!line.trim() || stopReason) return;
      try {
        const entry = JSON.parse(line); const publishedAt = entryPublishedAt(entry);
        if (cutoffDate && publishedAt && publishedAt < cutoffDate) { stopReason = 'lookback-boundary'; child.kill(); return; }
        if (publishedAt && publishedAt <= new Date() && videoId(entry)) {
          entry._adaptivePublishedAt = publishedAt;
          entry._adaptiveContentType = contentType;
          entries.push(entry);
          logger.debug('adaptive_candidate_discovered', { sourceId: String(source._id), sourceName: source.name, youtubeId: videoId(entry), contentType, publishedAt: publishedAt.toISOString(), candidates: entries.length, target });
          if (entries.length >= target) { stopReason = 'candidate-target'; child.kill(); }
        }
      } catch (error) {
        logger.warn('adaptive_metadata_line_invalid', { sourceId: String(source._id), sourceName: source.name, message: error.message });
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { if (!settled) { settled = true; clearTimeout(timeout); clearInterval(heartbeat); reject(error); } });
    child.on('close', code => {
      clearTimeout(timeout); clearInterval(heartbeat); if (settled) return; settled = true;
      if (timedOut) return reject(new Error(`Adaptive yt-dlp discovery timed out after ${YT_DLP_TIMEOUT_MINUTES} minutes`));
      if (code !== 0 && !entries.length && !stopReason) return reject(new Error((stderr.trim() || `yt-dlp exited ${code}`).slice(-2000)));
      logger.info('adaptive_ytdlp_feed_finished', { sourceId: String(source._id), sourceName: source.name, contentType, exitCode: code, stopReason: stopReason || 'feed-exhausted', metadataEntriesReceived: entries.length, durationMs: Date.now() - startedAt });
      resolve(entries);
    });
  });
}
async function runAdaptiveDiscovery(source, { target = 30, lookbackDays = 90 } = {}) {
  const cutoffDate = lookbackDays == null ? null : new Date(Date.now() - lookbackDays * 86400000);
  const allFeeds = getAdaptiveFeedUrls(source.url).map((url, index) => ({ url, contentType: index === 0 ? 'video' : 'short' }));
  const contentType = ['BOTH', 'VIDEOS', 'SHORTS'].includes(source.adaptiveContentType) ? source.adaptiveContentType : 'BOTH';
  const feeds = contentType === 'VIDEOS' ? allFeeds.filter(feed => feed.contentType === 'video') : contentType === 'SHORTS' ? allFeeds.filter(feed => feed.contentType === 'short') : allFeeds;
  logger.info('adaptive_discovery_started', { sourceId: String(source._id), sourceName: source.name, candidateTarget: target, lookbackDays, contentType, feedCount: feeds.length, metadataOnly: true });
  const candidates = [];
  for (const feed of feeds) candidates.push(...await runAdaptiveFeed(source, feed.url, feed.contentType, target, cutoffDate));
  const byId = new Map();
  for (const entry of candidates.sort((a, b) => b._adaptivePublishedAt - a._adaptivePublishedAt)) if (!byId.has(videoId(entry))) byId.set(videoId(entry), entry);
  return [...byId.values()].slice(0, target);
}
function videoId(entry) { return entry.id || (entry.url && /^[\w-]{11}$/.test(entry.url) ? entry.url : null); }
function videoUrl(entry, id) { return entry.webpage_url || entry.url && /^https?:/.test(entry.url) && entry.url || `https://www.youtube.com/watch?v=${id}`; }
function findMatches(source, entry, description = entry.description || '', thumbnailText = '') {
  const includedDescription = source.scanDescription === false && source.generateNfo !== true ? '' : description;
  // NFC normalization keeps canonically equivalent Malayalam and other Unicode
  // text searchable even when YouTube metadata and user input encode marks differently.
  const originalText = `${entry.title || ''}\n${includedDescription}\n${thumbnailText}`.normalize('NFC');
  const text = originalText.toLocaleLowerCase();
  const regexMode = source.keywordSearchMode === 'REGEX';
  let regexRules;
  if (regexMode) {
    regexRules = keywordRegexCache.get(source);
    if (!regexRules) {
      regexRules = {
        includes: (source.keywords || []).filter(Boolean).map(pattern => compileSafeRegex(pattern)),
        excludes: (source.excludeKeywords || []).filter(Boolean).map(pattern => compileSafeRegex(pattern))
      };
      keywordRegexCache.set(source, regexRules);
    }
  }
  const matchesPattern = (pattern, rule) => regexMode
    ? rule.test(originalText.slice(0, 8000))
    : text.includes(pattern.normalize('NFC').toLocaleLowerCase());
  const excludes = (source.excludeKeywords || []).filter(Boolean);
  const excludedKeyword = excludes.find((k, index) => matchesPattern(k, regexRules?.excludes[index]));
  if (excludedKeyword) return { accepted: false, matches: [], excluded: true, rejectionReason: `Excluded by keyword: ${excludedKeyword}` };
  const includes = (source.keywords || []).filter(Boolean);
  if (!includes.length) return { accepted: true, matches: [], excluded: false };
  const matches = includes.filter((k, index) => matchesPattern(k, regexRules?.includes[index]));
  const accepted = source.matchMode === 'ALL' ? matches.length === includes.length : matches.length > 0;
  return { accepted, matches, excluded: false, rejectionReason: accepted ? '' : `Did not match ${source.matchMode || 'ANY'} include keyword rule (${includes.join(', ')})` };
}
async function thumbnailTextFromUrl(url, visualReferences = []) {
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
  const parts = [{ text: visualReferences.length
    ? `Compare each of the ${visualReferences.length} reference images, in order, with the YouTube thumbnail. Ignore all people and faces completely; do not compare or identify anyone. For each reference, decide whether the same non-person object or a distinctive scene is visibly present in the thumbnail. Return JSON with matched_reference_indices (zero-based reference image indexes, empty if none) and thumbnail_text. Include an index only for a clear match, not merely a similar category. Also transcribe visible thumbnail text.`
    : 'Read and transcribe every word visible in this YouTube thumbnail. Preserve the original scripts and wording. Return only the visible text, without explanation.' }];
  for (const reference of visualReferences) parts.push({ inline_data: { mime_type: reference.mimeType, data: reference.image.toString('base64') } });
  parts.push({ inline_data: { mime_type: mimeType, data: image.toString('base64') } });
  const requestBody = { contents: [{ parts }] };
  if (visualReferences.length) requestBody.generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: { type: 'OBJECT', properties: { matched_reference_indices: { type: 'ARRAY', items: { type: 'INTEGER' } }, thumbnail_text: { type: 'STRING' } }, required: ['matched_reference_indices', 'thumbnail_text'] }
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
  if (!visualReferences.length) return { text: responseText, visualMatchIndices: [] };
  const analysis = JSON.parse(responseText);
  if (!Array.isArray(analysis.matched_reference_indices) || typeof analysis.thumbnail_text !== 'string' || analysis.matched_reference_indices.some(index => !Number.isInteger(index) || index < 0 || index >= visualReferences.length)) throw new Error('Gemini returned an invalid visual match result');
  return { text: analysis.thumbnail_text, visualMatchIndices: [...new Set(analysis.matched_reference_indices)] };
}
async function scanNewGeminiThumbnails(source, entries, { bypassCursor = false, queueAccepted = true } = {}) {
  const results = new Map();
  let visualReferences = [];
  if (source.visualMatchEnabled) {
    try {
      const storedSource = await Source.findById(source._id).select('visualReferences visualReferenceMimeType +visualReferenceFileId +visualReferenceUrl +visualReferenceImage');
      let refs = (storedSource?.visualReferences || []).map(ref => ({ _id: ref._id, fileId: ref.fileId, url: ref.url, mimeType: ref.mimeType, bytes: ref.bytes || 0 }));
      if (!refs.length && storedSource?.visualReferenceFileId && storedSource?.visualReferenceUrl) {
        refs = [{ fileId: storedSource.visualReferenceFileId, url: storedSource.visualReferenceUrl, mimeType: storedSource.visualReferenceMimeType, bytes: 0 }];
      } else if (!refs.length && storedSource?.visualReferenceUrl) {
        // Older source records can retain the ImageKit URL while lacking the
        // file ID required by the current visualReferences schema. The UI can
        // still display that URL, so recover and migrate it before declaring
        // the reference missing.
        const legacy = await imagekit.downloadReferenceImage(storedSource.visualReferenceUrl);
        const uploaded = await imagekit.uploadReferenceImage({ image: legacy.image, mimeType: legacy.mimeType, sourceId: source._id });
        refs = [{ ...uploaded, bytes: legacy.image.length }];
        logger.info('visual_reference_image_migrated_to_imagekit', { sourceId: String(source._id), sourceName: source.name, provider: 'imagekit', fileId: uploaded.fileId, mimeType: uploaded.mimeType, bytes: legacy.image.length, recoveredFromUrl: true });
      } else if (!refs.length && storedSource?.visualReferenceImage?.length && storedSource.visualReferenceMimeType) {
        const legacy = Buffer.from(storedSource.visualReferenceImage);
        const uploaded = await imagekit.uploadReferenceImage({ image: legacy, mimeType: storedSource.visualReferenceMimeType, sourceId: source._id });
        refs = [{ ...uploaded, bytes: legacy.length }];
        logger.info('visual_reference_image_migrated_to_imagekit', { sourceId: String(source._id), sourceName: source.name, provider: 'imagekit', fileId: uploaded.fileId, mimeType: storedSource.visualReferenceMimeType, bytes: legacy.length });
      }
      for (let index = 0; index < refs.length; index++) {
        const reference = refs[index];
        if (reference.fileId && reference.url && reference.mimeType) continue;
        if (!reference.url) continue;
        const legacy = await imagekit.downloadReferenceImage(reference.url);
        const uploaded = await imagekit.uploadReferenceImage({ image: legacy.image, mimeType: legacy.mimeType, sourceId: source._id });
        refs[index] = { ...uploaded, bytes: legacy.image.length };
        logger.info('visual_reference_image_migrated_to_imagekit', { sourceId: String(source._id), sourceName: source.name, provider: 'imagekit', fileId: uploaded.fileId, mimeType: uploaded.mimeType, bytes: legacy.image.length, recoveredIncompleteRecord: true });
      }
      if (!refs.length || refs.length > 10 || refs.some(ref => !ref.fileId || !ref.url || !ref.mimeType)) {
        logger.error('visual_reference_image_missing', { sourceId: String(source._id), sourceName: source.name, provider: 'imagekit', referenceCount: refs.length, hint: 'Visual matching is enabled but valid saved reference images are unavailable. Re-upload the reference images in source settings.' });
        throw new Error('Visual matching is enabled but saved ImageKit reference images are missing or invalid');
      }
      if (!(storedSource.visualReferences || []).length) {
        await Source.findByIdAndUpdate(source._id, {
          $set: { visualReferences: refs, visualReferenceMimeType: refs[0].mimeType },
          $unset: { visualReferenceImage: 1, visualReferenceFileId: 1, visualReferenceUrl: 1 }
        });
      }
      let totalBytes = 0;
      for (const reference of refs) {
        const downloaded = await imagekit.downloadReferenceImage(reference.url);
        totalBytes += downloaded.image.length;
        if (totalBytes > 8 * 1024 * 1024) throw new Error('Saved reference images exceed the 8 MB per-source limit');
        visualReferences.push({ ...downloaded, fileId: reference.fileId });
      }
      logger.info('visual_reference_images_loaded', { sourceId: String(source._id), sourceName: source.name, provider: 'imagekit', referenceCount: visualReferences.length, fileIds: visualReferences.map(ref => ref.fileId), bytes: totalBytes });
    } catch (err) {
      if (!err.message.includes('saved ImageKit reference images are missing or invalid')) logger.error('visual_reference_images_load_failed', { sourceId: String(source._id), sourceName: source.name, provider: 'imagekit', message: err.message });
      return { results, skippedIds: new Set(), attempted: 0, error: { youtubeId: null, message: err.message } };
    }
  }
  const cursor = bypassCursor ? '' : source.geminiLastScannedVideoId || '';
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
      logger.gemini('REQUEST', { model: 'gemini-3.1-flash-lite', sourceId: String(source._id), sourceName: source.name, youtubeId: id, title: String(entry.title || '').slice(0, 180), visualReferenceCount: visualReferences.length, visualMatchAction: source.visualMatchAction || 'ACCEPT' });
      const analysis = await thumbnailTextFromUrl(thumbnail, visualReferences);
      const description = source.generateNfo === true
        ? await descriptionFromNfo(source, entry, id)
        : source.scanDescription === false ? '' : (entry.description || '');
      const keywordMatch = findMatches(source, entry, description, analysis.text);
      const hasIncludes = (source.keywords || []).some(Boolean);
      const visualMatch = analysis.visualMatchIndices.length > 0;
      const action = source.visualMatchAction || 'ACCEPT';
      const accepted = keywordMatch.excluded ? false : source.visualMatchEnabled
        ? action === 'REJECT' ? (!visualMatch && keywordMatch.accepted) : (visualMatch || (hasIncludes && keywordMatch.accepted))
        : keywordMatch.accepted;
      const matches = [...keywordMatch.matches];
      if (visualMatch) matches.push('visual-reference-match');
      const match = { accepted, matches, excluded: keywordMatch.excluded };
      if (match.accepted && queueAccepted) await upsertVideo(source, entry, match.matches);
      await Source.updateOne({ _id: source._id }, { $set: { geminiLastScannedVideoId: id } });
      source.geminiLastScannedVideoId = id;
      results.set(id, { accepted: match.accepted, matches: match.matches, text: analysis.text });
      logger.gemini(match.accepted ? 'ACCEPTED' : 'REJECTED', { model: 'gemini-3.1-flash-lite', sourceId: String(source._id), sourceName: source.name, youtubeId: id, title: String(entry.title || '').slice(0, 180), extractedText: analysis.text, visualMatch, matchedReferenceIndices: analysis.visualMatchIndices, visualMatchAction: action, matchedKeywords: match.matches, matchMode: source.matchMode || 'ANY' });
    } catch (err) {
      error = { youtubeId: id, message: err.message };
      logger.gemini('ERROR', { model: 'gemini-3.1-flash-lite', sourceId: String(source._id), sourceName: source.name, youtubeId: id, title: String(entry.title || '').slice(0, 180), message: err.message });
      // Don't let one unsupported/corrupt thumbnail block all later videos.
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
    const result = await QueuedVideo.updateOne({ youtubeId: id }, {
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
    return result.upsertedCount || 0;
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
    return 0;
  }
}
function optionalNumber(value) { return Number.isFinite(value) ? value : null; }
async function processAdaptiveChannel(source, entries, { trending = false } = {}) {
  const sourceId = source._id; const now = new Date(); const rankingDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const oldSnapshots = await VideoStatsHistory.find({ sourceId, youtubeId: { $in: entries.map(videoId).filter(Boolean) }, capturedAt: { $gte: new Date(now.getTime() - 45 * 86400000), $lt: rankingDate } }).sort({ capturedAt: -1 }).lean();
  const previousStats = new Map();
  for (const snapshot of oldSnapshots) if (!previousStats.has(snapshot.youtubeId)) previousStats.set(snapshot.youtubeId, snapshot);
  const seenAt = now;
  for (const entry of entries) {
    const id = videoId(entry); const publishedAt = entry._adaptivePublishedAt || entryPublishedAt(entry);
    if (!id || !publishedAt) continue;
    const views = optionalNumber(entry.view_count); const likes = optionalNumber(entry.like_count); const comments = optionalNumber(entry.comment_count);
    const engagementRate = views > 0 && likes !== null && comments !== null ? ((likes + comments) / views) * 100 : null;
    const previous = previousStats.get(id);
    const elapsedDays = previous ? Math.max(1 / 24, (seenAt - new Date(previous.updatedAt || previous.capturedAt).getTime()) / 86400000) : null;
    const growthPerDay = views !== null && previous && Number.isFinite(previous.views)
      ? (views - previous.views) / elapsedDays : null;
    const likeGrowthPerDay = likes !== null && previous && Number.isFinite(previous.likes)
      ? (likes - previous.likes) / elapsedDays : null;
    const ageDays = Math.max(1, (now - publishedAt) / 86400000);
    const velocityPerDay = growthPerDay ?? (views === null ? null : views / ageDays);
    const adaptiveVideo = {
      sourceId, youtubeId: id, channelId: entry.channel_id || '', channelName: entry.channel || source.name, title: entry.title || '',
      description: entry.description || '', thumbnail: entry.thumbnail || (Array.isArray(entry.thumbnails) && entry.thumbnails.at(-1)?.url) || '',
      videoUrl: videoUrl(entry, id), publishedAt, duration: optionalNumber(entry.duration), contentType: entry._adaptiveContentType || 'video',
      views, likes, comments, engagementRate, engagementIncomplete: engagementRate === null, statsUpdatedAt: seenAt,
      lastDailyViewGrowth: growthPerDay, lastDailyLikeGrowth: likeGrowthPerDay, viewVelocityPerDay: velocityPerDay,
      viewSurge: false, surgeThresholdPerDay: null
    };
    await AdaptiveVideo.updateOne({ sourceId, youtubeId: id }, { $set: adaptiveVideo }, { upsert: true });
    await VideoStatsHistory.updateOne({ sourceId, youtubeId: id, capturedAt: rankingDate }, {
      $setOnInsert: { sourceId, youtubeId: id, channelId: entry.channel_id || '', capturedAt: rankingDate },
      $set: { views, likes, comments, engagementRate }
    }, { upsert: true });
  }
  const videos = await AdaptiveVideo.find({ sourceId, publishedAt: { $lte: now } }).sort({ publishedAt: -1 }).limit(trending ? 90 : 30).lean();
  if (trending) {
    const activeIds = videos.map(video => video.youtubeId);
    await Promise.all([
      AdaptiveVideo.deleteMany({ sourceId, youtubeId: { $nin: activeIds } }),
      VideoStatsHistory.deleteMany({ sourceId, youtubeId: { $nin: activeIds } })
    ]);
  }
  if (!videos.length) {
    const emptyProfile = computeProfile([], now);
    await Promise.all([
      ChannelProfile.findOneAndUpdate({ sourceId }, { $set: { ...emptyProfile, sourceId, channelId: '', channelName: source.name } }, { upsert: true, new: true }),
      ChannelRanking.updateOne({ sourceId, rankingDate, rankingType: 'recent' }, { $set: { sourceId, channelId: '', channelName: source.name, rankingDate, rankingType: 'recent', entries: [] } }, { upsert: true }),
      ChannelRanking.updateOne({ sourceId, rankingDate, rankingType: 'engagement' }, { $set: { sourceId, channelId: '', channelName: source.name, rankingDate, rankingType: 'engagement', entries: [] } }, { upsert: true })
    ]);
    await Source.updateOne({ _id: sourceId }, { $set: { adaptiveLastRunAt: seenAt } });
    source.adaptiveLastRunAt = seenAt;
    logger.info('adaptive_channel_scan_completed', { sourceId: String(sourceId), sourceName: source.name, discoveryWindowDays: 90, candidateCount: 0, newlyDiscovered: entries.length, recentTop10: 0, engagementTop10: 0, newQueueEntries: 0 });
    return { inspected: 0, matched: 0, queued: 0 };
  }
  const profileValues = computeProfile(videos, now);
  const publishedTimes = videos.map(video => new Date(video.publishedAt).getTime()).filter(Number.isFinite);
  const oldestPublishedAt = publishedTimes.length ? Math.min(...publishedTimes) : NaN;
  const observedSpanDays = Number.isFinite(oldestPublishedAt) ? Math.max(1, Math.min(30, (now.getTime() - oldestPublishedAt) / 86400000)) : 0;
  const uploadRateReliable = videos.length >= 15 && observedSpanDays >= 14;
  const observedUploadCount = videos.filter(video => new Date(video.publishedAt).getTime() >= now.getTime() - observedSpanDays * 86400000).length;
  const observedUploadsPerDay = observedSpanDays ? observedUploadCount / observedSpanDays : 0;
  profileValues.uploadRateReliable = uploadRateReliable;
  profileValues.projectedUploadsNext15Days = Math.max(1, Math.min(90, uploadRateReliable ? Math.ceil(observedUploadsPerDay * 15) : Math.min(90, entries.length || 1)));
  const dailyGrowth = videos.map(video => video.lastDailyViewGrowth).filter(Number.isFinite);
  profileValues.averageDailyViewGrowth = dailyGrowth.length ? dailyGrowth.reduce((sum, value) => sum + value, 0) / dailyGrowth.length : null;
  const profile = await ChannelProfile.findOneAndUpdate({ sourceId }, {
    $set: { ...profileValues, sourceId, channelId: videos.find(video => video.channelId)?.channelId || '', channelName: videos.find(video => video.channelName)?.channelName || source.name }
  }, { upsert: true, new: true }).lean();
  const ranked = rankVideos(videos, profile);
  const velocities = videos.map(video => video.viewVelocityPerDay).filter(Number.isFinite).filter(value => value >= 0);
  const velocityMedian = median(velocities) ?? 0;
  const velocityMad = median(velocities.map(value => Math.abs(value - velocityMedian))) ?? 0;
  const surgeThreshold = velocityMedian + Math.max(velocityMad * 1.5, velocityMedian * 0.5);
  const surges = trending ? videos.filter(video => Number.isFinite(video.viewVelocityPerDay) && video.viewVelocityPerDay > surgeThreshold)
    .sort((a, b) => b.viewVelocityPerDay - a.viewVelocityPerDay) : [];
  await Promise.all(videos.map(video => AdaptiveVideo.updateOne({ _id: video._id }, { $set: {
    viewSurge: surges.some(item => item.youtubeId === video.youtubeId),
    viewSurgeDetectedAt: surges.some(item => item.youtubeId === video.youtubeId) ? seenAt : null,
    surgeThresholdPerDay: surgeThreshold
  } })));
  const entriesById = new Map(entries.map(entry => [videoId(entry), entry])); const queueSelection = new Map();
  let detectedForQueue = ranked.recent.length + ranked.engagement.length;
  if (trending) {
    const dailyCapacity = profile.projectedUploadsNext15Days || 0;
    const queueableSurges = surges.slice(0, dailyCapacity);
    for (const item of queueableSurges) queueSelection.set(item.youtubeId, ['trending-view-surge']);
    detectedForQueue = surges.length;
  } else {
    for (const item of ranked.recent) queueSelection.set(item.youtubeId, [`adaptive-recent-top-10-rank-${item.rank}`]);
    for (const item of ranked.engagement) queueSelection.set(item.youtubeId, [...(queueSelection.get(item.youtubeId) || []), `adaptive-engagement-top-10-rank-${item.rank}`]);
  }
  const rejectedSelections = new Map();
  for (const [id] of queueSelection) {
    const entry = entriesById.get(id);
    const item = videos.find(video => video.youtubeId === id);
    if (!entry || !item) continue;
    const keywordResult = findMatches(source, entry, entry.description || item.description || '');
    const rejectionReason = keywordResult.rejectionReason;
    if (!keywordResult.accepted) {
      rejectedSelections.set(id, rejectionReason || 'Did not match keyword rules');
      await AdaptiveVideo.updateOne({ sourceId, youtubeId: id }, { $set: { rejectionReason: rejectionReason || 'Did not match keyword rules', matchedKeywords: [] } });
      queueSelection.delete(id);
    } else await AdaptiveVideo.updateOne({ sourceId, youtubeId: id }, { $set: { rejectionReason: '', matchedKeywords: keywordResult.matches } });
  }
  const annotate = list => list.map(item => ({ ...item, accepted: !rejectedSelections.has(item.youtubeId), rejectionReason: rejectedSelections.get(item.youtubeId) || '', matchedKeywords: entriesById.has(item.youtubeId) ? findMatches(source, entriesById.get(item.youtubeId)).matches : [] }));
  let newQueueEntries = 0;
  for (const [id, labels] of queueSelection) {
    const entry = entriesById.get(id);
    if (entry) newQueueEntries += await upsertVideo(source, entry, labels);
  }
  const queueItems = await QueuedVideo.find({ youtubeId: { $in: [...queueSelection.keys()] } }).select('youtubeId status approvalStatus').lean();
  const queueStates = new Map(queueItems.map(item => [item.youtubeId, `${item.approvalStatus}/${item.status}`]));
  const withQueueStatus = list => list.map(item => ({ ...item, queueStatus: queueStates.get(item.youtubeId) || 'NOT_QUEUED' }));
  await Promise.all([
    ChannelRanking.updateOne({ sourceId, rankingDate, rankingType: 'recent' }, { $set: { sourceId, channelId: profile.channelId, channelName: profile.channelName, rankingDate, rankingType: 'recent', entries: withQueueStatus(annotate(ranked.recent)) } }, { upsert: true }),
    ChannelRanking.updateOne({ sourceId, rankingDate, rankingType: 'engagement' }, { $set: { sourceId, channelId: profile.channelId, channelName: profile.channelName, rankingDate, rankingType: 'engagement', entries: withQueueStatus(annotate(ranked.engagement)) } }, { upsert: true }),
    Source.updateOne({ _id: sourceId }, { $set: { adaptiveLastRunAt: seenAt } })
  ]);
  source.adaptiveLastRunAt = seenAt;
  logger.info('adaptive_channel_scan_completed', {
    sourceId: String(sourceId), sourceName: source.name, discoveryWindowDays: 90, candidateCount: videos.length, newlyDiscovered: entries.length,
    statisticsUpdated: videos.length, minimumViewsThreshold: profile.minimumViewsThreshold, thresholdSampleSize: profile.thresholdSampleSize,
    thresholdProvisional: profile.thresholdProvisional, recentTop10: ranked.recent.length, engagementTop10: ranked.engagement.length,
    trending, viewSurges: surges.length, surgeThresholdPerDay: surgeThreshold,
    projectedUploadsNext15Days: profile.projectedUploadsNext15Days, uploadRateReliable: profile.uploadRateReliable, newQueueEntries
  });
  return { inspected: videos.length, matched: detectedForQueue, rejected: rejectedSelections.size, queued: newQueueEntries, viewSurges: surges.length, projectedUploadsNext15Days: profile.projectedUploadsNext15Days };
}
async function processDailyTopVideos(source, entries) {
  const now = new Date();
  const ids = entries.map(videoId).filter(Boolean);
  const geminiEnabled = source.thumbnailGeminiEnabled === true || source.visualMatchEnabled === true;
  const gemini = geminiEnabled
    ? await scanNewGeminiThumbnails(source, entries, { bypassCursor: true, queueAccepted: false })
    : { results: new Map(), skippedIds: new Set(), attempted: 0, error: null };
  for (const entry of entries) {
    const id = videoId(entry); const publishedAt = entry._adaptivePublishedAt || entryPublishedAt(entry);
    if (!id || !publishedAt) continue;
    const views = optionalNumber(entry.view_count); const likes = optionalNumber(entry.like_count);
    const comments = optionalNumber(entry.comment_count);
    const engagementRate = views > 0 && likes !== null && comments !== null ? ((likes + comments) / views) * 100 : null;
    await AdaptiveVideo.updateOne({ sourceId: source._id, youtubeId: id }, { $set: {
      sourceId: source._id, youtubeId: id, channelId: entry.channel_id || '', channelName: entry.channel || source.name,
      title: entry.title || '', description: entry.description || '', thumbnail: entry.thumbnail || entry.thumbnails?.at(-1)?.url || '',
      videoUrl: videoUrl(entry, id), publishedAt, duration: optionalNumber(entry.duration), contentType: entry._adaptiveContentType || 'video',
      views, likes, comments, engagementRate, engagementIncomplete: engagementRate === null, statsUpdatedAt: now
    } }, { upsert: true });
    const capturedAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    await VideoStatsHistory.updateOne({ sourceId: source._id, youtubeId: id, capturedAt }, {
      $setOnInsert: { sourceId: source._id, youtubeId: id, channelId: entry.channel_id || '', capturedAt },
      $set: { views, likes, comments, engagementRate }
    }, { upsert: true });
  }
  const passing = [];
  let rejected = 0;
  for (const entry of entries) {
    const id = videoId(entry); if (!id) continue;
    let result;
    if (geminiEnabled) result = gemini.results.get(id);
    else {
      const description = source.generateNfo === true ? await descriptionFromNfo(source, entry, id) : (entry.description || '');
      result = findMatches(source, entry, description);
    }
    if (!result?.accepted || gemini.skippedIds.has(id)) { rejected++; continue; }
    passing.push({ entry, result });
  }
  const count = Math.min(10, Math.max(1, Number(source.dailyTopVideosCount) || 1));
  const selected = passing.sort((a, b) => (Number(b.entry.view_count) || 0) - (Number(a.entry.view_count) || 0)).slice(0, count);
  let queued = 0;
  for (const { entry, result } of selected) queued += await upsertVideo(source, entry, result.matches || []);
  await ChannelRanking.updateOne({ sourceId: source._id, rankingDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), rankingType: 'top-one' }, {
    $set: { sourceId: source._id, channelId: entries.find(entry => entry.channel_id)?.channel_id || '', channelName: source.name,
      rankingDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), rankingType: 'top-one',
      entries: selected.map(({ entry, result }, index) => ({ youtubeId: videoId(entry), rank: index + 1, title: entry.title || '',
        thumbnail: entry.thumbnail || entry.thumbnails?.at(-1)?.url || '', videoUrl: videoUrl(entry, videoId(entry)), publishedAt: entry._adaptivePublishedAt || entryPublishedAt(entry),
        views: optionalNumber(entry.view_count), likes: optionalNumber(entry.like_count), accepted: true, matchedKeywords: result.matches || [], queueStatus: 'QUEUED' })) }
  }, { upsert: true });
  await Source.updateOne({ _id: source._id }, { $set: { adaptiveLastRunAt: now } });
  return { inspected: entries.length, matched: passing.length, rejected, queued, selected: selected.length, geminiAttempted: gemini.attempted, error: gemini.error };
}
async function scanSource(source, { forceAdaptive = false } = {}) {
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
  logger.info('source_scan_started', { sourceId: sourceKey, sourceName: source.name, sourceType: source.type, maxEntries: source.trendingDiscoveryEnabled === true ? 90 : limit, scanDescription: source.scanDescription !== false, generateNfo: source.generateNfo === true, thumbnailGeminiEnabled: source.thumbnailGeminiEnabled === true, visualMatchEnabled: source.visualMatchEnabled === true });
  try {
    if (source.dailyTopVideosEnabled === true || source.adaptiveDiscoveryEnabled === true || source.trendingDiscoveryEnabled === true) {
      if (source.type !== 'channel') throw new Error('Adaptive, Daily Top Videos, and Trending discovery are available for channel sources only');
      if (!forceAdaptive && source.adaptiveLastRunAt && Date.now() - new Date(source.adaptiveLastRunAt).getTime() < 24 * 3600000) {
        logger.info('adaptive_channel_scan_skipped_daily_limit', { sourceId: sourceKey, sourceName: source.name, lastRunAt: new Date(source.adaptiveLastRunAt).toISOString() });
        const completedAt = new Date();
        await ScanHistory.updateOne({ _id: history._id }, { $set: { completedAt, status: 'COMPLETED', errorCount: 0, errorDetails: [] } });
        return { sourceId: sourceKey, skipped: true, reason: 'adaptive discovery already ran in the last 24 hours' };
      }
      const trending = source.trendingDiscoveryEnabled === true;
      const dailyTop = source.dailyTopVideosEnabled === true;
      const candidates = await runAdaptiveDiscovery(source, dailyTop ? { target: 10000, lookbackDays: 7 } : trending ? { target: 90, lookbackDays: null } : {});
      const adaptiveResult = dailyTop ? await processDailyTopVideos(source, candidates) : await processAdaptiveChannel(source, candidates, { trending });
      inspected = adaptiveResult.inspected; matched = adaptiveResult.matched; rejected = adaptiveResult.rejected || 0;
      if (adaptiveResult.error) errors.push(`Gemini: ${adaptiveResult.error.message}`);
      const completedAt = new Date();
      await Source.updateOne({ _id: source._id }, { $set: { lastScannedAt: completedAt } });
      await ScanHistory.updateOne({ _id: history._id }, { $set: { completedAt, inspected, matched, rejected, errorCount: errors.length, errorDetails: errors, status: errors.length ? 'PARTIAL' : 'COMPLETED' } });
      const mode = dailyTop ? 'DAILY_TOP_VIDEOS' : trending ? 'TRENDING_SURGE' : 'ADAPTIVE_TOP_10';
      logger.info('source_scan_completed', { sourceId: sourceKey, sourceName: source.name, mode, status: errors.length ? 'PARTIAL' : 'COMPLETED', inspected, matched, rejected, errors: errors.length, durationMs: completedAt.getTime() - startedAt.getTime() });
      return { sourceId: sourceKey, inspected, matched, rejected, errors: errors.length, mode, queued: adaptiveResult.queued, geminiAttempted: adaptiveResult.geminiAttempted };
    }
    const entries = await runYtDlp(source, limit);
    let geminiResults = { results: new Map(), skippedIds: new Set(), attempted: 0, error: null };
    if (source.thumbnailGeminiEnabled === true || source.visualMatchEnabled === true) {
      geminiResults = await scanNewGeminiThumbnails(source, entries.slice(0, limit));
      geminiAttempted = geminiResults.attempted;
      if (geminiResults.error) {
        const retryHint = geminiResults.error.youtubeId
          ? 'This thumbnail was skipped and the cursor advanced. Toggle Gemini off and on to reset the cursor and retry it; verify GEMINI_API_KEY and Gemini API access.'
          : 'Reference-image loading failed before thumbnail analysis; the Gemini cursor was not advanced. Check the saved ImageKit reference and credentials, then scan again.';
        errors.push(`Gemini: ${geminiResults.error.message}`);
        logger.warn('thumbnail_gemini_failed', { sourceId: sourceKey, sourceName: source.name, youtubeId: geminiResults.error.youtubeId, message: geminiResults.error.message, hint: retryHint });
      }
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
    const adaptiveDueAt = new Date(Date.now() - 24 * 3600000);
    const sources = await Source.find({ enabled: true, $or: [
      { $and: [{ adaptiveDiscoveryEnabled: { $ne: true } }, { trendingDiscoveryEnabled: { $ne: true } }, { dailyTopVideosEnabled: { $ne: true } }] },
      { adaptiveLastRunAt: null }, { adaptiveLastRunAt: { $lte: adaptiveDueAt } }
    ] }).sort({ createdAt: 1 }).lean();
    logger.info('full_scan_started', { enabledSources: sources.length, defaultMaxEntriesPerSource: LIMIT, perSourceLimitsEnabled: true, adaptiveDailyFrequency: true });
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
  return scanSource(source, { forceAdaptive: true });
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
