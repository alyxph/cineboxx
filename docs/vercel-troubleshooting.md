# Daftar film kosong di Vercel

Warning npm `cache-dir`, deprecation ESLint, dan persetujuan install script
tidak cukup untuk menentukan penyebab kegagalan API pada runtime.

Perubahan ini menambahkan:

- Persetujuan install script untuk versi `ffmpeg-static` dan `unrs-resolver`
  yang dipakai proyek, melalui `allowScripts` di `package.json`.
- Pemeriksaan HTTP dan kode error MovieBox. Penolakan, respons HTML, dan timeout
  menghasilkan error API; tidak lagi dianggap daftar kosong yang sukses.
- Pembacaan format katalog `list`, `items`, `subjects`, dan array langsung.
- `Cache-Control: no-store` pada API kategori dan daftar video.
- Header `X-App-Revision` pada respons sukses di Vercel, berisi 12 karakter
  pertama `VERCEL_GIT_COMMIT_SHA`, untuk memeriksa versi yang sedang dilayani.

## Memperbarui deployment

1. Commit dan push perubahan ke branch yang dipakai proyek Vercel.
2. Periksa deployment terbaru sudah berstatus Ready dan domain produksi menunjuk
   ke deployment tersebut. Periksa commit SHA-nya sama dengan commit yang dipush.
3. Buka `/api/catalog/categories?model_id=Moviebox`. Respons versi terbaru
   tidak memuat kategori `indonesia`, `asian`, dan `western`.
4. Buka `/api/catalog/videos?model_id=Moviebox&category_id=trending&page=1`.
   Jika gagal, lihat pesan error dan Runtime Logs untuk `[MovieBox]`.
   Log hanya memuat endpoint/status/kode, tanpa token maupun isi respons.

Error HTTP 403/401 dari sumber, timeout, dan hasil kosong yang sah memerlukan
penanganan berbeda. Penolakan akses dari jaringan hosting tidak bisa dipastikan
dari warning build; periksa error runtime setelah deployment memakai kode terbaru.

Jika variabel `NPM_CONFIG_CACHE_DIR` dikonfigurasi sendiri pada Vercel, hapus
variabel tersebut atau gunakan opsi npm yang didukung, `NPM_CONFIG_CACHE`.
Perubahan kode aplikasi tidak menghapus variabel lingkungan pada platform.

Transcode HLS tetap membutuhkan server Node/Docker persisten, seperti dijelaskan
di [panduan HLS](hls-transcode.md). Instalasi ffmpeg tidak membuat sesi transcode
lokal dapat dibagikan antar-function Vercel.

Referensi: [npm install-script approvals](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/),
[Vercel deployments](https://vercel.com/docs/deployments).
