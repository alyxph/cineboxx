'use client';

const KEY_PROGRESS = 'cinebox_playback_progress';
const KEY_SUBTITLE_SYNC = 'cinebox_subtitle_sync';

const subtitleKey = (videoId, episodeId, subtitleName) =>
  [videoId, episodeId || '', subtitleName || 'default'].join(':');

export function saveProgress(videoId, episodeId, currentTime, duration) {
  if (
    !videoId ||
    typeof window === 'undefined' ||
    !Number.isFinite(currentTime) ||
    currentTime < 0 ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) return;

  try {
    const raw = localStorage.getItem(KEY_PROGRESS);
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const store = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const key = episodeId ? `${videoId}_${episodeId}` : videoId;
    store[key] = {
      currentTime: Math.floor(currentTime),
      duration: Math.floor(duration),
      updatedAt: Date.now()
    };
    const keys = Object.keys(store);
    if (keys.length > 100) {
      delete store[keys[0]];
    }
    localStorage.setItem(KEY_PROGRESS, JSON.stringify(store));
  } catch {}
}

export function getProgress(videoId, episodeId) {
  if (!videoId || typeof window === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(KEY_PROGRESS);
    if (!raw) return 0;
    const store = JSON.parse(raw);
    const key = episodeId ? `${videoId}_${episodeId}` : videoId;
    const entry = store[key];
    if (!entry || !Number.isFinite(entry.currentTime) || entry.currentTime < 0) return 0;
    if (entry.duration && entry.currentTime / entry.duration > 0.92) {
      return 0;
    }
    return entry.currentTime;
  } catch {
    return 0;
  }
}

export function getSubtitleDelay(videoId, episodeId, subtitleName) {
  if (!videoId || typeof window === 'undefined') return 0;
  try {
    const value = JSON.parse(localStorage.getItem(KEY_SUBTITLE_SYNC) || '{}')[subtitleKey(videoId, episodeId, subtitleName)];
    return Number.isFinite(value) && Math.abs(value) <= 30 ? value : 0;
  } catch { return 0; }
}

export function saveSubtitleDelay(videoId, episodeId, subtitleName, delay) {
  if (!videoId || typeof window === 'undefined' || !Number.isFinite(delay)) return;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY_SUBTITLE_SYNC) || '{}');
    const store = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const key = subtitleKey(videoId, episodeId, subtitleName);
    const value = Math.max(-30, Math.min(30, Math.round(delay * 2) / 2));
    if (value === 0) delete store[key];
    else store[key] = value;
    const keys = Object.keys(store);
    while (keys.length > 100) delete store[keys.shift()];
    localStorage.setItem(KEY_SUBTITLE_SYNC, JSON.stringify(store));
  } catch {}
}
