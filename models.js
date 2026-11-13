'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const defaultVideosPerScan = Math.min(10000, Math.max(1, Number.parseInt(process.env.VIDEOS_PER_SOURCE || '50', 10) || 50));

const sourceSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  url: { type: String, required: true, trim: true },
  type: { type: String, required: true, enum: ['channel', 'playlist', 'shorts'] },
  videosPerScan: { type: Number, default: defaultVideosPerScan, min: 1, max: 10000 },
  scanDescription: { type: Boolean, default: true },
  thumbnailGeminiEnabled: { type: Boolean, default: false },
  generateNfo: { type: Boolean, default: false },
  keywords: { type: [String], default: [] },
  excludeKeywords: { type: [String], default: [] },
  matchMode: { type: String, enum: ['ANY', 'ALL'], default: 'ANY' },
  priority: { type: String, enum: ['HIGH', 'NORMAL', 'LOW'], default: 'NORMAL' },
  autoApproveVideos: { type: Boolean, default: false },
  enabled: { type: Boolean, default: true },
  lastScannedAt: { type: Date, default: null },
  scanLockUntil: { type: Date, default: null, select: false }
}, { timestamps: true });
sourceSchema.index({ url: 1 }, { unique: true });

const discoveredSourceSchema = new Schema({
  sourceId: { type: Schema.Types.ObjectId, required: true },
  name: { type: String, required: true },
  type: { type: String, required: true },
  priority: { type: String, enum: ['HIGH', 'NORMAL', 'LOW'], required: true },
  matchedKeywords: { type: [String], default: [] },
  discoveredAt: { type: Date, default: Date.now }
}, { _id: false });
const queueSchema = new Schema({
  youtubeId: { type: String, required: true, unique: true, index: true },
  title: { type: String, default: '' }, description: { type: String, default: '' },
  url: { type: String, required: true }, thumbnail: { type: String, default: '' },
  uploadDate: { type: String, default: '' }, duration: { type: Number, default: null },
  discoveredSources: { type: [discoveredSourceSchema], default: [] },
  matchedKeywords: { type: [String], default: [] },
  priority: { type: String, enum: ['HIGH', 'NORMAL', 'LOW'], default: 'NORMAL' },
  priorityRank: { type: Number, enum: [1, 2, 3], default: 2 },
  approvalStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
  status: { type: String, enum: ['AWAITING_APPROVAL', 'PENDING', 'PROCESSING', 'SENT', 'PROCESSED', 'FAILED'], default: 'PENDING' },
  retryCount: { type: Number, default: 0, min: 0 }, maxRetries: { type: Number, default: 3, min: 1 },
  lastError: { type: String, default: '' }, discoveredAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null }
}, { timestamps: true });
queueSchema.index({ status: 1, approvalStatus: 1, priorityRank: 1, discoveredAt: 1 });
queueSchema.index({ approvalStatus: 1, discoveredAt: -1 });

const historySchema = new Schema({
  sourceId: { type: Schema.Types.ObjectId, default: null }, sourceName: { type: String, required: true },
  sourceType: { type: String, required: true }, startedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null }, inspected: { type: Number, default: 0 },
  matched: { type: Number, default: 0 }, rejected: { type: Number, default: 0 }, errorCount: { type: Number, default: 0 },
  status: { type: String, enum: ['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'], default: 'RUNNING' },
  errorDetails: { type: [String], default: [] }
}, { timestamps: true });
historySchema.index({ sourceId: 1, startedAt: -1 });
historySchema.index({ startedAt: -1 });

const scannerSettingsSchema = new Schema({
  _id: { type: String, default: 'global' },
  autoScanEnabled: { type: Boolean, default: true },
  scanIntervalMinutes: { type: Number, default: 360, min: 1, max: 10080 }
}, { timestamps: true, collection: 'scanner_settings' });

module.exports = {
  Source: mongoose.models.Source || mongoose.model('Source', sourceSchema, 'sources'),
  QueuedVideo: mongoose.models.QueuedVideo || mongoose.model('QueuedVideo', queueSchema, 'youtube_queue'),
  ScanHistory: mongoose.models.ScanHistory || mongoose.model('ScanHistory', historySchema, 'scan_history'),
  ScannerSettings: mongoose.models.ScannerSettings || mongoose.model('ScannerSettings', scannerSettingsSchema)
};
