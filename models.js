'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const defaultVideosPerScan = Math.min(10000, Math.max(1, Number.parseInt(process.env.VIDEOS_PER_SOURCE || '50', 10) || 50));
const visualReferenceSchema = new Schema({
  fileId: { type: String, required: true },
  url: { type: String, required: true },
  mimeType: { type: String, required: true },
  bytes: { type: Number, default: 0 }
});

const sourceSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  url: { type: String, required: true, trim: true },
  type: { type: String, required: true, enum: ['channel', 'playlist', 'shorts'] },
  videosPerScan: { type: Number, default: defaultVideosPerScan, min: 1, max: 10000 },
  adaptiveDiscoveryEnabled: { type: Boolean, default: false },
  trendingDiscoveryEnabled: { type: Boolean, default: false },
  dailyTopVideosEnabled: { type: Boolean, default: false },
  dailyTopVideosCount: { type: Number, default: 1, min: 1, max: 10 },
  adaptiveContentType: { type: String, enum: ['BOTH', 'VIDEOS', 'SHORTS'], default: 'BOTH' },
  adaptiveLastRunAt: { type: Date, default: null },
  scanDescription: { type: Boolean, default: true },
  thumbnailGeminiEnabled: { type: Boolean, default: false },
  geminiLastScannedVideoId: { type: String, default: '' },
  visualMatchEnabled: { type: Boolean, default: false },
  visualMatchAutoApprove: { type: Boolean, default: true },
  visualMatchAction: { type: String, enum: ['ACCEPT', 'REJECT'], default: 'ACCEPT' },
  visualReferences: { type: [visualReferenceSchema], default: [] },
  keywordSearchMode: { type: String, enum: ['TEXT', 'REGEX'], default: 'TEXT' },
  visualReferenceMimeType: { type: String, default: '' },
  visualReferenceFileId: { type: String, default: '' },
  visualReferenceUrl: { type: String, default: '' },
  visualReferenceImage: { type: Buffer, select: false }, // Legacy field, removed after ImageKit migration.
  generateNfo: { type: Boolean, default: false },
  keywords: { type: [String], default: [] },
  excludeKeywords: { type: [String], default: [] },
  matchMode: { type: String, enum: ['ANY', 'ALL'], default: 'ANY' },
  priority: { type: String, enum: ['HIGH', 'NORMAL', 'LOW'], default: 'NORMAL' },
  autoApproveVideos: { type: Boolean, default: false },
  enabled: { type: Boolean, default: true },
  lastScannedAt: { type: Date, default: null },
  scanLockUntil: { type: Date, default: null, select: false },
  scanLockToken: { type: String, default: null, select: false }
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

const adaptiveVideoSchema = new Schema({
  sourceId: { type: Schema.Types.ObjectId, required: true }, youtubeId: { type: String, required: true },
  channelId: { type: String, default: '' }, channelName: { type: String, default: '' }, title: { type: String, default: '' },
  description: { type: String, default: '' }, thumbnail: { type: String, default: '' }, videoUrl: { type: String, default: '' },
  publishedAt: { type: Date, required: true }, duration: { type: Number, default: null },
  contentType: { type: String, enum: ['video', 'short'], default: 'video' },
  views: { type: Number, default: null }, likes: { type: Number, default: null }, comments: { type: Number, default: null },
  engagementRate: { type: Number, default: null }, engagementIncomplete: { type: Boolean, default: true },
  statsUpdatedAt: { type: Date, default: null }, lastDailyViewGrowth: { type: Number, default: null },
  lastDailyLikeGrowth: { type: Number, default: null }, viewSurge: { type: Boolean, default: false },
  viewSurgeDetectedAt: { type: Date, default: null }, viewVelocityPerDay: { type: Number, default: null },
  surgeThresholdPerDay: { type: Number, default: null }, rejectionReason: { type: String, default: '' }, matchedKeywords: { type: [String], default: [] }
}, { timestamps: true, collection: 'adaptive_channel_videos' });
adaptiveVideoSchema.index({ sourceId: 1, youtubeId: 1 }, { unique: true });
adaptiveVideoSchema.index({ sourceId: 1, publishedAt: -1 });

