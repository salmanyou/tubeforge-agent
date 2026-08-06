const { google } = require('googleapis');
const { getAuthenticatedClient } = require('./auth');

function client() {
  const auth = getAuthenticatedClient();
  return google.youtube({ version: 'v3', auth });
}

async function resolveChannel(handleOrId) {
  const yt = client();
  const isId = /^UC[0-9A-Za-z_-]{22}$/.test(handleOrId || '');
  const params = { part: ['snippet', 'statistics', 'contentDetails'] };
  if (isId) params.id = [handleOrId];
  else params.forHandle = handleOrId.startsWith('@') ? handleOrId : '@' + handleOrId;

  const { data } = await yt.channels.list(params);
  if (!data.items || !data.items.length) throw new Error('Channel not found: ' + handleOrId);
  return data.items[0];
}

// Owner-authenticated equivalent — works even if you've never made the channel public metadata handy.
async function myChannel() {
  const yt = client();
  const { data } = await yt.channels.list({ part: ['snippet', 'statistics', 'contentDetails'], mine: true });
  if (!data.items || !data.items.length) throw new Error('No channel found for the authorized account.');
  return data.items[0];
}

async function fetchUploadIds(uploadsPlaylistId, maxVideos) {
  const yt = client();
  let ids = [];
  let pageToken;
  while (ids.length < maxVideos) {
    const { data } = await yt.playlistItems.list({
      part: ['contentDetails'],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });
    ids.push(...data.items.map(i => i.contentDetails.videoId));
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return ids.slice(0, maxVideos);
}

async function fetchVideoDetails(ids) {
  const yt = client();
  let out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { data } = await yt.videos.list({
      part: ['snippet', 'statistics', 'status'],
      id: chunk,
    });
    out.push(...data.items);
  }
  return out;
}

// IMPORTANT: videos.update replaces the whole snippet, so we always start from the
// video's current snippet and only overwrite the fields we intentionally changed —
// otherwise fields like categoryId or defaultLanguage can get silently wiped.
async function updateVideoMetadata(video, changes) {
  const yt = client();
  const snippet = { ...video.snippet, ...changes };
  const { data } = await yt.videos.update({
    part: ['snippet'],
    requestBody: { id: video.id, snippet },
  });
  return data;
}

// Uses YouTube's public autocomplete endpoint to surface real trending phrasing
// around a seed term — same data source search bars use.
async function suggestKeywords(seed) {
  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(seed)}`
    );
    const data = await res.json();
    return (data[1] || []).slice(0, 8);
  } catch {
    return [];
  }
}

module.exports = {
  resolveChannel, myChannel, fetchUploadIds, fetchVideoDetails, updateVideoMetadata, suggestKeywords,
};
