import { normalizeSources } from './playback.js';

const BASE_URL = process.env.CINEFLOW_BASE_URL || 'https://ngintipya2.cineflow.my.id/';

// Persist token & cache state across Next.js route workers and HMR reloads
const globalState = globalThis.__cineflowState || (globalThis.__cineflowState = {
  currentAccessToken: null,
  currentRefreshToken: (process.env.CINEFLOW_REFRESH_TOKEN || '').trim(),
  lastEnvRefreshToken: (process.env.CINEFLOW_REFRESH_TOKEN || '').trim(),
  lastTokenError: null,
  refreshPromise: null,
  memoryCache: new Map(),
  inFlightRequests: new Map(),
});

const envRefreshToken = (process.env.CINEFLOW_REFRESH_TOKEN || '').trim();
if (envRefreshToken && globalState.lastEnvRefreshToken !== envRefreshToken) {
  globalState.currentRefreshToken = envRefreshToken;
  globalState.lastEnvRefreshToken = envRefreshToken;
  globalState.currentAccessToken = null;
  globalState.lastTokenError = null;
}

// In-memory cache map with TTL
const memoryCache = globalState.memoryCache;
const inFlightRequests = globalState.inFlightRequests;

function getCached(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    return null;
  }
  return item.value;
}

function getStaleCached(key) {
  const item = memoryCache.get(key);
  return item && Date.now() - item.expiry < 900000 ? item.value : null;
}

function setCached(key, value, ttlSeconds = 180) {
  if (memoryCache.size >= 500 && !memoryCache.has(key)) memoryCache.delete(memoryCache.keys().next().value);
  memoryCache.set(key, {
    value,
    expiry: Date.now() + ttlSeconds * 1000,
  });
}

/**
 * Deduplicate simultaneous in-flight requests for the exact same cache key
 */
async function dedupeRequest(key, fn) {
  const cached = getCached(key);
  if (cached !== null) return cached;

  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key);
  }

  const promise = (async () => {
    try {
      return await fn();
    } finally {
      inFlightRequests.delete(key);
    }
  })();

  inFlightRequests.set(key, promise);
  return promise;
}

// Global request pacing to avoid bursting CineFlow API limits
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 80;

async function throttleRequest() {
  const now = Date.now();
  const diff = now - lastRequestTime;
  if (diff < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - diff));
  }
  lastRequestTime = Date.now();
}

const DEFAULT_INSTANCE_ID = process.env.CINEFLOW_INSTANCE_ID || '6897260a4809cd3e';

/**
 * Check if a response indicates token expiration
 */
function isTokenExpired(resData, status) {
  if (status === 401) return true;
  if (!resData) return false;
  const msg = typeof resData === 'string' ? resData : String(resData.message || resData.error || '');
  return (
    msg.includes('access_token_expired') ||
    msg.includes('access_token_required') ||
    msg.includes('token_expired') ||
    msg.includes('token_invalid') ||
    msg.includes('Unauthorized') ||
    msg.includes('Unauthenticated') ||
    resData.code === 401
  );
}

/**
 * Refresh access token using refresh_token & app_instance_id
 */
