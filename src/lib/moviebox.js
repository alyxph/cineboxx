import crypto from 'crypto';
import { normalizeSources } from './playback.js';
import { isHlsPlaybackAvailable } from './hls-gateway.js';
import { movieboxQualities, isHevcSource } from './transcode-sources.js';
import { tabSubjects, catalogItems } from './moviebox-tabs.js';

const GATEWAY_SECRET_ONLINE = '76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O';
const BASE_URL = 'https://apig.inmoviebox.com';

// Global state to persist token across serverless invocations and dev reloads
const globalMovieboxState = globalThis.__movieboxState || (globalThis.__movieboxState = {
  token: null,
  userId: null,
  tokenExpiry: 0,
  visitorPromise: null,
  cache: new Map(),
  inFlight: new Map(),
});

const cache = globalMovieboxState.cache;
const inFlight = globalMovieboxState.inFlight;

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCached(key, value, ttlSeconds = 300) {
  if (cache.size >= 500 && !cache.has(key)) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, {
    value,
    expiry: Date.now() + ttlSeconds * 1000,
  });
}

async function dedupe(key, fn) {
  const cached = getCached(key);
  if (cached !== null) return cached;
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

function md5Hex(data) {
  if (!data) return '';
  return crypto.createHash('md5').update(data).digest('hex');
}

function generateClientToken() {
  const ts = Date.now().toString();
  const reversedTs = ts.split('').reverse().join('');
  return `${ts},${md5Hex(reversedTs)}`;
}

function generateTrSignature(method, urlStr, bodyData = '', timestamp = Date.now()) {
  const parsed = new URL(urlStr);
  const path = parsed.pathname;
  const entries = Array.from(parsed.searchParams.entries());
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const queryStr = entries.map(([k, v]) => `${k}=${v}`).join('&');
  const resource = queryStr ? `${path}?${queryStr}` : path;

  const bodyForMd5 = bodyData ? bodyData.slice(0, 0x19000) : '';
  const bodyMd5 = bodyData ? md5Hex(bodyForMd5) : '';

  const canonicalString = [
    method.toUpperCase(),
    'application/json',
    'application/json;charset=UTF-8',
    bodyData ? String(Buffer.byteLength(bodyData)) : '',
    String(timestamp),
    bodyMd5,
    resource,
  ].join('\n');

  const key = Buffer.from(GATEWAY_SECRET_ONLINE, 'base64');
  return `${timestamp}|2|${crypto.createHmac('md5', key).update(canonicalString).digest('base64')}`;
}

function getDeviceClientInfo() {
  globalMovieboxState.deviceId ||= '86820305' + crypto.randomInt(1000000, 10000000);
  return {
    package_name: 'com.community.oneroom',
    version_name: '4.0.02',
    version_code: 50020126,
    os: 'android',
    os_version: '14',
    install_ch: 'ps',
    device_id: globalMovieboxState.deviceId,
    install_store: 'ps',
    gaid: '',
    brand: 'Google',
    model: 'Pixel 6',
    system_language: 'en',
    net: 'wifi',
    region: 'IN',
    timezone: 'Asia/Kolkata',
    sp_code: '404',
  };
}

/**
 * Acquire fresh visitor / guest token or user account token from MovieBox API
 */
export async function getVisitorToken(force = false) {
  // Direct token override from environment variable
  const envToken = (process.env.MOVIEBOX_TOKEN || '').trim();
  if (force) {
    globalMovieboxState.rejectedEnvToken = envToken;
    globalMovieboxState.token = null;
    globalMovieboxState.tokenExpiry = 0;
  }
  if (envToken && !force && envToken !== globalMovieboxState.rejectedEnvToken) {
    globalMovieboxState.token = envToken;
    return envToken;
  }

  if (!force && globalMovieboxState.token && Date.now() < globalMovieboxState.tokenExpiry) {
    return globalMovieboxState.token;
  }
  if (globalMovieboxState.visitorPromise) {
    return globalMovieboxState.visitorPromise;
  }

  globalMovieboxState.visitorPromise = (async () => {
    globalMovieboxState.authFailure = null;
    try {
      const mbEmail = (process.env.MOVIEBOX_EMAIL || '').trim();
      const mbPass = (process.env.MOVIEBOX_PASSWORD || '').trim();

      // If user provided account credentials in .env, authenticate as real user
      if (mbEmail && mbPass) {
        try {
          const loginEndpoint = '/wefeed-mobile-bff/user-api/login';
          const loginUrl = new URL(`${BASE_URL}${loginEndpoint}`);
          loginUrl.searchParams.set('host', 'apig.inmoviebox.com');
          const loginBody = JSON.stringify({
            password: md5Hex(mbPass),
            package_name: 'com.community.oneroom',
            authType: 1,
            type: 0,
            mail: mbEmail,
          });
          const loginTs = Date.now();
          const loginSig = generateTrSignature('POST', loginUrl.toString(), loginBody, loginTs);
          const loginHeaders = {
            'User-Agent': 'MovieBox/4.0.02 (Android 14; Pixel 6)',
            'Accept': 'application/json',
            'Content-Type': 'application/json;charset=UTF-8',
            'X-M-Version': '4.0.02',
            'Referer': 'https://apig.inmoviebox.com/',
            'X-Sign-Version': '2.0',
            'X-Client-Token': generateClientToken(),
            'X-Client-Info': JSON.stringify(getDeviceClientInfo()),
            'X-Client-Status': '1',
            'X-Play-Mode': '2',
            'appid': '4U01pxRu278GqCZKY9',
            'region': 'IN',
            'lang': 'en',
            'os': 'android',
            'X-Timestamp': String(loginTs),
            'x-tr-signature': loginSig,
          };
          const loginRes = await fetch(loginUrl.toString(), {
            method: 'POST',
            headers: loginHeaders,
            body: loginBody,
            cache: 'no-store',
            signal: AbortSignal.timeout(10000),
          });
          const loginJson = await loginRes.json();
          if (loginRes.ok && [0, 200].includes(Number(loginJson.code)) && loginJson.data?.token) {
            globalMovieboxState.token = loginJson.data.token;
            globalMovieboxState.userId = String(loginJson.data.userId || loginJson.data.uid || '');
            globalMovieboxState.tokenExpiry = Date.now() + 14 * 24 * 60 * 60 * 1000;
            console.log('[MovieBox] Account login successful. User:', globalMovieboxState.userId);
            return globalMovieboxState.token;
          }
          console.warn('[MovieBox] Account login failed, falling back to visitor:', loginJson?.message || loginJson?.msg);
        } catch (authErr) {
          console.warn('[MovieBox] Account login error, falling back to visitor:', authErr.message);
        }
      }

      // Default visitor login
      const endpoint = '/wefeed-mobile-bff/user-api/visitor-login';
      const urlObj = new URL(`${BASE_URL}${endpoint}`);
      urlObj.searchParams.set('host', 'apig.inmoviebox.com');

      const ts = Date.now();
      const bodyStr = '{}';
      const sig = generateTrSignature('POST', urlObj.toString(), bodyStr, ts);

      const headers = {
        'User-Agent': 'MovieBox/4.0.02 (Android 14; Pixel 6)',
        'Accept': 'application/json',
        'Content-Type': 'application/json;charset=UTF-8',
        'X-M-Version': '4.0.02',
        'Referer': 'https://apig.inmoviebox.com/',
        'X-Sign-Version': '2.0',
        'X-Client-Token': generateClientToken(),
        'X-Client-Info': JSON.stringify(getDeviceClientInfo()),
        'X-Client-Status': '1',
        'X-Play-Mode': '2',
        'appid': '4U01pxRu278GqCZKY9',
        'region': 'IN',
        'lang': 'en',
        'os': 'android',
        'X-Timestamp': String(ts),
        'x-tr-signature': sig,
      };

      const res = await fetch(urlObj.toString(), {
        method: 'POST',
        headers,
        body: bodyStr,
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });

      const json = await res.json();
      if (res.ok && [0, 200].includes(Number(json.code)) && json.data?.token) {
        globalMovieboxState.token = json.data.token;
        globalMovieboxState.userId = String(json.data.userId || json.data.uid || '');
        // Cache token for 24 hours (tokens typically last 30 days)
        globalMovieboxState.tokenExpiry = Date.now() + 24 * 60 * 60 * 1000;
        console.log('[MovieBox] Visitor login successful. User:', globalMovieboxState.userId);
        return globalMovieboxState.token;
      }
      const code = /^\d+$/.test(String(json?.code)) ? Number(json.code) : undefined;
      const message = String(json?.message || json?.msg || '');
      const reason = /signature|signing/i.test(message) ? 'validasi signature'
        : /appid|appkey|app_id|app_key/i.test(message) ? 'identitas aplikasi'
          : /token|jwt|session/i.test(message) ? 'autentikasi'
            : /\bip\b|region|country|blocked/i.test(message) ? 'kebijakan akses' : '';
      globalMovieboxState.authFailure = { status: res.status, code, reason };
      console.warn('[MovieBox] Visitor login failed', globalMovieboxState.authFailure);
      return null;
    } catch (err) {
      globalMovieboxState.authFailure = { reason: ['TimeoutError', 'AbortError'].includes(err.name)
        ? 'timeout' : err instanceof SyntaxError ? 'respons non-JSON' : 'koneksi gagal' };
      console.error('[MovieBox] Visitor login error', globalMovieboxState.authFailure);
      return null;
    } finally {
      globalMovieboxState.visitorPromise = null;
    }
  })();

  return globalMovieboxState.visitorPromise;
}

/**
 * Send signed request to MovieBox API
 */
export async function movieboxRequest(method, endpoint, params = {}, body = null) {
  let token = await getVisitorToken();

  const makeCall = async (authToken) => {
    const urlObj = new URL(`${BASE_URL}${endpoint}`);
    urlObj.searchParams.set('host', 'apig.inmoviebox.com');
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        urlObj.searchParams.set(k, String(v));
      }
    }

    const bodyStr = body !== null ? JSON.stringify(body) : '';
    const ts = Date.now();
    const sig = generateTrSignature(method, urlObj.toString(), bodyStr, ts);

    const headers = {
      'User-Agent': 'MovieBox/4.0.02 (Android 14; Pixel 6)',
      'Accept': 'application/json',
      'Content-Type': 'application/json;charset=UTF-8',
      'X-M-Version': '4.0.02',
      'Referer': 'https://apig.inmoviebox.com/',
      'X-Sign-Version': '2.0',
      'X-Client-Token': generateClientToken(),
      'X-Client-Info': JSON.stringify(getDeviceClientInfo()),
      'X-Client-Status': authToken ? '0' : '1',
      'X-Play-Mode': '2',
      'appid': '4U01pxRu278GqCZKY9',
      'region': 'IN',
      'lang': 'en',
      'os': 'android',
      'X-Timestamp': String(ts),
      'x-tr-signature': sig,
      ...(authToken ? { 'token': authToken, 'authorization': `Bearer ${authToken}` } : {}),
    };

    let res;
    try {
      res = await fetch(urlObj.toString(), {
        method,
        headers,
        body: bodyStr || undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      });
    } catch (cause) {
      const timedOut = ['TimeoutError', 'AbortError'].includes(cause.name);
      throw Object.assign(new Error(timedOut
        ? 'MovieBox tidak merespons tepat waktu. Silakan coba lagi.'
        : 'Server tidak dapat terhubung ke MovieBox. Silakan coba lagi.'), { status: timedOut ? 504 : 502 });
    }
    let json;
    try { json = await res.json(); }
    catch (cause) {
      if (['TimeoutError', 'AbortError'].includes(cause.name)) {
        throw Object.assign(new Error('MovieBox tidak merespons tepat waktu. Silakan coba lagi.'), { status: 504 });
      }
      console.warn('[MovieBox] Invalid upstream response', { endpoint, status: res.status });
      throw Object.assign(new Error(`MovieBox mengirim respons tidak valid (HTTP ${res.status}).`), { status: 502 });
    }
    return { status: res.status, ok: res.ok, json };
  };

  let result = await makeCall(token);

  // If token expired, refresh and retry once
  if ([401, 403, 440].includes(Number(result.json?.code)) || [401, 403, 440].includes(result.status)) {
    console.warn('[MovieBox] Token rejected, re-authenticating visitor...');
    token = await getVisitorToken(true);
    if (!token) {
      const failure = globalMovieboxState.authFailure || {};
      const details = [failure.status ? `HTTP ${failure.status}` : '',
        failure.code !== undefined ? `kode ${failure.code}` : '', failure.reason || ''].filter(Boolean).join(', ');
      throw Object.assign(new Error(`Login tamu MovieBox gagal${details ? ` (${details})` : ''}.`), { status: 502 });
    }
    result = await makeCall(token);
  }

  const code = result.json?.code;
  if (!result.ok || !result.json || typeof result.json !== 'object' || Array.isArray(result.json) ||
      !Object.hasOwn(result.json, 'data') ||
      result.json.success === false ||
      (code !== undefined && ![0, 200].includes(Number(code)))) {
    const message = String(result.json?.message || result.json?.msg || '');
    const reason = /signature|signing/i.test(message) ? 'validasi signature'
      : /appid|appkey|app_id|app_key/i.test(message) ? 'identitas aplikasi'
        : /token|jwt|session/i.test(message) ? 'autentikasi'
          : /\bip\b|region|country|blocked/i.test(message) ? 'kebijakan akses' : '';
    // Never log response bodies or authorization headers: they may contain credentials.
    console.warn('[MovieBox] Upstream rejected request', { endpoint, status: result.status,
      code: typeof code === 'number' || (typeof code === 'string' && /^\d+$/.test(code)) ? code : undefined, reason });
    throw Object.assign(new Error(result.status === 429
      ? 'MovieBox membatasi permintaan. Coba lagi sesaat lagi.'
      : result.status === 440 || Number(code) === 440
        ? `MovieBox tetap menolak permintaan (440) setelah autentikasi diperbarui.${reason ? ` Alasan: ${reason}.` : ' Perlu pemeriksaan akses server ke MovieBox.'}`
        : `MovieBox menolak permintaan katalog (HTTP ${result.status}${code !== undefined && /^\d+$/.test(String(code)) ? `, kode ${code}` : ''}).`),
    { status: result.status === 429 ? 503 : 502 });
  }
  return result.json;
}

