'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Film, Search, X } from 'lucide-react';

function NavbarContent({ initialQuery = '' }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQuery = searchParams ? (searchParams.get('q') || '') : '';
  const [query, setQuery] = useState(initialQuery || urlQuery);
  const inputRef = useRef(null);

  useEffect(() => {
    if (urlQuery) {
      setQuery(urlQuery);
    } else if (initialQuery) {
      setQuery(initialQuery);
    } else {
      setQuery('');
    }
  }, [urlQuery, initialQuery]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const q = query.trim();
    if (q) {
      router.push(`/search?q=${encodeURIComponent(q)}`);
    } else {
      router.push('/search');
    }
  };

  const handleClear = () => {
    setQuery('');
    inputRef.current?.focus();
  };

  return (
    <header className="sticky top-0 z-40 w-full bg-[#090a0f]/95 border-b border-white/5 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-3">

        {/* Brand Logo (Klik untuk kembali ke Beranda) */}
        <Link href="/" className="flex items-center gap-2.5 cursor-pointer shrink-0 sm:w-40" title="CineBox - Beranda">
          <div className="w-8 h-8 rounded-lg bg-[#e50914] flex items-center justify-center">
            <Film className="w-4 h-4 text-white" />
          </div>
          <span className="hidden sm:inline text-lg font-bold tracking-tight text-white">
            CINE<span className="text-[#e50914]">BOX</span>
          </span>
        </Link>

        {/* Search Bar (YouTube style, centered) */}
        <form onSubmit={handleSubmit} className="flex-1 min-w-0 flex justify-center">
          <div className="flex items-center w-full max-w-2xl h-10 rounded-full border border-white/10 bg-[#131622] focus-within:border-white/30 overflow-hidden transition-colors duration-200">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari film / serial..."
              aria-label="Cari film / serial"
              className="flex-1 min-w-0 bg-transparent pl-4 sm:pl-5 pr-2 text-sm text-white placeholder-gray-500 focus:outline-none"
            />

            {/* Tombol Clear (X) ala YouTube */}
            {query && (
              <button
                type="button"
                onClick={handleClear}
                className="p-1 mr-1.5 rounded-full text-gray-400 hover:text-white hover:bg-white/10 transition-colors flex items-center justify-center shrink-0"
                aria-label="Hapus kata kunci pencarian"
                title="Hapus"
              >
                <X className="w-4 h-4" />
              </button>
            )}

            {/* Tombol Submit Pencarian */}
            <button
              type="submit"
              aria-label="Cari"
              className="flex items-center justify-center w-12 sm:w-16 shrink-0 h-full border-l border-white/10 bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white transition-colors duration-200"
            >
              <Search className="w-5 h-5" />
            </button>
          </div>
        </form>

        {/* Spacer with same width as logo to keep search perfectly centered */}
        <div className="hidden sm:block shrink-0 w-40" aria-hidden="true" />
      </div>
    </header>
  );
}

function NavbarFallback({ initialQuery = '' }) {
  return (
    <header className="sticky top-0 z-40 w-full bg-[#090a0f]/95 border-b border-white/5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2.5 cursor-pointer shrink-0 sm:w-40" title="CineBox - Beranda">
          <div className="w-8 h-8 rounded-lg bg-[#e50914] flex items-center justify-center">
            <Film className="w-4 h-4 text-white" />
          </div>
          <span className="hidden sm:inline text-lg font-bold tracking-tight text-white">
            CINE<span className="text-[#e50914]">BOX</span>
          </span>
        </Link>
        <div className="flex-1 min-w-0 flex justify-center">
          <div className="flex items-center w-full max-w-2xl h-10 rounded-full border border-white/10 bg-[#131622] overflow-hidden">
            <input
              type="text"
              defaultValue={initialQuery}
              placeholder="Cari film / serial..."
              aria-label="Cari film / serial"
              className="flex-1 min-w-0 bg-transparent pl-4 sm:pl-5 pr-2 text-sm text-white placeholder-gray-500 focus:outline-none"
              readOnly
            />
            <div className="flex items-center justify-center w-12 sm:w-16 shrink-0 h-full border-l border-white/10 bg-white/5 text-gray-300">
              <Search className="w-5 h-5" />
            </div>
          </div>
        </div>
        <div className="hidden sm:block shrink-0 w-40" aria-hidden="true" />
      </div>
    </header>
  );
}

export default function Navbar({ initialQuery }) {
  return (
    <Suspense fallback={<NavbarFallback initialQuery={initialQuery} />}>
      <NavbarContent initialQuery={initialQuery} />
    </Suspense>
  );
}