export async function refreshAccessToken() {
  if (globalState.refreshPromise) return globalState.refreshPromise;

  globalState.refreshPromise = (async () => {
    if (!globalState.currentRefreshToken) {
      globalState.lastTokenError = 'Token belum dipasang (CINEFLOW_REFRESH_TOKEN kosong).';
      globalState.refreshPromise = null;
      return false;
    }
    try {
      const res = await fetch(`${BASE_URL}api/app/auth/refresh-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          refresh_token: globalState.currentRefreshToken,
          app_instance_id: DEFAULT_INSTANCE_ID,
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      });

      const json = await res.json();
      if (res.ok && json.data?.token_info) {
        const info = json.data.token_info;
        if (info.access_token) {
          globalState.currentAccessToken = info.access_token;
          if (info.refresh_token) globalState.currentRefreshToken = info.refresh_token;
          globalState.lastTokenError = null;
          console.log('[CineFlow] Access token refreshed successfully.');
          return true;
        }
      }
      const errMsg = json?.message || `HTTP ${res.status}`;
      if (errMsg === 'refresh_token_user_suspended') {
        globalState.lastTokenError = 'Token tidak bisa dipakai: Akun CineFlow di-suspend (refresh_token_user_suspended). Silakan ganti CINEFLOW_REFRESH_TOKEN baru.';
      } else if (errMsg === 'refresh_token_invalid' || errMsg === 'refresh_token_expired' || res.status === 401) {
        globalState.lastTokenError = `Token tidak bisa dipakai: Token tidak valid atau kedaluwarsa (${errMsg}). Silakan ganti CINEFLOW_REFRESH_TOKEN baru.`;
      } else {
        globalState.lastTokenError = `Token tidak bisa dipakai (${errMsg}).`;
      }
      console.warn('[CineFlow] Refresh token failed:', res.status, JSON.stringify(json));
      return false;
    } catch (e) {
      console.error('Failed to refresh CineFlow token:', e);
      return false;
    } finally {
      globalState.refreshPromise = null;
    }
  })();

  return globalState.refreshPromise;
}

/**
 * Perform authenticated request to CineFlow with automatic 401 refresh and 429 backoff
 */
export async function cineflowRequest(endpoint, options = {}) {
  const signal = AbortSignal.timeout(18000);
  // Pacing throttle to prevent bursts
  await throttleRequest();

  // If no access token yet, refresh first
  let alreadyTriedRefresh = false;
  if (!globalState.currentAccessToken) {
    alreadyTriedRefresh = true;
    await refreshAccessToken();
  }

  const url = `${BASE_URL}${endpoint}`;
  const method = options.method || 'GET';
  
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...(globalState.currentAccessToken ? { 'Authorization': `Bearer ${globalState.currentAccessToken}` } : {}),
    ...(options.headers || {}),
  };

  let res = await fetch(url, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
    signal,
  });

  let data;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  // If token expired, refresh and retry once
  if (!alreadyTriedRefresh && isTokenExpired(data, res.status)) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${globalState.currentAccessToken}`;
      await throttleRequest();
      res = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
    signal,
      });
      const retryText = await res.text();
      try {
        data = JSON.parse(retryText);
      } catch {
        data = retryText;
      }
    }
  }

  // If rate-limited (429), back off with randomized jitter to prevent simultaneous retry storms
  if (res.status === 429 || data?.code === 429) {
    const jitter1 = 1500 + Math.floor(Math.random() * 1200); // 1.5s - 2.7s
    console.warn(`[CineFlow] Rate limit 429 on ${endpoint}. Retrying after ${jitter1}ms backoff...`);
    await new Promise((r) => setTimeout(r, jitter1));
    await throttleRequest();
    res = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
    signal,
    });
    const retryText = await res.text();
    try {
      data = JSON.parse(retryText);
    } catch {
      data = retryText;
    }

    if (res.status === 429 || data?.code === 429) {
      const jitter2 = 2800 + Math.floor(Math.random() * 1500); // 2.8s - 4.3s
      console.warn(`[CineFlow] Rate limit 429 on ${endpoint} (attempt 2). Retrying after ${jitter2}ms...`);
      await new Promise((r) => setTimeout(r, jitter2));
      await throttleRequest();
      res = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
    signal,
      });
      const thirdText = await res.text();
      try {
        data = JSON.parse(thirdText);
      } catch {
        data = thirdText;
      }
    }
  }

  return { status: res.status, ok: res.ok, data };
}

/**
 * Fetch available movie models / sources (cached for 10 min)
 */
function requireResult({ data, ok, status }) {
  if (!ok || data?.success === false || Number(data?.code) >= 400 || !data || typeof data !== 'object') {
    if ((status === 401 || status === 403 || isTokenExpired(data, status)) && globalState.lastTokenError) {
      throw new Error(globalState.lastTokenError);
    }
    const message = status === 429 ? 'Server sedang sibuk. Coba lagi sebentar.' : 'Sumber sedang tidak tersedia. Silakan coba lagi.';
    throw new Error(message);
  }
  return data;
}

