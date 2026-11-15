import test from 'node:test';
import assert from 'node:assert/strict';
import { getMovieboxVideos } from '../src/lib/moviebox.js';
import { tabSubjects } from '../src/lib/moviebox-tabs.js';

test('Kids uses AnyFilm tab 23 and never falls back to the general movie feed', async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.MOVIEBOX_TOKEN;
  process.env.MOVIEBOX_TOKEN = 'test-token';
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: new URL(url), method: options.method });
    if (requests.length > 1) return Response.json({ code: 0, data: { list: [] } });
    return Response.json({ code: 0, data: { list: [{ customData: { items: [
      { subjectId: 'kids-movie', title: 'Kids Movie', subjectType: 1 },
      { subjectId: 'kids-series', title: 'Kids Series', subjectType: 2 },
      { subjectId: 'other', title: 'Other Content', subjectType: 3 },
    ] } }] } });
  };
  try {
    const result = await getMovieboxVideos({ categoryId: 'kids', page: 998 });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url.pathname, /\/tab-operating$/);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].url.searchParams.get('tabId'), '23');
    assert.equal(requests[0].url.searchParams.get('pageSize'), '50');
    assert.deepEqual(result.videos.map((video) => video.id), ['kids-movie', 'kids-series']);
    const empty = await getMovieboxVideos({ categoryId: 'kids', page: 999 });
    assert.deepEqual(empty.videos, []);
    assert.equal(empty.hasMore, false);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.url.searchParams.get('tabId') === '23'));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.MOVIEBOX_TOKEN;
    else process.env.MOVIEBOX_TOKEN = previousToken;
  }
});

test('tab parser handles direct lists, rankings, wrapped titles and excludes promotional sections', () => {
  const movie = { subjectId: 'movie', title: 'Kids Movie', subjectType: 1 };
  assert.deepEqual(tabSubjects([movie]), [movie]);
  assert.deepEqual(tabSubjects({ sections: [
    { type: 'ACTOR', items: [movie] },
    { rankingListData: { items: [{ subject: movie }] } },
    { banner: { banners: [{ hasResource: false, subject: movie }] } },
  ] }), [movie]);
});
