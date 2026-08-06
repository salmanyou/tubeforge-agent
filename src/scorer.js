// Transparent, rule-based scoring — same rubric the dashboard shows you,
// reused here so the agent can grade its OWN proposals before publishing them.

function scoreTitle(title, keyword) {
  title = title || '';
  let score = 100;
  const notes = [];
  const len = title.length;
  if (len === 0) return { score: 0, notes: ['No title.'] };
  if (len < 20) { score -= 20; notes.push('Short title — aim for 40-70 characters.'); }
  else if (len > 70) { score -= 15; notes.push('Long title — may get truncated in search/suggested.'); }
  if (len > 15 && title === title.toUpperCase() && /[A-Z]/.test(title)) {
    score -= 15; notes.push('ALL CAPS reads as spammy.');
  }
  if (!/\d/.test(title)) { score -= 5; notes.push('Consider a number (count, year, step).'); }
  const wordCount = title.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 4) { score -= 10; notes.push('Add descriptive words — topic is ambiguous.'); }
  if (keyword) {
    const idx = title.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx === -1) { score -= 20; notes.push(`Target keyword "${keyword}" missing from title.`); }
    else if (idx > title.length * 0.5) { score -= 8; notes.push('Move target keyword earlier in the title.'); }
  }
  const punctCount = (title.match(/[!?]/g) || []).length;
  if (punctCount > 2) { score -= 8; notes.push('Multiple !/? looks clickbaity.'); }
  const emojiCount = (title.match(/\p{Extended_Pictographic}/gu) || []).length;
  if (emojiCount > 2) { score -= 5; notes.push('Too many emoji clutter search results.'); }
  score = Math.max(0, Math.min(100, score));
  if (notes.length === 0) notes.push('Solid title.');
  return { score, notes };
}

function scoreTags(tagsArr) {
  tagsArr = (tagsArr || []).map(t => t.trim()).filter(Boolean);
  let score = 100;
  const notes = [];
  if (tagsArr.length === 0) return { score: 10, notes: ['No tags — add 8-15 mixing broad and specific terms.'] };
  const totalChars = tagsArr.join(',').length;
  if (tagsArr.length < 5) { score -= 25; notes.push('Few tags — add long-tail terms.'); }
  if (totalChars > 460) { score -= 10; notes.push('Near the ~500 char tag limit — trim low-value tags.'); }
  if (totalChars < 100) { score -= 15; notes.push('Tag field underused.'); }
  const uniq = new Set(tagsArr.map(t => t.toLowerCase()));
  if (uniq.size !== tagsArr.length) { score -= 10; notes.push('Duplicate tags found.'); }
  score = Math.max(0, Math.min(100, score));
  if (notes.length === 0) notes.push('Tag set well balanced.');
  return { score, notes };
}

function scoreDescription(desc) {
  desc = desc || '';
  let score = 100;
  const notes = [];
  const len = desc.length;
  const firstLine = desc.split('\n')[0] || '';
  if (len < 100) { score -= 25; notes.push('Description thin — aim for 200+ words.'); }
  if (firstLine.length < 40) { score -= 15; notes.push('First line short — that\'s what shows before "Show more".'); }
  if (!/https?:\/\//.test(desc)) { score -= 5; notes.push('No links found.'); }
  if (!/\d{1,2}:\d{2}/.test(desc)) { notes.push('No timestamps found.'); }
  score = Math.max(0, Math.min(100, score));
  if (notes.length === 0) notes.push('Description well structured.');
  return { score, notes };
}

function scoreMetadata({ title, tags, description }, keyword) {
  const ts = scoreTitle(title, keyword);
  const tgs = scoreTags(tags);
  const ds = scoreDescription(description);
  const overall = Math.round(ts.score * 0.45 + tgs.score * 0.3 + ds.score * 0.25);
  return { overall, titleScore: ts, tagScore: tgs, descScore: ds };
}

// Cheap word-overlap similarity so the agent can detect when a rewrite is a
// mild polish (safe to auto-apply) vs. a near-total rewrite (worth a human glance).
function titleChangePercent(oldTitle, newTitle) {
  const a = new Set((oldTitle || '').toLowerCase().split(/\s+/).filter(Boolean));
  const b = new Set((newTitle || '').toLowerCase().split(/\s+/).filter(Boolean));
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = new Set([...a, ...b]).size;
  const similarity = union === 0 ? 1 : shared / union;
  return Math.round((1 - similarity) * 100);
}

module.exports = { scoreTitle, scoreTags, scoreDescription, scoreMetadata, titleChangePercent };
