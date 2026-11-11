'use strict';
require('dotenv').config();
const { spawn } = require('node:child_process');
const { connectDB } = require('./db');
const { Source, QueuedVideo, ScanHistory } = require('./models');

const LIMIT = Math.max(1, Number.parseInt(process.env.VIDEOS_PER_SOURCE || '50', 10) || 50);
const MAX_RETRIES = Math.max(1, Number.parseInt(process.env.MAX_RETRIES || '3', 10) || 3);
const PRIORITY_RANK = { HIGH: 1, NORMAL: 2, LOW: 3 };
let activeAll = false;
const activeSources = new Set();

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--playlist-end', String(LIMIT), '--ignore-errors', '--no-warnings', '--skip-download', url];
    const child = spawn(process.env.YT_DLP_PATH || 'yt-dlp', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const timeout = setTimeout(() => { child.kill(); if (!settled) { settled = true; reject(new Error('yt-dlp timed out after 5 minutes')); } }, 300000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => { if (!settled) { settled = true; clearTimeout(timeout); reject(err); } });
    child.on('close', code => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0 && !stdout.trim()) return reject(new Error((stderr.trim() || `yt-dlp exited ${code}`).slice(0, 2000)));
      try {
        const lines = stdout.split(/\r?\n/).filter(line => line.trim());
        const entries = lines.map(line => JSON.parse(line));
        resolve(entries.filter(Boolean));
      } catch { reject(new Error(`Unable to parse yt-dlp JSON output: ${stderr.slice(0, 800)}`)); }
    });
  });
}
function videoId(entry) { return entry.id || (entry.url && /^[\w-]{11}$/.test(entry.url) ? entry.url : null); }
function videoUrl(entry, id) { return entry.webpage_url || entry.url && /^https?:/.test(entry.url) && entry.url || `https://www.youtube.com/watch?v=${id}`; }
function findMatches(source, entry) {
  const text = `${entry.title || ''}\n${entry.description || ''}`.toLocaleLowerCase();
  const excludes = source.excludeKeywords || [];
  if (excludes.some(k => k && text.includes(k.toLocaleLowerCase()))) return { accepted: false, matches: [] };
  const includes = (source.keywords || []).filter(Boolean);
  if (!includes.length) return { accepted: true, matches: [] };
  const matches = includes.filter(k => text.includes(k.toLocaleLowerCase()));
  return { accepted: source.matchMode === 'ALL' ? matches.length === includes.length : matches.length > 0, matches };
}
async function upsertVideo(source, entry, matches) {
  const id = videoId(entry);
  if (!id) return;
  const priority = source.priority || 'NORMAL';
  // Stable contribution allows $addToSet to deduplicate this source on rediscovery.
  const contribution = { sourceId: source._id, name: source.name, type: source.type, priority, matchedKeywords: matches };
  const approval = String(process.env.REQUIRE_MANUAL_APPROVAL || 'true').toLowerCase() === 'true' ? 'PENDING' : 'APPROVED';
  const url = videoUrl(entry, id);
  try {
    await QueuedVideo.updateOne({ youtubeId: id }, {
      $setOnInsert: {
        youtubeId: id, title: entry.title || '', description: entry.description || '', url,
        thumbnail: entry.thumbnail || (Array.isArray(entry.thumbnails) && entry.thumbnails.at(-1)?.url) || '',
        uploadDate: entry.upload_date || entry.release_date || '', duration: Number.isFinite(entry.duration) ? entry.duration : null,
        approvalStatus: approval, status: 'PENDING', retryCount: 0, maxRetries: MAX_RETRIES,
        lastError: '', discoveredAt: new Date(), processedAt: null
      },
      $addToSet: { discoveredSources: contribution, matchedKeywords: { $each: matches } },
      $min: { priorityRank: PRIORITY_RANK[priority] || 2 }
    }, { upsert: true });
    // Keep display priority aligned with the highest-priority source, without changing importer/approval state.
    await QueuedVideo.updateOne({ youtubeId: id, priorityRank: PRIORITY_RANK[priority] || 2 }, { $set: { priority } });
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Another scan inserted this ID between our lookup/upsert attempt. Add our
    // source contribution to that winning record without touching its status.
    await QueuedVideo.updateOne({ youtubeId: id }, {
      $addToSet: { discoveredSources: contribution, matchedKeywords: { $each: matches } },
      $min: { priorityRank: PRIORITY_RANK[priority] || 2 }
    });
    await QueuedVideo.updateOne({ youtubeId: id, priorityRank: PRIORITY_RANK[priority] || 2 }, { $set: { priority } });
  }
}
async function scanSource(source) {
  const sourceKey = String(source._id);
  if (activeSources.has(sourceKey)) return { skipped: true, reason: 'source scan already running' };
  const lockUntil = new Date(Date.now() + 6 * 60 * 1000);
  const lock = await Source.findOneAndUpdate({ _id: source._id, $or: [{ scanLockUntil: null }, { scanLockUntil: { $lt: new Date() } }] }, { $set: { scanLockUntil: lockUntil } }, { new: true, select: '+scanLockUntil' });
  if (!lock) return { sourceId: sourceKey, skipped: true, reason: 'source scan already running' };
  activeSources.add(sourceKey);
  const startedAt = new Date();
  const history = await ScanHistory.create({ sourceId: source._id, sourceName: source.name, sourceType: source.type, startedAt });
  let inspected = 0, matched = 0, rejected = 0; const errors = [];
  try {
    const entries = await runYtDlp(source.url);
    for (const entry of entries.slice(0, LIMIT)) {
      const id = videoId(entry); if (!id) continue;
      inspected++;
      const result = findMatches(source, entry);
      if (!result.accepted) { rejected++; continue; }
      try { await upsertVideo(source, entry, result.matches); matched++; }
      catch (err) { errors.push(`${id}: ${err.message}`); }
    }
    const completedAt = new Date();
    await Source.updateOne({ _id: source._id }, { $set: { lastScannedAt: completedAt } });
    await ScanHistory.updateOne({ _id: history._id }, { $set: { completedAt, inspected, matched, rejected, errorCount: errors.length, errorDetails: errors, status: errors.length ? (inspected ? 'PARTIAL' : 'FAILED') : 'COMPLETED' } });
    console.log(`[scanner] ${source.name}: inspected=${inspected} matched=${matched} rejected=${rejected} errors=${errors.length}`);
    return { sourceId: sourceKey, inspected, matched, rejected, errors: errors.length };
  } catch (err) {
    errors.push(err.message);
    const completedAt = new Date();
    await Source.updateOne({ _id: source._id }, { $set: { lastScannedAt: completedAt } }).catch(() => {});
    await ScanHistory.updateOne({ _id: history._id }, { $set: { completedAt, inspected, matched, rejected, errorCount: errors.length, errorDetails: errors, status: 'FAILED' } });
    const message = err.code === 'ENOENT' ? `yt-dlp executable not found. Install yt-dlp and ensure it is on PATH, or set YT_DLP_PATH to its executable. (${process.env.YT_DLP_PATH || 'yt-dlp'})` : err.message;
    console.error(`[scanner] ${source.name} failed: ${message}`);
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
    const sources = await Source.find({ enabled: true }).sort({ createdAt: 1 }).lean();
    const results = [];
    for (const source of sources) results.push(await scanSource(source));
    return results;
  } finally { activeAll = false; }
}
async function scanOne(id) {
  const source = await Source.findById(id).lean();
  if (!source) { const err = new Error('Source not found'); err.status = 404; throw err; }
  if (!source.enabled) { const err = new Error('Source is disabled'); err.status = 409; throw err; }
  return scanSource(source);
}
module.exports = { scanAll, scanOne, runYtDlp, findMatches, LIMIT };
if (require.main === module) {
  require('dotenv').config();
  const { connectDB } = require('./db');
  connectDB().then(async () => { const result = await scanAll(); console.log(`[scanner] completed ${result.length} source scans`); await require('mongoose').disconnect(); })
    .catch(err => { console.error(`[scanner] fatal: ${err.message}`); process.exitCode = 1; });
}