export async function getSources() {
  const cacheKey = 'sources';
  return dedupeRequest(cacheKey, async () => {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const data = requireResult(await cineflowRequest('api/modelles/models'));
    let rawList = [];
    if (Array.isArray(data?.data)) {
      rawList = data.data;
    } else if (Array.isArray(data?.data?.data)) {
      rawList = data.data.data;
    }

    const list = rawList.filter(Boolean).map((item, idx) => ({
      id: item.id || item.slug || item.model_id || String(idx),
      name: item.name || item.title || 'Sumber',
      contentType: item.content_type || 'movie_tv',
    }));

    if (list.length > 0) {
      setCached(cacheKey, list, 600);
    }
    return list;
  });
}

/**
 * Fetch categories for a specific source (cached for 10 min with in-flight deduplication)
 */
export async function getCategories(modelId) {
  const cacheKey = `categories:${modelId}`;
  return dedupeRequest(cacheKey, async () => {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const data = requireResult(await cineflowRequest(`api/modelles/categories?model_id=${encodeURIComponent(modelId)}`));
    let rawList = [];
    if (Array.isArray(data?.data)) {
      rawList = data.data;
    } else if (Array.isArray(data?.data?.data)) {
      rawList = data.data.data;
    }

    const list = rawList.map((c, idx) => ({
      id: c.id !== undefined ? String(c.id) : String(idx),
      name: c.name || c.title || String(c.id),
    }));

    if (list.length > 0) {
      setCached(cacheKey, list, 600); // Cache for 10 min
    }
    return list;
  });
}

/**
 * Filter out unwanted broadcast / announcement / system news cards
 */
function isExcludedVideo(item) {
  if (!item) return true;
  const id = String(item.id || item.key || '').toLowerCase();
  const title = String(item.title || item.name || '').toLowerCase();
  const type = String(item.type || '').toLowerCase();

  if (
    id === 'news-cineflow' ||
    id.startsWith('news-cineflow') ||
    type === 'news' ||
    title.includes('news cineflow') ||
    title.includes('berita & update cineflow')
  ) {
    return true;
  }
  return false;
}

/**
 * Fetch videos with pagination (cached for 2 min with in-flight deduplication)
 */
