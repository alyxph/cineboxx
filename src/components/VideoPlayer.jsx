'use client';

import { useState, useEffect, useRef, useCallback, useEffectEvent } from 'react';
import Hls from 'hls.js';
import { initialQuality, adaptiveQuality, qualityLadder } from '@/lib/adaptive-quality';
import { browserSupportsHevc, isHevcSource, playbackSource, sourceResolution } from '@/lib/transcode-sources';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  Volume1,
  VolumeX,
  Maximize,
  Minimize,
  Settings,
  SkipForward,
  Loader2,
  Check,
  ChevronRight,
  ChevronLeft,
  PictureInPicture2,
  RadioOff,
  Tv,
  Film,
} from 'lucide-react';
import { saveProgress, getProgress } from '@/lib/storage';
import { fetchJson } from '@/lib/http';
import { isLiveVideo, streamKind, proxyUrl, normalizeSources, createHlsSessionId, LIVE_SOURCE_TIMEOUT, LIVE_START_TIMEOUT, LIVE_STALL_TIMEOUT } from '@/lib/playback';
import { parseSubtitleText } from '@/lib/subtitles';

const RECOMMENDED_MOVIES = [
  {
    id: '5390197429792821032',
    title: 'Titanic',
    poster: 'https://pbcdn.aoneroom.com/image/2026/01/27/230959ee38bcae528aa8e9cff532d603.jpg',
  },
  {
    id: '1654274595068805784',
    title: 'Avatar',
    poster: 'https://pbcdn.aoneroom.com/image/2026/01/27/d0afc578a156ad5e2f754fc36081da26.jpg',
  },
  {
    id: '6027841441853048416',
    title: 'John Wick',
    poster: 'https://pbcdn.aoneroom.com/image/2026/01/27/e780c98f8245ea378875560936fef95b.jpg',
  },
  {
    id: '8328377108439386184',
    title: 'Iron Man',
    poster: 'https://pbcdn.aoneroom.com/image/2026/01/27/9064821a81dc1c2573f084ba68c3ea6f.jpg',
  },
  {
    id: '977486567826752424',
    title: 'Inception',
    poster: 'https://pbcdn.aoneroom.com/image/2026/01/27/ca253372223725b74b1e5ec6042db5ae.jpg',
  },
  {
    id: '1007576544987988816',
    title: 'Spider-Man',
    poster: 'https://pbcdn.aoneroom.com/image/2023/08/11/ff7e28b18536cfdb575dfa5e5520fe48.jpg',
  },
];

function base64UrlToHex(base64Url) {
  if (!base64Url || typeof base64Url !== 'string') return '';
  if (base64Url.length === 32 && /^[0-9a-fA-F]+$/.test(base64Url)) {
    return base64Url.toLowerCase();
  }
  try {
    let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    const raw = atob(base64);
    let hex = '';
    for (let i = 0; i < raw.length; i++) {
      const byte = raw.charCodeAt(i).toString(16).padStart(2, '0');
      hex += byte;
    }
    return hex.toLowerCase();
  } catch {
    return '';
  }
}

export default function VideoPlayer(props) {
  const [attempt, setAttempt] = useState(0);
  return <PlayerSession key={`${props.video.modelId}:${props.video.id}`} {...props} attempt={attempt} onRetry={() => {
    props.onPlaybackState?.('loading');
    setAttempt((value) => value + 1);
  }} />;
}

