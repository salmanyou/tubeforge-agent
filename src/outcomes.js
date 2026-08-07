// Every run, we snapshot each video's view count (always) and, for videos we're
// actively tracking, real CTR/retention from the Analytics API (when available).
// That gives a real time series, which lets us measure whether a change actually
// moved the needle — not just whether the rule-based score went up on paper.

const HISTORY_CAP = 80; // ~20 days of 6-hourly snapshots
const MIN_DAYS_BEFORE_EVALUATING = 7; // give a change a week to show real signal
const CTR_MEANINGFUL_DELTA = 0.005; // 0.5 percentage-point CTR shift counts as real movement

function snapshotViews(state, videos) {
  const now = new Date().toISOString();
  for (const v of videos) {
    state.videos[v.id] = state.videos[v.id] || {};
    const rec = state.videos[v.id];
    rec.viewHistory = rec.viewHistory || [];
    rec.viewHistory.push({ t: now, views: Number(v.statistics?.viewCount || 0) });
    if (rec.viewHistory.length > HISTORY_CAP) rec.viewHistory = rec.viewHistory.slice(-HISTORY_CAP);
  }
}

// Separate from snapshotViews because analytics is only fetched for a subset of
// videos each run (quota-conscious), not the whole channel.
function recordAnalyticsSnapshot(state, analyticsMap) {
  const now = new Date().toISOString();
  for (const [videoId, a] of Object.entries(analyticsMap || {})) {
    if (a.impressionsClickThroughRate === undefined && a.averageViewDuration === undefined) continue;
    state.videos[videoId] = state.videos[videoId] || {};
    const rec = state.videos[videoId];
    rec.analyticsHistory = rec.analyticsHistory || [];
    rec.analyticsHistory.push({
      t: now,
      ctr: a.impressionsClickThroughRate !== undefined ? Number(a.impressionsClickThroughRate) : null,
      avgViewDuration: a.averageViewDuration !== undefined ? Number(a.averageViewDuration) : null,
      avgViewPercentage: a.averageViewPercentage !== undefined ? Number(a.averageViewPercentage) : null,
    });
    if (rec.analyticsHistory.length > HISTORY_CAP) rec.analyticsHistory = rec.analyticsHistory.slice(-HISTORY_CAP);
  }
}

function velocityBetween(history, fromISO, toISO) {
  const points = (history || []).filter(h => h.t >= fromISO && h.t <= toISO);
  if (points.length < 2) return null;
  const first = points[0], last = points[points.length - 1];
  const days = (new Date(last.t) - new Date(first.t)) / 86400000;
  if (days <= 0) return null;
  return (last.views - first.views) / days;
}

function avgFieldBetween(history, field, fromISO, toISO) {
  const points = (history || []).filter(h => h.t >= fromISO && h.t <= toISO && h[field] !== null && h[field] !== undefined);
  if (!points.length) return null;
  return points.reduce((s, p) => s + p[field], 0) / points.length;
}

// What were OTHER videos doing in this same window? Used to isolate this video's
// change from ambient channel-wide trend (a general traffic bump shouldn't get
// credited to one video's title edit).
function channelBaselineVelocity(state, excludeVideoId, fromISO, toISO) {
  const deltas = [];
  for (const [vid, rec] of Object.entries(state.videos || {})) {
    if (vid === excludeVideoId) continue;
    const v = velocityBetween(rec.viewHistory || [], fromISO, toISO);
    if (v !== null) deltas.push(v);
  }
  if (!deltas.length) return null;
  return deltas.reduce((a, b) => a + b, 0) / deltas.length;
}

// Looks at every applied change old enough to judge and records a verdict.
// Prefers real CTR (normalized, far less confounded by external promotion) when
// available; falls back to channel-relative view velocity otherwise.
function evaluateOutcomes(state, appendHistory) {
  let newlyEvaluated = 0;
  for (const [videoId, rec] of Object.entries(state.videos || {})) {
    if (!rec.appliedChanges) continue;
    for (const change of rec.appliedChanges) {
      if (change.outcome) continue;
      const daysSince = (Date.now() - new Date(change.appliedAt).getTime()) / 86400000;
      if (daysSince < MIN_DAYS_BEFORE_EVALUATING) continue;

      const beforeStart = new Date(new Date(change.appliedAt).getTime() - 7 * 86400000).toISOString();
      const afterEnd = new Date(Math.min(Date.now(), new Date(change.appliedAt).getTime() + 14 * 86400000)).toISOString();

      const ctrBefore = avgFieldBetween(rec.analyticsHistory, 'ctr', beforeStart, change.appliedAt);
      const ctrAfter = avgFieldBetween(rec.analyticsHistory, 'ctr', change.appliedAt, afterEnd);

      let verdict, detail, method;

      if (ctrBefore !== null && ctrAfter !== null) {
        const delta = ctrAfter - ctrBefore;
        verdict = delta > CTR_MEANINGFUL_DELTA ? 'improved' : delta < -CTR_MEANINGFUL_DELTA ? 'declined' : 'flat';
        detail = `CTR ${(ctrBefore * 100).toFixed(2)}%→${(ctrAfter * 100).toFixed(2)}%`;
        method = 'ctr';
      } else {
        const before = velocityBetween(rec.viewHistory, beforeStart, change.appliedAt);
        const after = velocityBetween(rec.viewHistory, change.appliedAt, afterEnd);
        if (before === null || after === null) continue; // not enough snapshot density yet

        const baseBefore = channelBaselineVelocity(state, videoId, beforeStart, change.appliedAt);
        const baseAfter = channelBaselineVelocity(state, videoId, change.appliedAt, afterEnd);
        const channelGrowth = (baseAfter !== null && baseBefore !== null) ? (baseAfter - baseBefore) : 0;
        const relativeGrowth = (after - before) - channelGrowth; // this video's move, minus ambient trend

        const bar = Math.max(Math.abs(before) * 0.1, 0.5);
        verdict = relativeGrowth > bar ? 'improved' : relativeGrowth < -bar ? 'declined' : 'flat';
        detail = `velocity ${before.toFixed(1)}→${after.toFixed(1)} views/day, channel-adjusted`;
        method = 'view-velocity';
      }

      change.outcome = { verdict, detail, method, evaluatedAt: new Date().toISOString() };
      newlyEvaluated++;
      appendHistory({ videoId, action: 'outcome', reason: `${detail} → ${verdict}` });
    }
  }
  return newlyEvaluated;
}

// Success rate across all evaluated outcomes, and an adaptive threshold that
// nudges based on it. Never goes below the configured floor — this only ever
// makes the agent MORE conservative than your config, never less.
function computeAdaptiveThreshold(state, config) {
  const allOutcomes = Object.values(state.videos || {})
    .flatMap(r => (r.appliedChanges || []).map(c => c.outcome).filter(Boolean));

  const base = config.automation.minScoreGainToApply;
  if (allOutcomes.length < 3) {
    return { threshold: base, successRate: null, sampleSize: allOutcomes.length };
  }

  const improved = allOutcomes.filter(o => o.verdict === 'improved').length;
  const successRate = improved / allOutcomes.length;

  let threshold = base;
  if (successRate < 0.4) threshold = base + 15;
  else if (successRate < 0.6) threshold = base + 5;

  return { threshold, successRate: Math.round(successRate * 100) / 100, sampleSize: allOutcomes.length };
}

module.exports = { snapshotViews, recordAnalyticsSnapshot, evaluateOutcomes, computeAdaptiveThreshold };