/**
 * Filter out anti-piracy trap dummy videos
 */
function isDummyNoticeUrl(url = '') {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes('notice.mp4') ||
    lower.includes('80da52722ee7de7a4303290af6783424') ||
    lower.includes('b164fbfb4347792950bdfbfb563d39d9') ||
    lower.includes('1c7de0bd3393702d9191801f15f88f8d') ||
    lower.includes('9a0461bc39da389663bf3dbb17091d3f') ||
    (lower.includes('macdn.aoneroom.com') && lower.includes('/other/'))
  );
}

/**
 * Strictly check if a URL is a playable media stream
 */
export function isValidMediaUrl(url = '') {
  if (!url || typeof url !== 'string') return false;
  const lower = url.trim().toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;
  if (isDummyNoticeUrl(lower)) return false;

  // Webpages and scrapper source links must never be fed to the video player
  if (
    lower.includes('.html') ||
    lower.includes('.htm') ||
    lower.includes('fzmovies') ||
    lower.includes('darkiworld') ||
    lower.includes('/tv-') ||
    lower.includes('/movie-') ||
    lower.includes('/episode-')
  ) {
    return false;
  }

  // Must have direct media format or originate from verified MovieBox CDNs
  const hasMediaExt =
    lower.includes('.mp4') ||
    lower.includes('.m3u8') ||
    lower.includes('.mpd') ||
    lower.includes('.mkv') ||
    lower.includes('.webm');

  const isVerifiedCdn =
    lower.includes('hakunaymatata.com') ||
    lower.includes('aoneroom.com') ||
    lower.includes('inmoviebox.com') ||
    lower.includes('sportslive.wine');

  return hasMediaExt || isVerifiedCdn;
}