function PlayerSession({
  video,
  episode = null,
  seasonName = null,
  onClose,
  onNextEpisode = null,
  onUnavailable = null,
  onPlaybackState = null,
  onRetry,
  attempt = 0,
}) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const hlsRef = useRef(null);
  const shakaRef = useRef(null);
  const hideControlsTimer = useRef(null);
  const episodeBannerTimer = useRef(null);
  const loadedIframeUrl = useRef('');
  const prevEpisodeIdRef = useRef(episode?.id || null);

  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState(null);
  const [isChannelOffline, setIsChannelOffline] = useState(false);
  const resumePositionRef = useRef(null);

  const [notice, setNotice] = useState('');
  const [episodeBanner, setEpisodeBanner] = useState(null);
  const [ended, setEnded] = useState(false);
  const failedStreams = useRef(new Set());
  const hevcDecodeFailed = useRef(false);


  // Stream data
  const [streams, setStreams] = useState([]);
  const [selectedStream, setSelectedStream] = useState(null);
  const [autoQuality, setAutoQuality] = useState(true);
  const qualityPreference = useRef({ key: '', mode: 'auto', height: 0, url: '' });
  const qualityHealth = useRef({ changedAt: 0, stableSince: 0, waitingSince: 0 });
  const resumePausedRef = useRef(false);
  const loadingPositionRef = useRef(0);
  const [subtitles, setSubtitles] = useState([]);
  const [selectedSubtitle, setSelectedSubtitle] = useState(null);
  const [subtitleCues, setSubtitleCues] = useState([]);
  const [currentSubtitleText, setCurrentSubtitleText] = useState('');

  // Player controls state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [knownDuration, setKnownDuration] = useState(0);
  const seekOffsetRef = useRef(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [autoNext, setAutoNext] = useState(true);

  // Menus
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [settingsTab, setSettingsTab] = useState('main'); // 'main' | 'quality' | 'speed'

  const isIframe = streamKind(selectedStream) === 'iframe';
  const isLive = isLiveVideo(video);

  // Format time (seconds -> HH:MM:SS or MM:SS)
  const formatTime = (secs) => {
    if (isNaN(secs) || secs < 0 || !isFinite(secs)) return '0:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) {
      return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };


  const failStream = useEffectEvent((message, reason = 'unavailable') => {
    const offline = navigator.onLine === false;
    if (selectedStream) failedStreams.current.add(selectedStream.originalSource || selectedStream);
    const next = !offline && reason === 'unavailable'
      ? (() => {
          const available = streams.filter((stream) => !failedStreams.current.has(stream));
          if (!available.length) return null;
          // If the failed stream was HEVC, immediately prioritize any available native H.264 stream
          if (isHevcSource(selectedStream)) {
            const h264Fallback = available.find((s) => !isHevcSource(s));
            if (h264Fallback) return h264Fallback;
          }
          const height = Number(selectedStream?.resolution) || Number(selectedStream?.name?.match(/(\d+)p/i)?.[1]) || 0;
          if (!isLive && height) {
            const lower = qualityLadder(available).filter((stream) => (Number(stream.resolution) || Number(stream.name?.match(/(\d+)p/i)?.[1]) || 0) < height);
            if (autoQuality && lower.length > 0) return lower.at(-1);
          }
          return available[0];
        })()
      : null;
    if (next && failedStreams.current.size < (isLive ? 2 : 4)) {
      setNotice('Sumber bermasalah. Mencoba sumber video lain...');
      setLoading(true);
      setBuffering(false);
      resumePositionRef.current = videoRef.current?.currentTime || 0;
      qualityHealth.current.changedAt = Date.now();
      setSelectedStream(playbackSource(next, (browserSupportsHevc(videoRef.current) && !hevcDecodeFailed.current)));
      return;
    }
    const info = offline ? 'Koneksi internet terputus. Hubungkan kembali lalu tekan Coba Lagi.' : message;
    setLoading(false);
    setBuffering(false);
    setIsPlaying(false);
    setIsChannelOffline(isLive && !offline && reason === 'unavailable');
    setError(info);
    onPlaybackState?.('error');
    if (isLive && !offline && reason === 'unavailable') onUnavailable?.({ message: info });
  });

  const reportPlaying = useEffectEvent(() => onPlaybackState?.('playing'));
  const applyPreferences = useEffectEvent(() => {
    for (const media of [videoRef.current, audioRef.current]) {
      if (media) {
        media.volume = volume;
        media.muted = isMuted;
        media.playbackRate = playbackSpeed;
      }
    }
  });

  const showEpisodeChangeBanner = useEffectEvent((ep, sName) => {
    const epLabel = ep?.num ? `Episode ${ep.num}` : 'Episode Berikutnya';
    const rawTitle = ep?.title?.trim() || '';
    const epTitle =
      rawTitle &&
      rawTitle !== `Episode ${ep?.num}` &&
      rawTitle !== String(video?.title || '').trim()
        ? rawTitle
        : '';
    setEpisodeBanner({
      season: sName || ep?.seasonName || '',
      label: epLabel,
      title: epTitle,
    });
    if (episodeBannerTimer.current) clearTimeout(episodeBannerTimer.current);
    episodeBannerTimer.current = setTimeout(() => {
      setEpisodeBanner(null);
    }, 6000);
  });

  const resetForSource = useEffectEvent(() => {
    const isEpisodeSwitch =
      prevEpisodeIdRef.current != null &&
      episode?.id != null &&
      String(prevEpisodeIdRef.current) !== String(episode.id);
    prevEpisodeIdRef.current = episode?.id || null;

    if (isEpisodeSwitch) {
      showEpisodeChangeBanner(episode, seasonName);
    }

    failedStreams.current.clear();
    loadedIframeUrl.current = '';
    hevcDecodeFailed.current = false;
    resumePositionRef.current = null;
    resumePausedRef.current = false;
    const qualityKey = `${video.id}:${episode?.id || ''}`;
    if (qualityPreference.current.key !== qualityKey) {
      qualityPreference.current = { key: qualityKey, mode: 'auto', height: 0, url: '' };
      setAutoQuality(true);
    }
    qualityHealth.current = { changedAt: Date.now(), stableSince: Date.now(), waitingSince: 0 };
    setLoading(true);
    setBuffering(false);
    setError(null);
    setIsChannelOffline(false);


    setNotice('');
    setEnded(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setKnownDuration(0);
    seekOffsetRef.current = 0;
    setStreams([]);
    setSelectedStream(null);
    setSubtitles([]);
    setSelectedSubtitle(null);
    setSubtitleCues([]);
    setCurrentSubtitleText('');
  });
  useEffect(() => {
    const controller = new AbortController();
    // Reset episode state while retaining the fullscreen media element.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    resetForSource();
    async function loadSource() {
      try {
        const params = new URLSearchParams({ model_id: video.modelId, id: video.id });
        if (episode?.id != null) params.set('episode_id', episode.id);
        const json = await fetchJson(`/api/catalog/source?${params}`, {
          signal: controller.signal, timeoutMs: isLive ? LIVE_SOURCE_TIMEOUT : 30000,
        });
        if (controller.signal.aborted) return;
        const data = normalizeSources(json.data);
        if (!data.streams.length) {
          failStream('Tidak ada sumber siaran/video yang tersedia.');
          return;
        }
        const ordered = [...data.streams].sort((a, b) => {
          const rank = { file: 0, hls: 1, dash: 2, iframe: 3 };
          return rank[streamKind(a)] - rank[streamKind(b)];
        });
        setStreams(ordered);
        const preference = qualityPreference.current;
        const manual = preference.mode === 'manual' && ordered.find((stream) => preference.height
          ? sourceResolution(stream) === preference.height : stream.url === preference.url);
        const hevcSupported = (browserSupportsHevc(videoRef.current) && !hevcDecodeFailed.current);
        const initial = manual || (isLive ? ordered[0] : initialQuality(ordered, navigator.connection, hevcSupported));
        if (preference.mode === 'manual' && !manual) { preference.mode = 'auto'; setAutoQuality(true); }
        qualityHealth.current.changedAt = Date.now();
        setSelectedStream(playbackSource(initial, hevcSupported));
        if (data.duration && data.duration > 0) {
          setKnownDuration(data.duration);
        }
        setSubtitles(data.subtitles);
        setSelectedSubtitle(data.subtitles.find((sub) => /indonesia|\b(id|ina)\b/i.test(sub.name)) || data.subtitles[0] || null);
      } catch (error) {
        if (!controller.signal.aborted) failStream(error.message || 'Gagal memuat sumber video.');
      }
    }
    loadSource();
    return () => controller.abort();
  }, [video.id, video.modelId, episode?.id, isLive, attempt]);

  useEffect(() => {
    if (!selectedSubtitle) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    (async () => {
      try {
        const response = await fetch(proxyUrl(selectedSubtitle.url, selectedSubtitle.headers), { signal: controller.signal });
        if (!response.ok) throw new Error('Subtitle tidak tersedia.');
        const text = await response.text();
        if (!controller.signal.aborted) setSubtitleCues(parseSubtitleText(text));
      } catch {
        if (!controller.signal.aborted) setNotice('Subtitle gagal dimuat. Video tetap dapat diputar.');
      } finally { clearTimeout(timer); }
    })();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [selectedSubtitle]);

  // A cross-origin iframe exposes page load, not playback health.
  useEffect(() => {
    if (!selectedStream || !isIframe) return;
    const timer = setTimeout(() => {
      if (loadedIframeUrl.current === selectedStream.url) return;
      setLoading(false);
      setNotice('Pemutar eksternal belum merespons. Coba sumber lain atau tekan Coba Lagi.');
    }, LIVE_START_TIMEOUT);
    return () => clearTimeout(timer);
  }, [selectedStream, isIframe]);

  const chooseQuality = (source, automatic = false) => {
    if (!automatic) {
      qualityPreference.current = { ...qualityPreference.current, mode: 'manual', height: sourceResolution(source), url: source.url };
      setAutoQuality(false);
    }
    const current = selectedStream?.originalSource || selectedStream;
    if (current === source) return;
    const media = videoRef.current;
    resumePositionRef.current = media && media.readyState > 0
      ? media.currentTime + (seekOffsetRef.current || 0) : (loadingPositionRef.current || 0);
    resumePausedRef.current = Boolean(media?.paused && media.readyState > 0);
    qualityHealth.current = { changedAt: Date.now(), stableSince: Date.now(), waitingSince: 0 };
    failedStreams.current.clear(); setError(null); setLoading(true);
    setSelectedStream(playbackSource(source, (browserSupportsHevc(media) && !hevcDecodeFailed.current), Boolean(selectedStream?.originalSource)));
  };

  const checkAutoQuality = useEffectEvent((startup = false) => {
    const starting = startup === true;
    const media = videoRef.current;
    if (!autoQuality || isLive || !selectedStream || !media || (!starting && (media.seeking || media.paused)) || media.ended || error) return;
    // A native HLS/DASH adaptive manifest has its own bandwidth controller.
    if ((hlsRef.current?.levels?.length || 0) > 1 || shakaRef.current) return;
    const now = Date.now();
    let ahead = 0;
    for (let i = 0; i < media.buffered.length; i++) {
      if (media.currentTime >= media.buffered.start(i) && media.currentTime <= media.buffered.end(i)) ahead = media.buffered.end(i) - media.currentTime;
    }
    const health = qualityHealth.current;
    const waiting = starting || (media.readyState < 3 && ahead < 1);
    if (waiting) { health.waitingSince ||= now; health.stableSince = now; }
    else { health.waitingSince = 0; if (ahead < 10) health.stableSince = now; }
    const next = adaptiveQuality({ streams: streams.filter((stream) => !failedStreams.current.has(stream) &&
        (!hevcDecodeFailed.current || !isHevcSource(stream) || stream.transcodeAllowed !== false)),
      current: selectedStream, connection: navigator.connection, bufferAhead: ahead,
      waitingMs: health.waitingSince ? now - health.waitingSince : 0,
      stableMs: now - health.stableSince, sinceSwitchMs: now - health.changedAt,
      playing: true, seeking: starting ? false : media.seeking, playbackSeconds: media.currentTime });
    if (next) chooseQuality(next, true);
  });
  const applyManifestQuality = useEffectEvent(() => {
    const hls = hlsRef.current;
    if (!hls || hls.levels.length < 2) return;
    if (autoQuality) { hls.currentLevel = -1; return; }
    const height = Number(selectedStream?.resolution) || Number(selectedStream?.name?.match(/(\d+)p/i)?.[1]) || 0;
    if (!height) return;
    const levels = hls.levels.map((level, index) => ({ height: level.height, index })).sort((a, b) => a.height - b.height);
    hls.currentLevel = (levels.filter((level) => level.height <= height).at(-1) || levels[0]).index;
  });
  useEffect(() => { applyManifestQuality(); }, [autoQuality, selectedStream]);
  useEffect(() => {
    const timer = setInterval(checkAutoQuality, 3000);
    const connection = navigator.connection;
    connection?.addEventListener?.('change', checkAutoQuality);
    return () => { clearInterval(timer); connection?.removeEventListener?.('change', checkAutoQuality); };
  }, []);

  useEffect(() => {
    if (!selectedStream || isIframe || !videoRef.current) return;
    const videoEl = videoRef.current;
    const audioEl = audioRef.current;
    let disposed = false;
    let failed = false;
    let hls = null;
    let shakaPlayer = null;
    let ready = false;
    let resumed = false;
    let autoplayBlocked = false;
    let lastTime = -1;
    let lastProgress = Date.now();
    let mediaRecoveries = 0;
    let closeHlsSession = () => {};
    const isTranscodedHls = selectedStream.headers?.['x-transcode-format'] === 'hls';
    const startedAt = Date.now();
    const startupLimit = isLive ? LIVE_START_TIMEOUT : (isTranscodedHls ? 70000 : 22000);
    const stallLimit = isLive ? LIVE_STALL_TIMEOUT : (isTranscodedHls ? 55000 : 18000);
    const savedPos = isLive ? 0 : (resumePositionRef.current ?? getProgress(video.id, episode?.id));
    loadingPositionRef.current = savedPos;
    resumePositionRef.current = null;
    const listeners = [];
    const listen = (target, event, handler, options) => {
      target?.addEventListener(event, handler, options);
      listeners.push(() => target?.removeEventListener(event, handler, options));
    };
    const fail = (message, reason) => {
      if (disposed || failed) return;
      failed = true;
      hls?.stopLoad();
      closeHlsSession();
      videoEl.pause();
      audioEl?.pause();
      failStream(message, reason);
    };
    const play = () => {
      if (disposed || failed) return;
      videoEl.play().then(() => {
        if (disposed || failed) return;
        if (selectedStream.audioUrl) audioEl?.play().catch((error) => {
          if (disposed || failed || error.name === 'AbortError') return;
          if (error.name === 'NotAllowedError') {
            autoplayBlocked = true;
            videoEl.pause();
            setNotice('Tekan Play untuk mengaktifkan video dan suara.');
          } else fail('Trek audio tidak dapat diputar.');
        });
      }).catch((error) => {
        if (disposed || failed || error.name === 'AbortError') return;
        if (error.name === 'NotAllowedError') {
          autoplayBlocked = true;
          setLoading(false);
          setBuffering(false);
          setNotice('Tekan Play untuk mulai menonton.');
        } else fail('Video tidak dapat diputar. Sumber atau format bermasalah.');
      });
    };

    const isTranscodedMedia = selectedStream?.headers?.['x-transcode'] === 'h264';
    applyPreferences();
    if (selectedStream.audioUrl && audioEl) {
      audioEl.src = proxyUrl(selectedStream.audioUrl, selectedStream.headers);
      audioEl.load();
      listen(audioEl, 'error', () => fail('Trek audio gagal dimuat.'));
    }
    const restorePosition = () => {
      if (!resumed && !isTranscodedMedia && savedPos > 0 && Number.isFinite(videoEl.duration) && savedPos < videoEl.duration - 0.25) {
        resumed = true; videoEl.currentTime = savedPos;
        if (selectedStream.audioUrl && audioEl) audioEl.currentTime = savedPos;
      }
    };
    listen(videoEl, 'loadedmetadata', restorePosition);
    listen(videoEl, 'canplay', () => {
      if (disposed || failed) return;
      ready = true;
      setLoading(false);
      setBuffering(false);
      restorePosition();
      if (!resumePausedRef.current) play();
    }, { once: true });
    listen(videoEl, 'playing', () => {
      if (failed || disposed) return;
      ready = true;
      autoplayBlocked = false;
      resumePausedRef.current = false;
      lastProgress = Date.now();
      setLoading(false);
      setBuffering(false);
      setNotice('');
      if (episodeBannerTimer.current) {
        clearTimeout(episodeBannerTimer.current);
        episodeBannerTimer.current = setTimeout(() => setEpisodeBanner(null), 3500);
      }
      reportPlaying();
    });
    listen(videoEl, 'play', () => { autoplayBlocked = false; lastProgress = Date.now(); });
    listen(videoEl, 'pause', () => { setBuffering(false); });
    const fallbackHevc = () => {
      if (disposed || failed || isTranscodedMedia || !isHevcSource(selectedStream)) return false;
      hevcDecodeFailed.current = true;
      const original = selectedStream.originalSource || selectedStream;
      // Keep the selected resolution whenever a transcode worker is available.
      let next = playbackSource(original, false, true);
      if (next === original) {
        const native = streams.filter((source) => !isHevcSource(source) && !failedStreams.current.has(source));
        const ladder = qualityLadder(native);
        next = ladder.filter((source) => sourceResolution(source) <= sourceResolution(original)).at(-1) || ladder[0] || native[0];
      }
      if (!next) {
        fail('Video ini belum tersedia dalam format yang dapat diputar di perangkat ini.', 'unsupported');
        return true;
      }
      resumePositionRef.current = videoEl.readyState > 0 ? videoEl.currentTime + seekOffsetRef.current : savedPos;
      resumePausedRef.current = videoEl.paused && videoEl.readyState > 0;
      failed = true; // Ignore late events from the source being replaced.
      failedStreams.current.add(original);
      hls?.stopLoad();
      videoEl.pause();
      audioEl?.pause();
      qualityHealth.current = { changedAt: Date.now(), stableSince: Date.now(), waitingSince: 0 };
      setLoading(true);
      setBuffering(false);
      setNotice('Menyiapkan video untuk perangkat ini...');
      setSelectedStream(next);
      return true;
    };
    listen(videoEl, 'error', () => {
      if (!hls && !shakaPlayer && videoEl.currentSrc) {
        if (!fallbackHevc()) fail('Sumber video tidak dapat diputar.');
      }
    });
    // Some decoders advance audio/time without presenting a single video frame.
    let frameSeen = false;
    const frameCallback = videoEl.requestVideoFrameCallback?.(() => { frameSeen = true; });
    listen(videoEl, 'ended', () => {
      if (isLive) fail('Siaran telah berhenti. Mencari saluran lain.');
    });
    listen(videoEl, 'seeking', () => { lastProgress = Date.now(); qualityHealth.current.stableSince = Date.now(); });
    listen(window, 'offline', () => fail('Koneksi internet terputus.', 'connection'));

    const watchdog = setInterval(() => {
      if (disposed || failed || autoplayBlocked) return;
      const now = Date.now();
      if (!ready && now - startedAt >= 15000 && !resumePausedRef.current) checkAutoQuality(true);
      if (!ready && now - startedAt >= startupLimit) {
        fail('Sumber tidak merespons dalam batas waktu.');
      } else if (ready && !videoEl.paused && !videoEl.ended) {
        if (Math.abs(videoEl.currentTime - lastTime) > 0.05) {
          lastTime = videoEl.currentTime;
          lastProgress = now;
          if (!isLive && !videoEl.seeking && document.visibilityState === 'visible' &&
              now - startedAt >= 4000 && (videoEl.videoWidth === 0 || (frameCallback !== undefined && !frameSeen))) {
            if (!fallbackHevc()) fail('Gambar video gagal dimuat. Mencoba sumber lain.');
          }
        } else if (now - lastProgress >= stallLimit) {
          fail('Siaran terhenti atau terlalu lama melakukan buffering.');
        }
      }
    }, 500);

    let streamHeaders = { ...(selectedStream.headers || {}) };
    if (isTranscodedMedia && !isTranscodedHls && savedPos > 5 && !seekOffsetRef.current) {
      seekOffsetRef.current = savedPos;
      streamHeaders.ss = String(Math.floor(savedPos));
    }

    const kind = streamKind(selectedStream);
    const sessionId = isTranscodedHls ? createHlsSessionId() : undefined;
    const playUrl = proxyUrl(selectedStream.url, streamHeaders, sessionId);
    if (isTranscodedHls) {
      seekOffsetRef.current = 0;
      const sessionUrl = '/api/transcode/session?' + new URLSearchParams({ sid: sessionId });
      let closed = false;
      const heartbeat = setInterval(() => { fetch(sessionUrl, { method: 'POST' }).catch(() => {}); }, 30000);
      closeHlsSession = () => {
        if (closed) return;
        closed = true; clearInterval(heartbeat);
        if (!navigator.sendBeacon?.(sessionUrl + '&close=1')) fetch(sessionUrl + '&close=1', { method: 'POST', keepalive: true }).catch(() => {});
      };
      listen(window, 'pagehide', closeHlsSession);
      listen(videoEl, 'loadedmetadata', () => {
        if (Number.isFinite(videoEl.duration)) setKnownDuration(videoEl.duration);
        if (!hls && savedPos > 0 && savedPos < videoEl.duration - 1) videoEl.currentTime = savedPos;
      }, { once: true });
    }
    if (kind === 'dash') {
      (async () => {
        try {
          const shakaModule = await import('shaka-player/dist/shaka-player.compiled.js');
          const shaka = shakaModule.default || shakaModule;
          if (disposed || failed) return;
          shaka.polyfill.installAll();
          if (!shaka.Player.isBrowserSupported()) {
            fail('Browser ini belum mendukung format siaran ini. Coba browser lain.', 'unsupported');
            return;
          }
          shakaPlayer = new shaka.Player();
          shakaRef.current = shakaPlayer;
          await shakaPlayer.attach(videoEl);
          if (disposed || failed) return;
          const retryParameters = { maxAttempts: 2, baseDelay: 400, timeout: 8000, connectionTimeout: 5000, stallTimeout: 5000 };
          const config = {
            streaming: { bufferingGoal: 15, rebufferingGoal: 2, retryParameters },
            manifest: { retryParameters },
          };
          const drm = selectedStream.drm;
          let keys = drm?.clear_key?.keys || [];
          if (drm?.clear_key_json_base64) {
            try { keys = JSON.parse(atob(drm.clear_key_json_base64)).keys || []; } catch { /* Report load failure below. */ }
          }
          const clearKeys = {};
          if (Array.isArray(keys)) for (const key of keys) {
            const kid = base64UrlToHex(key?.kid);
            const value = base64UrlToHex(key?.k);
            if (kid.length === 32 && value.length === 32) clearKeys[kid] = value;
          }
          if (Object.keys(clearKeys).length) config.drm = { clearKeys };
          else if (selectedStream.isDrm) {
            fail('Sumber ini memerlukan lisensi DRM yang belum tersedia untuk pemutar ini.', 'unsupported');
            return;
          }
          shakaPlayer.configure(config);
          const net = shakaPlayer.getNetworkingEngine();
          net.registerRequestFilter((type, request) => {
            // License requests are not video GET requests.
            if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) return;
            request.uris = request.uris.map((uri) => {
              const parsed = new URL(uri, location.href);
              if (parsed.origin === location.origin && parsed.pathname === '/api/stream') return uri;
              return proxyUrl(uri, selectedStream.headers);
            });
          });
          net.registerResponseFilter((type, response) => {
            // Resolve relative DASH segments against the upstream manifest, including redirects.
            if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
              response.uri = response.headers['x-stream-url'] || new URL(response.uri, location.href).searchParams.get('url') || response.uri;
            }
          });
          shakaPlayer.addEventListener('error', (event) => {
            if (event.detail?.severity === 2) fail('Pemutar gagal memuat siaran DASH.');
          });
          await shakaPlayer.load(selectedStream.url);
        } catch {
          if (!disposed) fail('Sumber DASH gagal dimuat.');
        }
      })();
    } else if (kind === 'hls') {
      const nativeHls = videoEl.canPlayType('application/vnd.apple.mpegurl');
      if (nativeHls && /Apple/.test(navigator.vendor || '')) {
        videoEl.src = playUrl;
        videoEl.load();
      } else if (Hls.isSupported()) {
        const policy = { default: { maxTimeToFirstByteMs: isTranscodedHls ? 50000 : 6000, maxLoadTimeMs: isTranscodedHls ? 55000 : 8000,
          timeoutRetry: { maxNumRetry: 1, retryDelayMs: 300, maxRetryDelayMs: 600 },
          errorRetry: { maxNumRetry: 1, retryDelayMs: 300, maxRetryDelayMs: 600 },
        } };
        hls = new Hls({ enableWorker: true, lowLatencyMode: !isTranscodedHls, maxBufferLength: isTranscodedHls ? 60 : 30,
          startPosition: Math.max(0, savedPos), backBufferLength: 120,
          manifestLoadPolicy: policy, playlistLoadPolicy: policy, fragLoadPolicy: policy });
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, applyManifestQuality);
        if (isTranscodedHls) hls.on(Hls.Events.LEVEL_LOADED, (_, data) => { if (!disposed) setKnownDuration(data.details.totalduration); });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (disposed || failed || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && fallbackHevc()) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 1) {
            hls.recoverMediaError();
          } else fail('Sumber HLS tidak dapat diputar atau sedang offline.');
        });
        hls.attachMedia(videoEl);
        hls.loadSource(playUrl);
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        videoEl.src = playUrl;
        videoEl.load();
      } else {
        fail('Browser ini belum mendukung HLS. Coba browser lain.', 'unsupported');
      }
    } else {
      videoEl.src = playUrl;
      videoEl.load();
    }

    return () => {
      disposed = true;
      clearInterval(watchdog);
      if (frameCallback !== undefined) videoEl.cancelVideoFrameCallback?.(frameCallback);
      closeHlsSession();
      listeners.forEach((remove) => remove());
      hls?.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
      if (shakaRef.current === shakaPlayer) shakaRef.current = null;
      shakaPlayer?.destroy().catch(() => {});
      for (const media of [videoEl, audioEl]) {
        if (!media) continue;
        media.pause();
        media.removeAttribute('src');
        media.load();
      }
    };
  }, [selectedStream, streams, isIframe, isLive, video.id, episode?.id]);

  useEffect(() => {
    for (const media of [videoRef.current, audioRef.current]) {
      if (media) media.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  useEffect(() => () => {
    clearTimeout(hideControlsTimer.current);
    clearTimeout(episodeBannerTimer.current);
  }, []);


  // Sync Subtitle Cues with Video Time (and sync audio for DASH/Bstation)
  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const time = videoRef.current.currentTime;
    setCurrentTime(time + (seekOffsetRef.current || 0));

    // Sync separate audio track
    if (audioRef.current && selectedStream?.audioUrl) {
      const diff = Math.abs(audioRef.current.currentTime - time);
      if (diff > 0.25) {
        audioRef.current.currentTime = time;
      }
      if (!videoRef.current.paused && audioRef.current.paused) {
        audioRef.current.play().catch(() => {});
      }
    }

    const totalTime = time + (seekOffsetRef.current || 0);

    // Save progress periodically (every 5s)
    if (!isLive && Math.floor(totalTime) % 5 === 0 && effectiveDuration > 0) {
      saveProgress(video.id, episode?.id, totalTime, effectiveDuration);
    }

    // Subtitle matching
    if (selectedSubtitle && subtitleCues.length > 0) {
      const isTranscoded = selectedStream?.headers?.['x-transcode'] === 'h264';
      const subTime = isTranscoded ? totalTime : time;
      const match = subtitleCues.find((c) => subTime >= c.start && subTime <= c.end);
      setCurrentSubtitleText(match ? match.text : '');
    } else {
      setCurrentSubtitleText('');
    }
  };

  // Activity detection for auto-hiding controls
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);

    hideControlsTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setShowControls(false);
        setShowSubtitleMenu(false);
        setShowSettingsMenu(false);
      }
    }, 3500);
  }, []);

  // Keep fullscreen state in sync when the browser exits fullscreen (Esc / F11)
  useEffect(() => {
    const handleFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
      setIsFullscreen(active);
      if (!active) {
        try {
          screen.orientation?.unlock?.();
        } catch {}
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  const isTranscodedStream = selectedStream?.headers?.['x-transcode'] === 'h264';
  const effectiveDuration = selectedStream?.headers?.['x-transcode-format'] === 'hls' && duration > 0 ? duration : isTranscodedStream && knownDuration > 0
    ? knownDuration
    : ((knownDuration > 0 && (duration <= 30 || !Number.isFinite(duration)))
      ? knownDuration
      : (Number.isFinite(duration) && duration > 30 ? duration : (knownDuration || duration || 0)));

  const displayedTime = Math.max(0, currentTime);
  const progressPercent = effectiveDuration > 0 ? Math.min(100, (displayedTime / effectiveDuration) * 100) : 0;

  const handleSeek = (val) => {
    if (!videoRef.current || isLive) return;
    const isTranscoded = selectedStream?.headers?.['x-transcode'] === 'h264' && selectedStream.headers?.['x-transcode-format'] !== 'hls';
    if (isTranscoded) {
      seekOffsetRef.current = val;
      setCurrentTime(val);
      setLoading(true);
      const targetUrl = proxyUrl(selectedStream.url, {
        ...selectedStream.headers,
        ss: String(Math.floor(val)),
      });
      videoRef.current.src = targetUrl;
      videoRef.current.load();
      videoRef.current.play().catch(() => {});
    } else {
      seekOffsetRef.current = 0;
      setCurrentTime(val);
      videoRef.current.currentTime = val;
      if (audioRef.current && selectedStream?.audioUrl) {
        audioRef.current.currentTime = val;
      }
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.ended || (effectiveDuration > 0 && Math.abs(displayedTime - effectiveDuration) < 0.5)) {
      seekOffsetRef.current = 0;
      videoRef.current.currentTime = 0;
      if (audioRef.current && selectedStream?.audioUrl) {
        audioRef.current.currentTime = 0;
      }
      videoRef.current.play().catch(() => {});
      if (audioRef.current && selectedStream?.audioUrl) {
        audioRef.current.play().catch(() => {});
      }
      return;
    }
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      if (audioRef.current && selectedStream?.audioUrl) {
        audioRef.current.play().catch(() => {});
      }
    } else {
      videoRef.current.pause();
      if (audioRef.current && selectedStream?.audioUrl) {
        audioRef.current.pause();
      }
    }
  };

  const seekDelta = (seconds) => {
    if (!videoRef.current || isLive) return;
    const maxDur = effectiveDuration > 0 ? effectiveDuration : (duration > 0 ? duration : 100);
    const target = Math.max(0, Math.min(maxDur, displayedTime + seconds));
    handleSeek(target);
  };

  const setVolumeLevel = (newVol) => {
    if (!videoRef.current) return;
    videoRef.current.volume = newVol;
    videoRef.current.muted = newVol === 0;
    setVolume(newVol);
    setIsMuted(newVol === 0);
    if (audioRef.current) {
      audioRef.current.volume = newVol;
      audioRef.current.muted = newVol === 0;
    }
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const state = !isMuted;
    videoRef.current.muted = state;
    setIsMuted(state);
    if (audioRef.current) {
      audioRef.current.muted = state;
    }
  };

  const toggleFullscreen = async () => {
    const container = containerRef.current;
    const videoEl = videoRef.current;
    if (!container) return;

    const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
    const isVideoNativeFs = Boolean(videoEl?.webkitDisplayingFullscreen);

    // Exit fullscreen
    if (fsElement || isVideoNativeFs) {
      try {
        if (isVideoNativeFs) videoEl.webkitExitFullscreen?.();
        else if (document.exitFullscreen) await document.exitFullscreen();
        else document.webkitExitFullscreen?.();
      } catch {}
      try {
        screen.orientation?.unlock?.();
      } catch {}
      return;
    }

    // Enter fullscreen (container first, keeps custom controls)
    try {
      if (container.requestFullscreen) {
        await container.requestFullscreen({ navigationUI: 'hide' });
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      } else if (videoEl?.webkitEnterFullscreen) {
        // iPhone Safari: only the <video> element can go fullscreen (auto landscape)
        videoEl.webkitEnterFullscreen();
        return;
      }
    } catch {
      if (videoEl?.webkitEnterFullscreen) {
        try {
          videoEl.webkitEnterFullscreen();
        } catch {}
        return;
      }
    }

    // Force landscape on mobile after entering fullscreen
    try {
      await screen.orientation?.lock?.('landscape');
    } catch {}
  };

  const togglePiP = async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await videoRef.current.requestPictureInPicture();
      }
    } catch (err) {
      console.warn('PiP error:', err);
    }
  };

  // Keyboard navigation & Shortcuts
  const handleKeyDown = useEffectEvent((e) => {
      if (e.target?.closest?.('input, textarea, select, [contenteditable=true]')) return;
      if (!isFullscreen) {
        const container = containerRef.current;
        const isEngaged =
          container &&
          (container.matches(':hover') || container.contains(document.activeElement));
        if (!isEngaged) return;
      }

      resetHideTimer();

      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
        case 'j':
        case 'J':
          e.preventDefault();
          seekDelta(-10);
          break;
        case 'ArrowRight':
        case 'l':
        case 'L':
          e.preventDefault();
          seekDelta(10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolumeLevel(Math.min(1, volume + 0.1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolumeLevel(Math.max(0, volume - 0.1));
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          toggleMute();
          break;
        case 'Escape':
          if (document.fullscreenElement) {
            document.exitFullscreen?.().catch(() => {});
          }
          break;
        default:
          break;
      }
  });
  useEffect(() => {
    const listener = (event) => handleKeyDown(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  return (
    <div
      ref={containerRef}
      onMouseMove={resetHideTimer}
      onClick={() => {
        resetHideTimer();
        if (showSubtitleMenu) setShowSubtitleMenu(false);
        if (showSettingsMenu) setShowSettingsMenu(false);
      }}
      className="player-inline relative w-full aspect-video bg-black overflow-hidden select-none [&:fullscreen]:aspect-auto [&:fullscreen]:h-full [&:fullscreen]:w-full"
    >
      {/* Video or Iframe Player */}
      {isIframe ? (
        <iframe
          title="Pemutar video eksternal"
          src={selectedStream.url}
          className="w-full h-full border-0 z-0 bg-black"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          onLoad={() => {
            loadedIframeUrl.current = selectedStream.url;
            setLoading(false);
          }}
        />
      ) : (
        <>
          <video
            ref={videoRef}
            className="w-full h-full object-contain cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              resetHideTimer();
              togglePlay();
            }}
            onPlay={() => {
              setIsPlaying(true);
              setEnded(false);
              resetHideTimer();
              if (audioRef.current && selectedStream?.audioUrl && audioRef.current.paused) {
                audioRef.current.play().catch(() => {});
              }
            }}
            onPause={() => {
              setIsPlaying(false);
              setShowControls(true);
              if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current);
              if (audioRef.current && selectedStream?.audioUrl && !audioRef.current.paused) {
                audioRef.current.pause();
              }
            }}
            onSeeking={() => {
              if (audioRef.current && selectedStream?.audioUrl && videoRef.current) {
                audioRef.current.currentTime = videoRef.current.currentTime;
              }
            }}
            onSeeked={() => {
              if (audioRef.current && selectedStream?.audioUrl && videoRef.current) {
                audioRef.current.currentTime = videoRef.current.currentTime;
              }
            }}
            onWaiting={() => setBuffering(true)}
            onPlaying={() => {
              setBuffering(false);
              if (audioRef.current && selectedStream?.audioUrl && audioRef.current.paused) {
                audioRef.current.play().catch(() => {});
              }
            }}
            onTimeUpdate={handleTimeUpdate}
            onDurationChange={(e) => setDuration(Number.isFinite(e.target.duration) ? e.target.duration : 0)}
            onEnded={() => {
              setIsPlaying(false);
              setEnded(true);
              if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.currentTime = 0;
              }
              if (!isLive && autoNext && onNextEpisode) {
                onNextEpisode();
              }
            }}
            playsInline
            webkit-playsinline="true"
            x5-playsinline="true"
          />
          {/* Synchronized Audio Track for Separate Streams (e.g. Bstation DASH) */}
          <audio
            ref={audioRef}
            preload="auto"
            className="hidden"
          />
        </>
      )}

      {notice && !error && (
        <div role="status" className="absolute top-3 left-3 right-3 z-20 rounded-lg bg-black/85 p-3 text-xs text-white">
          {notice}
          {isIframe && <button className="ml-3 underline" onClick={onRetry}>Coba Lagi</button>}
        </div>
      )}

      {/* Loading Overlay */}
      {loading && !error && (
        <div className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center z-20">
          <Loader2 className="w-12 h-12 text-[#e50914] animate-spin mb-3" />
          <p className="text-white text-sm font-medium">Menghubungkan ke pemutar...</p>
        </div>
      )}

      {/* Buffering Spinner */}
      {buffering && !loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="w-14 h-14 rounded-full bg-black/55 flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-white animate-spin" />
          </div>
        </div>
      )}

      {/* Error / Offline Overlay */}
      {error && (
        <div role="alert" className="absolute inset-0 bg-[#090a0f]/95 flex flex-col items-center justify-center z-30 p-6 text-center">
          {isChannelOffline || isLive ? (
            <div className="max-w-md flex flex-col items-center space-y-2.5">
              <RadioOff className="w-8 h-8 text-gray-400 mb-1" />
              <h3 className="text-base sm:text-lg font-semibold text-white">
                Siaran Belum Dapat Diputar
              </h3>
              <p className="text-gray-400 text-xs sm:text-sm leading-relaxed max-w-sm">
                {error}
              </p>
              <div className="pt-2">
                <button
                  onClick={onRetry}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white font-medium text-xs sm:text-sm transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Coba Hubungkan Ulang</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-red-400 text-base font-semibold mb-2">{error}</p>
              <p className="text-gray-400 text-xs mb-6 max-w-md">
                Sumber video mungkin sedang offline atau mengalami pembatasan tautan. Silakan coba kembali atau pilih episode/kualitas lain.
              </p>

              <div className="flex items-center gap-3">
                <button
                  onClick={onRetry}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#e50914] text-white font-medium text-sm hover:bg-[#ff2b3e] transition-colors"
                >
                  <RotateCcw className="w-4 h-4" />
                  <span>Coba Lagi</span>
                </button>
                <button
                  onClick={onClose}
                  className="px-5 py-2.5 rounded-lg bg-white/10 text-white font-medium text-sm hover:bg-white/20 transition-colors"
                >
                  Kembali
                </button>
              </div>
              {/* Rekomendasi Film Populer Gratis / Langsung Putar */}
              <div className="mt-5 pt-4 border-t border-white/10 w-full max-w-md text-left">
                <p className="text-xs font-semibold text-gray-300 mb-2 flex items-center gap-1.5">
                  <Film className="w-3.5 h-3.5 text-[#e50914]" />
                  <span>Rekomendasi Film yang Tersedia Langsung:</span>
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {RECOMMENDED_MOVIES.map((mov) => (
                    <a
                      key={mov.id}
                      href={`/watch?model_id=Moviebox&id=${mov.id}&title=${encodeURIComponent(mov.title)}&type=movie`}
                      className="flex items-center gap-2 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/20 transition-all group"
                    >
                      <div className="w-6 h-8 rounded bg-[#1c2132] overflow-hidden shrink-0">
                        <img
                          src={mov.poster}
                          alt={mov.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-white/90 group-hover:text-white truncate">
                          {mov.title}
                        </p>
                        <span className="text-[9px] text-green-400 font-medium">Bisa Diputar</span>
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {episodeBanner && !error && !(isFullscreen && showControls) && (
        <div
          role="status"
          aria-live="polite"
          className="absolute top-3 left-3 sm:top-4 sm:left-4 z-30 pointer-events-none max-w-[85%]"
        >
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-black/70 text-xs sm:text-sm font-medium text-white">
            <span className="font-semibold text-white whitespace-nowrap">
              {episodeBanner.season ? `${episodeBanner.season} • ` : ''}{episodeBanner.label}
            </span>
            {episodeBanner.title && (
              <span className="text-white/70 truncate max-w-[180px] sm:max-w-xs">
                — {episodeBanner.title}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Custom High-Legibility Subtitle Overlay */}
      {currentSubtitleText && (
        <div
          className={`absolute left-2 right-2 sm:left-4 sm:right-4 flex justify-center pointer-events-none z-10 transition-all duration-200 ${
            showControls
              ? isFullscreen
                ? 'bottom-14 sm:bottom-20'
                : 'bottom-10 sm:bottom-16'
              : isFullscreen
              ? 'bottom-4 sm:bottom-8'
              : 'bottom-1.5 sm:bottom-4'
          }`}
        >
          <div className="max-w-[92%] sm:max-w-2xl text-center bg-black/60 px-2 py-0.5 sm:px-3.5 sm:py-1 rounded sm:rounded-lg">
            <p
              className={`text-white font-semibold sm:font-bold drop-shadow-[0_1px_3px_rgba(0,0,0,0.95)] whitespace-pre-line leading-tight sm:leading-snug ${
                isFullscreen
                  ? 'text-sm sm:text-lg md:text-xl'
                  : 'text-[11px] sm:text-base md:text-lg'
              }`}
            >
              {currentSubtitleText}
            </p>
          </div>
        </div>
      )}

      {/* Player Chrome Controls Overlay */}
      <div
        className={`absolute inset-0 flex flex-col justify-between pointer-events-none transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Top Header Bar (Show in fullscreen mode) */}
        {isFullscreen ? (
          <div className="pointer-events-auto p-4 sm:p-6 bg-gradient-to-b from-black/80 via-black/40 to-transparent flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div>
                <h1 className="text-sm sm:text-base font-bold text-white line-clamp-1 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                  {video.title}
                </h1>
                {episode && (
                  <p className="text-xs sm:text-sm text-white/85 font-medium drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                    {seasonName ? `${seasonName} • ` : ''}Episode {episode.num}
                    {episode.title &&
                    episode.title !== `Episode ${episode.num}` &&
                    episode.title.trim() !== String(video?.title || '').trim()
                      ? `: ${episode.title}`
                      : ''}
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 sm:p-6" />
        )}

        {/* Center Play/Pause Large Action (Quick click) */}
        {!isIframe && !buffering && (
          <div className="flex items-center justify-center gap-8 pointer-events-auto">
            <button
              onClick={() => seekDelta(-10)}
              className="w-11 h-11 rounded-full bg-black/50 hover:bg-black/75 text-white flex items-center justify-center active:scale-95 transition-all"
              title="Mundur 10 Detik"
            >
              <RotateCcw className="w-5 h-5" />
            </button>

            <button
              onClick={togglePlay}
              className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-black/65 hover:bg-black/85 text-white flex items-center justify-center active:scale-95 transition-all"
            >
              {ended ? (
                <RotateCcw className="w-7 h-7 text-white" />
              ) : isPlaying ? (
                <Pause className="w-7 h-7 fill-white" />
              ) : (
                <Play className="w-7 h-7 fill-white ml-1" />
              )}
            </button>

            <button
              onClick={() => seekDelta(10)}
              className="w-11 h-11 rounded-full bg-black/50 hover:bg-black/75 text-white flex items-center justify-center active:scale-95 transition-all"
              title="Maju 10 Detik"
            >
              <RotateCw className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* YouTube-Style Bottom Controls Bar */}
        {!isIframe && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="pointer-events-auto px-4 pb-3 pt-6 bg-gradient-to-t from-black/95 via-black/60 to-transparent flex flex-col gap-2 relative"
          >
            {/* Pop-up Menus (Opening Upwards) */}

            {/* Subtitle Pop-up Menu */}
            {showSubtitleMenu && subtitles.length > 0 && (
              <div className="absolute right-4 sm:right-24 bottom-14 w-56 bg-[#12151f]/95 border border-white/10 rounded-xl shadow-2xl p-2 z-50">
                <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-200">Subtitle</span>
                  <span className="text-xs text-gray-400 truncate max-w-[100px]">
                    {selectedSubtitle ? selectedSubtitle.name : 'Nonaktif'}
                  </span>
                </div>
                <div className="max-h-60 overflow-y-auto py-1 space-y-0.5">
                  <button
                    onClick={() => {
                      setSelectedSubtitle(null); setSubtitleCues([]); setCurrentSubtitleText('');
                      setShowSubtitleMenu(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors ${
                      !selectedSubtitle
                        ? 'bg-white/15 text-white font-semibold'
                        : 'text-gray-300 font-medium hover:bg-white/10'
                    }`}
                  >
                    <div className="w-4 h-4 flex items-center justify-center shrink-0">
                      {!selectedSubtitle && <Check className="w-4 h-4 text-white" />}
                    </div>
                    <span className="truncate text-left flex-1">Nonaktif</span>
                  </button>
                  {subtitles.map((sub, idx) => {
                    const isSelected = selectedSubtitle === sub;
                    return (
                      <button
                        key={idx}
                        onClick={() => {
                          setSelectedSubtitle(sub); setSubtitleCues([]); setCurrentSubtitleText('');
                          setShowSubtitleMenu(false);
                        }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors ${
                          isSelected
                            ? 'bg-white/15 text-white font-semibold'
                            : 'text-gray-300 font-medium hover:bg-white/10'
                        }`}
                      >
                        <div className="w-4 h-4 flex items-center justify-center shrink-0">
                          {isSelected && <Check className="w-4 h-4 text-white" />}
                        </div>
                        <span className="truncate text-left flex-1">{sub.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Settings Pop-up Menu */}
            {showSettingsMenu && (
              <div className="absolute right-4 sm:right-14 bottom-14 w-60 bg-[#12151f]/95 border border-white/10 rounded-xl shadow-2xl p-2 z-50">
                {settingsTab === 'main' && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-gray-300 px-3 py-1.5 border-b border-white/10">
                      Pengaturan
                    </p>

                    {/* Quality Row */}
                    {streams.length > 1 && (
                      <button
                        onClick={() => setSettingsTab('quality')}
                        className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium text-gray-200 hover:bg-white/10 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <Settings className="w-4 h-4 text-gray-400" />
                          <span>Kualitas</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-gray-400 min-w-0">
                          <span className="text-xs font-medium text-gray-300 truncate max-w-[120px]">
                            {autoQuality
                              ? `Auto (${selectedStream?.name || ''})`
                              : selectedStream?.name}
                          </span>
                          <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                        </div>
                      </button>
                    )}

                    {/* Speed Row */}
                    <button
                      onClick={() => setSettingsTab('speed')}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium text-gray-200 hover:bg-white/10 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <RotateCw className="w-4 h-4 text-gray-400" />
                        <span>Kecepatan Putar</span>
                      </div>
                      <div className="flex items-center gap-1 text-gray-400">
                        <span className="text-xs font-medium text-gray-300">
                          {playbackSpeed === 1 ? 'Normal' : `${playbackSpeed}x`}
                        </span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </div>
                    </button>
                  </div>
                )}

                {settingsTab === 'quality' && (
                  <div>
                    <button
                      onClick={() => setSettingsTab('main')}
                      className="w-full flex items-center gap-2 px-3 py-2 border-b border-white/10 text-xs font-semibold text-gray-300 hover:text-white transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      <span>Kualitas Video</span>
                    </button>
                    <div className="max-h-56 overflow-y-auto py-1 space-y-0.5">
                      <button
                        onClick={() => {
                          qualityPreference.current.mode = 'auto';
                          setAutoQuality(true);
                          qualityHealth.current = { changedAt: Date.now(), stableSince: Date.now(), waitingSince: 0 };
                          setShowSettingsMenu(false);
                          setSettingsTab('main');
                        }}
                        className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-gray-200 hover:bg-white/10"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="w-4 h-4">{autoQuality && <Check className="w-4 h-4" />}</span>
                          <span>Auto</span>
                        </div>
                        <span className="text-[10px] text-gray-400 font-mono">Adaptif</span>
                      </button>
                      {streams.map((st, idx) => {
                        const isSelected = !autoQuality && (selectedStream?.originalSource || selectedStream) === st;
                        return (
                          <button
                            key={idx}
                            onClick={() => {
                              chooseQuality(st);
                              setShowSettingsMenu(false);
                              setSettingsTab('main');
                            }}
                            className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-colors ${
                              isSelected
                                ? 'bg-white/15 text-white font-semibold'
                                : 'text-gray-300 font-medium hover:bg-white/10'
                            }`}
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-4 h-4 flex items-center justify-center shrink-0">
                                {isSelected && <Check className="w-4 h-4 text-white" />}
                              </div>
                              <span className="truncate text-left">{st.name}</span>
                            </div>

                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {settingsTab === 'speed' && (
                  <div>
                    <button
                      onClick={() => setSettingsTab('main')}
                      className="w-full flex items-center gap-2 px-3 py-2 border-b border-white/10 text-xs font-semibold text-gray-300 hover:text-white transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      <span>Kecepatan Putar</span>
                    </button>
                    <div className="max-h-56 overflow-y-auto py-1 space-y-0.5">
                      {[0.5, 0.75, 1, 1.25, 1.5, 2].map((spd) => {
                        const isSelected = playbackSpeed === spd;
                        return (
                          <button
                            key={spd}
                            onClick={() => {
                              if (videoRef.current) videoRef.current.playbackRate = spd;
                              setPlaybackSpeed(spd);
                              setShowSettingsMenu(false);
                              setSettingsTab('main');
                            }}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors ${
                              isSelected
                                ? 'bg-white/15 text-white font-semibold'
                                : 'text-gray-300 font-medium hover:bg-white/10'
                            }`}
                          >
                            <div className="w-4 h-4 flex items-center justify-center shrink-0">
                              {isSelected && <Check className="w-4 h-4 text-white" />}
                            </div>
                            <span className="truncate text-left flex-1">
                              {spd === 1 ? 'Normal' : `${spd}x`}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* YouTube Full-Width Timeline Progress Bar */}
            {isLive ? (
              <div className="w-full flex items-center py-1.5 select-none">
                <div className="w-full h-1 bg-white/20 rounded-full overflow-hidden relative">
                  <div className="h-full w-full bg-[#e50914]" />
                </div>
              </div>
            ) : (
              <div className="relative group/timeline w-full flex items-center cursor-pointer py-1.5">
                {/* Background & Progress Track */}
                <div className="w-full h-1 group-hover/timeline:h-1.5 bg-white/20 rounded-full overflow-hidden transition-all duration-150 relative">
                  <div
                    className="h-full bg-[#e50914] transition-none"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>

                {/* Red Scrubber Thumb Circle */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-[#e50914] rounded-full -translate-x-1/2 scale-100 group-hover/timeline:scale-125 transition-transform shadow-md pointer-events-none"
                  style={{ left: `${progressPercent}%` }}
                />

                {/* Invisible Interactive Range Input */}
                <input
                  type="range"
                  min={0}
                  max={effectiveDuration || 100}
                  step={0.1}
                  value={displayedTime}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    handleSeek(val);
                  }}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                />
              </div>
            )}

            {/* Bottom Controls Row */}
            <div className="flex items-center justify-between pt-0.5 gap-1">
              {/* Left Controls: Play/Pause, Rewind, Forward, Volume, Time */}
              <div className="flex items-center gap-1 sm:gap-2 min-w-0">
                {/* Play/Pause */}
                <button
                  onClick={togglePlay}
                  className="p-1.5 sm:p-2 text-white hover:text-[#e50914] transition-colors"
                  title={ended ? "Putar Ulang (k)" : isPlaying ? "Jeda (k)" : "Putar (k)"}
                >
                  {ended ? (
                    <RotateCcw className="w-5 h-5 text-white" />
                  ) : isPlaying ? (
                    <Pause className="w-5 h-5 fill-white" />
                  ) : (
                    <Play className="w-5 h-5 fill-white" />
                  )}
                </button>

                {/* Rewind 10s (Hidden for Live Streams & on mobile, center buttons exist) */}
                {!isLive && (
                  <button
                    onClick={() => seekDelta(-10)}
                    className="hidden sm:block p-1.5 sm:p-2 text-gray-300 hover:text-white transition-colors"
                    title="Mundur 10 detik (j)"
                  >
                    <RotateCcw className="w-4 h-4 sm:w-5 sm:h-5" />
                  </button>
                )}

                {/* Forward 10s (Hidden for Live Streams & on mobile) */}
                {!isLive && (
                  <button
                    onClick={() => seekDelta(10)}
                    className="hidden sm:block p-1.5 sm:p-2 text-gray-300 hover:text-white transition-colors"
                    title="Maju 10 detik (l)"
                  >
                    <RotateCw className="w-4 h-4 sm:w-5 sm:h-5" />
                  </button>
                )}

                {/* Volume with Smooth Hover Expand (desktop only) */}
                <div className="hidden sm:flex items-center group/vol">
                  <button
                    onClick={toggleMute}
                    className="p-1.5 sm:p-2 text-white hover:text-[#e50914] transition-colors"
                    title={isMuted ? "Bunyikan (m)" : "Bisukan (m)"}
                  >
                    {isMuted || volume === 0 ? (
                      <VolumeX className="w-5 h-5" />
                    ) : volume < 0.5 ? (
                      <Volume1 className="w-5 h-5" />
                    ) : (
                      <Volume2 className="w-5 h-5" />
                    )}
                  </button>

                  <div className="w-0 group-hover/vol:w-16 sm:group-hover/vol:w-20 transition-all duration-200 overflow-hidden flex items-center">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={isMuted ? 0 : volume}
                      onChange={(e) => setVolumeLevel(parseFloat(e.target.value))}
                      className="w-14 sm:w-16 h-1 bg-white/30 rounded-lg appearance-none accent-[#e50914] cursor-pointer"
                    />
                  </div>
                </div>

                {/* Time Display or LIVE Badge */}
                {isLive ? (
                  <div className="flex items-center pl-1.5 select-none">
                    <span className="px-2 py-0.5 rounded bg-[#e50914] text-white text-[11px] font-semibold">
                      Live
                    </span>
                  </div>
                ) : (
                  <div className="text-xs sm:text-sm font-medium text-white/90 pl-1 select-none flex items-center gap-1">
                    <span>{formatTime(displayedTime)}</span>
                    <span className="text-white/40">/</span>
                    <span className="text-white/60">{formatTime(effectiveDuration)}</span>
                  </div>
                )}
              </div>

              {/* Right Controls: Autoplay, CC Subtitle, Settings, Next, PiP, Fullscreen */}
              <div className="flex items-center gap-0.5 sm:gap-1.5 shrink-0">
                {/* Autoplay Toggle Switch */}
                {onNextEpisode && (
                  <button
                    onClick={() => setAutoNext(!autoNext)}
                    className="hidden sm:block p-1.5 sm:p-2 text-gray-300 hover:text-white transition-colors"
                    title={autoNext ? "Putar otomatis aktif" : "Putar otomatis nonaktif"}
                  >
                    <div className={`w-7 h-4 rounded-full transition-colors flex items-center px-0.5 ${autoNext ? 'bg-[#e50914]' : 'bg-white/20'}`}>
                      <div className={`w-3 h-3 rounded-full flex items-center justify-center transition-transform ${autoNext ? 'translate-x-3 bg-white text-black' : 'translate-x-0 bg-white text-black'}`}>
                        {autoNext ? (
                          <Play className="w-1.5 h-1.5 fill-current" />
                        ) : (
                          <Pause className="w-1.5 h-1.5 fill-current" />
                        )}
                      </div>
                    </div>
                  </button>
                )}

                {/* Next Episode Button */}
                {onNextEpisode && (
                  <button
                    onClick={onNextEpisode}
                    className="p-1.5 sm:p-2 text-gray-300 hover:text-white transition-colors"
                    title="Episode Berikutnya"
                  >
                    <SkipForward className="w-5 h-5" />
                  </button>
                )}

                {/* YouTube CC Subtitle Button */}
                {subtitles.length > 0 && (
                  <button
                    onClick={() => {
                      setShowSubtitleMenu(!showSubtitleMenu);
                      setShowSettingsMenu(false);
                    }}
                    className={`relative p-1.5 sm:p-2 rounded-lg hover:bg-white/10 transition-colors ${
                      selectedSubtitle ? 'text-white' : 'text-gray-300 hover:text-white'
                    }`}
                    title="Subtitle (CC)"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="w-5 h-5 fill-none stroke-current stroke-2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="5" width="18" height="14" rx="2" />
                      <path d="M7 10h4M13 10h4M7 14h8" />
                    </svg>
                    {selectedSubtitle && (
                      <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-3.5 h-[2px] bg-[#e50914] rounded-full" />
                    )}
                  </button>
                )}

                {/* Settings Gear Button */}
                <button
                  onClick={() => {
                    setShowSettingsMenu(!showSettingsMenu);
                    setShowSubtitleMenu(false);
                    setSettingsTab('main');
                  }}
                  className={`p-1.5 sm:p-2 rounded-lg hover:bg-white/10 transition-colors ${
                    showSettingsMenu ? 'text-[#e50914]' : 'text-gray-300 hover:text-white'
                  }`}
                  title="Setelan (Kualitas & Kecepatan)"
                >
                  <Settings className="w-5 h-5" />
                </button>

                {/* Picture in Picture (desktop only) */}
                <button
                  onClick={togglePiP}
                  className="hidden sm:block p-1.5 sm:p-2 text-gray-300 hover:text-white transition-colors"
                  title="Picture in Picture"
                >
                  <PictureInPicture2 className="w-5 h-5" />
                </button>

                {/* Fullscreen Button (always visible, auto landscape on mobile) */}
                <button
                  onClick={toggleFullscreen}
                  className="p-2 text-white hover:text-[#e50914] transition-colors shrink-0"
                  title="Layar Penuh (f)"
                  aria-label="Layar Penuh"
                >
                  {isFullscreen ? (
                    <Minimize className="w-5 h-5" />
                  ) : (
                    <Maximize className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
