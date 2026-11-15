'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { fetchJson } from '@/lib/http';
import Navbar from '@/components/Navbar';
import MovieCard from '@/components/MovieCard';
import { Film, AlertCircle } from 'lucide-react';

function SearchContent({ initialQuery }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(Boolean(initialQuery.trim()));
  const hasSearched = Boolean(initialQuery.trim());
  const [error, setError] = useState(null);

  useEffect(() => {
    const q = initialQuery.trim();
    if (!q) return;

    let active = true;
    const controller = new AbortController();
    fetchJson(`/api/catalog/search?q=${encodeURIComponent(q)}`, { signal: controller.signal, timeoutMs: 45000 })
      .then((json) => {
        if (!active) return;
        if (json.success && Array.isArray(json.videos)) {
          setResults(json.videos);
        } else {
          setResults([]);
          if (json.error) setError(json.error);
        }
      })
      .catch((err) => {
        if (!active) return;
        setError(err.message || 'Gagal mencari video.');
        setResults([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [initialQuery]);

  return (
    <div className="min-h-screen flex flex-col bg-[#090a0f] text-white">
      <Navbar />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">

        {/* Results Area */}
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4 pt-4">
            {Array.from({ length: 12 }).map((_, idx) => (
              <div
                key={idx}
                className="aspect-[2/3] rounded-lg bg-[#131622] animate-shimmer"
              />
            ))}
          </div>
        ) : error ? (
          <div className="min-h-[250px] flex flex-col items-center justify-center text-center p-6 bg-[#131622] border border-white/5 rounded-xl">
            <AlertCircle className="w-10 h-10 text-red-500 mb-3" />
            <h3 className="text-base font-bold text-white mb-1">Gagal Mencari Film</h3>
            <p className="text-xs text-gray-400 max-w-sm">{error}</p>
          </div>
        ) : hasSearched && results.length === 0 ? (
          <div className="min-h-[250px] flex flex-col items-center justify-center text-center p-6 bg-[#131622] border border-white/5 rounded-xl">
            <Film className="w-12 h-12 text-gray-600 mb-3" />
            <h3 className="text-base font-bold text-white mb-1">Tidak Ditemukan</h3>
            <p className="text-xs text-gray-400">
              Tidak ada hasil untuk kata kunci &ldquo;{initialQuery}&rdquo;. Coba kata kunci yang lain.
            </p>
          </div>
        ) : results.length > 0 ? (
          <div className="space-y-4">
            <p className="text-xs text-gray-400">
              Ditemukan <span className="text-white font-semibold">{results.length}</span> hasil pencarian:
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-4">
              {results.map((vid, idx) => (
                <MovieCard
                  key={`${vid.id}_${idx}`}
                  video={vid}
                />
              ))}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function SearchRoute() {
  const searchParams = useSearchParams();
  const q = searchParams.get('q') || '';
  return <SearchContent key={q} initialQuery={q} />;
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#090a0f]" />}>
      <SearchRoute />
    </Suspense>
  );
}
