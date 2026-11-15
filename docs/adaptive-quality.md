# Kualitas Auto

Auto memilih kualitas awal berdasarkan estimasi `navigator.connection.downlink`
dan preferensi hemat data bila tersedia. Estimasi itu tidak selalu tersedia atau
akurat; jika tidak tersedia, player mulai pada kualitas hingga 480p yang disediakan
sumber. Tidak ada resolusi baru yang ditambahkan ke katalog.

Player memantau buffer dan perkiraan jaringan setiap 3 detik. Jika pemutaran belum
mulai setelah 15 detik, Auto juga memeriksa kemungkinan menurunkan kualitas.
Saat buffer habis
selama sedikitnya 3 detik, kualitas diturunkan; ada jeda minimal 12 detik sejak
pergantian terakhir. Kenaikan hanya satu tingkat, setelah posisi playback minimal
45 detik, pemutaran stabil minimal 45 detik, buffer minimal 25 detik, dan sudah
90 detik sejak pergantian terakhir. Kualitas manual menonaktifkan keputusan Auto.
Memilih kualitas yang sedang dipakai tidak memasang ulang sumber media.

Manifest HLS/DASH yang sudah mempunyai beberapa level menggunakan adaptasi
bawaan player. Untuk HLS, pilihan kualitas manual membatasi level sesuai resolusi
yang dipilih. Sumber berupa file terpisah atau HLS transcode memerlukan pergantian
sumber saat resolusinya berubah; posisi dan status pause dipertahankan, tetapi
pergantian tersebut masih dapat menimbulkan buffering singkat.

Auto mengurangi beban jaringan dan pergantian berulang. Waktu API sumber, koneksi
CDN, cold start hosting, dan proses transcode HEVC tetap dapat memperlambat mulai
pemutaran. Sesi HLS dengan proses ffmpeg/cache lokal tetap memerlukan deployment
persisten; mode Auto tidak mengatasi keterbatasan serverless.

Referensi: [NetworkInformation](https://developer.mozilla.org/en-US/docs/Web/API/NetworkInformation),
[Hls.js bandwidth estimate](https://hlsjs.video-dev.org/api-docs/hls.js.hls.bandwidthestimate).
