import { sourceResolution, isHevcSource } from './transcode-sources.js';
import { streamKind } from './playback.js';

export function qualityLadder(streams) {
  const seen = new Set();
  return streams.filter((stream) => {
    const height = sourceResolution(stream);
    if (!height || seen.has(height) || stream.isDrm || stream.audioUrl || streamKind(stream) === 'iframe') return false;
    seen.add(height);
    return true;
  }).sort((a, b) => sourceResolution(a) - sourceResolution(b));
}

export function requiredMbps(stream) {
  if (Number(stream.bitrate) > 0) return Number(stream.bitrate) / 1000000;
  const height = sourceResolution(stream);
  return height <= 360 ? 0.8 : height <= 480 ? 1.5 : height <= 720 ? 3 : height <= 1080 ? 6 : height <= 1440 ? 10 : 20;
}

export function networkBudget(connection) {
  if (connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType)) return 0.6;
  const downlink = Number(connection?.downlink);
  if (Number.isFinite(downlink) && downlink > 0) return downlink / 1.6;
  return connection?.effectiveType === '3g' ? 0.9 : null;
}

export function initialQuality(streams, connection, supportsHevc = true) {
  const ladder = qualityLadder(streams);
  if (!ladder.length) return streams[0];

  // If the browser does not support HEVC, prioritize native H.264 streams
  const compatible = !supportsHevc ? ladder.filter((s) => !isHevcSource(s)) : ladder;
  const pool = compatible.length > 0 ? compatible : ladder;

  const budget = networkBudget(connection);
  const fits = pool.filter((s) => budget === null ? sourceResolution(s) <= 480 : requiredMbps(s) <= budget);
  return fits.at(-1) || pool[0];
}

export function adaptiveQuality({ streams, current, connection, bufferAhead, waitingMs,
  stableMs, sinceSwitchMs, playing, seeking, playbackSeconds }) {
  if (!playing || seeking) return null;
  const ladder = qualityLadder(streams);
  const height = sourceResolution(current);
  const lower = ladder.filter((s) => sourceResolution(s) < height);
  const budget = networkBudget(connection);
  if (sinceSwitchMs >= 12000 && lower.length &&
      (waitingMs >= 3000 || (bufferAhead < 5 && budget !== null && requiredMbps(current) > budget))) {
    return lower.filter((s) => budget === null || requiredMbps(s) <= budget).at(-1) || lower[0];
  }
  if (playbackSeconds < 45 || stableMs < 45000 || sinceSwitchMs < 90000 || bufferAhead < 25) return null;
  const higher = ladder.find((s) => sourceResolution(s) > height);
  if (higher && (budget !== null ? requiredMbps(higher) * 1.2 <= budget : bufferAhead >= 40)) return higher;
  return null;
}
