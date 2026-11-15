'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { fetchJson } from '@/lib/http';
import Navbar from '@/components/Navbar';
import MovieCard from '@/components/MovieCard';
import { Film, ChevronDown, ChevronLeft, ChevronRight, RefreshCw, AlertCircle, Loader2 } from 'lucide-react';

function getVideoGroupKey(video) {
  const title = String(video?.canonicalTitle || video?.title || '').trim().toLowerCase();
  return `${title}|${video?.type || ''}`;
}

function HorizontalScrollBar({ children, className = '' }) {
  const scrollRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateScrollState, children]);

  const scrollBy = (direction) => {
    const el = scrollRef.current;
    if (!el) return;
    const step = Math.max(200, Math.floor(el.clientWidth * 0.6));
    el.scrollBy({ left: direction * step, behavior: 'smooth' });
  };

  return (
    <div className="relative group/scroll">
      <div
        ref={scrollRef}
        onScroll={updateScrollState}
        className={`flex items-center overflow-x-auto pb-1 scrollbar-none ${className}`}
      >
        {children}
      </div>

      {canScrollLeft && (
        <div className="absolute inset-y-0 left-0 flex items-center pr-6 bg-gradient-to-r from-[#090a0f] via-[#090a0f]/80 to-transparent pointer-events-none">
          <button
            type="button"
            onClick={() => scrollBy(-1)}
            aria-label="Geser ke kiri"
            className="pointer-events-auto w-7 h-7 rounded-full bg-[#181c2b] hover:bg-[#252b42] border border-white/10 text-white flex items-center justify-center transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      )}

      {canScrollRight && (
        <div className="absolute inset-y-0 right-0 flex items-center pl-6 bg-gradient-to-l from-[#090a0f] via-[#090a0f]/80 to-transparent pointer-events-none">
          <button
            type="button"
            onClick={() => scrollBy(1)}
            aria-label="Geser ke kanan"
            className="pointer-events-auto w-7 h-7 rounded-full bg-[#181c2b] hover:bg-[#252b42] border border-white/10 text-white flex items-center justify-center transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function HomeContent() {
  const [sources, setSources] = useState([]);
  const [activeSourceId, setActiveSourceId] = useState('');
  const [categories, setCategories] = useState([]);
  const [activeCategoryId, setActiveCategoryId] = useState('');

  const [videos, setVideos] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingVideos, setLoadingVideos] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const observerTargetRef = useRef(null);
  const fetchSeqRef = useRef(0);
  const catSeqRef = useRef(0);
  const isFetchingMoreRef = useRef(false);
  const abortControllerRef = useRef(null);
  const selectCatTimerRef = useRef(null);
  const isSwitchingSourceRef = useRef(false);
  const isRetryingRef = useRef(false);
  const hasInitializedRef = useRef(false);

  // Sync current server & category to the browser URL without triggering Next.js router loops
  const syncUrl = useCallback((server, cat) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (server) url.searchParams.set('server', server);
    if (cat) url.searchParams.set('cat', cat);
    else url.searchParams.delete('cat');
    const nextUrl = url.pathname + url.search;
    const currentUrl = window.location.pathname + window.location.search;
    if (nextUrl !== currentUrl) {
      window.history.replaceState(window.history.state, '', nextUrl);
    }
  }, []);

  // Fetch videos with pagination, abort support, and stale-response protection
  const fetchVideos = useCallback(async (sourceId, catId, targetPage = 1, append = false) => {
    if (!sourceId) return;

    if (append) {
      if (isFetchingMoreRef.current) return;
      isFetchingMoreRef.current = true;
      setLoadingMore(true);
    } else {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();
      setLoadingVideos(true);
      setError(null);
      setVideos([]);
    }

    const currentSeq = ++fetchSeqRef.current;
    const signal = abortControllerRef.current?.signal;

    try {
      let url = `/api/cineflow/videos?model_id=${encodeURIComponent(sourceId)}&page=${targetPage}`;
      if (catId) {
        url += `&category_id=${encodeURIComponent(catId)}`;
      }

      const json = await fetchJson(url, { signal });

      // Discard response if a newer fetch request has already been triggered
      if (currentSeq !== fetchSeqRef.current) return;

      if (json.success) {
        const newVids = Array.isArray(json.videos) ? json.videos : [];
        const serverHasMore = json.hasMore !== undefined
          ? Boolean(json.hasMore)
          : newVids.length > 0;

        setHasMore(serverHasMore);
        setPage(targetPage);

        setVideos((prev) => {
          if (!append) return newVids;
          const seen = new Set(prev.map(getVideoGroupKey));
          const uniqueNew = newVids.filter((v) => {
            const key = getVideoGroupKey(v);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          return [...prev, ...uniqueNew];
        });
      } else {
        if (!append) setError(json.error || 'Gagal mengambil daftar film.');
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (currentSeq === fetchSeqRef.current) {
        if (append) setHasMore(false);
        setError(err.message || 'Terjadi gangguan koneksi.');
      }
    } finally {
      if (currentSeq === fetchSeqRef.current) {
        setLoadingVideos(false);
        setLoadingMore(false);
      }
      if (currentSeq === fetchSeqRef.current) isFetchingMoreRef.current = false;
    }
  }, []);

  // Load categories for a source and determine the active category
  const initCategoriesAndVideos = useCallback(
    async (sourceId, preferredCat = null) => {
      clearTimeout(selectCatTimerRef.current);
      abortControllerRef.current?.abort();
      fetchSeqRef.current++;
      isFetchingMoreRef.current = false;
      setVideos([]);
      setLoadingVideos(true);
      const currentCatSeq = ++catSeqRef.current;
      try {
        const json = await fetchJson(`/api/cineflow/categories?model_id=${encodeURIComponent(sourceId)}`);
        if (currentCatSeq !== catSeqRef.current) return;

        const cats = json.success && Array.isArray(json.data) ? json.data : [];
        setCategories(cats);

        let targetCat = '';
        if (preferredCat && cats.some((c) => c.id === preferredCat)) {
          targetCat = preferredCat;
        } else if (sourceId === 'CineTv') {
          // CineTv default: Indonesian channels
          targetCat = cats.find((c) => c.id === 'ID')?.id || cats[0]?.id || '';
        } else {
          targetCat = cats[0]?.id || '';
        }

        setActiveCategoryId(targetCat);
        syncUrl(sourceId, targetCat);

        setPage(1);
        setHasMore(true);
        fetchVideos(sourceId, targetCat, 1, false);
      } catch {
        if (currentCatSeq !== catSeqRef.current) return;
        setCategories([]);
        setActiveCategoryId('');
        syncUrl(sourceId, '');
        fetchVideos(sourceId, '', 1, false);
      }
    },
    [fetchVideos, syncUrl]
  );

  // Initial load of sources on mount
  const loadSources = useCallback(async () => {
    setLoadingSources(true);
    setError(null);
    try {
      const json = await fetchJson('/api/cineflow/sources');
      if (json.success && Array.isArray(json.data) && json.data.length > 0) {
        setSources(json.data);

        const params =
          typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search)
            : new URLSearchParams();
        const urlServer = params.get('server');
        const urlCat = params.get('cat');

        const targetSource = json.data.find((s) => s.id === urlServer) || json.data[0];

        const targetSourceId = targetSource.id;
        setActiveSourceId(targetSourceId);
        await initCategoriesAndVideos(targetSourceId, urlCat);
      } else {
        setError(json.error || 'Tidak ada server sumber film yang tersedia.');
        setLoadingVideos(false);
      }
    } catch (err) {
      setError(err.message || 'Gagal memuat daftar sumber.');
      setLoadingVideos(false);
    } finally {
      setLoadingSources(false);
    }
  }, [initCategoriesAndVideos]);

  useEffect(() => {
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;
    loadSources();
  }, [loadSources]);

  // Handle popstate for back/forward navigation within home page
  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const urlServer = params.get('server');
      const urlCat = params.get('cat');
      if (urlServer && urlServer !== activeSourceId) {
        setActiveSourceId(urlServer);
        initCategoriesAndVideos(urlServer, urlCat);
      } else if (urlCat && urlCat !== activeCategoryId) {
        setActiveCategoryId(urlCat);
        setPage(1);
        setHasMore(true);
        fetchVideos(activeSourceId, urlCat, 1, false);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [activeSourceId, activeCategoryId, initCategoriesAndVideos, fetchVideos]);

  // User selects a server (with anti-spam single request lock)
  const handleSelectSource = (srcId) => {
    if (srcId === activeSourceId || isSwitchingSourceRef.current) return;
    isSwitchingSourceRef.current = true;
    setActiveSourceId(srcId);
    initCategoriesAndVideos(srcId).finally(() => {
      setTimeout(() => {
        isSwitchingSourceRef.current = false;
      }, 400);
    });
  };

  // User selects a category (with 150ms debounce and active state lock)
  const handleSelectCategory = (catId) => {
    if (catId === activeCategoryId) return;
    abortControllerRef.current?.abort();
    fetchSeqRef.current++;
    isFetchingMoreRef.current = false;
    setLoadingMore(false);
    setActiveCategoryId(catId);
    syncUrl(activeSourceId, catId);
    setPage(1);
    setHasMore(true);

    if (selectCatTimerRef.current) clearTimeout(selectCatTimerRef.current);
    selectCatTimerRef.current = setTimeout(() => {
      fetchVideos(activeSourceId, catId, 1, false);
    }, 150);
  };

  // Anti-spam retry handler
  const handleRetry = () => {
    if (isRetryingRef.current) return;
    isRetryingRef.current = true;
    if (sources.length === 0) {
      loadSources();
    } else {
      fetchVideos(activeSourceId, activeCategoryId, 1, false);
    }
    setTimeout(() => {
      isRetryingRef.current = false;
    }, 1200);
  };

  // Load more videos handler with cooldown protection
  const lastLoadMoreTimeRef = useRef(0);
  const handleLoadMore = useCallback(() => {
    const now = Date.now();
    if (now - lastLoadMoreTimeRef.current < 1200) return; // At least 1.2s between page requests
    if (!isFetchingMoreRef.current && hasMore && !loadingMore && !loadingVideos && activeSourceId) {
      lastLoadMoreTimeRef.current = now;
      fetchVideos(activeSourceId, activeCategoryId, page + 1, true);
    }
  }, [activeSourceId, activeCategoryId, page, hasMore, loadingMore, loadingVideos, fetchVideos]);

  // Infinite Scroll Observer with moderate margin
  useEffect(() => {
    if (loadingVideos || loadingMore || !hasMore) return;

    const target = observerTargetRef.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !isFetchingMoreRef.current) {
          handleLoadMore();
        }
      },
      {
        root: null,
        rootMargin: '160px',
        threshold: 0,
      }
    );

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [loadingVideos, loadingMore, hasMore, handleLoadMore]);

  return (
    <div className="min-h-screen flex flex-col bg-[#090a0f] text-white">
      <Navbar />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 space-y-5">
        {/* Sticky Source & Category Selector */}
        {(sources.length > 0 || categories.length > 0) && (
          <div className="sticky top-16 z-30 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-2.5 space-y-2 bg-[#090a0f]/95 backdrop-blur-md border-b border-white/5">
            {/* Source Selector Bar */}
            {!loadingSources && sources.length > 0 && (
              <HorizontalScrollBar className="gap-2">
                <span className="text-xs font-medium text-gray-500 mr-1 shrink-0">
                  Server:
                </span>
                {sources.map((src) => (
                  <button
                    key={src.id}
                    disabled={activeSourceId === src.id}
                    onClick={() => handleSelectSource(src.id)}
                    className={`px-3.5 py-1.5 rounded-lg text-xs sm:text-sm font-semibold whitespace-nowrap transition-colors border shrink-0 ${
                      activeSourceId === src.id
                        ? 'bg-[#e50914] text-white border-[#e50914] cursor-default'
                        : 'bg-[#131622] text-white/90 hover:text-white border-white/10 hover:border-white/25'
                    }`}
                  >
                    {src.name}
                  </button>
                ))}
              </HorizontalScrollBar>
            )}

            {/* Category Filter Bar */}
            {categories.length > 0 && (
              <HorizontalScrollBar className="gap-1.5">
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    disabled={activeCategoryId === cat.id}
                    onClick={() => handleSelectCategory(cat.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors shrink-0 ${
                      activeCategoryId === cat.id
                        ? 'bg-white text-[#090a0f] font-semibold cursor-default'
                        : 'bg-[#131622] text-white/90 hover:text-white hover:bg-white/10 font-medium'
                    }`}
                  >
                    {cat.name}
                  </button>
                ))}
              </HorizontalScrollBar>
            )}
          </div>
        )}

        {/* Content Area */}
        {loadingVideos ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
            {Array.from({ length: 12 }).map((_, idx) => (
              <div
                key={idx}
                className="aspect-[2/3] rounded-lg bg-[#131622] animate-shimmer"
              />
            ))}
          </div>
        ) : error ? (
          <div className="min-h-[300px] flex flex-col items-center justify-center text-center p-6 bg-[#131622] border border-white/5 rounded-xl">
            <AlertCircle className="w-10 h-10 text-red-500 mb-3" />
            <h3 className="text-base font-bold text-white mb-1">Gagal Menampilkan Film</h3>
            <p className="text-xs text-gray-400 max-w-sm mb-4">{error}</p>
            <button
              onClick={handleRetry}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#e50914] text-white text-xs font-semibold hover:bg-[#ff2b3e] transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Coba Lagi
            </button>
          </div>
        ) : videos.length === 0 ? (
          <div className="min-h-[300px] flex flex-col items-center justify-center text-center p-6 bg-[#131622] border border-white/5 rounded-xl">
            <Film className="w-12 h-12 text-gray-600 mb-3" />
            <h3 className="text-base font-bold text-white mb-1">Tidak Ada Film Ditemukan</h3>
            <p className="text-xs text-gray-400">Silakan pilih kategori atau server lain.</p>
          </div>
        ) : (
          <>
            {/* Movie Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
              {videos.map((vid, idx) => (
                <MovieCard
                  key={`${vid.id}_${idx}`}
                  video={vid}
                />
              ))}
            </div>

            {/* Infinite Scroll Sentinel & Loading Indicator */}
            <div ref={observerTargetRef} className="pt-6 pb-12 flex flex-col items-center justify-center">
              {loadingMore ? (
                <div className="flex items-center gap-2 text-gray-400 text-xs sm:text-sm py-2">
                  <Loader2 className="w-4 h-4 text-[#e50914] animate-spin" />
                  <span>Memuat film lainnya...</span>
                </div>
              ) : hasMore ? (
                <button
                  disabled={loadingMore}
                  onClick={handleLoadMore}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#131622] hover:bg-white/10 text-gray-200 text-xs sm:text-sm font-medium border border-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                  <span>Muat Lebih Banyak</span>
                </button>
              ) : (
                <p className="text-xs text-gray-500">
                  Semua film telah ditampilkan
                </p>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function HomePageSkeleton() {
  return (
    <div className="min-h-screen flex flex-col bg-[#090a0f] text-white">
      <Navbar />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 space-y-5">
        <div className="h-9 w-48 rounded-lg bg-[#131622] animate-shimmer" />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
          {Array.from({ length: 12 }).map((_, idx) => (
            <div key={idx} className="aspect-[2/3] rounded-lg bg-[#131622] animate-shimmer" />
          ))}
        </div>
      </main>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<HomePageSkeleton />}>
      <HomeContent />
    </Suspense>
  );
}
