'use strict';
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { connectDB } = require('./db');
const { Source, QueuedVideo, ScanHistory, ScannerSettings } = require('./models');
const scanner = require('./scanner');
const scheduler = require('./scheduler');
const logger = require('./logger');
const app = express();
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const details = { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started, clientIp: req.ip };
    if (req.path === '/api/health') logger.debug('http_request_completed', details);
    else if (res.statusCode >= 500) logger.error('http_request_failed', details);
    else if (res.statusCode >= 400) logger.warn('http_request_rejected', details);
    else logger.info('http_request_completed', details);
  });
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use(express.static('public'));
const priorities = ['HIGH', 'NORMAL', 'LOW'];
const types = ['channel', 'playlist', 'shorts'];
const matchModes = ['ANY', 'ALL'];
const allowedUrl = value => { try { const u = new URL(value); return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'youtube.com.', 'www.youtube.com.'].includes(u.hostname) || u.hostname.endsWith('.youtube.com'); } catch { return false; } };
function cleanKeywords(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 200 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 120)) throw Object.assign(new Error('Keywords must be an array of non-empty strings (max 120 chars each)'), { status: 400 });
  return [...new Set(value.map(v => v.trim()))];
}
function sourceInput(body, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('JSON object required'), { status: 400 });
  const out = {};
  for (const key of ['name', 'url', 'type', 'matchMode', 'priority', 'enabled', 'autoApproveVideos', 'videosPerScan', 'scanDescription', 'generateNfo', 'keywords', 'excludeKeywords']) {
    if (!(key in body)) continue;
    const value = body[key];
    if (key === 'name') { if (typeof value !== 'string' || !value.trim() || value.length > 160) throw Object.assign(new Error('Name is required (max 160 chars)'), { status: 400 }); out.name = value.trim(); }
    else if (key === 'url') { if (typeof value !== 'string' || !allowedUrl(value)) throw Object.assign(new Error('A valid YouTube URL is required'), { status: 400 }); out.url = value.trim(); }
    else if (key === 'type') { if (!types.includes(value)) throw Object.assign(new Error('Invalid source type'), { status: 400 }); out.type = value; }
    else if (key === 'matchMode') { if (!matchModes.includes(value)) throw Object.assign(new Error('matchMode must be ANY or ALL'), { status: 400 }); out.matchMode = value; }
    else if (key === 'priority') { if (!priorities.includes(value)) throw Object.assign(new Error('Invalid priority'), { status: 400 }); out.priority = value; }
    else if (key === 'enabled') { if (typeof value !== 'boolean') throw Object.assign(new Error('enabled must be boolean'), { status: 400 }); out.enabled = value; }
    else if (key === 'autoApproveVideos') { if (typeof value !== 'boolean') throw Object.assign(new Error('autoApproveVideos must be boolean'), { status: 400 }); out.autoApproveVideos = value; }
    else if (key === 'videosPerScan') { if (!Number.isInteger(value) || value < 1 || value > 10000) throw Object.assign(new Error('videosPerScan must be an integer from 1 to 10000'), { status: 400 }); out.videosPerScan = value; }
    else if (key === 'scanDescription' || key === 'generateNfo') { if (typeof value !== 'boolean') throw Object.assign(new Error(`${key} must be boolean`), { status: 400 }); out[key] = value; }
    else out[key] = cleanKeywords(value);
  }
  if (out.type && out.type !== 'channel' && out.autoApproveVideos) throw Object.assign(new Error('Automatic video approval is only available for channel sources'), { status: 400 });
  if (out.type && out.type !== 'channel' && out.autoApproveVideos === undefined) out.autoApproveVideos = false;
  if (!partial && (!out.name || !out.url || !out.type)) throw Object.assign(new Error('name, url and type are required'), { status: 400 });
  return out;
}
function objectId(value) { if (!mongoose.isValidObjectId(value)) throw Object.assign(new Error('Invalid id'), { status: 400 }); }
function rankSort() { return { priorityRank: 1, discoveredAt: 1 }; }
function requestedSort(req, allowed, fallback) {
  const field = String(req.query.sort || '');
  const order = String(req.query.order || 'asc');
  if (!field) return fallback;
  if (!Object.hasOwn(allowed, field) || !['asc', 'desc'].includes(order)) return null;
  const direction = order === 'asc' ? 1 : -1;
  const result = { [allowed[field]]: direction };
  if (field === 'priorityRank') result.discoveredAt = 1;
  result._id = -1;
  return result;
}
app.get('/api/health', (_req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));
app.get('/api/sources', async (_req, res, next) => { try { res.json(await Source.find().sort({ type: 1, name: 1 }).lean()); } catch (e) { next(e); } });
app.post('/api/sources', async (req, res, next) => { try { res.status(201).json(await Source.create(sourceInput(req.body))); } catch (e) { next(e); } });
app.put('/api/sources/:id', async (req, res, next) => { try { objectId(req.params.id); const updates = sourceInput(req.body, true); const current = await Source.findById(req.params.id).select('type'); if (!current) return res.status(404).json({ error: 'Source not found' }); if ((updates.type || current.type) !== 'channel' && updates.autoApproveVideos) throw Object.assign(new Error('Automatic video approval is only available for channel sources'), { status: 400 }); const source = await Source.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true, runValidators: true }); res.json(source); } catch (e) { next(e); } });
app.delete('/api/sources/:id', async (req, res, next) => { try { objectId(req.params.id); const source = await Source.findByIdAndDelete(req.params.id); if (!source) return res.status(404).json({ error: 'Source not found' }); res.json({ deleted: true }); } catch (e) { next(e); } });
app.get('/api/queue', async (req, res, next) => { try {
  const page = Math.max(1, Math.min(1000000, Number.parseInt(req.query.page || '1', 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || '50', 10) || 50));
  const filter = {};
  for (const key of ['status', 'approvalStatus', 'priority']) if (req.query[key]) {
    const allowed = key === 'status' ? ['AWAITING_APPROVAL', 'PENDING', 'PROCESSING', 'SENT', 'PROCESSED', 'FAILED'] : key === 'approvalStatus' ? ['PENDING', 'APPROVED', 'REJECTED'] : priorities;
    if (!allowed.includes(req.query[key])) return res.status(400).json({ error: `Invalid ${key}` }); filter[key] = req.query[key];
  }
  // Treat a PENDING queue request as an importer request: never expose pending
  // or rejected approvals unless the caller explicitly asks for an approval state.
  if (filter.status === 'PENDING' && !filter.approvalStatus) filter.approvalStatus = 'APPROVED';
  if (req.query.q) filter.$or = ['title', 'youtubeId', 'description'].map(k => ({ [k]: { $regex: String(req.query.q).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }));
  const sort = requestedSort(req, { discoveredAt: 'discoveredAt', title: 'title', priorityRank: 'priorityRank', duration: 'duration', status: 'status' }, rankSort());
  if (!sort) return res.status(400).json({ error: 'Invalid queue sort or order' });
  const [items, total] = await Promise.all([QueuedVideo.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), QueuedVideo.countDocuments(filter)]);
  res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
} catch (e) { next(e); } });
app.post('/api/queue/claim', async (req, res, next) => {
  try {
    const limit = req.body?.limit === undefined ? 50 : req.body.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ error: 'limit must be an integer from 1 to 100' });
    const candidates = await QueuedVideo.find({ status: 'PENDING', approvalStatus: 'APPROVED', $expr: { $lt: ['$retryCount', '$maxRetries'] } })
      .sort(rankSort()).limit(limit).select('_id').lean();
    const claimed = [];
    for (const candidate of candidates) {
      const item = await QueuedVideo.findOneAndUpdate(
        { _id: candidate._id, status: 'PENDING', approvalStatus: 'APPROVED', $expr: { $lt: ['$retryCount', '$maxRetries'] } },
        { $set: { status: 'PROCESSING' } }, { new: true }
      ).lean();
      if (item) claimed.push(item);
    }
    logger.info('queue_items_claimed', { claimed: claimed.length, requested: limit, approvalStatusRequired: 'APPROVED' });
    res.json({ items: claimed, total: claimed.length });
  } catch (e) { next(e); }
});
async function approval(req, res, next, status) { try { objectId(req.params.id); const update = status === 'APPROVED' ? { $set: { approvalStatus: status, status: 'PENDING' } } : { $set: { approvalStatus: status, status: 'AWAITING_APPROVAL' } }; const item = await QueuedVideo.findOneAndUpdate({ _id: req.params.id, status: { $in: ['AWAITING_APPROVAL', 'PENDING'] }, approvalStatus: { $ne: 'REJECTED' } }, update, { new: true }); if (!item) return res.status(409).json({ error: 'Video is missing, already rejected, or has already been claimed/sent; approval cannot be changed now' }); res.json(item); } catch (e) { next(e); } }
app.post('/api/queue/:id/approve', (req, res, next) => approval(req, res, next, 'APPROVED'));
app.post('/api/queue/:id/reject', (req, res, next) => approval(req, res, next, 'REJECTED'));
app.post('/api/queue/bulk-approve', async (req, res, next) => { try { const ids = req.body?.ids; if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || ids.some(id => !mongoose.isValidObjectId(id))) return res.status(400).json({ error: 'ids must contain 1 to 500 valid IDs' }); const result = await QueuedVideo.updateMany({ _id: { $in: ids }, approvalStatus: 'PENDING', status: { $in: ['AWAITING_APPROVAL', 'PENDING'] } }, { $set: { approvalStatus: 'APPROVED', status: 'PENDING' } }); res.json({ modified: result.modifiedCount }); } catch (e) { next(e); } });
app.post('/api/queue/:id/retry', async (req, res, next) => { try { objectId(req.params.id); const base = { _id: req.params.id, status: 'FAILED', $expr: { $lt: ['$retryCount', '$maxRetries'] } }; let item = await QueuedVideo.findOneAndUpdate({ ...base, approvalStatus: 'APPROVED' }, { $set: { status: 'PENDING', lastError: '' } }, { new: true }); if (!item) item = await QueuedVideo.findOneAndUpdate({ ...base, approvalStatus: 'PENDING' }, { $set: { status: 'AWAITING_APPROVAL', lastError: '' } }, { new: true }); if (!item) return res.status(409).json({ error: 'Video is not eligible for retry' }); res.json(item); } catch (e) { next(e); } });
app.post('/api/queue/:id/reset', async (req, res, next) => { try { objectId(req.params.id); const base = { _id: req.params.id, status: 'FAILED' }; let item = await QueuedVideo.findOneAndUpdate({ ...base, approvalStatus: 'APPROVED' }, { $set: { status: 'PENDING', retryCount: 0, lastError: '' } }, { new: true }); if (!item) item = await QueuedVideo.findOneAndUpdate({ ...base, approvalStatus: 'PENDING' }, { $set: { status: 'AWAITING_APPROVAL', retryCount: 0, lastError: '' } }, { new: true }); if (!item) return res.status(409).json({ error: 'Only non-rejected failed videos can be reset' }); res.json(item); } catch (e) { next(e); } });
app.post('/api/queue/bulk-retry', async (req, res, next) => { try { const ids = req.body?.ids; if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 || ids.some(id => !mongoose.isValidObjectId(id)))) return res.status(400).json({ error: 'ids must contain at most 500 valid IDs' }); const base = { status: 'FAILED', $expr: { $lt: ['$retryCount', '$maxRetries'] } }; if (ids) base._id = { $in: ids }; const approved = await QueuedVideo.updateMany({ ...base, approvalStatus: 'APPROVED' }, { $set: { status: 'PENDING', lastError: '' } }); const pending = await QueuedVideo.updateMany({ ...base, approvalStatus: 'PENDING' }, { $set: { status: 'AWAITING_APPROVAL', lastError: '' } }); res.json({ modified: approved.modifiedCount + pending.modifiedCount }); } catch (e) { next(e); } });
let scanPromise = null;
app.post('/api/scan', async (_req, res, next) => { try { if (scanPromise) return res.status(409).json({ error: 'A full scan is already running' }); scanPromise = scanner.scanAll(); res.status(202).json({ message: 'Scan started' }); scanPromise.catch(e => console.error('[api] scan error:', e.message)).finally(() => { scanPromise = null; }); } catch (e) { next(e); } });
app.post('/api/scan/:sourceId', async (req, res, next) => { try { objectId(req.params.sourceId); const result = await scanner.scanOne(req.params.sourceId); res.json(result); } catch (e) { next(e); } });
app.get('/api/scan-history', async (req, res, next) => { try { const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1); const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || '50', 10) || 50)); const sort = requestedSort(req, { startedAt: 'startedAt', sourceName: 'sourceName', matched: 'matched', errors: 'errorCount' }, { startedAt: -1 }); if (!sort) return res.status(400).json({ error: 'Invalid scan history sort or order' }); const [items, total] = await Promise.all([ScanHistory.find().sort(sort).skip((page - 1) * limit).limit(limit).lean(), ScanHistory.countDocuments()]); res.json({ items, total, page, limit }); } catch (e) { next(e); } });
app.get('/api/scan-history/:sourceId', async (req, res, next) => { try { objectId(req.params.sourceId); res.json(await ScanHistory.find({ sourceId: req.params.sourceId }).sort({ startedAt: -1 }).limit(100).lean()); } catch (e) { next(e); } });
app.get('/api/settings/scan', async (_req, res, next) => {
  try {
    const settings = await scheduler.getSettings();
    res.json({ autoScanEnabled: settings.autoScanEnabled, scanIntervalMinutes: settings.scanIntervalMinutes, nextScanAt: scheduler.getNextScanAt() });
  } catch (e) { next(e); }
});
app.put('/api/settings/scan', async (req, res, next) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'JSON object required' });
    const updates = {};
    if ('autoScanEnabled' in req.body) {
      if (typeof req.body.autoScanEnabled !== 'boolean') return res.status(400).json({ error: 'autoScanEnabled must be boolean' });
      updates.autoScanEnabled = req.body.autoScanEnabled;
    }
    if ('scanIntervalMinutes' in req.body) {
      const value = req.body.scanIntervalMinutes;
      if (!Number.isInteger(value) || value < 1 || value > 10080) return res.status(400).json({ error: 'scanIntervalMinutes must be an integer from 1 to 10080' });
      updates.scanIntervalMinutes = value;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Provide autoScanEnabled or scanIntervalMinutes' });
    const settings = await scheduler.updateSettings(updates);
    logger.info('automatic_scan_settings_updated', { autoScanEnabled: settings.autoScanEnabled, intervalMinutes: settings.scanIntervalMinutes, nextScanAt: scheduler.getNextScanAt()?.toISOString() || null });
    res.json({ autoScanEnabled: settings.autoScanEnabled, scanIntervalMinutes: settings.scanIntervalMinutes, nextScanAt: scheduler.getNextScanAt() });
  } catch (e) { next(e); }
});
app.get('/api/stats', async (_req, res, next) => { try { const [sources, queue] = await Promise.all([Source.countDocuments(), QueuedVideo.aggregate([{ $group: { _id: null, total: { $sum: 1 }, pendingApproval: { $sum: { $cond: [{ $eq: ['$approvalStatus', 'PENDING'] }, 1, 0] } }, approved: { $sum: { $cond: [{ $eq: ['$approvalStatus', 'APPROVED'] }, 1, 0] } }, pendingImports: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'PENDING'] }, { $eq: ['$approvalStatus', 'APPROVED'] }] }, 1, 0] } }, processed: { $sum: { $cond: [{ $eq: ['$status', 'PROCESSED'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] } } } }])]); res.json({ sources, ...(queue[0] || { total: 0, pendingApproval: 0, approved: 0, pendingImports: 0, processed: 0, failed: 0 }) }); } catch (e) { next(e); } });
app.use((err, _req, res, _next) => {
  logger.error('http_request_exception', { message: err.message, stack: err.stack });
  if (err.code === 11000) return res.status(409).json({ error: 'A source with this URL already exists' });
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
});
async function start() {
  logger.info('server_starting', { port: Number(process.env.PORT || 3000), logLevel: process.env.LOG_LEVEL || 'info' });
  await connectDB();
  logger.info('mongodb_connected');
  await Promise.all([Source.init(), QueuedVideo.init(), ScanHistory.init(), ScannerSettings.init()]);
  logger.info('mongodb_indexes_ready', { collections: ['sources', 'youtube_queue', 'scan_history', 'scanner_settings'] });
  const approvalHoldback = await QueuedVideo.updateMany({ status: 'PENDING', approvalStatus: { $ne: 'APPROVED' } }, { $set: { status: 'AWAITING_APPROVAL' } });
  if (approvalHoldback.modifiedCount) logger.warn('unapproved_queue_items_held_back', { movedToAwaitingApproval: approvalHoldback.modifiedCount });
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => logger.info('server_listening', { port, trustedLanOnly: true }));
  await scheduler.startScheduler();
}
if (require.main === module) start().catch(err => { logger.error('server_startup_failed', { message: err.message, stack: err.stack }); process.exit(1); });
module.exports = app;
