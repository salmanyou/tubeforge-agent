// Every run, we snapshot each video's view count. That gives us a real time
// series, which lets us measure whether a change actually moved the needle —
// not just whether the rule-based score went up on paper.

const HISTORY_CAP = 80; // ~20 days of 6-hourly snapshots
const MIN_DAYS_BEFORE_EVALUATING = 7; // give a change a week to show real signal

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

function velocityBetween(history, fromISO, toISO) {
  const points = history.filter(h => h.t >= fromISO && h.t <= toISO);
  if (points.length < 2) return null;
  const first = points[0], last = points[points.length - 1];
  const days = (new Date(last.t) - new Date(first.t)) / 86400000;
  if (days <= 0) return null;
  return (last.views - first.views) / days; // views/day
}

// Looks at every applied change old enough to judge, compares the view
// velocity in the week before vs. the week (or more) after, and records a
// verdict. Returns how many new outcomes were scored this run.
function evaluateOutcomes(state, appendHistory) {
  let newlyEvaluated = 0;
  for (const [videoId, rec] of Object.entries(state.videos || {})) {
    if (!rec.appliedChanges) continue;
    for (const change of rec.appliedChanges) {
      if (change.outcome) continue; // already scored
      const daysSince = (Date.now() - new Date(change.appliedAt).getTime()) / 86400000;
      if (daysSince < MIN_DAYS_BEFORE_EVALUATING) continue;

      const before = velocityBetween(
        rec.viewHistory,
        new Date(new Date(change.appliedAt).getTime() - 7 * 86400000).toISOString(),
        change.appliedAt
      );
      const afterWindowEnd = new Date(Math.min(Date.now(), new Date(change.appliedAt).getTime() + 14 * 86400000)).toISOString();
      const after = velocityBetween(rec.viewHistory, change.appliedAt, afterWindowEnd);

      if (before === null || after === null) continue; // not enough snapshot density yet

      const verdict = after > before * 1.1 ? 'improved' : after < before * 0.9 ? 'declined' : 'flat';
      change.outcome = { verdict, velocityBefore: Math.round(before * 100) / 100, velocityAfter: Math.round(after * 100) / 100, evaluatedAt: new Date().toISOString() };
      newlyEvaluated++;
      appendHistory({ videoId, action: 'outcome', reason: `Velocity ${before.toFixed(1)}→${after.toFixed(1)} views/day → ${verdict}` });
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
  if (successRate < 0.4) threshold = Math.min(base + 15, base + 15);
  else if (successRate < 0.6) threshold = base + 5;
  // successRate >= 0.6: stick with the configured base — it's working, no need to tighten further.

  return { threshold, successRate: Math.round(successRate * 100) / 100, sampleSize: allOutcomes.length };
}

module.exports = { snapshotViews, evaluateOutcomes, computeAdaptiveThreshold };
