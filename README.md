# 📖 Panduan Command CLIZA.AI Bot

Bot AI crypto serba bisa untuk komunitas. Bisa dipakai **langsung tanpa mention** untuk command market, atau **@mention bot** untuk chat AI dan analisis mendalam.

---

## ⚡ Command Tanpa Tag (Langsung Ketik di Channel)

### 💰 Harga & Market

| Command | Contoh | Keterangan |
|---|---|---|
| `price [COIN]` atau `p [COIN]` | `price BTC` atau `p ETH` | Cek harga kripto real-time via CoinGecko |
| `[jumlah] [COIN] to [COIN]` | `1 ETH to USDT` | Konversi harga antar token |
| `[jumlah] [COIN] ke [COIN]` | `5k USDC ke IDR` | Konversi ke/dari Rupiah juga bisa |
| `gainers` | `gainers` | Top gainer kripto hari ini |
| `losers` | `losers` | Top loser kripto hari ini |
| `market` | `market` | Overview kondisi market kripto |

### 📊 Chart Teknikal

| Command | Contoh | Keterangan |
|---|---|---|
| `c [COIN]` | `c BTC` | Chart BTC default timeframe 4h |
| `c [COIN] [timeframe]` | `c ETH 1h` | Chart dengan timeframe tertentu |
| `c [COIN] [timeframe] [candles]` | `c SOL 1d 30` | Chart dengan jumlah candle custom |

**Timeframe tersedia:** `1m` `5m` `15m` `30m` `1h` `2h` `4h` `6h` `1d` `1w`

### 📈 CryptoRank Data

| Command | Contoh | Keterangan |
|---|---|---|
| `cr [COIN]` | `cr BTC` | Harga, market cap, volume token |
| `gainers` | `gainers` | Top gainer 24h |
| `losers` | `losers` | Top loser 24h |
| `market` | `market` | Ringkasan kondisi market |

### 🔍 GMGN — Analisis Token & Wallet

| Command | Contoh | Keterangan |
|---|---|---|
| `gmgn <CA>` | `gmgn EPjFWdd5...` | Info + security token **Solana** |
| `gmgn base <CA>` | `gmgn base 0x532f27...` | Info + security token **Base Network** |
| `gmgn bsc <CA>` | `gmgn bsc 0xbb4CdB...` | Info + security token **BSC** |
| `gmgn eth <CA>` | `gmgn eth 0xC02aaA...` | Info + security token **Ethereum** |
| `gmgn smart` | `gmgn smart` | Top smart wallet / smart money global (SOL) |
| `gmgn smart <CA>` | `gmgn smart EPjFWd...` | Smart wallet holder untuk token tertentu |
| `gmgn trending` | `gmgn trending` | Token trending 1 jam terakhir (SOL) |
| `gmgn trending [chain]` | `gmgn trending eth` | Trending per chain: `sol` `eth` `base` `bsc` |
| `gmgn wallet <address>` | `gmgn wallet 0x123...` | Analisis profil & performa wallet |

> **`<CA>`** = contract address token.

### 🛡️ Token Scanner (Scam Check)

| Command | Contoh | Keterangan |
|---|---|---|
| `!base <CA>` | `!base 0x532f27...` | Scan token Base Network — cek risiko, liquidity, holder |
| `!sol <CA>` | `!sol EPjFWdd...` | Scan token Solana — cek pump.fun, dev, distribusi |

### 💧 LP Analysis (Liquidity Pool)

| Command | Contoh | Keterangan |
|---|---|---|
| `lp <CA> [modal] [range%]` | `lp EPjFWdd5... 500 20` | Analisa LP lengkap: range, ratio token, IL, fee APR |
| `lp <CA> [modal]` | `lp EPjFWdd5... 1000` | Range default ±20% dari harga sekarang |
| `lp <CA>` | `lp 0x532f27...` | Modal default $100, range ±20% |
| `lp pnl <CA> <entry_price> <modal> [range%] [hari]` | `lp pnl EPj... 0.00015 500 20 30` | P&L nyata posisi LP kamu: IL aktual, fee earned, net P&L vs HODL, fee coverage ratio, break-even |
| `lp rebalance <CA>` | `lp rebalance EPj...` | Saran range optimal berbasis volatilitas σ (Parkinson): 3 strategi (agresif/moderat/konservatif) + kapan waktunya rebalance |
| `lp pos <wallet>` | `lp pos 5Q544f...` | Lihat posisi LP aktif di wallet (Raydium CLMM + Meteora DLMM) |

**Mendukung:** Meteora DLMM, Raydium CLMM, Raydium AMM, Orca Whirlpool, Uniswap V3

