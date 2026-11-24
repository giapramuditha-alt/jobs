# JobHub – setup (±10 menit, gratis)
1. Buat repo GitHub baru, upload semua file ini (termasuk folder .github).
2. Settings → Secrets and variables → Actions → tambahkan (opsional tapi disarankan):
   - JOOBLE_KEY  (daftar gratis di jooble.org/api/about)
   - SERPAPI_KEY (serpapi.com, ada paket gratis terbatas; ini membuka hasil Google Jobs)
3. Settings → Pages → Source: Deploy from branch → main / root.
4. Tab Actions → collect-jobs → Run workflow (manual refresh). Setelah itu jalan otomatis tiap 6 jam.
5. Buka https://<username>.github.io/<repo>/ setiap pagi.
Frekuensi: edit baris cron di .github/workflows/collect.yml. Profil/keyword/lokasi: edit config.json.
Career page: isi greenhouseBoards / leverCompanies di config.json (token dari URL boards.greenhouse.io/<token> atau jobs.lever.co/<nama>).
Catatan: repo public berarti config.json terlihat publik; gunakan repo private + GitHub Pro jika ingin privat.