export async function getVideos({ modelId, categoryId = '', page = 1 }) {
  let activeCatId = categoryId;

  // Auto-resolve category ID if missing (since CineFlow server requires category_id)
  if (!activeCatId) {
    try {
      const cats = await getCategories(modelId);
      if (Array.isArray(cats) && cats.length > 0) {
        if (modelId === 'CineTv') {
          activeCatId = cats.find(c => c.id === 'ID')?.id || cats[0].id;
        } else {
          activeCatId = cats[0].id;
        }
      }
    } catch (e) {
      console.warn('Failed to auto-fetch first category in getVideos:', e);
    }
  }

  const cacheKey = `videos:${modelId}:${activeCatId}:${page}`;
  return dedupeRequest(cacheKey, async () => {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    let endpoint = `api/modelles/videos?model_id=${encodeURIComponent(modelId)}&page=${page}`;
    if (activeCatId) {
      endpoint += `&category_id=${encodeURIComponent(activeCatId)}`;
    }

    const { data, ok, status } = await cineflowRequest(endpoint);

    const hasDetailModules =
      Array.isArray(data?.detail?.modules) && data.detail.modules.length > 0;

    // If rate-limited or error (without usable fallback modules), check stale cache
    if ((!ok && !hasDetailModules) || status === 429 || data?.code === 429) {
      const stale = getStaleCached(cacheKey);
      if (stale && Array.isArray(stale.videos) && stale.videos.length > 0) {
        console.warn(`[CineFlow] Serving stale cached videos for ${cacheKey} due to status ${status}`);
        return stale;
      }
      const errMsg =
        (data && (data.message || data.error)) ||
        (status === 429
          ? 'Server CineFlow sedang sibuk (Rate Limit). Silakan coba lagi sebentar.'
          : 'Gagal mengambil daftar film dari server.');
      throw new Error(errMsg);
    }

    const resultVideos = [];
    const seenIds = new Set();
    let rootData = data?.data;

    const pushItem = (raw, fallbackId) => {
      if (!raw || isExcludedVideo(raw)) return;
      const vidId = String(raw.key || raw.cid || raw.id || raw.slug || fallbackId);
      if (!vidId || seenIds.has(vidId)) return;
      seenIds.add(vidId);

      const rawType = typeof raw.type === 'string' ? raw.type : '';
      const resolvedType =
        rawType || (modelId === 'CineTv' ? 'live' : raw.episode_id > 1 ? 'series' : 'movie');

      resultVideos.push({
        id: vidId,
        title: raw.title || raw.name || 'Tanpa Judul',
        poster:
          raw.img_list?.img_v ||
          raw.cover ||
          raw.cover_url ||
          raw.poster ||
          raw.pic ||
          raw.img_list?.img_h ||
          raw.thumbnail ||
          '',
        type: resolvedType,
        modelId,
      });
    };

    if (rootData) {
      let arr = null;

      if (Array.isArray(rootData)) {
        arr = rootData;
      } else if (Array.isArray(rootData.data)) {
        arr = rootData.data;
      } else if (rootData.items || rootData.module_type) {
        arr = Array.isArray(rootData.items) ? rootData.items : [rootData];
      }

      if (arr) {
        for (let i = 0; i < arr.length; i++) {
          const item = arr[i];
          if (Array.isArray(item?.items)) {
            for (let j = 0; j < item.items.length; j++) {
              pushItem(item.items[j], `${i}_${j}`);
            }
          } else {
            pushItem(item, String(i));
          }
        }
      }
    } else if (hasDetailModules) {
      // Fallback for upstream wrapper errors (e.g. WeTV API error) that still include modules payload
      for (let i = 0; i < data.detail.modules.length; i++) {
        const mod = data.detail.modules[i];
        if (Array.isArray(mod?.items)) {
          for (let j = 0; j < mod.items.length; j++) {
            pushItem(mod.items[j], `${i}_${j}`);
          }
        }
      }
    }

    const isLiveTv =
      modelId === 'CineTv' ||
      rootData?.module_type === 'live_tv' ||
      rootData?.type === 'Live TV' ||
      rootData?.type === 'ID';

    // Determine if there are more pages
    let hasMore = false;
    let lastPage = 1;

    if (isLiveTv) {
      // Live TV channels have no pagination - all channels returned in single page
      hasMore = false;
      lastPage = 1;
    } else if (hasDetailModules && !rootData) {
      hasMore = Boolean(data.detail.has_next_page) && resultVideos.length > 0 && Number(page) < 8;
      lastPage = hasMore ? Number(page) + 1 : Number(page);
    } else if (rootData?.total_pages !== undefined) {
      lastPage = Math.max(1, Number(rootData.total_pages));
      hasMore = Number(page) < lastPage;
    } else if (rootData?.last_page !== undefined) {
      lastPage = Math.max(1, Number(rootData.last_page));
      hasMore = Number(page) < lastPage;
    } else if (rootData?.has_more !== undefined) {
      hasMore = Boolean(rootData.has_more);
      lastPage = hasMore ? Number(page) + 1 : Number(page);
    } else {
      // Models that don't return pagination metadata:
      // Stop pagination if fewer than 15 items were returned or page >= 8 to prevent infinite 429 loops
      hasMore = resultVideos.length >= 15 && Number(page) < 8;
      lastPage = hasMore ? Number(page) + 1 : Number(page);
    }

    const result = {
      videos: resultVideos,
      currentPage: Number(page),
      lastPage,
      hasMore,
    };

    if (resultVideos.length > 0) {
      // Cache page 1 for 5 minutes, subsequent pages for 3 minutes
      const ttl = Number(page) === 1 ? 300 : 180;
      setCached(cacheKey, result, ttl);
    }

    return result;
  });
}