/**
 * Available categories on MovieBox
 */
export function getMovieboxCategories() {
  return [
    { id: 'trending', name: 'Trending' },
    { id: 'film-indo', name: 'Film Indo' },
    { id: 'series-indo', name: 'Series Indo' },
    { id: 'komedi-indo', name: 'Komedi Indo' },
    { id: 'movie', name: 'Movies' },
    { id: 'tv', name: 'Series' },
    { id: 'anime', name: 'Anime' },
    { id: 'kids', name: 'Kids' },
  ];
}

function mapSubjectToVideo(item) {
  const info = item?.info || item?.subject || item || {};
  const sid = String(info.subjectId || info.id || '');
  if (!sid) return null;

  const poster =
    info.cover?.url ||
    (typeof info.cover === 'string' ? info.cover : '') ||
    info.poster?.url ||
    (typeof info.poster === 'string' ? info.poster : '') ||
    info.stills?.url ||
    '';

  const score = String(info.imdbRatingValue || info.score || info.starRating || '');
  const releaseDate = info.releaseDate || '';
  const year = releaseDate ? releaseDate.slice(0, 4) : '';
  const duration = info.duration || (info.durationSeconds ? `${Math.round(info.durationSeconds / 60)}m` : '');

  const title = info.title || info.name || 'Tanpa Judul';
  const { baseTitle } = splitTitleVersion(title);

  return {
    id: sid,
    title,
    canonicalTitle: baseTitle,
    poster,
    score: score && score !== '0' ? score : 'N/A',
    releaseDate,
    year,
    duration,
    modelId: 'Moviebox',
    type: info.subjectType === 2 ? 'tv' : 'movie',
  };
}

const VERSION_TAGS = new Set([
  'english', 'hindi', 'telugu', 'tamil', 'kannada', 'malayalam', 'bengali', 'urdu',
  'punjabi', 'arabic', 'tagalog', 'indonesian', 'russian', 'kurdish', 'spanish',
  'spanishlatam', 'portuguese', 'french', 'german', 'japanese', 'korean', 'thai',
  'filipino', 'malay', 'vietnamese', 'chinese', 'mandarin', 'cantonese', 'italian',
  'turkish', 'dutch', 'polish', 'esla', 'ptbr', 'original',
]);

function splitTitleVersion(title) {
  const fullTitle = String(title || '').trim();
  const match = fullTitle.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  if (!match) return { baseTitle: fullTitle, version: '' };

  const version = match[2].trim();
  const normalized = version.toLowerCase().replace(/\s+(dub|sub|audio)$/i, '').trim();
  const isVersionTag = VERSION_TAGS.has(normalized) || /\s+(dub|sub)$/i.test(version);
  if (!isVersionTag) return { baseTitle: fullTitle, version: '' };

  return { baseTitle: match[1].trim() || fullTitle, version };
}

