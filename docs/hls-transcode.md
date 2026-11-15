# Transcode HLS untuk sumber HEVC

Daftar kualitas MovieBox hanya menampilkan resolusi yang disediakan sumber,
satu pilihan per resolusi (misalnya 1080p, 720p, 320p). Tidak ada pilihan codec
atau kualitas tambahan. H.264 native dipilih jika tersedia pada resolusi yang sama.
Jika sumber terpilih HEVC, player memeriksa dukungan browser: browser yang
mendukung memutar sumber asli; browser lain otomatis memakai HLS H.264 pada
resolusi yang dipilih. Kegagalan decoder saat playback juga memicu fallback
otomatis tanpa tombol manual. ffmpeg mengubah video menjadi
H.264 yuv420p dan audio AAC stereo, sehingga browser tidak memerlukan decoder HEVC.

## Menjalankan

Gunakan server Node persisten (`npm run build`, lalu `npm start`) atau Docker:

```sh
docker build -t cineboxweb .
docker run --rm -p 3000:3000 --env-file .env.local cineboxweb
```

Image memasang ffmpeg dari Alpine dan memakai tini untuk meneruskan sinyal
shutdown ke proses anak. Pada komputer lokal, `ffmpeg-static` dipakai otomatis;
`FFMPEG_PATH` dapat menunjuk instalasi ffmpeg lain. Jika paket tersebut tidak
menyediakan binary, server mencoba `ffmpeg` di PATH.

Satu instance Node harus melayani playlist, segmen, dan lifecycle sesi yang sama.
Untuk beberapa replica, gunakan sticky routing untuk **semua** `/api/transcode/*`
berdasarkan `session`/`sid`, atau pisahkan layanan transcode dengan routing sesi.
Cache dan proses belum dibagikan antar-instance.

Transcode ini dinonaktifkan pada Vercel (`VERCEL` terisi). Function yang terpisah
tidak berbagi proses ffmpeg dan cache lokal, dan eksekusinya dibatasi durasi.
Sumber H.264 native dan proxy yang sudah ada masih dapat digunakan di Vercel;
HEVC-only memerlukan browser yang mendukung HEVC atau deployment Node/Docker.

## Cara kerja

1. Saat diperlukan transcode, player membuat ID acak untuk satu pemutaran. `GET /api/transcode/hls` membuka
   sumber dengan ffmpeg untuk membaca durasi aktual, kemudian mengembalikan
   playlist VOD dengan seluruh timeline. Durasi perkiraan dari katalog tidak
   menentukan panjang playlist.
2. Playlist menunjuk `/api/transcode/segment?sid=...&file=seg000000.ts`. Permintaan
   segmen yang belum ada memulai ffmpeg dari batas segmen tersebut. Setiap proses
   menghasilkan maksimal 60 detik, dalam segmen 4 detik. Penulisan sementara
   (`temp_file`) mencegah pengiriman segmen yang belum lengkap.
3. Segmen MPEG-TS memakai timestamp timeline film. Seek jauh mengganti jendela
   encode tanpa mengganti playlist atau memasang ulang media player. Segmen yang
   selesai dari jendela lama tetap dapat digunakan saat kembali ke posisi lama.
4. +10 detik di buffer browser langsung mengubah `currentTime`. Jika hanya tersedia
   di cache server, player mengunduh segmennya. Posisi yang belum ditranscode tetap
   bisa buffering sambil ffmpeg menyiapkan data; CPU dan kecepatan sumber menentukan
   waktu tunggu. Tidak ada janji bahwa setiap seek bebas buffering.
5. `POST /api/transcode/session?sid=...` memperpanjang sesi setiap 30 detik,
   termasuk saat pause. `POST ...&close=1` (beacon) atau `DELETE ...?sid=...`
   menghentikan worker dan menghapus file ketika berganti sumber/episode atau
   meninggalkan player. ID tertutup sementara ditolak agar retry terlambat tidak
   membuat ulang worker. Sesi tanpa aktivitas dibersihkan otomatis.

## Konfigurasi server

| Variabel | Default | Kegunaan |
| --- | --- | --- |
| `FFMPEG_PATH` | ffmpeg-static / PATH | Lokasi binary; Docker menggunakan `/usr/bin/ffmpeg` |
| `HLS_TRANSCODE_ENABLED` | aktif di Node | `0` menyembunyikan pilihan HLS dan menolak sesi baru |
| `HLS_MAX_SESSIONS` | `4` | Batas sesi, termasuk inisialisasi; kapasitas penuh mengembalikan 503 |
| `HLS_SESSION_IDLE_MS` | `300000` | Waktu idle sebelum cleanup; interval heartbeat harus lebih pendek |
| `HLS_CACHE_BYTES` | `268435456` | Batas cache per sesi, membuang segmen yang paling lama digunakan |

Setiap sesi memakai paling banyak satu worker encode dan dua thread encoder.
Proses hanya bekerja saat segmen diminta, dengan lookahead terbatas. Cache berada
di direktori sementara OS; setelah eviction, segmen lama dibuat ulang jika diminta.
Cache bukan penyimpanan permanen. Shutdown paksa/crash dapat menyisakan file di
direktori sementara sampai dibersihkan oleh OS/operator.

## Verifikasi

`node --test tests/hls-transcode.test.mjs tests/playback.test.mjs` menguji encode
HEVC nyata, deduplikasi sesi, cache, seek jauh, timestamp, header upstream,
penolakan kapasitas berlebih, pembatalan, expiry, dan penghapusan worker/file.

Setelah build, `npm run test:e2e -- tests/browser/hls-transcode.spec.mjs` menguji
pemutaran H.264/AAC, +10 detik, seek jauh/kembali/akhir, resume, satu playlist selama
seek, serta cleanup navigasi dan penutupan tab memakai video HEVC lokal 3 menit.
Browser Playwright perlu mendukung H.264/AAC (misalnya Chromium atau Edge).

Referensi: [FFmpeg HLS muxer](https://ffmpeg.org/ffmpeg-formats.html),
[Vercel runtimes](https://vercel.com/docs/functions/runtimes).