/**
 * Fetch movie or series detail (cached for 3 min with in-flight deduplication)
 */
export async function getMovieDetail(modelId, id) {
  if (isExcludedVideo({ id })) {
    return {
      id: String(id),
      modelId: String(modelId),
      title: 'Tidak Tersedia',
      synopsis: 'Konten pengumuman ini telah disembunyikan.',
      poster: '',
      type: 'movie',
      rating: null,
      year: null,
      duration: null,
      genres: [],
      seasons: [],
      playId: null,
    };
  }

  const cacheKey = `detail:${modelId}:${id}`;
  return dedupeRequest(cacheKey, async () => {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const data = requireResult(await cineflowRequest(`api/modelles/detail?model_id=${encodeURIComponent(modelId)}&id=${encodeURIComponent(id)}`));
    const raw = data?.data || data;

    const genres = [];
    if (Array.isArray(raw?.genres)) {
      for (const g of raw.genres) {
        if (typeof g === 'string') {
          g.split(/[,/•|]/).forEach(p => p.trim() && genres.push(p.trim()));
        } else if (g?.name) {
          genres.push(String(g.name).trim());
        }
      }
    } else if (typeof raw?.genre === 'string') {
      raw.genre.split(/[,/•|]/).forEach(p => p.trim() && genres.push(p.trim()));
    }

    // Parse seasons and episodes
    const seasons = [];
    if (Array.isArray(raw?.seasons)) {
      raw.seasons.filter(Boolean).forEach((s, sIdx) => {
        const episodes = [];
        if (Array.isArray(s.episodes)) {
          s.episodes.filter(Boolean).forEach((ep, eIdx) => {
            episodes.push({
              id: String(ep.id || ep.episode_id || eIdx),
              num: ep.number || ep.episode_number || ep.num || eIdx + 1,
              title: ep.title || ep.name || `Episode ${ep.num || eIdx + 1}`,
              videoUrl: ep.video_url || ep.stream_url || ep.url || '',
              thumbnail: ep.cover || ep.cover_url || ep.poster || ep.thumbnail || raw?.cover_url || raw?.cover || raw?.poster || '',
              duration: ep.duration || ep.runtime || '',
            });
          });
        }
        seasons.push({
          id: String(s.id || sIdx),
          name: s.name || s.title || `Season ${sIdx + 1}`,
          episodes,
        });
      });
    }

    const isLiveTv = modelId === 'CineTv' || raw?.type === 'Live TV' || raw?.module_type === 'live_tv';

    const result = {
      id: String(id),
      modelId: String(modelId),
      title: raw?.title || raw?.name || 'Tanpa Judul',
      synopsis: raw?.synopsis || raw?.description || raw?.overview || (isLiveTv ? 'Siaran Langsung Televisi (Live TV).' : 'Tidak ada sinopsis.'),
      poster: raw?.cover_url || raw?.cover || raw?.poster || raw?.thumbnail || '',
      type: isLiveTv ? 'live' : (raw?.type || (seasons.length > 0 ? 'tv' : 'movie')),
      rating: raw?.rating || raw?.vote_average || null,
      year: raw?.year || String(raw?.release_date || '').substring(0, 4) || null,
      duration: raw?.duration || raw?.runtime || (isLiveTv ? 'LIVE' : null),
      genres,
      seasons: isLiveTv ? [] : seasons,
      playId: raw?.play_id || raw?.anchor_play_id || null,
    };

    if (raw && (raw.title || raw.name || seasons.length > 0 || isLiveTv)) {
      setCached(cacheKey, result, 180);
    }

    return result;
  });
}

/**
 * Fetch video streaming sources, subtitles & headers with multi-tier fallback
 */