function collapseVariantVideos(videos) {
  const byBaseTitle = new Map();
  for (const video of videos || []) {
    if (!video) continue;
    const { baseTitle, version } = splitTitleVersion(video.title);
    const key = baseTitle.toLowerCase();
    const normalized = { ...video, title: baseTitle || video.title, canonicalTitle: baseTitle || video.title };
    const existing = byBaseTitle.get(key);
    if (!existing || (version === '' && existing.version !== '')) {
      byBaseTitle.set(key, { ...normalized, version });
    }
  }
  return Array.from(byBaseTitle.values(), ({ version, ...video }) => video);
}

/**
 * Fetch Indonesian movies and series (filtered strictly by countryName: 'Indonesia' or language: 'Indonesian')
 */
export async function getIndonesianVideos(page = 1) {
  const cacheKey = 'mb_indonesia_pool_v2';
  const pool = await dedupe(cacheKey, async () => {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const seeds = [
      'Indonesia',
      'KKN',
      'Warkop',
      'Dilan',
      'Siksa',
      'Agak Laen',
      'The Raid',
      'Pengantin Setan',
      'Danur',
      'Sewu Dino',
      'Habibie',
      'Gundala',
    ];

    const responses = await Promise.all(
      seeds.map((term) =>
        movieboxRequest('POST', '/wefeed-mobile-bff/subject-api/search/v2', {}, {
          keyword: term,
          page: 1,
          perPage: 20,
          pageSize: 20,
          subjectType: 0,
          type: 0,
          q: term,
        }).catch(() => null)
      )
    );

    const seen = new Set();
    const indos = [];

    for (const res of responses) {
      if (!res?.data?.results) continue;
      for (const block of res.data.results) {
        for (const s of (block.subjects || [])) {
          if (!s?.subjectId || seen.has(s.subjectId)) continue;
          const country = String(s.countryName || s.country || '').toLowerCase();
          const lang = String(s.language || s.lang || '').toLowerCase();
          const isMovieOrTv = [1, 2].includes(s.subjectType);

          // Strictly filter for Indonesian content (countryName: 'Indonesia', language: 'Indonesian')
          if ((country.includes('indonesia') || lang.includes('indonesian')) && isMovieOrTv) {
            seen.add(s.subjectId);
            indos.push(s);
          }
        }
      }
    }

    // Prioritize movies (free visitor streams) over VIP series
    indos.sort((a, b) => (b.subjectType === 1 ? 1 : 0) - (a.subjectType === 1 ? 1 : 0));

    const mapped = collapseVariantVideos(indos.map(mapSubjectToVideo).filter(Boolean));
    if (mapped.length > 0) {
      setCached(cacheKey, mapped, 600); // Cache pool for 10 minutes
    }
    return mapped;
  });

  const perPage = 20;
  const startIndex = (page - 1) * perPage;
  const pageVideos = pool.slice(startIndex, startIndex + perPage);
  const hasMore = startIndex + perPage < pool.length;

  return {
    videos: pageVideos,
    page,
    hasMore,
  };
}

const DISCOVER_CATEGORY_FILTERS = {
  'film-indo': { subjectType: 1, country: 'Indonesia', language: 'Indonesian', sort: 'Latest' },
  'series-indo': { subjectType: 2, country: 'Indonesia', language: 'Indonesian', sort: 'Latest' },
  'komedi-indo': { subjectType: 1, country: 'Indonesia', genre: 'Comedy', language: 'Indonesian', sort: 'Latest' },
  'movie': { subjectType: 1, sort: 'Trending' },
  'tv': { subjectType: 2, sort: 'Trending' },
  'anime': { genre: 'Anime', sort: 'ForYou' },
  'western': { country: 'United States', sort: 'ForYou' },
};

/**
 * Fetch Asian movies and series (Korea, China, Thailand, Japan)
 */
export async function getAsianVideos(page = 1) {
  const cacheKey = `mb_asian_pool_v2_${page}`;
  return dedupe(cacheKey, async () => {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const countries = ['Korea', 'China', 'Thailand', 'Japan'];
    const responses = await Promise.all(
      countries.map((c) =>
        movieboxRequest('POST', '/wefeed-mobile-bff/subject-api/list', {}, {
          subjectType: 0,
          country: c,
          sort: 'ForYou',
          page,
          perPage: 10,
        }).catch(() => null)
      )
    );

    const seen = new Set();
    const items = [];

    for (const res of responses) {
      for (const item of (res?.data?.items || [])) {
        if (!item?.subjectId || seen.has(item.subjectId)) continue;
        if (![1, 2].includes(Number(item.subjectType))) continue;
        seen.add(item.subjectId);
        items.push(item);
      }
    }

    const videos = collapseVariantVideos(items.map(mapSubjectToVideo).filter(Boolean));
    const result = {
      videos,
      page,
      hasMore: videos.length >= 10,
    };

    if (videos.length > 0) {
      setCached(cacheKey, result, 300);
    }
    return result;
  });
}

/**
 * Fetch titles using MovieBox list filters (country, genre, language, subject type)
 */
export async function getMovieboxDiscover({
  subjectType = 0,
  country = '',
  genre = '',
  language = '',
  sort = 'ForYou',
  page = 1,
  perPage = 20,
} = {}) {
  const safePerPage = Math.min(Math.max(Number(perPage) || 20, 1), 20);
  const cacheKey = `mb_discover_v2_${subjectType}_${country}_${genre}_${language}_${sort}_${page}_${safePerPage}`.toLowerCase();
  return dedupe(cacheKey, async () => {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const payload = {
      page,
      perPage: safePerPage,
      subjectType: Number(subjectType) || 0,
      sort,
    };
    if (country) payload.country = country;
    if (genre) payload.genre = genre;

    const json = await movieboxRequest('POST', '/wefeed-mobile-bff/subject-api/list', {}, payload);
    const rawItems = catalogItems(json?.data);
    const languageNeedle = String(language).trim().toLowerCase();

    const filtered = rawItems.filter((item) => {
      if (![1, 2].includes(Number(item?.subjectType))) return false;
      if (!languageNeedle) return true;
      const itemLanguage = String(item?.language || '').trim().toLowerCase();
      return !itemLanguage || itemLanguage.includes(languageNeedle);
    });

    const seenIds = new Set();
    const uniqueVideos = [];
    for (const item of filtered) {
      const video = mapSubjectToVideo(item);
      if (!video || seenIds.has(video.id)) continue;
      seenIds.add(video.id);
      uniqueVideos.push(video);
    }
    const videos = collapseVariantVideos(uniqueVideos);
    const pager = json?.data?.pager || {};
    const hasMore = pager.hasMore !== undefined
      ? Boolean(pager.hasMore)
      : rawItems.length >= safePerPage;

    const result = { videos, page, hasMore };
    if (videos.length > 0) {
      setCached(cacheKey, result, 300);
    }
    return result;
  });
}