**Output `lp <CA>`:**
- 🔍 Auto-deteksi chain + launchpad dari CA
- 📐 Range optimal (lower/upper price)
- 💰 Komposisi deposit: berapa token A vs token B (unit real)
- 📉 Simulasi Impermanent Loss (±20%, ±50%, ±100%, -75%)
- 💸 Fee APR historis (1d/7d/30d), fee realtime per jam

**Output `lp pnl <CA> <entry> <modal> [range%] [hari]`:**
- 💸 IL aktual (formula CLMM proper, bukan aproksimasi V2)
- 📊 Nilai posisi sekarang vs nilai kalau HODL
- 🏆 Fee earned estimate + **Net P&L vs HODL**
- 🔢 Fee coverage ratio (fee ÷ IL): apakah fee sudah menutup IL?
- ⏱️ Break-even: berapa hari pada APR saat ini
- 📈 Simulasi IL di berbagai harga (-50% s/d +100%)

**Output `lp rebalance <CA>`:**
- 📊 σ_daily (Parkinson's volatility estimator dari data historis 1d + 7d)
- 🎯 3 saran range: Agresif (±1σ, 3 hari), Moderat (±1.5σ, 7 hari), Konservatif (±2σ, 14 hari)
- 💸 Estimasi APR per strategi
- ⏱️ Panduan kapan rebalance layak (biaya vs fee earned)

### 💼 Portfolio Wallet

| Command | Contoh | Keterangan |
|---|---|---|
| `balance [wallet]` | `balance 0x742d35...` | Cek portfolio wallet via Zerion |
| `balance [ENS]` | `balance vitalik.eth` | Bisa pakai ENS juga |

### 🐦 Twitter / X History

| Command | Contoh | Keterangan |
|---|---|---|
| `twit [username]` | `twit monad` | Riwayat username Twitter/X akun kripto |
| `twit [user1],[user2]` | `twit vitalik,cz` | Cek beberapa akun sekaligus |

### ⚙️ Info & Status

| Command | Keterangan |
|---|---|
| `!command` | Tampilkan semua daftar command bot |
| `!provider` | Cek status & urutan fallback AI provider yang aktif |

---

## 💬 Command dengan Mention @bot

Tag bot terlebih dahulu, lalu tulis perintahnya.

### 🤖 Chat AI

```
@bot [pertanyaan bebas]
```

Bisa tanya apa saja — analisis kripto, coding, berita, strategi trading, dll.

**Contoh:**
- `@bot analisis market BTC minggu ini`
- `@bot jelaskan apa itu liquidity pool`
- `@bot buatkan script Python untuk cek harga ETH`

### 📋 Semua Command Market (Versi Mention)

Semua command di atas juga bisa dipakai dengan mention:

| Command | Contoh |
|---|---|
| `@bot c [COIN] [timeframe]` | `@bot c BTC 1d` |
| `@bot price [COIN]` | `@bot price SOL` |
| `@bot [jumlah] [COIN] to [COIN]` | `@bot 2 ETH to USDT` |
| `@bot balance [wallet]` | `@bot balance vitalik.eth` |
| `@bot cr [COIN]` | `@bot cr ETH` |
| `@bot gainers` | `@bot gainers` |
| `@bot twit [username]` | `@bot twit monad` |

### 🔎 Auto-Analisis Token (Paste Address Langsung)

Paste contract address langsung ke chat + mention bot, bot akan otomatis analisis:

```
@bot 0x532f27101965dd16442E59d40670FaF5eBB142E4
@bot EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

Bot otomatis mengambil data on-chain dari GMGN dan memberikan analisis risiko.

### 📁 Analisis File / Dokumen

Kirim file + pertanyaan ke bot:

```
@bot [pertanyaan] + lampirkan file
```

Mendukung file kode (`.js`, `.py`, `.sol`, dll), dokumen teks, CSV, dan lainnya.

### 🗑️ Riwayat Chat

| Command | Keterangan |
|---|---|
| `@bot !command` | Tampilkan semua daftar command |
| `@bot !clearhistory` | Hapus riwayat percakapan AI di channel ini (mulai sesi baru) |

---

## 💡 Tips

- **Tanpa mention** → command market & scanner langsung dieksekusi
- **Dengan @mention** → chat AI bebas + semua command market tetap bisa
- Setiap respons ada tombol **🗑️ Hapus** — hanya kamu (pengirim) yang bisa menekannya
- Riwayat chat AI per channel disimpan **1 turn terakhir** (hemat token)
- Bot support file up to **60 KB** per attachment, maksimal **3 file** per pesan di channel

---

*CLIZA.AI — Powered by Groq · Gemini · OpenAI*
