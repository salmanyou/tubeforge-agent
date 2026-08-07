require('dotenv').config();
const fs = require('fs');
const path = require('path');

const config = require('../config.json');
const yt = require('./youtube');
const analytics = require('./analytics');
const { generateOptimizedMetadata } = require('./ai');
const { evaluateProposal } = require('./safety');
const { scoreMetadata } = require('./scorer');
const { snapshotViews, recordAnalyticsSnapshot, evaluateOutcomes, computeAdaptiveThreshold } = require('./outcomes');
const { loadState, saveState, appendHistory } = require('./store');

const DRY_RUN = process.env.DRY_RUN === 'true' || config.automation.dryRun === true;

function daysSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

function firstKeyword(title) {
  // crude but effective: longest word in the title, ignoring stopwords, as the seed keyword
  const stop = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'your', 'from', 'you', 'how', 'what', 'why']);
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stop.has(w))
    .sort((a, b) => b.length - a.length)[0] || '';
}

async function run() {
  console.log(`\n=== Tube Forge Agent — ${new Date().toISOString()} ${DRY_RUN ? '(DRY RUN)' : ''} ===`);

  const state = loadState();
  const channel = await yt.resolveChannel(process.env.CHANNEL_HANDLE);
  const uploadsPlaylist = channel.contentDetails.relatedPlaylists.uploads;

  console.log(`Channel: ${channel.snippet.title} (${channel.statistics.subscriberCount} subs, ${channel.statistics.videoCount} videos)`);

  // Pull a healthy batch of recent uploads, then filter down to ones actually due for optimization.
  const allIds = await yt.fetchUploadIds(uploadsPlaylist, 50);
  const videos = await yt.fetchVideoDetails(allIds);

  // Snapshot every video's view count, every run — this is what builds the
  // time series the feedback loop needs, whether or not we touch a video today.
  snapshotViews(state, videos);

  const due = videos.filter(v => {
    const last = state.videos[v.id]?.lastUpdated;
    return daysSince(last) >= config.automation.rateLimitDaysPerVideo;
  });

  // Prioritize videos with the weakest current score first — biggest opportunity.
  const scored = due.map(v => ({
    video: v,
    current: scoreMetadata({ title: v.snippet.title, tags: v.snippet.tags, description: v.snippet.description }),
  })).sort((a, b) => a.current.overall - b.current.overall);

  const batch = scored.slice(0, config.automation.maxVideosPerRun);

  // Fetch real CTR/retention only for videos that actually need it this run —
  // the ones we're about to consider, plus anything still awaiting an outcome
  // verdict from a past change (so that judgment has continuous data to work with).
  const pendingJudgmentIds = Object.entries(state.videos || {})
    .filter(([, rec]) => (rec.appliedChanges || []).some(c => !c.outcome))
    .map(([id]) => id);
  const analyticsIds = [...new Set([...batch.map(b => b.video.id), ...pendingJudgmentIds])];
  let analyticsMap = {};
  try {
    analyticsMap = await analytics.fetchAnalytics(analyticsIds);
  } catch (e) {
    console.warn('Analytics fetch failed this run, continuing without it:', e.message);
  }
  recordAnalyticsSnapshot(state, analyticsMap);

  // Score any past changes that are now old enough to judge — using real CTR when
  // we have it, channel-adjusted view velocity otherwise — then let that adjust
  // how strict we are this run.
  const newOutcomes = evaluateOutcomes(state, appendHistory);
  const adaptive = computeAdaptiveThreshold(state, config);
  if (newOutcomes > 0) console.log(`Scored ${newOutcomes} past change(s) on real outcome data.`);
  if (adaptive.successRate !== null) {
    console.log(`Track record: ${Math.round(adaptive.successRate * 100)}% of judged changes improved (n=${adaptive.sampleSize}). Threshold: +${adaptive.threshold} (base +${config.automation.minScoreGainToApply}).\n`);
  } else {
    console.log(`Not enough judged changes yet to adapt (n=${adaptive.sampleSize}) — using configured threshold +${adaptive.threshold}.\n`);
  }

  console.log(`${due.length} videos eligible (rate-limit window: ${config.automation.rateLimitDaysPerVideo}d) — processing ${batch.length} this run.\n`);

  let appliedCount = 0;

  for (const { video, current } of batch) {
    const keyword = firstKeyword(video.snippet.title);
    const videoAnalytics = analyticsMap[video.id];
    console.log(`→ "${video.snippet.title}"  (current score: ${current.overall}/100)`);
    if (videoAnalytics?.impressionsClickThroughRate !== undefined) {
      console.log(`   Real CTR: ${(Number(videoAnalytics.impressionsClickThroughRate) * 100).toFixed(1)}%  Retention: ${Number(videoAnalytics.averageViewPercentage || 0).toFixed(0)}%`);
    }

    let trendingTerms = [];
    try { trendingTerms = await yt.suggestKeywords(keyword); } catch { /* non-fatal */ }

    let proposal;
    try {
      proposal = await generateOptimizedMetadata({
        video,
        niche: config.channel.niche,
        audience: config.channel.audience,
        brandVoice: config.channel.brandVoice,
        trendingTerms,
        scoreNotes: [...current.titleScore.notes, ...current.tagScore.notes, ...current.descScore.notes],
        analytics: videoAnalytics,
      });
    } catch (e) {
      console.log(`   ✗ AI generation failed: ${e.message}`);
      appendHistory({ videoId: video.id, title: video.snippet.title, action: 'error', reason: e.message });
      continue;
    }

    const result = evaluateProposal({ video, proposal, config, keyword, minScoreGainOverride: adaptive.threshold });
    console.log(`   ${result.verdict.toUpperCase()}: ${result.reason}`);
    if (result.verdict !== 'reject') {
      console.log(`   New title: "${result.title}"`);
      console.log(`   New tags: ${result.tags.join(', ')}`);
      console.log(`   New description (first 150 chars): ${result.description.slice(0, 150).replace(/\n/g, ' ')}...`);
    }

    if (result.verdict === 'apply' && !DRY_RUN) {
      await yt.updateVideoMetadata(video, {
        title: result.title,
        description: result.description,
        tags: result.tags,
      });
      appliedCount++;
      const rec = state.videos[video.id] || {};
      rec.lastUpdated = new Date().toISOString();
      rec.lastScore = result.after.overall;
      rec.appliedChanges = rec.appliedChanges || [];
      rec.appliedChanges.push({
        appliedAt: rec.lastUpdated,
        scoreDelta: result.scoreDelta,
        viewsAtApply: Number(video.statistics?.viewCount || 0),
      });
      state.videos[video.id] = rec;
    } else if (result.verdict === 'apply' && DRY_RUN) {
      console.log('   (dry run — not actually applied)');
    }

    if (result.verdict === 'review') {
      state.pendingReview = state.pendingReview || [];
      state.pendingReview.push({
        videoId: video.id, currentTitle: video.snippet.title, proposedTitle: result.title,
        scoreDelta: result.scoreDelta, changePercent: result.changePercent, addedAt: new Date().toISOString(),
      });
    }

    appendHistory({
      videoId: video.id,
      videoTitle: video.snippet.title,
      action: DRY_RUN ? 'dry-run-' + result.verdict : result.verdict,
      before: { title: video.snippet.title, score: result.before?.overall },
      after: result.verdict !== 'reject' ? { title: result.title, score: result.after?.overall } : undefined,
      scoreDelta: result.scoreDelta,
      reason: result.reason,
    });
  }

  state.lastRun = new Date().toISOString();
  state.totalRuns = (state.totalRuns || 0) + 1;
  state.totalUpdatesApplied = (state.totalUpdatesApplied || 0) + appliedCount;
  state.agentHealth = {
    successRate: adaptive.successRate,
    sampleSize: adaptive.sampleSize,
    currentThreshold: adaptive.threshold,
    baseThreshold: config.automation.minScoreGainToApply,
  };
  state.channel = {
    title: channel.snippet.title,
    subscribers: channel.statistics.subscriberCount,
    views: channel.statistics.viewCount,
    videoCount: channel.statistics.videoCount,
    thumbnail: channel.snippet.thumbnails?.default?.url,
  };
  saveState(state);

  console.log(`\nRun complete. ${appliedCount} video(s) updated. ${(state.pendingReview || []).length} pending your review.\n`);
}

run().catch(err => {
  console.error('\nAgent run failed:', err);
  process.exit(1);
});