/**
 * Fetch video list for a category
 */
export async function getMovieboxVideos({ categoryId = 'trending', page = 1 } = {}) {
  if (categoryId === 'kids') {
    const kidsCacheKey = `mb_kids_tab23_v1_${page}`;
    return dedupe(kidsCacheKey, async () => {
      const json = await movieboxRequest('GET', '/wefeed-mobile-bff/tab-operating', {
        tabId: 23, page, pageSize: 50,
      });
      if (json?.code !== undefined && ![0, 200].includes(Number(json.code))) {
        throw new Error('Kategori Kids sedang tidak tersedia.');
      }
      const titles = tabSubjects(json?.data);
      const seen = new Set();
      const videos = collapseVariantVideos(titles.map(mapSubjectToVideo).filter((video) => {
        if (!video || seen.has(video.id)) return false;
        seen.add(video.id);
        return true;
      }));
      const result = { videos, page, hasMore: json?.data?.pager?.hasMore !== undefined
        ? Boolean(json.data.pager.hasMore) : titles.length >= 50 };
      if (videos.length) setCached(kidsCacheKey, result, 300);
      return result;
    });
  }
  if (categoryId === 'indonesia') {
    return getIndonesianVideos(page);
  }
  if (categoryId === 'asian') {
    return getAsianVideos(page);
  }

  const discoverFilter = DISCOVER_CATEGORY_FILTERS[categoryId];
  if (discoverFilter) {
    return getMovieboxDiscover({ ...discoverFilter, page });
  }

  const cacheKey = `mb_videos_v6_${categoryId}_${page}`;
  return dedupe(cacheKey, async () => {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const catMap = {
      trending: 'trending',
      movie: 'movie',
      tv: 'tv',
      anime: 'anime',
      asian: 'asian',
      western: 'western',
    };

    const type = catMap[categoryId] || 'trending';
    const json = await movieboxRequest('POST', '/wefeed-mobile-bff/subject-api/genre-top', {}, {
      type,
      page,
      perPage: 24,
    });

    const rawList = catalogItems(json?.data);
    const popularity = (item) => {
      const value = (item?.info || item?.subject || item)?.popularity;
      return value !== null && value !== undefined && value !== '' ? Number(value) : NaN;
    };
    // Use explicit popularity scores when supplied. Otherwise keep the provider's
    // Trending ranking, without substituting IMDb ratings or movie/series priority.
    const rankedList = type === 'trending' && rawList.every((item) => Number.isFinite(popularity(item)))
      ? [...rawList].sort((a, b) => popularity(b) - popularity(a))
      : rawList;
    const videos = collapseVariantVideos(rankedList.map(mapSubjectToVideo).filter(Boolean));

    const hasMore = json?.data?.pager?.hasMore !== undefined
      ? Boolean(json.data.pager.hasMore) : rawList.length >= 24;

    const result = { videos, page, hasMore };
    if (videos.length > 0) {
      setCached(cacheKey, result, 300);
    }
    return result;
  });
}

/**
 * Fetch movie or series detail
 */
export async function getMovieboxDetail(subjectId) {
  const cacheKey = `mb_detail_v4_${subjectId}`;
  return dedupe(cacheKey, async () => {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const json = await movieboxRequest('GET', '/wefeed-mobile-bff/subject-api/get', { subjectId });
    const data = json?.data;
    if (!data || !data.title) {
      throw new Error('Film Moviebox tidak ditemukan.');
    }

    const isSeries = data.subjectType === 2;
    let seasons = [];

    if (isSeries) {
      try {
        const sJson = await movieboxRequest('GET', '/wefeed-mobile-bff/subject-api/season-info', { subjectId });
        const rawSeasons = sJson?.data?.seasons || [];

        seasons = rawSeasons.map((s) => {
          const sNum = s.se || 1;
          let epList = [];

          if (s.allEp && typeof s.allEp === 'string' && s.allEp.trim()) {
            epList = s.allEp.split(',').map((x) => x.trim()).filter(Boolean);
          } else if (s.maxEp && Number(s.maxEp) > 0) {
            epList = Array.from({ length: Number(s.maxEp) }, (_, i) => String(i + 1));
          } else {
            epList = ['1'];
          }

          return {
            season: sNum,
            name: `Season ${sNum}`,
            episodes: epList.map((epNum) => ({
              id: `${subjectId}_${sNum}_${epNum}`,
              episode: Number(epNum) || 1,
              title: `Episode ${epNum}`,
            })),
          };
        });
      } catch (e) {
        console.warn('[MovieBox] Failed to fetch season-info:', e);
      }
    }

    if (seasons.length === 0) {
      seasons = [
        {
          season: 1,
          name: 'Season 1',
          episodes: [
            {
              id: String(subjectId),
              episode: 1,
              title: isSeries ? 'Episode 1' : 'Tonton Film',
            },
          ],
        },
      ];
    }

    const poster = data.cover?.url || data.poster?.url || data.stills?.url || '';
    const score = String(data.imdbRatingValue || data.score || '');
    const titleInfo = splitTitleVersion(data.title);

    const versions = [];
    const seenVersionIds = new Set();
    for (const dub of Array.isArray(data.dubs) ? data.dubs : []) {
      const versionId = String(dub?.subjectId || '');
      if (!versionId || seenVersionIds.has(versionId)) continue;
      seenVersionIds.add(versionId);
      versions.push({
        id: versionId,
        name: String(dub.lanName || dub.lanCode || 'Versi'),
        language: String(dub.lanCode || ''),
        original: Boolean(dub.original),
      });
    }
    if (versions.length === 0) {
      versions.push({
        id: String(subjectId),
        name: 'Original Audio',
        language: '',
        original: true,
      });
    }

    const genres = typeof data.genre === 'string'
      ? data.genre.split(',').map((s) => s.trim()).filter(Boolean)
      : (Array.isArray(data.genre) ? data.genre : []);
    const year = data.releaseDate ? String(data.releaseDate).slice(0, 4) : '';
    const rating = score && score !== '0' ? score : '';
    const desc = data.description?.trim() || (Array.isArray(data.explains) && data.explains.length > 0 ? data.explains.join('\n') : '') || data.aka || '';

    const result = {
      id: String(subjectId),
      title: titleInfo.baseTitle || data.title,
      description: desc,
      synopsis: desc,
      poster,
      score: rating || 'N/A',
      rating,
      releaseDate: data.releaseDate || '',
      year,
      genre: data.genre || '',
      genres,
      duration: data.duration || '',
      durationSeconds: Number(data.durationSeconds) || 0,
      type: isSeries ? 'tv' : 'movie',
      modelId: 'Moviebox',
      seasons,
      versions,
      rawDetail: data,
    };

    setCached(cacheKey, result, 600);
    return result;
  });
}

