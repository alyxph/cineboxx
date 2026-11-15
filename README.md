# 🎬 CineBox Web

Aplikasi web streaming film dan serial TV modern berbasis Next.js 16 (App Router), terintegrasi langsung dengan API CineFlow. Transcode HLS untuk sumber HEVC memerlukan server Node/Docker persisten; lihat [panduan HLS](docs/hls-transcode.md).

---

## ✨ Fitur Utama

- **🚀 Server Multi-Sumber (CineFlow Integrated):**
  - MovieBox, Rebahin, Bstation, WeTV, Youku, Anichin, Samehadaku, FreeReels, dll.
  - Auto-refresh token Bearer & Device Instance ID otomatis di background.
- **🛡️ Smart Streaming & CORS Proxy (`/api/stream`):**
  - Meneruskan header `Referer` dan `User-Agent` yang dibutuhkan server pihak ketiga.
  - Mendukung HTTP Range Request (seeking lancar tanpa macet).
  - Mengatasi blokir CORS pada file video (`.mp4`, `.m3u8`) dan subtitle (`.srt`, `.vtt`).
- **🍿 Pemutar Video Bioskop (Hls.js + HTML5):**
  - Auto-hiding control bar, timeline seekbar, tombol mundur/maju 10 detik.
  - Pemilihan kualitas video (Auto, 1080p, 720p, 480p, 360p).
  - Teks terjemahan (Subtitle) bahasa Indonesia & Inggris dengan rendering kontras tinggi.
  - Pintasan keyboard (Spasi = Play/Pause, Panah Kiri/Kanan = Seek 10s, F = Fullscreen, M = Mute).
  - Otomatis melanjutkan posisi tontonan terakhir (Resume playback).
- **🎨 Tema Cinema Red (#E50914):**
  - Tampilan dark-mode elegan identik dengan aplikasi Android CineSimpel.
  - Kartu film bersih (bebas watermark HD / tulisan mengganggu).
  - Tombol kapsul *Muat Lebih Banyak* yang nyaman dan responsif di HP, Tablet, Laptop, maupun Browser Smart TV.
- **⭐ Favorit & Riwayat Nonton:**
  - Disimpan secara lokal di browser (`localStorage`), tidak memerlukan database eksternal.
- **🔍 Pencarian Cepat & Riwayat:**
  - Pencarian lintas server untuk judul film, serial, anime, maupun drakor.

---

## 💻 Menjalankan di Komputer Lokal

```bash
# 1. Masuk ke folder proyek
cd cineboxweb

# 2. Install dependencies (jika belum)
npm install

# 3. Jalankan server development
npm run dev
```

Buka peramban di [http://localhost:3000](http://localhost:3000).

Untuk menguji build produksi secara lokal:
```bash
npm run build
npm run start
```

---

## 🚀 Panduan Deploy ke Vercel (Gratis)

Sumber native dan proxy dapat menggunakan **Vercel Serverless Functions**. Transcode HLS HEVC dinonaktifkan pada Vercel karena sesi ffmpeg dan cache segmen memerlukan server persisten. Gunakan deployment Node/Docker untuk fitur tersebut; lihat [konfigurasi dan batasannya](docs/hls-transcode.md).

### Cara 1: Lewat Web Dashboard Vercel (Paling Mudah)
1. Buat repositori baru di akun GitHub Anda (misal: `cineboxweb`).
2. Masukkan dan push isi folder `cineboxweb` ke repositori tersebut:
   ```bash
   git init
   git add .
   git commit -m "Initial commit CineBox Web"
   git branch -M main
   git remote add origin https://github.com/USERNAME_ANDA/cineboxweb.git
   git push -u origin main
   ```
3. Buka [https://vercel.com](https://vercel.com) dan login dengan akun GitHub Anda.
4. Klik **Add New...** -> **Project**.
5. Pilih repositori `cineboxweb` yang baru dibuat.
6. Klik **Deploy**. Selesai! Web Anda akan langsung aktif dengan domain `.vercel.app`.

### Cara 2: Lewat Vercel CLI
```bash
npm install -g vercel
vercel
```
Ikuti instruksi singkat di terminal dan proyek akan langsung ter-deploy dalam beberapa detik.

---

## 📁 Struktur Direktori

```text
cineboxweb/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── cineflow/
│   │   │   │   ├── sources/route.js     # API list server film
│   │   │   │   ├── categories/route.js  # API kategori genre
│   │   │   │   ├── videos/route.js      # API daftar film & pagination
│   │   │   │   ├── detail/route.js      # API sinopsis & episode
│   │   │   │   ├── source/route.js      # API tautan stream & subtitle
│   │   │   │   └── search/route.js      # API pencarian
│   │   │   └── stream/route.js          # Proxy video & subtitle anti-CORS/Referer
│   │   ├── library/page.js              # Halaman Favorit & Riwayat
│   │   ├── search/page.js               # Halaman Pencarian Film
│   │   ├── globals.css                  # Style sistem & tema Cinema Red
│   │   ├── layout.js                    # Layout & meta tag SEO
│   │   └── page.js                      # Beranda CineBox Web
│   ├── components/
│   │   ├── Navbar.jsx                   # Navigasi & logo CineBox
│   │   ├── MovieCard.jsx                # Kartu poster film
│   │   ├── DetailModal.jsx              # Modal detail & pemilih episode
│   │   └── VideoPlayer.jsx              # Pemutar video kustom Hls.js
│   └── lib/
│       ├── cineflow.js                  # Engine koneksi & auth CineFlow
│       └── storage.js                   # Manajemen Favorit & Riwayat lokal
├── package.json
└── next.config.mjs
```
