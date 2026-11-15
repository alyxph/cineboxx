import test from 'node:test';
import assert from 'node:assert/strict';
import { getMovieboxVideos } from '../src/lib/moviebox.js';

test('Trending puts higher popularity first across films and series, preserving ties', async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.MOVIEBOX_TOKEN;
  process.env.MOVIEBOX_TOKEN = 'test-token';
  const requests = [];
  globalThis.fetch = async (_, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return Response.json({ code: 0, data: { list: body.page === 966 ? [
      { subjectId: 'film', title: 'Film', subjectType: 1, popularity: 5, imdbRatingValue: 9.9 },
      { subjectId: 'serial', title: 'Serial', subjectType: 2, popularity: 100, imdbRatingValue: 6.0 },
      { subjectId: 'tie', title: 'Other Serial', subjectType: 2, popularity: '100' },
    ] : [
      { subjectId: 'provider-first', title: 'Provider First', subjectType: 2, imdbRatingValue: 6.0 },
      { subjectId: 'provider-second', title: 'Provider Second', subjectType: 1, imdbRatingValue: 9.9 },
    ] } });
  };
  try {
    const ranked = await getMovieboxVideos({ categoryId: 'trending', page: 966 });
    assert.deepEqual(ranked.videos.map((video) => video.id), ['serial', 'tie', 'film']);
    const fallback = await getMovieboxVideos({ categoryId: 'trending', page: 967 });
    assert.deepEqual(fallback.videos.map((video) => video.id), ['provider-first', 'provider-second']);
    assert.deepEqual(requests.map((body) => [body.type, body.page]), [['trending', 966], ['trending', 967]]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.MOVIEBOX_TOKEN;
    else process.env.MOVIEBOX_TOKEN = previousToken;
  }
});