/**
 * Resolve streaming playback sources and subtitles for MovieBox
 */
export function parseDurationToSeconds(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val > 0 ? val : 0;
  const str = String(val).trim();
  if (/^\d+$/.test(str)) return Number(str);
  let total = 0;
  const h = str.match(/(\d+)\s*h/i);
  const m = str.match(/(\d+)\s*(m|min)/i);
  const s = str.match(/(\d+)\s*s/i);
  if (h) total += parseInt(h[1], 10) * 3600;
  if (m) total += parseInt(m[1], 10) * 60;
  if (s) total += parseInt(s[1], 10);
  return total;
}

export async function getMovieboxSource(subjectId, episodeId = '', _depth = 0) {
  let season = 1;
  let episode = 1;
  let isSeries = false;

  if (episodeId && episodeId.includes('_')) {
    const parts = episodeId.split('_');
    if (parts.length >= 3) {
      season = Number(parts[1]) || 1;
      episode = Number(parts[2]) || 1;
      isSeries = true;
    }
  }

  // 1. Get subject detail to discover resourceDetectors
  let resourceId = '';
  let detail = null;
  let mediaDuration = 0;
  const streams = [];
  const subtitles = [];
  const seenUrls = new Set();

  const addStream = (url, name, format, customHeaders = null, sourceCodec = null) => {
    if (!url) return;
    // Reject dummy preview/sample placeholder files (< 1MB samples)
    if (url.includes('macdn.aoneroom.com/other/') || url.includes('80da52722ee7de7a4303290af6783424')) {
      return;
    }

    const key = url + (customHeaders?.['x-transcode'] || '');
    if (seenUrls.has(key)) return;
    seenUrls.add(key);

    const streamHeaders = customHeaders || {
      'User-Agent': 'MovieBox/4.0.02 (Android 14; Pixel 6)',
    };

    const determinedCodec = sourceCodec || (isHevcSource({ name, url }) ? 'hevc' : 'h264');

    streams.push({
      url,
      name,
      format,
      headers: streamHeaders,
      sourceCodec: determinedCodec,
    });
  };

  try {
    detail = await getMovieboxDetail(subjectId);
    if (detail.type === 'tv') isSeries = true;
    if (!mediaDuration) {
      if (detail.rawDetail?.durationSeconds && Number(detail.rawDetail.durationSeconds) > 0) {
        mediaDuration = Number(detail.rawDetail.durationSeconds);
      } else if (detail.rawDetail?.duration) {
        mediaDuration = parseDurationToSeconds(detail.rawDetail.duration);
      }
    }
    const detectors = detail.rawDetail?.resourceDetectors || [];

    for (const det of detectors) {
      if (det.resourceId && !resourceId) resourceId = String(det.resourceId);
      if (det.duration && !mediaDuration) mediaDuration = parseDurationToSeconds(det.duration);

      // Check resolutionList in detectors if present (provides 1080p, 720p, 480p, 360p)
      if (Array.isArray(det.resolutionList)) {
        for (const rItem of det.resolutionList) {
          const rUrl = rItem.resourceLink || rItem.downloadUrl || rItem.url || '';
          if (isValidMediaUrl(rUrl)) {
            const resLabel = rItem.resolution ? `${rItem.resolution}p` : 'HD';
            const codecLabel = rItem.codecName ? ` (${rItem.codecName.toUpperCase()})` : '';
            addStream(
              rUrl,
              `${resLabel}${codecLabel}`,
              rUrl.includes('.m3u8') ? 'hls' : rUrl.includes('.mpd') ? 'dash' : 'mp4'
            );
          }
        }
      }

      // Check direct downloadUrl
      if (isValidMediaUrl(det.downloadUrl)) {
        const codecLabel = det.codecName ? ` (${det.codecName.toUpperCase()})` : '';
        addStream(
          det.downloadUrl,
          `Direct MP4${codecLabel}`,
          'mp4'
        );
      }
    }
  } catch (e) {
    console.warn('[MovieBox] Failed to inspect resourceDetectors:', e);
  }

  // 2. Query resource/v2 with isVip=true spoofing & cloud sniffing
  try {
    const rParams = {
      subjectId,
      page: 1,
      perPage: 20,
      all: 0,
      startPosition: 1,
      endPosition: 1,
      pagerMode: 2,
      resolution: 0,
      isVip: 'true',
    };
    if (isSeries) {
      rParams.se = season;
      rParams.epFrom = episode;
      rParams.epTo = episode;
    }

    const rJson = await movieboxRequest('GET', '/wefeed-mobile-bff/subject-api/resource/v2', rParams);
    const rList = rJson?.data?.list || [];

    for (const item of rList) {
      const itEp = item.ep || item.episode;
      const itSe = item.se || 1;
      const matchEp = !isSeries || Number(itEp) === episode;
      const matchSe = !isSeries || !item.se || Number(itSe) === season;
      if (!matchEp || !matchSe) continue;

      if (item.duration && !mediaDuration) {
        mediaDuration = Number(item.duration);
      }

      // If item has sourceUrl, it is a cloud stream that must be sniffed to obtain the real full video
      if (item.sourceUrl) {
        try {
          const sniff = await movieboxRequest('GET', '/wefeed-mobile-bff/sniff/config', {
            linkUrl: item.sourceUrl,
            subjectId,
          });
          const dlUrl = sniff?.data?.downloadUrl;
          if (isValidMediaUrl(dlUrl)) {
            const res = sniff.data?.resource?.resolution || item.resolution || 720;
            const codec = sniff.data?.resource?.codecName || item.codecName || 'h264';
            const dSec = Number(sniff.data?.resource?.duration || item.duration || 0);
            if (dSec > 0 && !mediaDuration) mediaDuration = dSec;
            addStream(dlUrl, `${res}p (${codec.toUpperCase()})`, 'mp4');

            for (const cap of sniff.data?.resource?.extCaptions || []) {
              if (cap.url) {
                subtitles.push({
                  url: cap.url,
                  name: cap.lanName || cap.lan || 'Subtitle',
                });
              }
            }
          }
        } catch (se) {
          console.warn('[MovieBox] Sniff from resource/v2 failed:', se.message);
        }
      }

      const candidates = [item.resourceLink, item.downloadUrl, item.url];
      const validUrl = candidates.find((u) => isValidMediaUrl(u));
      if (validUrl) {
        const resLabel = item.resolution ? `${item.resolution}p` : 'HD';
        const codecLabel = item.codecName ? ` (${item.codecName.toUpperCase()})` : '';
        addStream(
          validUrl,
          `${resLabel}${codecLabel}`,
          validUrl.includes('.m3u8') ? 'hls' : validUrl.includes('.mpd') ? 'dash' : 'mp4'
        );
      }
      if (!resourceId && item.resourceId) {
        resourceId = String(item.resourceId);
      }
    }
  } catch (e) {
    console.warn('[MovieBox] resource/v2 error:', e);
  }

  // 3. Query play-info/v2 for DASH/HLS manifests
  try {
    const playParams = { subjectId };
    if (isSeries) {
      playParams.se = season;
      playParams.ep = episode;
    }

    const pJson = await movieboxRequest('GET', '/wefeed-mobile-bff/subject-api/play-info/v2', playParams);
    if (pJson?.data?.duration && !mediaDuration) {
      mediaDuration = Number(pJson.data.duration);
    }
    const pStreams = pJson?.data?.streams || pJson?.data?.streamList || [];

    for (const st of pStreams) {
      const stUrl = st.url || '';
      if (isValidMediaUrl(stUrl)) {
        const resLabel = st.resolutions ? `${st.resolutions}p` : 'Auto';
        const codecLabel = st.codecName ? ` (${st.codecName.toUpperCase()})` : '';
        addStream(
          stUrl,
          `${resLabel}${codecLabel}`,
          st.format?.toLowerCase() || 'mp4'
        );
      }

      // Check for hidden signed cookie base64 urlprefix
      const signCookie = st.signCookie || pJson?.data?.signCookie || '';
      if (signCookie && signCookie.includes('urlprefix=')) {
        try {
          const b64 = signCookie.split('urlprefix=')[1].split(';')[0];
          const basePath = Buffer.from(b64, 'base64').toString('utf8');
          if (basePath.startsWith('http')) {
            addStream(`${basePath}index.m3u8`, 'HLS Stream', 'hls');
            addStream(`${basePath}index.mpd`, 'DASH Manifest', 'dash');
          }
        } catch {}
      }
    }

    // Collect subtitles from play-info
    const pSubs = pJson?.data?.subTitleList || [];
    for (const sub of pSubs) {
      if (sub.url) {
        subtitles.push({
          url: sub.url,
          name: sub.lanName || sub.language || sub.lan || 'Subtitle',
        });
      }
    }
  } catch (e) {
    console.warn('[MovieBox] play-info/v2 error:', e);
  }

  // 4. Query legacy play-info if no streams yet
  if (streams.length === 0 && resourceId) {
    try {
      const legParams = { subjectId, resourceId };
      if (isSeries) {
        legParams.se = season;
        legParams.ep = episode;
      }
      const legJson = await movieboxRequest('GET', '/wefeed-mobile-bff/subject-api/play-info', legParams);
      const legStreams = legJson?.data?.streams || legJson?.data?.streamList || [];
      for (const lst of legStreams) {
        const lUrl = lst.url || '';
        if (isValidMediaUrl(lUrl)) {
          const resLabel = lst.resolutions ? `${lst.resolutions}p` : 'Auto';
          const codecLabel = lst.codecName ? ` (${lst.codecName.toUpperCase()})` : '';
          addStream(
            lUrl,
            `${resLabel}${codecLabel}`,
            lst.format?.toLowerCase() || 'mp4'
          );
        }
      }
    } catch (le) {
      console.warn('[MovieBox] Legacy play-info error:', le);
    }
  }

  // 5. Cloud Sniffer Engine (/sniff/config) - Bypasses VIP restrictions for TV series and movies
  if (streams.length === 0) {
    try {
      const targetEp = isSeries ? episode : 1;
      const targetSe = isSeries ? season : 1;
      const sniffPage = Math.max(0, Math.floor((targetEp - 1) / 20));

      const pagesToTry = [sniffPage];
      if (sniffPage > 0) pagesToTry.push(sniffPage - 1);
      pagesToTry.push(sniffPage + 1);

      for (const p of pagesToTry) {
        if (streams.length > 0) break;
        const resRaw = await movieboxRequest('GET', '/wefeed-mobile-bff/subject-api/resource', {
          subjectId,
          page: p,
          perPage: 20,
          pagerMode: 0,
        });
        const resItems = resRaw?.data?.list || resRaw?.data?.items || [];
        if (resItems.length === 0 && p > sniffPage) break;

        for (const it of resItems) {
          const itEp = it.ep || it.episode;
          const itSe = it.se || 1;
          const matchEp = !isSeries || Number(itEp) === targetEp;
          const matchSe = !isSeries || !it.se || Number(itSe) === targetSe;

          if (matchEp && matchSe) {
            const link = it.sourceUrl || it.resourceLink;
            if (link) {
              try {
                const sniff = await movieboxRequest('GET', '/wefeed-mobile-bff/sniff/config', {
                  linkUrl: link,
                  subjectId,
                });
                const dlUrl = sniff?.data?.downloadUrl;
                if (isValidMediaUrl(dlUrl)) {
                  const res = sniff.data?.resource?.resolution || it.resolution || 720;
                  const codec = sniff.data?.resource?.codecName || it.codecName || 'h264';
                  const dSec = Number(sniff.data?.resource?.duration || it.duration || 0);
                  if (dSec > 0 && !mediaDuration) mediaDuration = dSec;
                  addStream(dlUrl, `${res}p (${codec.toUpperCase()})`, 'mp4');

                  // Collect subtitles if provided in sniff response
                  const extCaps = sniff.data?.resource?.extCaptions || [];
                  for (const cap of extCaps) {
                    if (cap.url) {
                      subtitles.push({
                        url: cap.url,
                        name: cap.lanName || cap.lan || 'Subtitle',
                      });
                    }
                  }
                }
              } catch (se) {
                console.warn('[MovieBox] Sniffer call failed:', se.message);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[MovieBox] Sniffer engine error:', e);
    }
  }

  // 6. UGC Collection Mirror Engine (/ugc/...) - Community mirror fallback
  if (streams.length === 0) {
    try {
      const targetEp = isSeries ? episode : 1;
      const ugcFirst = await movieboxRequest('GET', '/wefeed-mobile-bff/ugc/video/first-by-subject', { subjectId });
      const collId = ugcFirst?.data?.belongToCollection?.collectionId;

      if (collId) {
        const ugcPage = Math.max(1, Math.floor((targetEp - 1) / 50) + 1);
        const pagesToTry = [ugcPage];
        if (ugcPage > 1) pagesToTry.push(ugcPage - 1);
        pagesToTry.push(ugcPage + 1);

        for (const p of pagesToTry) {
          if (streams.length > 0) break;
          const dlList = await movieboxRequest('GET', '/wefeed-mobile-bff/ugc/collection/download-list', {
            collectionId: collId,
            page: p,
            perPage: 50,
          });
          const items = dlList?.data?.items || [];
          if (items.length === 0 && p > ugcPage) break;

          for (const it of items) {
            const ep = it.episode || it.ep || it.order;
            const epTitle = String(it.epTitle || it.title || '');
            const matchEp = !isSeries || Number(ep) === targetEp || epTitle.includes(`EP${targetEp}`) || epTitle.includes(`E${targetEp}`);

            if (matchEp) {
              const resources = it.resources || [];
              for (const r of resources) {
                if (isValidMediaUrl(r.url)) {
                  const res = r.resolution || 720;
                  const codec = r.codecName ? ` (${r.codecName.toUpperCase()})` : '';
                  addStream(r.url, `${res}p${codec}`, 'mp4');
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('[MovieBox] UGC engine error:', e);
    }
  }

  // 7. External Captions from get-ext-captions
  try {
    const capParams = {
      resourceId: resourceId || subjectId,
      subjectId,
      episode: isSeries ? episode : 1,
    };
    const cJson = await movieboxRequest('GET', '/wefeed-mobile-bff/subject-api/get-ext-captions', capParams);
    const cList = cJson?.data?.extCaptions || cJson?.data?.list || [];

    for (const cap of cList) {
      if (cap.url) {
        subtitles.push({
          url: cap.url,
          name: cap.lanName || cap.lan || 'Subtitle',
        });
      }
    }
  } catch (e) {
    console.warn('[MovieBox] get-ext-captions error:', e);
  }

  // 8. Automatic Alternative Search for Native H.264 Streams
  // If the title is a dubbed version (e.g. [Hindi]) or only HEVC streams exist,
  // query the original standard title to grab native H.264 streams.
  // _depth === 0 guard prevents infinite recursion when alt source is also HEVC-only.
  const hasDubMarker = /\[.*?\]/i.test(detail?.title || '');
  const hasOnlyHevc = streams.length > 0 && streams.every((s) => isHevcSource(s) || s.headers?.['x-transcode']);

  if (_depth === 0 && (hasDubMarker || hasOnlyHevc) && detail?.title) {
    try {
      const cleanTitle = detail.title.replace(/\[.*?\]|\(.*?\)/g, '').trim();
      const shouldSearch = cleanTitle && cleanTitle.length >= 2 && (hasOnlyHevc || cleanTitle.toLowerCase() !== detail.title.toLowerCase());
      if (shouldSearch) {
        const altSearch = await searchMoviebox(cleanTitle);
        const altVideo = (altSearch?.videos || []).find(
          (v) => String(v.id) !== String(subjectId) && v.title.toLowerCase().includes(cleanTitle.toLowerCase())
        );
        if (altVideo) {
          const altEpId = isSeries ? `${altVideo.id}_${season}_${episode}` : String(altVideo.id);
          // Pass _depth + 1 so the recursive call does NOT trigger another alt-search
          const altSrc = await getMovieboxSource(altVideo.id, altEpId, _depth + 1);
          if (altSrc.duration && !mediaDuration) mediaDuration = altSrc.duration;
          for (const st of altSrc.streams || []) {
            const isAltH264 = !isHevcSource(st) && !st.headers?.['x-transcode'];
            if (isAltH264) {
              addStream(st.url, `${st.name}`, st.format, st.headers, 'h264');
            }
          }
          for (const sub of altSrc.subtitles || []) {
            if (sub.url && !subtitles.some((s) => s.url === sub.url || s.name === sub.name)) {
              subtitles.push(sub);
            }
          }
        }
      }
    } catch (altErr) {
      console.warn('[MovieBox] Alternative source search error:', altErr.message);
    }
  }

  const qualities = movieboxQualities(streams, isHlsPlaybackAvailable());

  if (streams.length === 0) {
    throw new Error(
      'Sumber video untuk judul ini sedang tidak tersedia atau mengalami pembatasan tautan oleh MovieBox. Silakan coba judul atau episode lainnya.'
    );
  }

  if (!mediaDuration || mediaDuration <= 0) {
    mediaDuration = isSeries ? 45 * 60 : 90 * 60;
  }

  return normalizeSources({
    streams: qualities,
    subtitles,
    duration: mediaDuration || 0,
  });
}

/**
 * Search MovieBox catalogue
 */
export async function searchMoviebox(query, page = 1) {
  if (!query || !query.trim()) {
    return { videos: [], page, hasMore: false };
  }

  const cleanQ = query.trim();
  const cacheKey = `mb_search_v2_${cleanQ}_${page}`;
  return dedupe(cacheKey, async () => {
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const payload = {
      keyword: cleanQ,
      page,
      perPage: 20,
      pageSize: 20,
      subjectType: 0,
      type: 0,
      q: cleanQ,
    };

    const json = await movieboxRequest('POST', '/wefeed-mobile-bff/subject-api/search/v2', {}, payload);
    const results = json?.data?.results || [];
    const subjects = [];

    for (const res of results) {
      if (Array.isArray(res.subjects)) {
        subjects.push(...res.subjects);
      }
    }

    if (subjects.length === 0 && Array.isArray(json?.data?.list)) {
      subjects.push(...json.data.list);
    }

    const videos = collapseVariantVideos(subjects.map(mapSubjectToVideo).filter(Boolean));

    const hasMore = videos.length >= 20;

    const result = { videos, page, hasMore };
    if (videos.length > 0) {
      setCached(cacheKey, result, 300);
    }
    return result;
  });
}

