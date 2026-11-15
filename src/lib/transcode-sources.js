export const sourceResolution = (stream) => Number(stream.resolution) || Number(String(stream.name || '').match(/(\d+)p/i)?.[1]) || 0;
export const isHevcSource = (stream) => stream.sourceCodec === 'hevc' || /hevc|h\.?265/i.test(`${stream.name || ''} ${stream.url || ''}`);

// One entry per supplied quality; codec handling belongs to playback.
export function movieboxQualities(streams, transcodeAllowed = true) {
  const qualities = new Map();
  for (const stream of streams) {
    if (stream.headers?.['x-transcode']) continue;
    const height = sourceResolution(stream);
    const sourceCodec = isHevcSource(stream) ? 'hevc' : (/h\.?264|avc/i.test(stream.name || '') ? 'h264' : '');
    const candidate = { ...stream, resolution: height, sourceCodec, transcodeAllowed,
      name: height ? `${height}p` : stream.name };
    const key = height || stream.url;
    const existing = qualities.get(key);
    if (!existing || (existing.sourceCodec === 'hevc' && sourceCodec !== 'hevc')) qualities.set(key, candidate);
  }
  return [...qualities.values()].sort((a, b) => b.resolution - a.resolution);
}

export function browserSupportsHevc(media) {
  return Boolean(media?.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
    media?.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"'));
}

export function playbackSource(source, supportsHevc, force = false) {
  if (source.headers?.['x-transcode'] || source.transcodeAllowed === false ||
      !isHevcSource(source) || (!force && supportsHevc)) return source;
  return { ...source, originalSource: source, format: 'hls', headers: {
    ...source.headers, 'x-transcode': 'h264', 'x-transcode-format': 'hls',
    'x-transcode-height': String(sourceResolution(source)),
  } };
}
