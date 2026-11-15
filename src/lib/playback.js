export const LIVE_SOURCE_TIMEOUT = 12000;
export const LIVE_START_TIMEOUT = 12000;
export const LIVE_STALL_TIMEOUT = 10000;

export function isLiveVideo(video) {
  return video?.modelId === 'CineTv' || ['live', 'live_tv'].includes(video?.type) || /^bittv[d_:]/.test(String(video?.id || ''));
}

export function validMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

export function streamKind(stream) {
  if (stream?.headers?.['x-transcode-format'] === 'hls') return 'hls';
  const format = String(stream?.format || '').toLowerCase();
  const url = String(stream?.url || '');
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (/\.mpd$/.test(path)) return 'dash';
  if (/\.m3u8$/.test(path)) return 'hls';
  // Separate MP4 video/audio tracks are not DASH manifests.
  if (stream?.audioUrl && !stream?.isDrm && !stream?.drm) return 'file';
  if (['dash', 'mpd'].includes(format) || stream?.isDrm || stream?.drm) return 'dash';
  if (['hls', 'm3u8'].includes(format)) return 'hls';
  if (['mp4', 'webm', 'mkv'].includes(format) || /\.(mp4|webm|m4v)$/.test(path)) return 'file';
  if (format === 'iframe' || /\/embed|\/videoembed|https?:\/\/([^/]+\.)?(ok\.ru|videoplayer\.vip|suzihaza\.com)\//i.test(url)) return 'iframe';
  return 'file';
}

export function createHlsSessionId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function proxyUrl(url, headers = {}, sessionId) {
  if (!validMediaUrl(url)) return url || '';
  const values = Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]));

  if (values['x-transcode-format'] === 'hls') {
    const params = new URLSearchParams({ url: validMediaUrl(url) });
    for (const [header, param] of [
      ['referer', 'referer'],
      ['user-agent', 'ua'],
      ['cookie', 'cookie'],
      ['origin', 'origin'],
      ['authorization', 'authorization'],
    ]) {
      if (typeof values[header] === 'string' && values[header]) params.set(param, values[header]);
    }
    params.set('height', values['x-transcode-height'] || '720');
    params.set('session', sessionId || createHlsSessionId());
    return `/api/transcode/hls?${params}`;
  }

  const params = new URLSearchParams({ url: validMediaUrl(url) });
  for (const [header, param] of [
    ['referer', 'referer'],
    ['user-agent', 'ua'],
    ['cookie', 'cookie'],
    ['origin', 'origin'],
    ['authorization', 'authorization'],
    ['x-transcode', 'transcode'],
    ['transcode', 'transcode'],
    ['ss', 'ss'],
    ['x-ss', 'ss'],
  ]) {
    if (typeof values[header] === 'string' && values[header]) params.set(param, values[header]);
  }
  return `/api/stream?${params}`;
}

export function normalizeSources(data = {}) {
  const root = data && typeof data === 'object' ? data : {};
  const candidates = Array.isArray(root) ? root : [
    ...[root.streams, root.sources, root.qualities, root.data, root.files, root.urls].filter(Array.isArray).flat(),
    root,
  ];
  const pickUrl = (value) => {
    if (Array.isArray(value)) return value.map(pickUrl).find(Boolean) || '';
    if (value && typeof value === 'object') return pickUrl(value.url || value.baseUrl || value.base_url);
    return validMediaUrl(value);
  };
  const seen = new Set();
  const streams = candidates.filter(Boolean).flatMap((raw) => {
    const item = typeof raw === 'string' ? { url: raw } : raw;
    const url = pickUrl(item.url || item.link || item.file || item.video || item.video_url || item.stream_url || item.embed_url || item.player_url || item.iframe || item.embed || item.stream?.url || item.source?.url);
    const audioUrl = pickUrl(item.audioUrl || item.audio);
    const drm = item.drm || root.drm || null;
    const headers = { ...(root.headers || {}), ...(item.headers || {}) };
    const identity = JSON.stringify([url, audioUrl, headers, drm]);
    if (!url || seen.has(identity)) return [];
    seen.add(identity);
    return [{ ...item, url, audioUrl, headers, drm,
      name: String(item.name || item.quality || item.label || 'Kualitas Normal'),
      format: item.format || (item.embed_url || item.player_url || item.iframe || item.embed ? 'iframe' : ''),
      isDrm: Boolean(item.isDrm || item.is_drm || root.is_drm || drm),
      drmType: item.drmType || item.drm_type || drm?.type || '',
    }];
  });
  const tracks = [root.subtitles, root.tracks, root.captions].find(Array.isArray) || [];
  const subtitles = tracks.filter(Boolean).flatMap((track) => {
    const url = pickUrl(track.url || track.file);
    return url ? [{ url, name: String(track.name || track.lang || track.language || track.label || 'Bahasa'), headers: { ...(root.headers || {}), ...(track.headers || {}) } }] : [];
  });
  return {
    streams,
    subtitles,
    headers: root.headers || {},
    duration: Number(root.duration) || 0,
  };
}

export function nextAvailableChannel(channels, currentId, failedIds) {
  const start = channels.findIndex((channel) => String(channel.id) === String(currentId));
  for (let offset = 1; offset <= channels.length; offset++) {
    const channel = channels[(start + offset + channels.length) % channels.length];
    if (String(channel.id) !== String(currentId) && !failedIds.has(String(channel.id))) return channel;
  }
  return null;
}
