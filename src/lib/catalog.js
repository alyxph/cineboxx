import { getMovieboxCategories, getMovieboxVideos, getMovieboxDetail, getMovieboxSource, searchMoviebox } from './moviebox.js';

const isMoviebox = (id) => String(id || '').toLowerCase() === 'moviebox';
const cineflowEnabled = () => process.env.CINEFLOW_ENABLED !== '0' && Boolean(
  process.env.CINEFLOW_ENABLED === '1' || process.env.CINEFLOW_REFRESH_TOKEN?.trim() || process.env.CINEFLOW_INSTANCE_ID?.trim()
);
const cineflow = () => import('./providers/cineflow.js');

export async function getSources() {
  if (cineflowEnabled()) return (await cineflow()).getSources();
  return [{ id: 'Moviebox', name: 'Moviebox', contentType: 'movie_tv' }];
}

export async function getCategories(modelId) {
  return isMoviebox(modelId) ? getMovieboxCategories() : (await cineflow()).getCategories(modelId);
}
export async function getVideos(options) {
  return isMoviebox(options.modelId) ? getMovieboxVideos(options) : (await cineflow()).getVideos(options);
}
export async function getMovieDetail(modelId, id) {
  return isMoviebox(modelId) ? getMovieboxDetail(id) : (await cineflow()).getMovieDetail(modelId, id);
}
export async function getMovieSource(modelId, id, episodeId) {
  return isMoviebox(modelId) ? getMovieboxSource(id, episodeId) : (await cineflow()).getMovieSource(modelId, id, episodeId);
}
export async function searchCatalog(query, page = 1) {
  if (cineflowEnabled()) return (await cineflow()).searchCineflow(query, page);
  const result = await searchMoviebox(query, page);
  return { ...result, currentPage: Number(page) };
}
