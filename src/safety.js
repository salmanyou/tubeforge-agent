const { scoreMetadata, titleChangePercent } = require('./scorer');

// Extracts URLs from a description so we can make sure the AI rewrite doesn't
// silently drop the creator's links (socials, other videos, affiliate links, etc).
function extractUrls(text) {
  return [...(text || '').matchAll(/https?:\/\/\S+/g)].map(m => m[0]);
}

function ensureLinksPreserved(originalDesc, newDesc) {
  const originalUrls = extractUrls(originalDesc);
  const missing = originalUrls.filter(u => !newDesc.includes(u));
  if (missing.length === 0) return newDesc;
  return newDesc.trim() + '\n\n' + missing.join('\n');
}

// Returns { verdict: 'apply' | 'review' | 'reject', reason, before, after }
function evaluateProposal({ video, proposal, config, keyword, minScoreGainOverride }) {
  const minScoreGain = minScoreGainOverride ?? config.automation.minScoreGainToApply;
  const before = scoreMetadata(
    { title: video.snippet.title, tags: video.snippet.tags, description: video.snippet.description },
    keyword
  );

  let { title, description, tags } = proposal;
  title = (title || '').trim();
  tags = (tags || []).map(t => String(t).trim()).filter(Boolean);
  description = ensureLinksPreserved(video.snippet.description, (description || '').trim());

  // Hard constraints — YouTube API limits, not opinions.
  if (title.length === 0) return { verdict: 'reject', reason: 'AI returned an empty title.' };
  if (title.length > config.limits.titleMaxChars) {
    title = title.slice(0, config.limits.titleMaxChars - 1).trim();
  }
  const tagsJoined = tags.slice(0, config.limits.tagsMax).join(',');
  if (tagsJoined.length > config.limits.tagsMaxTotalChars) {
    while (tags.join(',').length > config.limits.tagsMaxTotalChars) tags.pop();
  } else {
    tags = tags.slice(0, config.limits.tagsMax);
  }

  const after = scoreMetadata({ title, tags, description }, keyword);
  const scoreDelta = after.overall - before.overall;
  const changePercent = titleChangePercent(video.snippet.title, title);

  const result = { before, after, scoreDelta, changePercent, title, description, tags };

  if (scoreDelta < minScoreGain) {
    return { ...result, verdict: 'reject', reason: `Score gain (+${scoreDelta}) below threshold (+${minScoreGain}).` };
  }
  if (changePercent >= config.automation.requireHumanReviewAboveTitleChangePercent) {
    return { ...result, verdict: 'review', reason: `Title changed ${changePercent}% — flagged for a quick human glance instead of auto-publishing.` };
  }
  return { ...result, verdict: 'apply', reason: `Score +${scoreDelta} (${before.overall} → ${after.overall}), title changed ${changePercent}%.` };
}

module.exports = { evaluateProposal, extractUrls, ensureLinksPreserved };
