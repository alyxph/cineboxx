'use client';

import { Suspense, useEffect, useMemo, useState, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Navbar from '@/components/Navbar';
import VideoPlayer from '@/components/VideoPlayer';
import { buildWatchUrl } from '@/lib/watch';
import { fetchJson } from '@/lib/http';
import { nextAvailableChannel } from '@/lib/playback';
import {
  AlertCircle,
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  Film,
  Play,
  Star,
  Tv,
  Volume2,
} from 'lucide-react';

function getTvCountryCode(channelId) {
  if (typeof channelId !== 'string') return 'ID';
  if (channelId.startsWith('bittvd_')) {
    try {
      const b64 = channelId.substring(7);
      const str = typeof window !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf8');
      const json = JSON.parse(str);
      if (json.cc) return json.cc;
    } catch {}
  } else if (channelId.startsWith('bittv:')) {
    const parts = channelId.split(':');
    if (parts[1]) return parts[1];
  }
  return 'ID';
}

function formatVersionLabel(version) {
  if (version?.original) return 'Original';
  const name = String(version?.name || '')
    .replace(/\s*dub$/i, '')
    .replace(/\s*audio$/i, '')
    .trim();
  return name || 'Versi';
}

function WatchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const modelId = searchParams.get('model_id') || '';
  const id = searchParams.get('id') || '';
  const episodeId = searchParams.get('episode_id') || '';
  const fallbackEpNum = searchParams.get('ep') || '';
  const fallbackSeason = searchParams.get('season') || '';
  const fallbackTitle = searchParams.get('title') || 'Tanpa Judul';
  const fallbackPoster = searchParams.get('poster') || '';
  const fallbackType = searchParams.get('type') || 'movie';

  const isBlockedContent =
    id === 'news-cineflow' ||
    id.startsWith('news-cineflow') ||
    fallbackType === 'news' ||
    fallbackTitle.toLowerCase().includes('news cineflow') ||
    fallbackTitle.toLowerCase().includes('berita & update cineflow');

  const isLive =
    modelId === 'CineTv' ||
    (fallbackType === 'live' || fallbackType === 'live_tv') ||
    id.startsWith('bittvd_') ||
    id.startsWith('bittv:');

  const [tvCategories, setTvCategories] = useState([]);
  const [activeTvCatId, setActiveTvCatId] = useState(() => getTvCountryCode(id));
  const [channelResult, setChannelResult] = useState(null);
  const tvChannels = useMemo(() => channelResult?.category === activeTvCatId ? channelResult.channels : [], [channelResult, activeTvCatId]);
  const loadingTvChannels = isLive && channelResult?.category !== activeTvCatId;
  const [tvError, setTvError] = useState('');
  const [failedChannels, setFailedChannels] = useState(() => new Set());
  const [channelFailure, setChannelFailure] = useState(null);
  const [tvNotice, setTvNotice] = useState('');
  const [playbackState, setPlaybackState] = useState(null);

  const [detailResult, setDetailResult] = useState(null);
  const detailKey = `${modelId}:${id}`;
  const detail = detailResult?.key === detailKey ? detailResult.data : null;
  const loadingDetail = !isLive && detailResult?.key !== detailKey;
  const detailError = detailResult?.key === detailKey ? detailResult.error : null;
  const [descExpanded, setDescExpanded] = useState(false);
  const [seasonSelection, setSeasonSelection] = useState(null);

  const isNavigatingEpisodeRef = useRef(false);
  const isBackingRef = useRef(false);
  const episodeListRef = useRef(null);
  const activeEpisodeRef = useRef(null);
  const channelListRef = useRef(null);
  const activeChannelRef = useRef(null);

  useEffect(() => {
    if (!isLive) return;
    const controller = new AbortController();
    fetchJson('/api/catalog/categories?model_id=CineTv', { signal: controller.signal })
      .then((json) => {
        if (controller.signal.aborted) return;
        const categories = Array.isArray(json.data) ? json.data : [];
        setTvCategories(categories);
        setActiveTvCatId((current) => categories.some((cat) => cat.id === current) ? current : categories[0]?.id || 'ID');
      }).catch(() => {
        if (!controller.signal.aborted) setTvError('Kategori TV gagal dimuat. Daftar saluran saat ini tetap dapat dicoba.');
      });
    return () => controller.abort();
  }, [isLive]);

  useEffect(() => {
    if (!isLive || !activeTvCatId) return;
    const controller = new AbortController();
    fetchJson(`/api/catalog/videos?model_id=CineTv&category_id=${encodeURIComponent(activeTvCatId)}&page=1`, { signal: controller.signal })
      .then((json) => {
        if (!Array.isArray(json.videos)) throw new Error('Daftar saluran tidak valid.');
        if (!controller.signal.aborted) {
          setChannelResult({ category: activeTvCatId, channels: json.videos });
          setTvError('');
        }
      }).catch((error) => {
        if (!controller.signal.aborted) {
          setChannelResult({ category: activeTvCatId, channels: [] });
          setTvError(error.message || 'Daftar saluran gagal dimuat.');
        }
      });
    return () => controller.abort();
  }, [isLive, activeTvCatId]);

  const navigateToTvChannel = (channel) => {
    setChannelFailure(null);
    setTvNotice('');
    setFailedChannels((previous) => {
      const next = new Set(previous);
      next.delete(String(channel.id));
      return next;
    });
    if (String(channel.id) === id) return;
    router.replace(buildWatchUrl({ ...channel, modelId: 'CineTv', type: 'live' }), { scroll: false });
  };

  const handleChannelUnavailable = ({ message }) => {
    setFailedChannels((previous) => new Set([...previous, String(id)]));
    setChannelFailure({ id, title: fallbackTitle, message });
    setTvNotice(`${fallbackTitle} tidak tersedia: ${message} Mencari saluran lain...`);
  };

  useEffect(() => {
    if (!isLive || channelFailure?.id !== id || loadingTvChannels) return;
    const timer = setTimeout(() => {
      if (!navigator.onLine) {
        setTvNotice('Koneksi internet terputus. Perpindahan otomatis dihentikan.');
        return;
      }
      const next = nextAvailableChannel(tvChannels, id, failedChannels);
      if (next) {
        setTvNotice(`${channelFailure.title} tidak tersedia: ${channelFailure.message} Beralih otomatis ke ${next.title}.`);
        router.replace(buildWatchUrl({ ...next, modelId: 'CineTv', type: 'live' }), { scroll: false });
      } else {
        setTvNotice(tvError ? 'Daftar saluran gagal dimuat; perpindahan otomatis dihentikan. Pilih kategori lain atau muat ulang halaman.' : 'Semua saluran dalam daftar ini sudah dicoba atau tidak tersedia. Perpindahan otomatis dihentikan. Pilih kategori lain atau coba lagi.');
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [isLive, channelFailure, id, loadingTvChannels, tvChannels, failedChannels, router, tvError]);

  const playerVideo = useMemo(
    () => ({
      id,
      modelId,
      title: fallbackTitle,
      poster: fallbackPoster,
      type: fallbackType,
    }),
    [id, modelId, fallbackTitle, fallbackPoster, fallbackType]
  );

  useEffect(() => {
    if (!modelId || !id || isLive || isBlockedContent) return;
    const controller = new AbortController();
    fetchJson(`/api/catalog/detail?model_id=${encodeURIComponent(modelId)}&id=${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((json) => {
        if (!json.data) throw new Error('Detail video tidak tersedia.');
        if (!controller.signal.aborted) setDetailResult({ key: detailKey, data: json.data });
      }).catch((error) => {
        if (!controller.signal.aborted) setDetailResult({ key: detailKey, data: null, error: error.message });
      });
    return () => controller.abort();
  }, [modelId, id, detailKey, isLive, isBlockedContent]);

  const seasons = useMemo(() => (Array.isArray(detail?.seasons) ? detail.seasons : []), [detail]);
  const versions = useMemo(() => (Array.isArray(detail?.versions) ? detail.versions : []), [detail]);

  const allEpisodes = useMemo(
    () =>
      seasons.flatMap((s) =>
        (Array.isArray(s?.episodes) ? s.episodes : []).map((ep) => ({ ...ep, seasonName: s?.name || '' }))
      ),
    [seasons]
  );

  const urlEpisode = useMemo(() => {
    if (!episodeId) return null;

    const match = allEpisodes.find((ep) => String(ep.id) === String(episodeId));
    if (match) return match;

    return {
      id: episodeId,
      num: fallbackEpNum,
      title: '',
      seasonName: fallbackSeason,
    };
  }, [episodeId, allEpisodes, fallbackEpNum, fallbackSeason]);

  const displayEpisode = urlEpisode || allEpisodes[0] || null;

  const matchedSeasonIdx = seasons.findIndex((season) => season.episodes?.some((ep) => String(ep.id) === String(episodeId)));
  const selectedSeasonIdx = seasonSelection?.key === detailKey ? seasonSelection.index : Math.max(0, matchedSeasonIdx);

  const currentIndex = displayEpisode
    ? allEpisodes.findIndex((ep) => String(ep.id) === String(displayEpisode.id))
    : -1;
  const nextEpisode = currentIndex >= 0 ? allEpisodes[currentIndex + 1] || null : null;

  const navigateToEpisode = (ep) => {
    if (isNavigatingEpisodeRef.current || String(ep.id) === String(displayEpisode?.id)) return;
    isNavigatingEpisodeRef.current = true;
    setSeasonSelection(null);
    const params = new URLSearchParams(searchParams.toString());
    params.set('episode_id', String(ep.id));
    if (ep.num) params.set('ep', String(ep.num));
    else params.delete('ep');
    if (ep.seasonName) params.set('season', ep.seasonName);
    else params.delete('season');
    router.replace(`/watch?${params.toString()}`, { scroll: false });
    if (typeof window !== 'undefined' && !(document.fullscreenElement || document.webkitFullscreenElement)) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    setTimeout(() => {
      isNavigatingEpisodeRef.current = false;
    }, 800);
  };

  const navigateToVersion = (version) => {
    if (!version || String(version.id) === String(id)) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('id', String(version.id));

    if (isSeries && displayEpisode?.num) {
      const activeSeason = seasons.find(
        (season) => Array.isArray(season.episodes) && season.episodes.some(
          (ep) => String(ep.id) === String(displayEpisode.id)
        )
      );
      const seasonNumber = activeSeason?.season || 1;
      params.set('episode_id', `${version.id}_${seasonNumber}_${displayEpisode.num}`);
      params.set('ep', String(displayEpisode.num));
      params.set('season', activeSeason?.name || `Season ${seasonNumber}`);
    } else {
      params.delete('episode_id');
      params.delete('ep');
      params.delete('season');
    }

    router.replace(`/watch?${params.toString()}`, { scroll: false });
  };

  const handleBack = () => {
    if (isBackingRef.current) return;
    isBackingRef.current = true;
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push(modelId ? `/?server=${encodeURIComponent(modelId)}` : '/');
    }
    setTimeout(() => {
      isBackingRef.current = false;
    }, 1000);
  };

  const currentSeason = seasons[selectedSeasonIdx] || seasons[0] || null;
  const episodes = Array.isArray(currentSeason?.episodes) ? currentSeason.episodes : [];
  const isSeries =
    !isLive && (
      seasons.length > 0 ||
      detail?.type === 'tv' ||
      detail?.type === 'series' ||
      detail?.type === 'short_drama'
    );
  const hasSidebar = seasons.length > 0 || versions.length > 1 || isLive;

  const title = detail?.title || fallbackTitle;
  const synopsis = detail?.synopsis || detail?.description || '';

  useEffect(() => {
    document.title = `${title} - CineBox`;
    return () => {
      document.title = 'CineBox - Nonton Film & Serial Gratis';
    };
  }, [title]);

  // Auto-scroll active episode to top of sidebar list
  useEffect(() => {
    if (!displayEpisode?.id || !episodeListRef.current) return;
    const scrollActiveIntoTop = () => {
      const container = episodeListRef.current;
      const target = activeEpisodeRef.current;
      if (!container || !target) return;
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const relativeTop = targetRect.top - containerRect.top + container.scrollTop;
      container.scrollTo({
        top: Math.max(0, relativeTop),
        behavior: 'smooth',
      });
    };

    const rafId = requestAnimationFrame(scrollActiveIntoTop);
    const timer = setTimeout(scrollActiveIntoTop, 150);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timer);
    };
  }, [displayEpisode?.id, selectedSeasonIdx, episodes.length]);

  // Auto-scroll active TV channel to top of sidebar list
  useEffect(() => {
    if (!isLive || !id || !channelListRef.current) return;
    const scrollActiveIntoTop = () => {
      const container = channelListRef.current;
      const target = activeChannelRef.current;
      if (!container || !target) return;
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const relativeTop = targetRect.top - containerRect.top + container.scrollTop;
      container.scrollTo({
        top: Math.max(0, relativeTop),
        behavior: 'smooth',
      });
    };

    const rafId = requestAnimationFrame(scrollActiveIntoTop);
    const timer = setTimeout(scrollActiveIntoTop, 150);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timer);
    };
  }, [isLive, id, activeTvCatId, tvChannels.length]);

  if (!modelId || !id || isBlockedContent) {
    return (
      <div className="min-h-screen flex flex-col bg-[#090a0f] text-white">
        <Navbar />
        <main className="flex-1 flex flex-col items-center justify-center text-center p-6">
          <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
          <h1 className="text-lg font-bold mb-2">
            {isBlockedContent ? 'Konten Tidak Tersedia' : 'Film Tidak Ditemukan'}
          </h1>
          <p className="text-sm text-gray-400 mb-6">
            {isBlockedContent
              ? 'Konten pengumuman sistem ini telah dinonaktifkan.'
              : 'Parameter film tidak lengkap. Silakan pilih film dari beranda.'}
          </p>
          <button
            onClick={handleBack}
            className="px-5 py-2.5 rounded-xl bg-[#e50914] hover:bg-[#ff2b3e] text-white text-sm font-bold transition-colors"
          >
            Kembali ke Beranda
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#090a0f] text-white">
      <Navbar />

      <main className="flex-1 max-w-[1720px] w-full mx-auto px-3 sm:px-5 lg:px-8 pt-2 sm:pt-3 pb-8">
        {/* 2-Column Split Screen (YouTube Style) */}
        <div className={`flex flex-col ${hasSidebar ? 'lg:flex-row gap-6 items-start' : 'max-w-6xl mx-auto'}`}>
          
          {/* LEFT COLUMN: Main Video Player & Video Details (~70% width on Desktop) */}
          <div className={`${hasSidebar ? 'w-full lg:w-[70%] xl:w-[72%] min-w-0 space-y-4' : 'w-full space-y-4'}`}>
            
            {/* Main Video Player */}
            <div className="rounded-xl overflow-hidden border border-white/5 bg-black aspect-video w-full">
              {loadingDetail && !episodeId ? <div role="status" className="h-full flex items-center justify-center text-sm text-gray-300">Memuat informasi video...</div> : <VideoPlayer
                key={`${modelId}:${id}`}
                video={playerVideo}
                episode={displayEpisode}
                seasonName={displayEpisode?.seasonName || null}
                onClose={handleBack}
                onUnavailable={isLive ? handleChannelUnavailable : null}
                onPlaybackState={(status) => {
                  setPlaybackState({ id, status });
                  if (status === 'playing' || status === 'loading') {
                    setChannelFailure(null);
                    setFailedChannels((previous) => {
                      if (!previous.has(String(id))) return previous;
                      const next = new Set(previous);
                      next.delete(String(id));
                      return next;
                    });
                  }
                }}
                onNextEpisode={nextEpisode ? () => navigateToEpisode(nextEpisode) : null}
              />}
            </div>

            {isLive && tvNotice && <div role="status" aria-live="polite" className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">{tvNotice}</div>}

            {/* Video / Episode Title right below player */}
            <div className="space-y-1.5 pt-1">
              <h1 className="text-base sm:text-xl font-bold text-white leading-snug">
                {title}
              </h1>

              {/* Metadata Info */}
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-gray-400">
                {isLive ? (
                  <span className="px-2 py-0.5 rounded bg-[#e50914] text-white font-semibold">
                    Live TV
                  </span>
                ) : (
                  <span className="text-gray-300 font-medium">
                    {isSeries ? 'Serial' : 'Film'}
                  </span>
                )}

                {displayEpisode && (
                  <>
                    <span className="text-gray-600">•</span>
                    <span className="text-white font-medium">
                      {displayEpisode.seasonName ? `${displayEpisode.seasonName} • ` : ''}
                      Episode {displayEpisode.num}
                      {displayEpisode.title &&
                      displayEpisode.title !== `Episode ${displayEpisode.num}` &&
                      displayEpisode.title.trim() !== title.trim()
                        ? `: ${displayEpisode.title}`
                        : ''}
                    </span>
                  </>
                )}

                {detail?.year && (
                  <>
                    <span className="text-gray-600">•</span>
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5 text-gray-500" />
                      {detail.year}
                    </span>
                  </>
                )}

                {detail?.duration && (
                  <>
                    <span className="text-gray-600">•</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 text-gray-500" />
                      {detail.duration}
                    </span>
                  </>
                )}

                {detail?.rating && (
                  <>
                    <span className="text-gray-600">•</span>
                    <span className="inline-flex items-center gap-1 font-medium text-amber-400">
                      <Star className="w-3.5 h-3.5 fill-amber-400" />
                      {detail.rating}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Description / Synopsis Card */}
            {loadingDetail ? (
              <div className="rounded-xl bg-[#131622] border border-white/5 p-4 space-y-2.5">
                <div className="h-3 w-24 rounded bg-white/10 animate-shimmer" />
                <div className="h-3 w-full rounded bg-white/10 animate-shimmer" />
                <div className="h-3 w-5/6 rounded bg-white/10 animate-shimmer" />
              </div>
            ) : detailError ? (
              <div className="rounded-xl bg-[#131622] border border-red-500/20 p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-400">Gagal memuat detail film</p>
                  <p className="text-xs text-gray-400 mt-1">{detailError}</p>
                </div>
              </div>
            ) : (
              <div className="rounded-xl bg-[#131622] border border-white/5 p-3.5 sm:p-4 space-y-2.5">
                {detail?.genres && detail.genres.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {detail.genres.map((g, idx) => (
                      <span
                        key={idx}
                        className="text-xs px-2 py-0.5 rounded bg-white/5 text-gray-300"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                )}

                <p
                  className={`text-sm text-gray-300 leading-relaxed whitespace-pre-line ${
                    descExpanded ? '' : 'line-clamp-3'
                  }`}
                >
                  {synopsis || 'Tidak ada sinopsis tersedia.'}
                </p>

                {synopsis.length > 180 && (
                  <button
                    onClick={() => setDescExpanded((prev) => !prev)}
                    className="flex items-center gap-1 text-xs font-bold text-white/70 hover:text-white transition-colors"
                  >
                    {descExpanded ? (
                      <>
                        <span>Sembunyikan</span>
                        <ChevronUp className="w-3.5 h-3.5" />
                      </>
                    ) : (
                      <>
                        <span>Selengkapnya</span>
                        <ChevronDown className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* RIGHT COLUMN: Sidebar Navigation (~30% width on Desktop, YouTube Style) */}
          {hasSidebar && (
            <div className="w-full lg:w-[30%] xl:w-[28%] shrink-0 flex flex-col space-y-3 lg:sticky lg:top-20">
              
              {isLive ? (
                /* LIVE TV CHANNELS SIDEBAR */
                <>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between px-1">
                      <h2 className="text-sm font-bold text-white flex items-center gap-2">
                        <Tv className="w-4 h-4 text-[#e50914]" />
                        <span>Daftar Saluran TV</span>
                      </h2>
                      <span className="text-xs text-gray-400 font-medium">
                        {tvChannels.length} Saluran
                      </span>
                    </div>

                    {tvError && <p role="alert" className="text-xs text-red-300">{tvError}</p>}
                    {!loadingTvChannels && !tvChannels.length && <p className="text-xs text-gray-400">Tidak ada saluran yang tersedia dalam kategori ini.</p>}

                    {/* Horizontal Category Filter Pills */}
                    {tvCategories.length > 0 && (
                      <div className="flex items-center gap-2 overflow-x-auto pb-1.5 pt-0.5 scrollbar-none">
                        {tvCategories.map((cat) => {
                          const isActive = cat.id === activeTvCatId;
                          return (
                            <button
                              key={cat.id}
                              onClick={() => setActiveTvCatId(cat.id)}
                              className={`px-3 py-1.5 rounded-lg text-xs transition-colors whitespace-nowrap shrink-0 ${
                                isActive
                                  ? 'bg-white text-[#090a0f] font-semibold'
                                  : 'bg-white/10 hover:bg-white/15 text-gray-300 hover:text-white font-medium'
                              }`}
                            >
                              {cat.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Vertical Channel List */}
                  <div ref={channelListRef} className="space-y-1.5 max-h-[calc(100vh-140px)] overflow-y-auto pr-1 scrollbar-thin">
                    {loadingTvChannels ? (
                      <div className="space-y-2.5 p-1">
                        {Array.from({ length: 7 }).map((_, idx) => (
                          <div key={idx} className="flex gap-3 items-center p-2 rounded-lg bg-white/5">
                            <div className="w-32 aspect-video rounded-md bg-white/10 animate-shimmer shrink-0" />
                            <div className="flex-1 space-y-2">
                              <div className="h-3 w-3/4 rounded bg-white/10 animate-shimmer" />
                              <div className="h-2.5 w-1/2 rounded bg-white/10 animate-shimmer" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      tvChannels.map((ch) => {
                        const isActiveChannel = id === String(ch.id);
                        const isUnavailable = failedChannels.has(String(ch.id));
                        const isPlayingChannel = isActiveChannel && playbackState?.id === id && playbackState.status === 'playing';
                        const chPoster = ch.poster || fallbackPoster || '';
                        const chTitle = ch.title || 'Saluran TV';

                        return (
                          <div
                            key={ch.id}
                            ref={isActiveChannel ? activeChannelRef : null}
                            onClick={() => navigateToTvChannel(ch)}
                            className={`flex items-start gap-3 p-2 rounded-lg transition-colors cursor-pointer group ${
                              isActiveChannel
                                ? 'bg-white/10 border border-white/15'
                                : 'bg-transparent hover:bg-white/5 border border-transparent'
                            }`}
                          >
                            {/* Left: Thumbnail / Logo (~16:9 Aspect Ratio) */}
                            <div className="relative w-32 sm:w-36 aspect-video rounded-md overflow-hidden shrink-0 bg-[#1c2132] border border-white/5 flex items-center justify-center">
                              {chPoster ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={chPoster}
                                  alt={chTitle}
                                  className="w-full h-full object-contain p-2 transition-transform duration-300 group-hover:scale-[1.03]"
                                  loading="lazy"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center bg-[#181c2b]">
                                  <Tv className="w-6 h-6 text-white/30" />
                                </div>
                              )}

                              {!isActiveChannel && (
                                <span
                                  className={`absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                    isUnavailable
                                      ? 'bg-black/80 text-red-400'
                                      : 'bg-[#e50914] text-white'
                                  }`}
                                >
                                  {isUnavailable ? 'Tidak tersedia' : 'TV'}
                                </span>
                              )}

                              {/* Active Channel Overlay */}
                              {isActiveChannel && (
                                <div className="absolute inset-0 bg-black/65 flex items-center justify-center">
                                  <span className="text-xs font-semibold text-white">
                                    {isUnavailable ? 'Gagal' : isPlayingChannel ? 'Memutar' : 'Dipilih'}
                                  </span>
                                </div>
                              )}
                            </div>

                            {/* Right: Channel Details */}
                            <div className="flex-1 min-w-0 flex flex-col justify-center py-1">
                              <h4
                                className={`text-xs sm:text-sm line-clamp-1 leading-snug transition-colors ${
                                  isActiveChannel
                                    ? 'text-white font-semibold'
                                    : 'text-white/90 font-medium group-hover:text-white'
                                }`}
                              >
                                {chTitle}
                              </h4>

                              <span className="text-[11px] text-gray-400 mt-1 line-clamp-1">
                                {tvCategories.find((c) => c.id === activeTvCatId)?.name || 'Live TV'}
                              </span>

                              {(isUnavailable || isPlayingChannel) && (
                                <span className={`text-[11px] mt-0.5 ${isUnavailable ? 'text-red-400' : 'text-gray-300'}`}>
                                  {isUnavailable ? 'Tidak dapat diakses' : 'Sedang diputar'}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              ) : (
                /* SERIES EPISODES SIDEBAR */
                <>
                  {versions.length > 1 && (
                    <div className="rounded-xl border border-white/5 bg-[#131622] p-3 space-y-2">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                        <Volume2 className="w-3.5 h-3.5 text-[#e50914]" />
                        <span>Audio</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {versions.map((version) => {
                          const isActiveVersion = String(version.id) === String(id);
                          return (
                            <button
                              key={version.id}
                              type="button"
                              onClick={() => navigateToVersion(version)}
                              disabled={isActiveVersion}
                              className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                                isActiveVersion
                                  ? 'bg-white text-[#090a0f] border-white cursor-default'
                                  : 'bg-[#090a0f] text-gray-300 border-white/10 hover:border-white/25 hover:text-white'
                              }`}
                            >
                              {formatVersionLabel(version)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {seasons.length > 0 && (
                    <>
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between px-1">
                          <h2 className="text-sm font-bold text-white flex items-center gap-2">
                            <Film className="w-4 h-4 text-[#e50914]" />
                            <span>Daftar Episode</span>
                          </h2>
                          <span className="text-xs text-gray-400 font-medium">
                            {episodes.length} Episode
                          </span>
                        </div>

                        {/* Horizontal Season Tabs */}
                      <div className="flex items-center gap-2 overflow-x-auto pb-1.5 pt-0.5 scrollbar-none">
                        {seasons.map((s, idx) => {
                          const isActiveSeason = idx === selectedSeasonIdx;
                          return (
                            <button
                              key={s.id || idx}
                              onClick={() => setSeasonSelection({ key: detailKey, index: idx })}
                              className={`px-3 py-1.5 rounded-lg text-xs transition-colors whitespace-nowrap shrink-0 ${
                                isActiveSeason
                                  ? 'bg-white text-[#090a0f] font-semibold'
                                  : 'bg-white/10 hover:bg-white/15 text-gray-300 hover:text-white font-medium'
                              }`}
                            >
                              {s.name || `Season ${idx + 1}`}
                            </button>
                          );
                        })}
                      </div>
                      </div>

                      {/* Vertical List of Episodes */}
                      <div ref={episodeListRef} className="space-y-1.5 max-h-[calc(100vh-140px)] overflow-y-auto pr-1 scrollbar-thin">
                        {episodes.map((ep) => {
                      const isActive = displayEpisode && String(displayEpisode.id) === String(ep.id);
                      const epThumbnail = ep.thumbnail || fallbackPoster || detail?.poster || '';
                      const rawEpTitle = ep.title?.trim() || '';
                      const epTitle =
                        rawEpTitle && rawEpTitle !== title.trim()
                          ? rawEpTitle
                          : `Episode ${ep.num}`;

                      return (
                        <div
                          key={ep.id}
                          ref={isActive ? activeEpisodeRef : null}
                          onClick={() =>
                            navigateToEpisode({
                              ...ep,
                              seasonName: currentSeason?.name || null,
                            })
                          }
                          className={`flex items-start gap-3 p-2 rounded-lg transition-colors cursor-pointer group ${
                            isActive
                              ? 'bg-white/10 border border-white/15'
                              : 'bg-transparent hover:bg-white/5 border border-transparent'
                          }`}
                        >
                          {/* Left: Thumbnail (~16:9 Aspect Ratio) */}
                          <div className="relative w-32 sm:w-36 aspect-video rounded-md overflow-hidden shrink-0 bg-[#1c2132] border border-white/5">
                            {epThumbnail ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={epThumbnail}
                                alt={epTitle}
                                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                                loading="lazy"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center bg-[#181c2b]">
                                <Play className="w-6 h-6 text-white/30" />
                              </div>
                            )}

                            {/* Episode Number Tag (Bottom Right) */}
                            {!isActive && (
                              <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-medium text-white">
                                Ep {ep.num}
                              </div>
                            )}

                            {/* Active Episode Overlay */}
                            {isActive && (
                              <div className="absolute inset-0 bg-black/65 flex items-center justify-center">
                                <span className="text-xs font-semibold text-white">
                                  Memutar
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Right: Episode Title & Details */}
                          <div className="flex-1 min-w-0 flex flex-col justify-center py-0.5">
                            <h4
                              className={`text-xs sm:text-sm line-clamp-2 leading-snug transition-colors ${
                                isActive
                                  ? 'text-white font-semibold'
                                  : 'text-white/90 font-medium group-hover:text-white'
                              }`}
                            >
                              {epTitle}
                            </h4>

                            <span className="text-[11px] text-gray-400 mt-1 line-clamp-1">
                              {currentSeason?.name || 'Season 1'} • Episode {ep.num}
                            </span>

                            {ep.duration && (
                              <span className="text-[10px] text-gray-500 mt-0.5">
                                {ep.duration}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                        })}
                      </div>
                    </>
                  )}
                </>
              )}

            </div>
          )}

        </div>
      </main>
    </div>
  );
}

export default function WatchPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#090a0f] flex items-center justify-center">
          <div className="w-8 h-8 border-4 border-[#e50914]/20 border-t-[#e50914] rounded-full animate-spin" />
        </div>
      }
    >
      <WatchContent />
    </Suspense>
  );
}