const channelProfileSchema = new Schema({
  sourceId: { type: Schema.Types.ObjectId, required: true, unique: true }, channelId: { type: String, default: '' }, channelName: { type: String, default: '' },
  candidateCount: { type: Number, default: 0 }, medianViews: { type: Number, default: null }, percentile25Views: { type: Number, default: null }, percentile75Views: { type: Number, default: null },
  averageViews: { type: Number, default: null }, medianLikes: { type: Number, default: null }, medianComments: { type: Number, default: null },
  medianEngagementRate: { type: Number, default: null }, averageEngagementRate: { type: Number, default: null }, percentile75EngagementRate: { type: Number, default: null },
  averageUploadsPerDay7d: { type: Number, default: 0 }, averageUploadsPerDay30d: { type: Number, default: 0 }, uploadsLast24Hours: { type: Number, default: 0 },
  averageTimeBetweenUploadsHours: { type: Number, default: null }, averageDailyViewGrowth: { type: Number, default: null },
  projectedUploadsNext15Days: { type: Number, default: null }, uploadRateReliable: { type: Boolean, default: false },
  minimumViewsThreshold: { type: Number, default: null }, thresholdSampleSize: { type: Number, default: 0 }, thresholdProvisional: { type: Boolean, default: true },
  thresholdMethod: { type: String, default: 'linear-interpolation' }, discoveryWindowDays: { type: Number, default: 90 }, calculatedAt: { type: Date, default: null }
}, { timestamps: true, collection: 'channel_profiles' });

const channelRankingSchema = new Schema({
  sourceId: { type: Schema.Types.ObjectId, required: true }, channelId: { type: String, default: '' }, channelName: { type: String, default: '' },
  rankingDate: { type: Date, required: true }, rankingType: { type: String, enum: ['recent', 'engagement'], required: true },
  entries: [{ youtubeId: String, rank: Number, title: String, thumbnail: String, videoUrl: String, publishedAt: Date, views: Number, likes: Number, comments: Number, engagementRate: Number, relativeEngagement: Number, queueStatus: String, accepted: Boolean, rejectionReason: String, matchedKeywords: [String] }]
}, { timestamps: true, collection: 'channel_rankings' });
channelRankingSchema.index({ sourceId: 1, rankingDate: -1, rankingType: 1 }, { unique: true });

const videoStatsHistorySchema = new Schema({
  sourceId: { type: Schema.Types.ObjectId, required: true }, youtubeId: { type: String, required: true }, channelId: { type: String, default: '' },
  capturedAt: { type: Date, required: true }, views: { type: Number, default: null }, likes: { type: Number, default: null }, comments: { type: Number, default: null }, engagementRate: { type: Number, default: null }
}, { timestamps: true, collection: 'video_stats_history' });
videoStatsHistorySchema.index({ sourceId: 1, youtubeId: 1, capturedAt: 1 }, { unique: true });
const statsRetentionDays = Math.max(30, Number.parseInt(process.env.STATS_RETENTION_DAYS || '45', 10) || 45);
videoStatsHistorySchema.index({ capturedAt: 1 }, { expireAfterSeconds: statsRetentionDays * 86400 });

module.exports = {
  Source: mongoose.models.Source || mongoose.model('Source', sourceSchema, 'sources'),
  QueuedVideo: mongoose.models.QueuedVideo || mongoose.model('QueuedVideo', queueSchema, 'youtube_queue'),
  ScanHistory: mongoose.models.ScanHistory || mongoose.model('ScanHistory', historySchema, 'scan_history'),
  ScannerSettings: mongoose.models.ScannerSettings || mongoose.model('ScannerSettings', scannerSettingsSchema),
  AdaptiveVideo: mongoose.models.AdaptiveVideo || mongoose.model('AdaptiveVideo', adaptiveVideoSchema),
  ChannelProfile: mongoose.models.ChannelProfile || mongoose.model('ChannelProfile', channelProfileSchema),
  ChannelRanking: mongoose.models.ChannelRanking || mongoose.model('ChannelRanking', channelRankingSchema),
  VideoStatsHistory: mongoose.models.VideoStatsHistory || mongoose.model('VideoStatsHistory', videoStatsHistorySchema)
};
