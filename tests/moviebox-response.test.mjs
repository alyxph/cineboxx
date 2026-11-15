import test from 'node:test';
import assert from 'node:assert/strict';
import { movieboxRequest, getMovieboxVideos, getMovieboxDiscover, getMovieboxDetail, selectEpisodeResourceId } from '../src/lib/moviebox.js';
import { catalogItems } from '../src/lib/moviebox-tabs.js';

test('series captions select the resource belonging to the requested episode', () => {
  const items = [
    { se: 1, ep: 2, resourceId: 'episode-2' },
    { se: 1, ep: 3, resourceId: 'episode-3' },
    { se: 2, ep: 3, resourceId: 'season-2-episode-3' },
  ];
  assert.equal(selectEpisodeResourceId(items, 1, 2, 'generic'), 'episode-2');
  assert.equal(selectEpisodeResourceId(items, 1, 3, 'generic'), 'episode-3');
  assert.equal(selectEpisodeResourceId(items, 2, 3, 'generic'), 'season-2-episode-3');
  assert.equal(selectEpisodeResourceId(items, 1, 4, 'generic'), 'generic');
});

test('movie details do not invent a season or Tonton Film episode', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ code: 0, data: {
    title: 'Standalone Movie', subjectType: 1, duration: '1h 30m',
  } });
  try {
    const detail = await getMovieboxDetail('movie-without-seasons-test');
    assert.equal(detail.type, 'movie');
    assert.deepEqual(detail.seasons, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('upstream rejection, HTML, malformed JSON and timeouts never become empty success', async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.MOVIEBOX_TOKEN;
  process.env.MOVIEBOX_TOKEN = 'test-only';
  try {
    for (const response of [
      () => Response.json({ code: 1001, message: 'denied' }),
      () => Response.json({ code: 403, data: null }, { status: 403 }),
      () => new Response('<html>Access denied</html>', { status: 403 }),
      () => Response.json({ code: 0 }),
      () => Response.json('invalid envelope'),
    ]) {
      globalThis.fetch = async () => response();
      await assert.rejects(movieboxRequest('POST', '/test', {}, {}), { status: 502 });
    }
    globalThis.fetch = async () => { throw new DOMException('Timeout', 'TimeoutError'); };
    await assert.rejects(movieboxRequest('POST', '/test', {}, {}), { status: 504 });
    globalThis.fetch = async () => ({ status: 200, ok: true,
      json: async () => { throw new DOMException('Body timeout', 'AbortError'); } });
    await assert.rejects(movieboxRequest('POST', '/test', {}, {}), { status: 504 });
    globalThis.fetch = async () => Response.json({ code: 429, data: null }, { status: 429 });
    await assert.rejects(movieboxRequest('POST', '/test', {}, {}), { status: 503 });

    let requests = 0;
    process.env.MOVIEBOX_TOKEN = 'test-401';
    globalThis.fetch = async (url) => {
      if (url.includes('/visitor-login')) return Response.json({ code: 0, data: { token: 'fresh-401' } });
      requests++;
      return requests === 1 ? Response.json({ code: '401', data: null }, { status: 401 })
        : Response.json({ code: 0, data: { items: [] } });
    };
    assert.deepEqual(await movieboxRequest('POST', '/test', {}, {}), { code: 0, data: { items: [] } });
    assert.equal(requests, 2);

    const movie = { subjectId: 'valid', title: 'Valid Movie', subjectType: 1 };
    globalThis.fetch = async () => Response.json({ code: 0, data: { items: [movie], pager: { hasMore: false } } });
    const trending = await getMovieboxVideos({ categoryId: 'trending', page: 853 });
    assert.equal(trending.videos[0].id, 'valid');
    assert.equal(trending.hasMore, false);
    globalThis.fetch = async () => Response.json({ code: 0, data: { list: [movie] } });
    assert.equal((await getMovieboxDiscover({ page: 854 })).videos[0].id, 'valid');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.MOVIEBOX_TOKEN;
    else process.env.MOVIEBOX_TOKEN = previousToken;
  }
});

test('440 retries once with a fresh guest token and stable device, without reusing the rejected env token', async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.MOVIEBOX_TOKEN;
  process.env.MOVIEBOX_TOKEN = 'old-440';
  const authorizations = [];
  const devices = [];
  let logins = 0;
  globalThis.fetch = async (url, options) => {
    devices.push(JSON.parse(options.headers['X-Client-Info']).device_id);
    if (url.includes('/visitor-login')) {
      logins++;
      assert.equal(options.headers['X-Client-Status'], '1', 'bootstrap must declare an unauthenticated client');
      return Response.json({ code: '0', data: { token: 'fresh-440' } });
    }
    authorizations.push(options.headers.authorization);
    return authorizations.length === 1 ? Response.json({ code: 440, data: null }, { status: 440 })
      : Response.json({ code: 0, data: { items: [] } });
  };
  try {
    await movieboxRequest('POST', '/test-440', {}, {});
    await movieboxRequest('POST', '/test-440', {}, {});
    assert.deepEqual(authorizations, ['Bearer old-440', 'Bearer fresh-440', 'Bearer fresh-440']);
    assert.equal(logins, 1);
    assert.equal(new Set(devices).size, 1);
    process.env.MOVIEBOX_TOKEN = 'permanent-440';
    let attempts = 0;
    globalThis.fetch = async (url) => {
      if (url.includes('/visitor-login')) return Response.json({ code: 0, data: { token: 'still-rejected' } });
      attempts++;
      return Response.json({ code: 440, data: null }, { status: 440 });
    };
    await assert.rejects(movieboxRequest('POST', '/test-440', {}, {}), /440.*setelah autentikasi/);
    assert.equal(attempts, 2);
    process.env.MOVIEBOX_TOKEN = 'gateway-failure-test';
    globalThis.fetch = async (url) => url.includes('/visitor-login')
      ? Response.json({ code: 440, message: 'Invalid signature', data: null }, { status: 440 })
      : Response.json({ code: 440, data: null }, { status: 440 });
    await assert.rejects(movieboxRequest('POST', '/test-440', {}, {}), /Login tamu MovieBox gagal \(HTTP 440, kode 440, validasi signature\)/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.MOVIEBOX_TOKEN;
    else process.env.MOVIEBOX_TOKEN = previousToken;
  }
});

test('catalog parsing supports response variants and distinguishes empty from malformed data', () => {
  const items = [{ subjectId: 'a' }];
  for (const data of [items, { list: items }, { items }, { subjects: items }, { list: [], items }]) {
    assert.deepEqual(catalogItems(data), items);
  }
  assert.deepEqual(catalogItems({ list: [] }), []);
  assert.throws(() => catalogItems(null), { status: 502 });
  assert.throws(() => catalogItems({ message: 'error' }), { status: 502 });
});