export async function getMovieSource(modelId, id, episodeId = '') {
  let targetEpisodeId = episodeId;
  let fallbackDirectUrl = '';
  const cachedDetail = getCached(`detail:${modelId}:${id}`);
  if (episodeId && cachedDetail) {
    fallbackDirectUrl = cachedDetail.seasons.flatMap((season) => season.episodes)
      .find((episode) => String(episode.id) === String(episodeId))?.videoUrl || '';
  }

  // 1. CineTv / IPTV play_id resolution directly from id
  if (modelId === 'CineTv' || id.startsWith('bittvd_') || id.startsWith('bittv:')) {
    if (!targetEpisodeId) {
      if (id.startsWith('bittvd_')) {
        try {
          const rawB64 = id.substring(7);
          const jsonStr = Buffer.from(rawB64, 'base64').toString('utf8');
          const json = JSON.parse(jsonStr);
          if (json.cc && json.cid) {
            targetEpisodeId = `bittv:${json.cc}:${json.cid}`;
          }
        } catch {}
      } else if (id.startsWith('bittv:')) {
        targetEpisodeId = id;
      }
    }
  }

  // 2. Auto-resolve episode ID and fallback videoUrl from detail
  if (!targetEpisodeId) {
    try {
      const detail = await getMovieDetail(modelId, id);
      if (detail?.playId) {
        targetEpisodeId = detail.playId;
      } else {
        const seasons = detail?.seasons || [];
        const episodes = seasons.flatMap((season) => season.episodes || []);
        const matchedEp = episodes.find((episode) => String(episode.id) === String(id)) || episodes[0];

        if (matchedEp) {
          targetEpisodeId = matchedEp.id;
          if (matchedEp.videoUrl) fallbackDirectUrl = matchedEp.videoUrl;
        }
      }
    } catch (e) {
      console.warn('Failed to resolve episode from detail in getMovieSource:', e);
    }
  }

  let endpoint = `api/modelles/source?model_id=${encodeURIComponent(modelId)}&id=${encodeURIComponent(id)}`;
  if (targetEpisodeId) {
    endpoint += `&episode_id=${encodeURIComponent(targetEpisodeId)}`;
  }

  let result;
  try { result = await cineflowRequest(endpoint); }
  catch (error) {
    if (fallbackDirectUrl) return normalizeSources({ url: fallbackDirectUrl });
    throw error;
  }
  let { data } = result;

  // If failed with missing params and targetEpisodeId wasn't set, try id as episode_id
  if ((!data || data?.code === 400 || data?.status === 400) && !targetEpisodeId) {
    const fallbackEndpoint = `api/modelles/source?model_id=${encodeURIComponent(modelId)}&id=${encodeURIComponent(id)}&episode_id=${encodeURIComponent(id)}`;
    const retry = await cineflowRequest(fallbackEndpoint);
    if (retry.data && retry.data.code !== 400) {
      data = retry.data;
      result = retry;
    }
  }

  const normalized = normalizeSources(data?.data || data);
  if (!normalized.streams.length && fallbackDirectUrl) {
    return normalizeSources({ streams: [{ url: fallbackDirectUrl }], subtitles: normalized.subtitles });
  }
  requireResult(result);
  return normalized;
}

const ADULT_KEYWORDS = [
  'jan dara', 'hentai', 'ecchi', '18+', 'r-18', 'r18', 'erotic', 'erotika', 'erotis',
  'film semi', 'semi barat', 'semi korea', 'semi jepang', 'semi asia', 'semi mandarin',
  'bokep', 'porn', 'porno', 'jav', 'uncensored jav', 'mature 18', 'adult only', 'dewasa 18',
  'sho-bitch', 'shobitch', 'midara na', 'shimoneta', 'yosuga no sora', 'aki sora',
  'kiss x sis', 'red light bandung', 'red light bali', 'interspecies reviewers'
];

