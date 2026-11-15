import test from 'node:test';
import assert from 'node:assert/strict';
import { getSources, getCategories, getVideos, getMovieDetail, searchCatalog } from '../src/lib/catalog.js';

test('MovieBox catalog routes independently and valid empty searches remain successful', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.MOVIEBOX_TOKEN;
  const originalEnabled = process.env.CINEFLOW_ENABLED;
  process.env.MOVIEBOX_TOKEN = 'catalog-test';
  process.env.CINEFLOW_ENABLED = '1';
  const paths = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'apig.inmoviebox.com');
    paths.push(parsed.pathname);
    return Response.json({ code: 0, data: parsed.pathname.endsWith('/get')
      ? { subjectId: 'catalog-movie', title: 'Catalog Movie', subjectType: 1 }
      : { list: [], results: [] } });
  };
  try {
    assert.ok((await getCategories('Moviebox')).length);
    assert.deepEqual((await getVideos({ modelId: 'Moviebox', categoryId: 'trending', page: 812 })).videos, []);
    assert.equal((await getMovieDetail('Moviebox', 'catalog-movie')).title, 'Catalog Movie');
    process.env.CINEFLOW_ENABLED = '0';
    assert.deepEqual(await getSources(), [{ id: 'Moviebox', name: 'Moviebox', contentType: 'movie_tv' }]);
    assert.deepEqual((await searchCatalog('catalog-empty-result', 1)).videos, []);
    assert.equal(paths.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [['MOVIEBOX_TOKEN', originalToken], ['CINEFLOW_ENABLED', originalEnabled]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
