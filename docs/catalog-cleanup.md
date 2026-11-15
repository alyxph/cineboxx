# Alur katalog

Frontend menggunakan `/api/catalog/{sources,categories,videos,detail,source,search}`.
Router server berada di `src/lib/catalog.js`. Permintaan kategori, video, detail,
dan stream MovieBox langsung memakai `src/lib/moviebox.js`, tanpa memuat adapter
autentikasi CineFlow.

CineFlow masih dipakai untuk Live TV dan provider tambahan. Implementasinya
dipindahkan dari `src/lib/cineflow.js` ke `src/lib/providers/cineflow.js` dan dimuat
saat diperlukan. Pencarian multi-provider menjalankan permintaan MovieBox dan
CineFlow secara bersamaan; hasil MovieBox kosong yang valid dihitung sebagai
respons sukses.

Tanpa konfigurasi CineFlow, sumber dan pencarian memakai MovieBox langsung.
`CINEFLOW_ENABLED=0` menonaktifkan penemuan sumber tambahan dan pencarian gabungan,
walaupun token lama masih ada di environment. `CINEFLOW_ENABLED=1` mengaktifkannya.
Jika variabel itu tidak diisi, adanya `CINEFLOW_REFRESH_TOKEN` atau
`CINEFLOW_INSTANCE_ID` mempertahankan integrasi CineFlow. Permintaan langsung
untuk model non-MovieBox tetap diarahkan ke adapter tersebut.

Route `/api/cineflow/*` dipertahankan sebagai alias tipis ke route katalog untuk
klien/deployment lama. Tidak ada implementasi handler terpisah di alias tersebut.
Parameter `model_id` dan bentuk respons tetap sama.

Player memakai metadata `sourceCodec`/`resolution` dari katalog. HEVC yang tidak
didukung browser diarahkan ke HLS H.264 pada kualitas pilihan. Seek HLS menggunakan
timeline playlist, dan pergantian sumber/navigasi menutup sesi transcode.

Resolver binary ffmpeg dipakai bersama oleh HLS dan route stream lama. Proxy
tidak lagi mengubah pengaturan TLS global proses Node. Perbaikan ini tidak
menentukan penyebab penolakan 440 pada gateway MovieBox; alur autentikasi dan
akses jaringan gateway tetap diperiksa secara terpisah.