function isAdultContent(title, id = '') {
  const text = `${title || ''} ${id || ''}`.toLowerCase();
  return ADULT_KEYWORDS.some((kw) => text.includes(kw));
}

function calculateRelevanceScore(title, query) {
  const cleanQ = (query || '').toLowerCase().trim();
  const compactQ = cleanQ.replace(/[^a-z0-9]/g, '');
  const cleanT = (title || '').toLowerCase().trim();
  const compactT = cleanT.replace(/[^a-z0-9]/g, '');

  if (!compactQ || !compactT) return 0;
  if (compactT === compactQ) return 100;
  if (compactT.startsWith(compactQ)) return 95;
  if (compactT.includes(compactQ)) return 85;

  const qTokens = cleanQ.split(/\s+/).filter((t) => t.length > 1);
  if (qTokens.length > 0) {
    const matchedTokens = qTokens.filter((t) => cleanT.includes(t));
    if (matchedTokens.length === qTokens.length) return 75;
    if (matchedTokens.length / qTokens.length >= 0.6) return 50;
  }
  return 0;
}

/**
 * Search videos across models with strict relevance and safe-search filtering
 */
export async function searchCineflow(query, page = 1) {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery) {
    return { videos: [], currentPage: 1 };
  }

  const cacheKey = `search:${cleanQuery.toLowerCase()}:${page}`;
  return dedupeRequest(cacheKey, async () => {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const contentTypes = ['movie_tv', 'short_drama'];
    const rawVideos = [];
    let successfulSearches = 0;
    const seenIds = new Set();

    for (const ct of contentTypes) {
      try {
        const response = await cineflowRequest('api/modelles/search', {
          method: 'POST',
          body: {
            q: cleanQuery,
            page: Number(page),
            content_type: ct,
          },
        });

        const data = requireResult(response);
        successfulSearches++;
        const rootData = data?.data;
        const list = Array.isArray(rootData)
          ? rootData
          : Array.isArray(rootData?.items)
          ? rootData.items
          : Array.isArray(rootData?.data)
          ? rootData.data
          : [];

        for (const item of list.filter(Boolean)) {
          const id = item.id || item.slug || item.key;
          if (!id || seenIds.has(id)) continue;
          if (isExcludedVideo(item)) continue;
          seenIds.add(id);

          let detectedModelId = item.model_id;
          if (!detectedModelId && typeof id === 'string' && id.includes(':')) {
            const parts = id.split(':');
            if (parts.length > 1) detectedModelId = parts[0];
          }

          rawVideos.push({
            id,
            title: item.title || item.name || 'Tanpa Judul',
            poster: item.cover || item.cover_url || item.poster || item.thumbnail || '',
            type: item.type || (ct === 'short_drama' ? 'short_drama' : 'movie'),
            modelId: detectedModelId || 'moviebox',
          });
        }
      } catch (e) {
        console.warn(`Search error on content_type ${ct}:`, e.message);
      }
    }

    if (!successfulSearches) throw new Error('Pencarian gagal terhubung ke server. Silakan coba lagi.');

    // Check if user explicitly searched for an adult keyword
    const userSearchedAdult = isAdultContent(cleanQuery);

    // Apply strict matching & adult content filtering
    const filteredVideos = rawVideos
      .filter((v) => {
        // Filter out adult/erotic content unless explicitly searched by user
        if (!userSearchedAdult && isAdultContent(v.title, v.id)) {
          return false;
        }
        return true;
      })
      .map((v) => ({
        ...v,
        relevanceScore: calculateRelevanceScore(v.title, cleanQuery),
      }))
      // Filter out irrelevant noise returned by loose upstream search
      .filter((v) => v.relevanceScore >= 50)
      // Sort best matches to the top
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .map(({ relevanceScore, ...rest }) => rest);

    const result = {
      videos: filteredVideos,
      currentPage: Number(page),
    };

    if (filteredVideos.length > 0) {
      setCached(cacheKey, result, 180); // Cache for 3 minutes
    }

    return result;
  });
}
