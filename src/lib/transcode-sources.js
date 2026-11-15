export const sourceResolution = (stream) => Number(stream?.resolution) || Number(String(stream?.name || '').match(/(\d+)p/i)?.[1]) || 0;

export const isHevcSource = (stream) => Boolean(stream && (stream.sourceCodec === 'hevc' || /hevc|h\.?265/i.test(`${stream.name || ''} ${stream.url || ''}`)));

export const getStreamCodec = (stream) => {
  if (!stream) return 'H.264';
  if (isHevcSource(stream)) return 'HEVC';
  if (stream.format === 'iframe') return 'Embed';
  if (stream.format === 'hls' || stream.url?.includes('.m3u8')) return 'HLS';
  if (stream.format === 'dash' || stream.url?.includes('.mpd')) return 'DASH';
  return 'H.264';
};

// One entry per supplied quality; codec handling belongs to playback.
export function movieboxQualities(streams, transcodeAllowed = true) {
  const qualities = new Map();
  for (const stream of streams) {
    if (stream.headers?.['x-transcode']) continue;
    const height = sourceResolution(stream);
    const sourceCodec = isHevcSource(stream) ? 'hevc' : 'h264';
    const candidate = {
      ...stream,
      resolution: height,
      sourceCodec,
      transcodeAllowed,
      name: height ? `${height}p` : stream.name,
    };
    const key = height || stream.url;
    const existing = qualities.get(key);
    if (!existing || (existing.sourceCodec === 'hevc' && sourceCodec !== 'hevc')) {
      qualities.set(key, candidate);
    }
  }
  return [...qualities.values()].sort((a, b) => b.resolution - a.resolution);
}

export function browserSupportsHevc(media) {
  const el = media || (typeof document !== 'undefined' && typeof document.createElement === 'function' ? document.createElement('video') : null);
  if (!el?.canPlayType) return false;
  const check = (type) => {
    try {
      const res = el.canPlayType(type);
      return res === 'probably' || res === 'maybe';
    } catch {
      return false;
    }
  };
  return Boolean(
    check('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
    check('video/mp4; codecs="hev1.1.6.L93.B0"') ||
    check('video/mp4; codecs="hvc1"') ||
    check('video/mp4; codecs="hev1"')
  );
}

export function playbackSource(source, supportsHevc, force = false) {
  if (source.headers?.['x-transcode'] || source.transcodeAllowed === false ||
      !isHevcSource(source) || (!force && supportsHevc)) return source;
  return { ...source, originalSource: source, format: 'hls', headers: {
    ...source.headers, 'x-transcode': 'h264', 'x-transcode-format': 'hls',
    'x-transcode-height': String(sourceResolution(source)),
  } };
}
