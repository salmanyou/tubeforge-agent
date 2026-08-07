const { google } = require('googleapis');
const { getAuthenticatedClient } = require('./auth');

function client() {
  const auth = getAuthenticatedClient();
  return google.youtubeAnalytics({ version: 'v2', auth });
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

async function queryReport(videoIds, startDate, endDate, metrics) {
  const yta = client();
  const { data } = await yta.reports.query({
    ids: 'channel==MINE',
    startDate,
    endDate,
    metrics,
    dimensions: 'video',
    filters: 'video==' + videoIds.join(','),
    maxResults: videoIds.length,
  });
  const headers = (data.columnHeaders || []).map(h => h.name);
  const out = {};
  for (const row of data.rows || []) {
    const rec = {};
    headers.forEach((h, i) => { rec[h] = row[i]; });
    if (rec.video) out[rec.video] = rec;
  }
  return out;
}

// Real click-through rate + retention for specific videos. This is owner-only data —
// far stronger signal than public view counts, since it's not confounded by external
// promotion, algorithm pushes, or shares that have nothing to do with the metadata.
//
// Returns {} (not an error) rather than throwing when analytics simply isn't ready —
// there's a reporting lag of a few days, and very low-traffic videos can have sparse
// or missing rows. Callers should treat this as "may be empty" and fall back gracefully.
async function fetchAnalytics(videoIds, daysBack = 14) {
  if (!videoIds.length) return {};
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 86400000);
  const startDate = isoDate(start);
  const endDate = isoDate(end);

  const fullMetrics = 'views,averageViewDuration,averageViewPercentage,impressions,impressionsClickThroughRate';
  const basicMetrics = 'views,averageViewDuration,averageViewPercentage';

  try {
    return await queryReport(videoIds, startDate, endDate, fullMetrics);
  } catch (e) {
    try {
      console.warn('Full analytics metrics unavailable, trying a smaller metric set:', e.message);
      return await queryReport(videoIds, startDate, endDate, basicMetrics);
    } catch (e2) {
      console.warn('Analytics API unavailable this run — continuing with public view counts only:', e2.message);
      return {};
    }
  }
}

module.exports = { fetchAnalytics };
