'use strict';

function numbers(videos, key) { return videos.map(video => video[key]).filter(value => Number.isFinite(value)); }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function median(values) { return quantile(values, 0.5); }
function quantile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position); const fraction = position - lower;
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * fraction;
}
function computeProfile(videos, now = new Date()) {
  const views = numbers(videos, 'views');
  const likes = numbers(videos, 'likes');
  const comments = numbers(videos, 'comments');
  const engagements = videos.filter(video => Number.isFinite(video.engagementRate)).map(video => video.engagementRate);
  const dates = videos.map(video => new Date(video.publishedAt)).filter(date => Number.isFinite(date.getTime())).sort((a, b) => a - b);
  const recent24 = dates.filter(date => now - date <= 86400000).length;
  const recent7 = dates.filter(date => now - date <= 7 * 86400000).length;
  const recent30 = dates.filter(date => now - date <= 30 * 86400000).length;
  const gaps = dates.slice(1).map((date, index) => (date - dates[index]) / 3600000);
  return {
    candidateCount: videos.length, medianViews: median(views), percentile25Views: quantile(views, 0.25), percentile75Views: quantile(views, 0.75), averageViews: mean(views),
    medianLikes: median(likes), medianComments: median(comments), medianEngagementRate: median(engagements), averageEngagementRate: mean(engagements), percentile75EngagementRate: quantile(engagements, 0.75),
    uploadsLast24Hours: recent24, averageUploadsPerDay7d: recent7 / 7, averageUploadsPerDay30d: recent30 / 30,
    averageTimeBetweenUploadsHours: mean(gaps), minimumViewsThreshold: quantile(views, 0.25), thresholdSampleSize: views.length,
    thresholdProvisional: videos.length < 30, thresholdMethod: 'linear-interpolation', discoveryWindowDays: 90, calculatedAt: now
  };
}
function rankVideos(videos, profile) {
  const recent = videos.filter(video => Number.isFinite(video.views)).sort((a, b) => b.views - a.views).slice(0, 10);
  const threshold = profile.minimumViewsThreshold;
  const engagement = videos.filter(video => Number.isFinite(video.views) && video.views > 0 && video.views >= (threshold ?? 0)
    && Number.isFinite(video.likes) && Number.isFinite(video.comments) && Number.isFinite(video.engagementRate))
    .sort((a, b) => b.engagementRate - a.engagementRate).slice(0, 10);
  const toEntry = (video, rank) => ({
    youtubeId: video.youtubeId, rank: rank + 1, title: video.title || '', thumbnail: video.thumbnail || '', videoUrl: video.videoUrl || '', publishedAt: video.publishedAt,
    views: video.views, likes: video.likes, comments: video.comments, engagementRate: video.engagementRate,
    relativeEngagement: Number.isFinite(video.engagementRate) && Number.isFinite(profile.medianEngagementRate) && profile.medianEngagementRate > 0 ? video.engagementRate / profile.medianEngagementRate : null
  });
  return { recent: recent.map(toEntry), engagement: engagement.map(toEntry) };
}
module.exports = { computeProfile, rankVideos, quantile, median, mean };
