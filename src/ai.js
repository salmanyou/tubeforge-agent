function parseAIJson(text) {
  if (!text) throw new Error('Empty AI response');
  let t = text.trim();
  t = t.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const startObj = t.indexOf('{');
  const startArr = t.indexOf('[');
  let s = startObj;
  if (startArr !== -1 && (startObj === -1 || startArr < startObj)) s = startArr;
  if (s > 0) t = t.slice(s);
  const endObj = t.lastIndexOf('}');
  const endArr = t.lastIndexOf(']');
  const e = Math.max(endObj, endArr);
  if (e !== -1 && e < t.length - 1) t = t.slice(0, e + 1);
  return JSON.parse(t);
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function askPollinationsPost(systemPrompt, userPrompt, attempt = 1) {
  let res, data;
  try {
    res = await fetchWithTimeout('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          { role: 'system', content: systemPrompt + ' Respond with ONLY valid JSON, no markdown fences, no commentary.' },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return askPollinationsPost(systemPrompt, userPrompt, attempt + 1);
    }
    throw new Error(`Pollinations POST network error after ${attempt} attempts: ${e.message}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return askPollinationsPost(systemPrompt, userPrompt, attempt + 1);
    }
    throw new Error(`Pollinations POST returned no message content after ${attempt} attempts (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return parseAIJson(text);
}

async function askPollinationsGet(systemPrompt, userPrompt) {
  const prompt = `${systemPrompt}\n\n${userPrompt}`;
  const res = await fetch(`https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=openai`);
  const text = await res.text();
  if (!res.ok || !text) {
    throw new Error(`Pollinations GET fallback failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  return parseAIJson(text);
}

async function askPollinations(systemPrompt, userPrompt) {
  try {
    return await askPollinationsPost(systemPrompt, userPrompt);
  } catch (e) {
    console.warn('Pollinations POST failed, trying GET fallback:', e.message);
    return await askPollinationsGet(systemPrompt, userPrompt);
  }
}

async function askAnthropic(systemPrompt, userPrompt) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1200,
      system: systemPrompt + ' Respond with ONLY valid JSON, no markdown fences, no commentary.',
      messages: [{ role: 'user', content: userPrompt }],
    }),
  }, 30000);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Anthropic API error (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  const text = (data.content || []).map(b => b.text || '').join('\n');
  return parseAIJson(text);
}

async function askGemini(systemPrompt, userPrompt, modelOverride, attempt = 1) {
  const key = process.env.GEMINI_API_KEY;
  const model = modelOverride || process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  let res, data;
  try {
    res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      },
      30000
    );
    data = await res.json().catch(() => null);
  } catch (e) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return askGemini(systemPrompt, userPrompt, modelOverride, attempt + 1);
    }
    throw new Error(`Gemini network error after ${attempt} attempts: ${e.message}`);
  }

  if (res.status === 404 && !modelOverride) {
    console.warn(`Gemini model "${model}" not found, retrying with gemini-flash-latest...`);
    return askGemini(systemPrompt, userPrompt, 'gemini-flash-latest');
  }

  if ((res.status === 429 || res.status === 503) && attempt < 3) {
    console.warn(`Gemini returned ${res.status} (transient), retrying (attempt ${attempt + 1})...`);
    await new Promise(r => setTimeout(r, 1500 * attempt));
    return askGemini(systemPrompt, userPrompt, modelOverride, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Gemini API error (HTTP ${res.status}) after ${attempt} attempt(s): ${JSON.stringify(data).slice(0, 300)}`);
  }
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n');
  if (!text) {
    throw new Error(`Gemini response had no usable text (possibly blocked/filtered): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return parseAIJson(text);
}

async function askAI(systemPrompt, userPrompt) {
  if (process.env.ANTHROPIC_API_KEY) {
    try { return await askAnthropic(systemPrompt, userPrompt); }
    catch (e) { console.warn('Anthropic call failed, trying next backend:', e.message); }
  }
  if (process.env.GEMINI_API_KEY) {
    try { return await askGemini(systemPrompt, userPrompt); }
    catch (e) { console.warn('Gemini call failed, trying next backend:', e.message); }
  }
  return askPollinations(systemPrompt, userPrompt);
}

async function generateOptimizedMetadata({ video, niche, audience, brandVoice, trendingTerms, scoreNotes, analytics }) {
  const system = [
    `You are a YouTube SEO editor for a channel about: ${niche}.`,
    `Audience: ${audience}. Voice: ${brandVoice}.`,
    'You improve metadata for videos that ALREADY EXIST — never invent facts, numbers, or claims not supported by the existing title/description.',
    'You optimize for genuine search relevance and honest click-through, never misleading clickbait (title/thumbnail promises must match the actual content).',
  ].join(' ');

  const analyticsLine = analytics && (analytics.impressionsClickThroughRate !== undefined || analytics.averageViewPercentage !== undefined)
    ? [
        'REAL PERFORMANCE DATA (owner-only, last 14 days):',
        analytics.impressionsClickThroughRate !== undefined ? `- Click-through rate: ${(Number(analytics.impressionsClickThroughRate) * 100).toFixed(1)}% (people who see the thumbnail/title and click)` : null,
        analytics.averageViewPercentage !== undefined ? `- Average retention: ${Number(analytics.averageViewPercentage).toFixed(0)}% of the video watched on average` : null,
        'Use this: a LOW click-through rate with GOOD retention means the title/thumbnail undersell strong content — prioritize a more compelling, curiosity-driving (but still honest) title. A GOOD click-through rate with LOW retention means the title is already working — don\'t touch it much, the content/pacing is the issue, which metadata can\'t fix.',
      ].filter(Boolean).join('\n')
    : '';

  const user = [
    `CURRENT TITLE: ${video.snippet.title}`,
    `CURRENT DESCRIPTION:\n${video.snippet.description || '(empty)'}`,
    `CURRENT TAGS: ${(video.snippet.tags || []).join(', ') || '(none)'}`,
    `PUBLIC STATS — VIEWS: ${video.statistics?.viewCount || 0}  LIKES: ${video.statistics?.likeCount || 0}  COMMENTS: ${video.statistics?.commentCount || 0}`,
    analyticsLine,
    `KNOWN WEAKNESSES: ${scoreNotes.join(' | ')}`,
    `REAL TRENDING SEARCH PHRASES RELATED TO THIS TOPIC: ${trendingTerms.join(', ') || '(none found)'}`,
    '',
    'Rewrite the metadata to fix the weaknesses and work in relevant trending phrases ONLY where they genuinely fit the video.',
    'Rules:',
    '- title: 40-70 characters, keyword-forward, no ALL CAPS, at most one ! or ?, describes what is actually in the video.',
    '- description: 200+ words. First 1-2 lines must hook and include the main keyword (this is what shows before "Show more"). Preserve any URLs from the original description verbatim. Do not invent timestamps that were not in the original.',
    '- tags: 10-15 tags, mix of broad and specific, no duplicates, total under 460 characters combined.',
    '',
    'Respond as JSON: {"title": "...", "description": "...", "tags": ["...", "..."]}',
  ].filter(Boolean).join('\n');

  const proposal = await askAI(system, user);

  if (!proposal || typeof proposal.title !== 'string' || !proposal.title.trim()) {
    throw new Error(`AI response missing a usable "title" field. Got: ${JSON.stringify(proposal).slice(0, 300)}`);
  }
  if (typeof proposal.description !== 'string' || !proposal.description.trim()) {
    throw new Error(`AI response missing a usable "description" field. Got: ${JSON.stringify(proposal).slice(0, 300)}`);
  }
  if (!Array.isArray(proposal.tags)) {
    throw new Error(`AI response missing a usable "tags" array. Got: ${JSON.stringify(proposal).slice(0, 300)}`);
  }

  return proposal;
}

module.exports = { askAI, askGemini, generateOptimizedMetadata, parseAIJson };
