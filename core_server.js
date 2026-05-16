/**
 * ============================================================
 * BIMBA ADMIN BOT — CORE SERVER
 * PORT: 3001
 * ============================================================
 * Berisi semua logika bisnis chatbot administrasi Bimba:
 *  1. Memproses pesan teks (menu, info, sapaan)
 *  2. Memproses gambar dengan Groq Llama 4 Scout (utama) + Gemini (fallback)
 *  3. Human mode — admin Bimba bisa ambil alih percakapan
 *  4. Spam filter (teks & gambar terpisah) dengan notifikasi ban
 *  5. Logging ke PostgreSQL
 * ============================================================
 */

require('dotenv').config();

const express  = require('express');
const axios    = require('axios');
const { Pool } = require('pg');

const app  = express();
const PORT = 3001;

app.use(express.json({ limit: '10mb' }));

// ============================================================
// FILE LOGGER — semua console.log juga ditulis ke file
// ============================================================
const fs   = require('fs');
const path = require('path');
const logDir  = path.join(__dirname, 'logs');
const logFile = path.join(logDir, `core-${new Date().toISOString().slice(0,10)}.log`);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
const origLog   = console.log.bind(console);
const origWarn  = console.warn.bind(console);
const origError = console.error.bind(console);
const stamp = () => new Date().toISOString();
console.log   = (...a) => { const m = `[${stamp()}] ${a.join(' ')}`; origLog(m);   logStream.write(m + '\n'); };
console.warn  = (...a) => { const m = `[${stamp()}] WARN  ${a.join(' ')}`; origWarn(m);  logStream.write(m + '\n'); };
console.error = (...a) => { const m = `[${stamp()}] ERROR ${a.join(' ')}`; origError(m); logStream.write(m + '\n'); };

// ============================================================
// MIDDLEWARE — Autentikasi API key untuk endpoint sensitif
// ============================================================
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key || key !== INTERNAL_API_KEY) {
        console.warn(`[AUTH] ⛔ Akses ditolak ke ${req.path} — API key salah atau kosong.`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ============================================================
// KONFIGURASI
// ============================================================
const GROQ_API_KEY      = process.env.GROQ_API_KEY;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const ADMIN_WA_NUMBER   = process.env.ADMIN_WA_NUMBER;
const INTERNAL_API_KEY  = process.env.INTERNAL_API_KEY;
const WA_GATEWAY_URL    = 'http://127.0.0.1:3002/send-direct';

const BIMBA_NAMA_REKENING = process.env.BIMBA_NAMA_REKENING;
const BIMBA_NO_REKENING   = process.env.BIMBA_NO_REKENING;
const BIMBA_NAMA_BANK     = process.env.BIMBA_NAMA_BANK;

console.log('============================================================');
console.log(' BIMBA ADMIN BOT — CORE SERVER');
console.log('============================================================');
console.log(`[CONFIG] GROQ_API_KEY   : ${GROQ_API_KEY   ? '✅ tersedia' : '❌ kosong'}`);
console.log(`[CONFIG] GEMINI_API_KEY : ${GEMINI_API_KEY ? '✅ tersedia' : '❌ kosong'}`);
console.log(`[CONFIG] ADMIN_WA_NUMBER: ${ADMIN_WA_NUMBER ? `✅ ${ADMIN_WA_NUMBER}` : '❌ kosong — notif admin tidak akan terkirim'}`);
console.log(`[CONFIG] Rekening       : ${BIMBA_NAMA_BANK} / ${BIMBA_NAMA_REKENING} / ${BIMBA_NO_REKENING}`);
console.log('============================================================');

if (!GROQ_API_KEY && !GEMINI_API_KEY) {
    console.error('[CONFIG] ❌ FATAL: Minimal satu API key harus diisi. Server berhenti.');
    process.exit(1);
}
if (!GROQ_API_KEY)   console.warn('[CONFIG] ⚠️  GROQ_API_KEY kosong — hanya Gemini (fallback) yang aktif.');
if (!GEMINI_API_KEY) console.warn('[CONFIG] ⚠️  GEMINI_API_KEY kosong — tidak ada fallback jika Groq gagal.');

// ============================================================
// DATABASE POSTGRESQL
// ============================================================
const pool = new Pool({
    host:                    process.env.PG_HOST,
    port:                    process.env.PG_PORT,
    database:                process.env.PG_DATABASE,
    user:                    process.env.PG_USER,
    password:                process.env.PG_PASSWORD,
    max:                     10,
    idleTimeoutMillis:       30000,
    connectionTimeoutMillis: 5000,
});

const dbQuery = (sql, params = []) => pool.query(sql, params);

async function dbGet(sql, params = []) {
    const res = await pool.query(sql, params);
    return res.rows[0] || null;
}

async function dbAll(sql, params = []) {
    const res = await pool.query(sql, params);
    return res.rows;
}

async function initDB() {
    console.log('[DB] Menginisialisasi tabel PostgreSQL...');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_logs (
            id          SERIAL PRIMARY KEY,
            phone       TEXT        NOT NULL,
            name        TEXT,
            type        TEXT        DEFAULT 'text',
            message_in  TEXT,
            message_out TEXT,
            context     TEXT,
            created_at  TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS payment_logs (
            id              SERIAL PRIMARY KEY,
            phone           TEXT        NOT NULL,
            name            TEXT,
            nama_pengirim   TEXT,
            nominal         TEXT,
            bank_pengirim   TEXT,
            no_referensi    TEXT,
            tanggal         TEXT,
            status          TEXT        DEFAULT 'pending_review',
            confidence      NUMERIC(5,2) DEFAULT 0,
            raw_json        JSONB,
            created_at      TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS user_mode (
            phone       TEXT PRIMARY KEY,
            mode        TEXT        DEFAULT 'bot',
            updated_at  TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_chat_logs_phone     ON chat_logs (phone);
        CREATE INDEX IF NOT EXISTS idx_payment_logs_phone  ON payment_logs (phone);
        CREATE INDEX IF NOT EXISTS idx_payment_logs_status ON payment_logs (status);
    `);

    // Migrasi otomatis: ubah confidence INTEGER -> NUMERIC jika tabel sudah terlanjur dibuat
    await pool.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name  = 'payment_logs'
                  AND column_name = 'confidence'
                  AND data_type   = 'integer'
            ) THEN
                ALTER TABLE payment_logs
                    ALTER COLUMN confidence TYPE NUMERIC(5,2);
                RAISE NOTICE 'Migrasi: confidence INTEGER -> NUMERIC selesai.';
            END IF;
        END
        $$;
    `);

    // Migrasi: tambah kolom no_rekening_tujuan jika belum ada
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'payment_logs' AND column_name = 'no_rekening_tujuan'
            ) THEN
                ALTER TABLE payment_logs ADD COLUMN no_rekening_tujuan TEXT;
                RAISE NOTICE 'Migrasi: kolom no_rekening_tujuan ditambahkan.';
            END IF;
        END
        $$;
    `);

    // RECOVERY: reset user yang masih tercatat "human" dari sesi server sebelumnya
    const { rowCount } = await pool.query(`UPDATE user_mode SET mode = 'bot' WHERE mode = 'human'`);
    if (rowCount > 0) {
        console.warn(`[DB] ⚠️  Recovery: ${rowCount} user direset dari human mode (sisa sesi lama).`);
    }

    console.log('[DB] ✅ Semua tabel siap.');
}

// ============================================================
// HUMAN MODE
// ============================================================
const HUMAN_MODE_TIMEOUT = 10 * 60 * 1000; // 10 menit
const humanTimers = {};

async function getUserMode(phone) {
    const row = await dbGet('SELECT mode FROM user_mode WHERE phone = $1', [phone]);
    return row ? row.mode : 'bot';
}

async function setUserMode(phone, mode) {
    await dbQuery(`
        INSERT INTO user_mode (phone, mode, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (phone) DO UPDATE
            SET mode = EXCLUDED.mode, updated_at = NOW()
    `, [phone, mode]);
}

function startHumanTimer(phone) {
    if (humanTimers[phone]) {
        clearTimeout(humanTimers[phone]);
        console.log(`[HUMAN MODE] Timer di-reset untuk ${phone}`);
    }

    humanTimers[phone] = setTimeout(async () => {
        await setUserMode(phone, 'bot');
        delete humanTimers[phone];
        console.log(`[HUMAN MODE] ⏰ Timer habis untuk ${phone} — mode kembali ke bot.`);

        try {
            await axios.post(WA_GATEWAY_URL, {
                to: phone,
                message: '⚠️ *Sesi Admin Berakhir*\nTidak ada aktivitas dari admin. Kamu sekarang terhubung kembali ke bot.\n\nKetik *menu* untuk melihat pilihan.'
            });
            console.log(`[HUMAN MODE] Notif timeout terkirim ke ${phone}`);
        } catch (err) {
            console.error(`[HUMAN MODE] ❌ Gagal kirim notif timeout ke ${phone}:`, err.message);
        }
    }, HUMAN_MODE_TIMEOUT);

    console.log(`[HUMAN MODE] Timer ${HUMAN_MODE_TIMEOUT / 60000} menit dimulai untuk ${phone}`);
}

// ============================================================
// SPAM FILTER
// ============================================================
const spamData = {};
const SPAM_RULES = {
    MAX_MSG:       15,           // maks pesan teks per window
    WINDOW_MS:     60_000,       // window teks = 1 menit
    MAX_IMG:       5,            // maks gambar/OCR per window
    IMG_WINDOW_MS: 60_000,       // window gambar = 1 menit
    BAN_DURATION:  300_000       // durasi ban = 5 menit
};

/**
 * Cek apakah nomor sedang spam.
 * @param {string} phone
 * @param {boolean} isImage - true jika pesan berisi gambar
 * @returns {{ spam: boolean, reason: string|null, firstBan: boolean }}
 */
function checkSpam(phone, isImage = false) {
    const now = Date.now();

    if (!spamData[phone]) {
        spamData[phone] = {
            count:          0,
            windowStart:    now,
            imgCount:       0,
            imgWindowStart: now,
            bannedUntil:    0,
            notifiedBan:    false
        };
    }

    const d = spamData[phone];

    // Masih dalam masa ban
    if (d.bannedUntil > now) {
        const sisaDetik = Math.ceil((d.bannedUntil - now) / 1000);
        return { spam: true, reason: `masih dibanned (${sisaDetik}s lagi)`, firstBan: false };
    }

    // Reset window teks jika sudah lewat
    if (now - d.windowStart > SPAM_RULES.WINDOW_MS) {
        d.count = 0;
        d.windowStart = now;
        d.notifiedBan = false;
    }

    // Reset window gambar jika sudah lewat
    if (now - d.imgWindowStart > SPAM_RULES.IMG_WINDOW_MS) {
        d.imgCount = 0;
        d.imgWindowStart = now;
    }

    d.count++;
    if (isImage) d.imgCount++;

    // Cek limit gambar
    if (isImage && d.imgCount > SPAM_RULES.MAX_IMG) {
        d.bannedUntil = now + SPAM_RULES.BAN_DURATION;
        const firstBan = !d.notifiedBan;
        d.notifiedBan = true;
        return { spam: true, reason: `terlalu banyak gambar (${d.imgCount}/${SPAM_RULES.MAX_IMG} per menit)`, firstBan };
    }

    // Cek limit teks
    if (d.count > SPAM_RULES.MAX_MSG) {
        d.bannedUntil = now + SPAM_RULES.BAN_DURATION;
        const firstBan = !d.notifiedBan;
        d.notifiedBan = true;
        return { spam: true, reason: `terlalu banyak pesan (${d.count}/${SPAM_RULES.MAX_MSG} per menit)`, firstBan };
    }

    return { spam: false, reason: null, firstBan: false };
}

// ============================================================
// SESSION
// ============================================================
const sessions = {};
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 menit

function getSession(phone) {
    const s = sessions[phone];
    if (!s) return null;
    if (Date.now() - s.lastActive > SESSION_TIMEOUT) {
        console.log(`[SESSION] ⏰ Session ${phone} expired setelah idle ${SESSION_TIMEOUT / 60000} menit.`);
        delete sessions[phone];
        return null;
    }
    s.lastActive = Date.now();
    return s;
}

function setSession(phone, step, data = {}) {
    const prev = sessions[phone];
    sessions[phone] = { step, data, lastActive: Date.now() };
    if (prev?.step !== step) {
        console.log(`[SESSION] ${phone} step: ${prev?.step || '(baru)'} → ${step}`);
    }
}

function clearSession(phone) {
    if (sessions[phone]) {
        console.log(`[SESSION] ${phone} session dihapus (step sebelumnya: ${sessions[phone].step})`);
        delete sessions[phone];
    }
}

// ============================================================
// OCR PROMPT
// ============================================================
const OCR_PROMPT = `Kamu adalah sistem OCR administrasi keuangan lembaga pendidikan Bimba.

Analisis gambar ini. Ada DUA kemungkinan:

A) Gambar adalah BUKTI TRANSFER/PEMBAYARAN:
   Jika ya, ekstrak data dan kembalikan JSON:
   {
     "jenis": "bukti_transfer",
     "nama_pengirim": string|null,
     "nama_penerima": string|null,
     "nominal": string|null,
     "nominal_formatted": string|null,
     "bank_pengirim": string|null,
     "bank_penerima": string|null,
     "no_rekening_tujuan": string|null,
     "tanggal": string|null,
     "waktu": string|null,
     "no_referensi": string|null,
     "status_transaksi": "BERHASIL"|"GAGAL"|"PENDING"|"TIDAK DIKETAHUI",
     "metode_transfer": string|null,
     "confidence": number,
     "catatan": string|null
   }

B) Gambar BUKAN bukti transfer:
   Kembalikan JSON:
   {
     "jenis": "lainnya",
     "deskripsi": "deskripsi singkat isi gambar dalam 1 kalimat"
   }

PENTING: Balas HANYA dengan JSON object, tanpa markdown atau backtick.`;

// ============================================================
// HELPER PARSER JSON
// ============================================================
function parseModelJSON(text) {
    if (!text) return null;
    try { return JSON.parse(text.trim()); } catch (_) {}
    let c = text.replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/i, '').trim();
    try { return JSON.parse(c); } catch (_) {}
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s !== -1 && e > s) try { return JSON.parse(text.slice(s, e + 1)); } catch (_) {}
    console.warn('[PARSER] ⚠️  Gagal parse JSON dari respons model. Raw text:', text?.slice(0, 200));
    return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
// GROQ VISION — Llama 4 Scout 17B (MODEL UTAMA)
// ============================================================
async function callGroqVision(base64Data, mimeType) {
    if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY tidak tersedia.');

    const MAX_RETRY = 3;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
            console.log(`[GROQ] Percobaan ${attempt}/${MAX_RETRY} — model: llama-4-scout-17b`);
            const t0 = Date.now();

            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                    temperature: 0.1,
                    max_tokens: 1024,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } },
                            { type: 'text', text: OCR_PROMPT }
                        ]
                    }]
                })
            });

            const data = await res.json();

            if (data.error) {
                const msg = data.error.message || JSON.stringify(data.error);
                const isRateLimit = res.status === 429 || msg.toLowerCase().includes('rate');
                if (isRateLimit && attempt < MAX_RETRY) {
                    const delay = attempt * 5000;
                    console.warn(`[GROQ] ⚠️  Rate limit (HTTP ${res.status}), tunggu ${delay / 1000}s sebelum retry...`);
                    await sleep(delay);
                    continue;
                }
                throw new Error(`HTTP ${res.status} — ${msg}`);
            }

            const rawText = data.choices?.[0]?.message?.content || '';
            const elapsed = Date.now() - t0;
            const usage   = data.usage || {};
            console.log(`[GROQ] ✅ Selesai dalam ${elapsed}ms | tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`);

            const parsed = parseModelJSON(rawText);
            if (!parsed) console.warn('[GROQ] ⚠️  Respons diterima tapi gagal di-parse sebagai JSON.');
            return parsed;

        } catch (err) {
            console.error(`[GROQ] ❌ Error percobaan ${attempt}/${MAX_RETRY}: ${err.message}`);
            if (attempt === MAX_RETRY) throw err;
            const delay = attempt * 4000;
            console.log(`[GROQ] Menunggu ${delay / 1000}s sebelum retry...`);
            await sleep(delay);
        }
    }
    return null;
}

// ============================================================
// GEMINI VISION — Gemini 2.5 Flash (FALLBACK)
// ============================================================
async function callGeminiVision(base64Data, mimeType) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY tidak tersedia.');

    const MAX_RETRY = 3;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
            console.log(`[GEMINI] Percobaan ${attempt}/${MAX_RETRY} — model: gemini-2.5-flash`);
            const t0 = Date.now();

            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [
                            { inline_data: { mime_type: mimeType, data: base64Data } },
                            { text: OCR_PROMPT }
                        ]}],
                        generationConfig: {
                            temperature: 0.1,
                            maxOutputTokens: 1024,
                            responseMimeType: 'application/json',
                            thinkingConfig: { thinkingBudget: 0 }
                        }
                    })
                }
            );

            const data = await res.json();
            if (data.error) {
                const msg = data.error.message || '';
                const isOverload = msg.includes('high demand') || msg.includes('overload') || res.status === 503 || res.status === 429;
                if (isOverload && attempt < MAX_RETRY) {
                    const delay = attempt * 5000;
                    console.warn(`[GEMINI] ⚠️  Overload/rate limit (HTTP ${res.status}), tunggu ${delay / 1000}s...`);
                    await sleep(delay);
                    continue;
                }
                throw new Error(`HTTP ${res.status} — ${msg}`);
            }

            const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const elapsed = Date.now() - t0;
            const usage   = data.usageMetadata || {};
            const thinking = usage.thoughtsTokenCount || 0;
            console.log(`[GEMINI] ✅ Selesai dalam ${elapsed}ms | tokens: prompt=${usage.promptTokenCount} output=${usage.candidatesTokenCount} thinking=${thinking} total=${usage.totalTokenCount}`);
            if (thinking > 0) console.warn(`[GEMINI] ⚠️  thinkingBudget=0 tapi ada ${thinking} thinking tokens — perhatikan biaya.`);

            const parsed = parseModelJSON(rawText);
            if (!parsed) console.warn('[GEMINI] ⚠️  Respons diterima tapi gagal di-parse sebagai JSON.');
            return parsed;

        } catch (err) {
            console.error(`[GEMINI] ❌ Error percobaan ${attempt}/${MAX_RETRY}: ${err.message}`);
            if (attempt === MAX_RETRY) throw err;
            const delay = attempt * 4000;
            console.log(`[GEMINI] Menunggu ${delay / 1000}s sebelum retry...`);
            await sleep(delay);
        }
    }
    return null;
}

// ============================================================
// ORCHESTRATOR — Groq utama, Gemini fallback
// ============================================================
async function analyzeImage(base64Data, mimeType) {
    console.log(`[OCR] Memulai analisis gambar (${mimeType})...`);

    if (GROQ_API_KEY) {
        try {
            console.log('[OCR] → Mencoba Groq Llama 4 Scout (model utama)...');
            const result = await callGroqVision(base64Data, mimeType);
            if (result) {
                console.log(`[OCR] ✅ Berhasil via Groq | jenis=${result.jenis} confidence=${result.confidence}`);
                return { ...result, _model: 'groq/llama-4-scout' };
            }
            console.warn('[OCR] ⚠️  Groq mengembalikan null — beralih ke Gemini...');
        } catch (err) {
            console.warn(`[OCR] ⚠️  Groq gagal: ${err.message} — beralih ke Gemini...`);
        }
    } else {
        console.log('[OCR] Groq dilewati (GROQ_API_KEY kosong) — langsung ke Gemini.');
    }

    if (GEMINI_API_KEY) {
        try {
            console.log('[OCR] → Mencoba Gemini 2.5 Flash (fallback)...');
            const result = await callGeminiVision(base64Data, mimeType);
            if (result) {
                console.log(`[OCR] ✅ Berhasil via Gemini | jenis=${result.jenis} confidence=${result.confidence}`);
                return { ...result, _model: 'gemini/2.5-flash' };
            }
            console.warn('[OCR] ⚠️  Gemini mengembalikan null.');
        } catch (err) {
            console.error(`[OCR] ❌ Gemini juga gagal: ${err.message}`);
        }
    } else {
        console.warn('[OCR] Gemini dilewati (GEMINI_API_KEY kosong).');
    }

    console.error('[OCR] ❌ Semua model gagal — tidak ada hasil OCR.');
    return null;
}

// ============================================================
// PESAN BALASAN
// ============================================================
function msgMenu(name) {
    return `Halo, *${name}*! 👋 Selamat datang di *Bot Administrasi Bimba*.

Saya bisa membantu kamu dengan:

1️⃣ *Info Pembayaran* — nomor rekening & cara bayar
2️⃣ *Kirim Bukti Transfer* — kirim foto/screenshot bukti TF
3️⃣ *Hubungi Admin* — terhubung langsung ke admin Bimba

Balas dengan angka *1*, *2*, atau *3*.\n\n_Ketik *menu* kapan saja untuk kembali ke sini._`;
}

function msgInfoPembayaran() {
    return `💳 *Informasi Pembayaran Bimba*

Silakan transfer ke rekening berikut:

🏦 Bank      : *${BIMBA_NAMA_BANK}*
💼 Atas Nama : *${BIMBA_NAMA_REKENING}*
🔢 No. Rek   : *${BIMBA_NO_REKENING}*

Setelah transfer, kirim bukti transfer (foto/screenshot) ke nomor ini. Bot akan langsung memverifikasi dan mengkonfirmasi pembayaran kamu. ✅`;
}

function msgKonfirmasiTransfer(result, userName) {
    const nominal  = result.nominal_formatted || result.nominal || '(tidak terbaca)';
    const pengirim = result.nama_pengirim || '(tidak terbaca)';
    const bank     = result.bank_pengirim || '(tidak terbaca)';
    const tgl      = result.tanggal || '(tidak terbaca)';
    const waktu    = result.waktu ? ` ${result.waktu}` : '';
    const ref      = result.no_referensi || '-';
    const status   = result.status_transaksi || 'TIDAK DIKETAHUI';
    const emoji    = status === 'BERHASIL' ? '✅' : status === 'GAGAL' ? '❌' : '⏳';

    return `${emoji} *Bukti Transfer Diterima!*

Terima kasih, *${userName}*! Kami telah menerima bukti pembayaran kamu.

📋 *Detail Transaksi:*
├ Pengirim      : ${pengirim}
├ Nominal       : *${nominal}*
├ Bank          : ${bank}
├ Tanggal       : ${tgl}${waktu}
├ No. Referensi : ${ref}
└ Status        : *${status}*

${status === 'BERHASIL'
    ? '✅ Pembayaran akan diverifikasi oleh admin Bimba dalam waktu dekat.\n\n_Harap simpan bukti transfer ini sebagai arsip._'
    : '⚠️ Status transaksi tidak terbaca dengan jelas. Admin Bimba akan segera menghubungi kamu untuk konfirmasi.'}`;
}

function msgNotifAdmin(userName, phone, result) {
    return `🔔 *[NOTIF ADMIN BIMBA]*

Ada bukti transfer masuk!

👤 Wali Murid : ${userName}
📱 Nomor      : ${phone}
💰 Nominal    : *${result.nominal_formatted || result.nominal || '?'}*
👤 Pengirim   : ${result.nama_pengirim || '?'}
📄 Ref        : ${result.no_referensi || '-'}
✅ Status     : ${result.status_transaksi || '?'}
🎯 Confidence : ${result.confidence || 0}%
🤖 Model      : ${result._model || '?'}

_Verifikasi dan konfirmasi pembayaran di sistem administrasi._`;
}

// ============================================================
// PROSESOR PESAN UTAMA
// ============================================================
async function processMessage({ from, text, userName, realNumber, hasMedia, mediaData, mediaType }) {
    const phone = from;
    const name  = userName || 'Wali Murid';
    const input = (text || '').toLowerCase().trim();

    console.log(`\n${'─'.repeat(56)}`);
    console.log(`[MSG] Dari : ${name} (${realNumber})`);
    console.log(`[MSG] Tipe : ${hasMedia ? `media (${mediaType})` : `teks "${input.slice(0, 60)}"`}`);

    // 1. Cek human mode
    const mode = await getUserMode(phone);
    if (mode === 'human') {
        console.log(`[MSG] ↩️  Diabaikan — ${phone} sedang dalam human mode.`);
        return null;
    }
    console.log(`[MSG] Mode : bot (aktif)`);

    // 2. Spam filter
    const isImage = hasMedia && !!mediaData;
    const spam = checkSpam(phone, isImage);
    if (spam.spam) {
        console.warn(`[SPAM] ⚠️  ${phone} (${name}) — ${spam.reason}`);
        if (spam.firstBan) {
            console.log(`[SPAM] Mengirim notif ban pertama ke ${phone}`);
            return `⏸️ *Terlalu banyak pesan dalam waktu singkat.*\n\nSilakan tunggu beberapa menit sebelum mengirim pesan lagi.`;
        }
        return null;
    }

    // 3. Proses gambar
    if (hasMedia) {
        if (mediaType === 'image_too_large') {
            console.warn(`[MSG] ⚠️  Gambar dari ${name} terlalu besar — tolak.`);
            return `⚠️ Maaf, ukuran gambar terlalu besar.\n\nCoba kirim screenshot langsung dari aplikasi m-banking kamu.`;
        }
        if (mediaType === 'download_failed') {
            console.warn(`[MSG] ⚠️  Gambar dari ${name} gagal diunduh gateway.`);
            return `Maaf, gagal mengunduh gambar kamu. Coba kirim ulang sekali lagi ya. 🙏`;
        }
        if (!mediaData) {
            console.warn(`[MSG] ⚠️  hasMedia=true tapi mediaData kosong (tipe: ${mediaType}) — tolak.`);
            return `Maaf, saya hanya bisa memproses gambar (foto/screenshot). 📸`;
        }

        console.log(`[MSG] Meneruskan gambar ke OCR orchestrator...`);
        const result = await analyzeImage(mediaData, mediaType);

        if (!result) {
            console.error(`[MSG] ❌ OCR gagal total untuk ${name} (${realNumber})`);
            return `Maaf, sistem sedang tidak bisa membaca gambar saat ini. 😔\n\nCoba lagi sebentar, atau hubungi admin Bimba langsung.`;
        }

        // Log ke DB
        await dbQuery(
            `INSERT INTO chat_logs (phone, name, type, message_in, message_out, context)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [phone, name, 'image', '[GAMBAR]', JSON.stringify(result), result.jenis]
        );
        console.log(`[DB] chat_log tersimpan: jenis=${result.jenis}`);

        if (result.jenis !== 'bukti_transfer') {
            console.log(`[MSG] Gambar bukan bukti transfer — deskripsi: ${result.deskripsi}`);
            return `📸 Saya menerima gambar, tapi sepertinya ini bukan bukti transfer.\n\n_(Terdeteksi: ${result.deskripsi || 'gambar tidak dikenali'})_\n\nJika kamu ingin mengirim bukti pembayaran, kirim foto/screenshot struk atau riwayat transfer dari m-banking kamu. 🏦`;
        }

        // ── Cek deduplication berdasarkan no_referensi ─────────────
        const noRef = (result.no_referensi || '').trim();
        if (noRef) {
            const dupCheck = await dbGet(
                `SELECT id, created_at FROM payment_logs WHERE no_referensi = $1 LIMIT 1`,
                [noRef]
            );
            if (dupCheck) {
                console.warn(`[DB] ⚠️  Duplikat! no_referensi=${noRef} sudah ada (id=${dupCheck.id}). Diabaikan.`);
                return `ℹ️ Bukti transfer ini sudah pernah dikirimkan sebelumnya dan sedang dalam proses verifikasi.\n\nJika ada pertanyaan, silakan hubungi admin Bimba langsung. 🙏`;
            }
        }

        // ── Validasi rekening tujuan ──────────────────────────────
        const rekeningOCR   = (result.no_rekening_tujuan || '').replace(/\D/g, '');
        const rekeningBimba = BIMBA_NO_REKENING.replace(/\D/g, '');
        let paymentStatus   = 'pending_review';
        let rekeningValid   = true;

        if (rekeningOCR && rekeningBimba && rekeningOCR !== rekeningBimba) {
            console.warn(`[VALIDASI] ⚠️  Rekening tujuan tidak cocok! OCR: ${rekeningOCR} | Bimba: ${rekeningBimba}`);
            paymentStatus = 'wrong_account';
            rekeningValid = false;
        } else if (!rekeningOCR) {
            console.warn(`[VALIDASI] ⚠️  Nomor rekening tujuan tidak terbaca dari gambar.`);
            paymentStatus = 'unverified_account';
        } else {
            console.log(`[VALIDASI] ✅ Rekening tujuan cocok: ${rekeningOCR}`);
        }

        // ── Simpan payment log ────────────────────────────────────
        await dbQuery(
            `INSERT INTO payment_logs
             (phone, name, nama_pengirim, nominal, bank_pengirim, no_referensi, no_rekening_tujuan, tanggal, status, confidence, raw_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
                phone, name,
                result.nama_pengirim || '',
                result.nominal || '',
                result.bank_pengirim || '',
                noRef,
                result.no_rekening_tujuan || '',
                result.tanggal || '',
                paymentStatus,
                result.confidence || 0,
                result
            ]
        );
        console.log(`[DB] ✅ payment_log tersimpan: nominal=${result.nominal} status=${paymentStatus} model=${result._model}`);

        // ── Jika rekening salah, balas peringatan & notif admin ──
        if (!rekeningValid) {
            if (ADMIN_WA_NUMBER) {
                axios.post(WA_GATEWAY_URL, {
                    to: ADMIN_WA_NUMBER,
                    message: `⚠️ *[ALERT REKENING SALAH]*\n\n*${name}* (${realNumber}) mengirim bukti TF ke rekening yang *tidak sesuai*.\n\n📄 Rekening di bukti : ${result.no_rekening_tujuan || '(tidak terbaca)'}\n✅ Rekening Bimba    : ${BIMBA_NO_REKENING}\n💰 Nominal           : ${result.nominal_formatted || result.nominal || '?'}\n\n_Harap hubungi wali murid untuk klarifikasi._`
                }).catch(() => {});
            }
            return `⚠️ *Perhatian!*\n\nBerdasarkan bukti transfer yang kamu kirim, nomor rekening tujuan *tidak sesuai* dengan rekening Bimba.\n\n🔢 Rekening Bimba yang benar:\n*${BIMBA_NAMA_BANK}* — *${BIMBA_NO_REKENING}*\na/n *${BIMBA_NAMA_REKENING}*\n\nJika ini adalah kesalahan, silakan hubungi admin Bimba segera. 🙏`;
        }

        // ── Notif admin (rekening benar) ─────────────────────────
        if (ADMIN_WA_NUMBER) {
            console.log(`[NOTIF] Mengirim notif bukti TF ke admin (${ADMIN_WA_NUMBER})...`);
            axios.post(WA_GATEWAY_URL, { to: ADMIN_WA_NUMBER, message: msgNotifAdmin(name, realNumber, result) })
                .then(() => console.log(`[NOTIF] ✅ Notif admin terkirim.`))
                .catch(err => console.error(`[NOTIF] ❌ Gagal kirim notif admin: ${err.message}`));
        } else {
            console.warn('[NOTIF] ⚠️  ADMIN_WA_NUMBER kosong — notif admin tidak dikirim.');
        }

        return msgKonfirmasiTransfer(result, name);
    }

    // 4. Proses teks
    const session = getSession(phone);

    if (['menu', 'halo', 'hai', 'hi', 'hello', 'mulai', 'start'].some(k => input.includes(k))) {
        console.log(`[MSG] → Trigger menu`);
        clearSession(phone);
        return msgMenu(name);
    }

    if (session?.step === 'waiting_tf' && input) {
        console.log(`[MSG] → Dalam sesi waiting_tf tapi kirim teks — minta gambar`);
        return `Untuk konfirmasi pembayaran, silakan kirim *foto atau screenshot* bukti transfer kamu ya, bukan teks. 📸`;
    }

    // Keyword matching dengan word-boundary agar tidak false-positive
    const hasWord = (words) => words.some(w => new RegExp(`(^|\\s)${w}(\\s|$)`).test(input));

    if (input === '1' || hasWord(['info', 'rekening', 'bayar', 'pembayaran', 'tagihan'])) {
        console.log(`[MSG] → Info pembayaran`);
        clearSession(phone);
        await dbQuery(
            `INSERT INTO chat_logs (phone, name, type, message_in, context) VALUES ($1, $2, $3, $4, $5)`,
            [phone, name, 'text', text, 'info_rekening']
        );
        return msgInfoPembayaran();
    }

    if (input === '2' || hasWord(['bukti', 'transfer', 'konfirmasi', 'bayar', 'kirim tf', 'kirim bukti'])) {
        console.log(`[MSG] → Minta bukti transfer — set session waiting_tf`);
        setSession(phone, 'waiting_tf');
        await dbQuery(
            `INSERT INTO chat_logs (phone, name, type, message_in, context) VALUES ($1, $2, $3, $4, $5)`,
            [phone, name, 'text', text, 'bukti_transfer']
        );
        return `📎 *Kirim Bukti Transfer*\n\nSilakan kirim foto atau screenshot bukti transfer kamu sekarang.\n\nPastikan gambar jelas dan terbaca ya! ✅\n\n_Bot akan langsung membaca dan mengkonfirmasi pembayaran secara otomatis._`;
    }

    if (input === '3' || hasWord(['admin', 'cs', 'operator', 'bantuan', 'hubungi'])) {
        console.log(`[MSG] → Minta human mode — set mode human untuk ${phone}`);
        clearSession(phone);
        await setUserMode(phone, 'human');
        startHumanTimer(phone);
        await dbQuery(
            `INSERT INTO chat_logs (phone, name, type, message_in, context) VALUES ($1, $2, $3, $4, $5)`,
            [phone, name, 'text', text, 'human_mode']
        );
        if (ADMIN_WA_NUMBER) {
            console.log(`[MSG] Mengirim notif human mode ke admin...`);
            axios.post(WA_GATEWAY_URL, {
                to: ADMIN_WA_NUMBER,
                message: `🔔 *[NOTIF ADMIN BIMBA]*\n\n*${name}* (${realNumber}) ingin bicara dengan admin.\n\nBalas pesan mereka langsung dari HP ini.`
            })
            .then(() => console.log(`[MSG] ✅ Notif human mode terkirim ke admin.`))
            .catch(err => console.error(`[MSG] ❌ Gagal kirim notif human mode: ${err.message}`));
        }
        return `🙋 Menghubungkan kamu ke *Admin Bimba*...\n\nMohon tunggu sebentar. Admin akan segera membalas pesan kamu.\n\n_Jika tidak ada respons dalam 10 menit, bot akan aktif kembali._`;
    }

    // Fallback
    console.log(`[MSG] → Tidak cocok ke menu mana pun — tampilkan menu utama (fallback)`);
    clearSession(phone);
    return msgMenu(name);
}

// ============================================================
// ENDPOINTS
// ============================================================
app.post('/process-message', async (req, res) => {
    const { from, text, userName, realNumber, hasMedia, mediaData, mediaType } = req.body;
    if (!from) return res.status(400).json({ error: 'Parameter from wajib.' });
    try {
        const reply = await processMessage({ from, text, userName, realNumber, hasMedia, mediaData, mediaType });
        return res.status(200).json(reply ? { reply } : {});
    } catch (err) {
        console.error('[CORE] ❌ Error tidak tertangani di processMessage:', err.message);
        console.error(err.stack);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/admin-sync', async (req, res) => {
    const { targetNumber } = req.body;
    if (!targetNumber) return res.status(400).json({ error: 'targetNumber wajib.' });
    const mode = await getUserMode(targetNumber);
    if (mode === 'human') {
        startHumanTimer(targetNumber);
        console.log(`[ADMIN SYNC] Timer di-reset untuk ${targetNumber} (admin masih aktif)`);
    } else {
        console.log(`[ADMIN SYNC] ${targetNumber} tidak dalam human mode — sync diabaikan.`);
    }
    return res.status(200).json({ status: 'ok' });
});

app.post('/api/exit-human-mode', async (req, res) => {
    const { targetNumber } = req.body;
    if (!targetNumber) return res.status(400).json({ error: 'targetNumber wajib.' });

    const phonePrefix = targetNumber.replace(/@\S+$/, '');
    const row = await dbGet(
        `SELECT phone, mode FROM user_mode WHERE phone LIKE $1`,
        [`${phonePrefix}@%`]
    );

    const wasActive  = row?.mode === 'human';
    const actualPhone = row?.phone || `${phonePrefix}@c.us`;

    console.log(`[EXIT HUMAN] targetNumber=${targetNumber} → actualPhone=${actualPhone} | wasActive=${wasActive}`);

    if (wasActive) {
        if (humanTimers[actualPhone]) {
            clearTimeout(humanTimers[actualPhone]);
            delete humanTimers[actualPhone];
            console.log(`[EXIT HUMAN] Timer untuk ${actualPhone} dibatalkan.`);
        }
        await setUserMode(actualPhone, 'bot');
        console.log(`[EXIT HUMAN] ✅ ${actualPhone} kembali ke mode bot.`);

        try {
            await axios.post(WA_GATEWAY_URL, {
                to: actualPhone,
                message: `✅ *Sesi Admin Selesai*\nAdmin Bimba telah menutup sesi percakapan ini.\n\nKamu sekarang terhubung kembali ke bot.\n\nKetik *menu* untuk melihat pilihan.`
            });
            console.log(`[EXIT HUMAN] Notif selesai terkirim ke ${actualPhone}`);
        } catch (err) {
            console.error(`[EXIT HUMAN] ❌ Gagal kirim notif ke ${actualPhone}: ${err.message}`);
        }
    } else {
        console.log(`[EXIT HUMAN] ${actualPhone} tidak sedang dalam human mode — tidak ada perubahan.`);
    }

    return res.status(200).json({ status: 'ok', wasActive, phone: actualPhone });
});

app.get('/api/user-mode/:phone', requireApiKey, async (req, res) => {
    const phone = decodeURIComponent(req.params.phone);
    const mode  = await getUserMode(phone);
    return res.json({ phone, mode });
});

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected', uptime: Math.floor(process.uptime()) });
    } catch (err) {
        console.error('[HEALTH] ❌ DB tidak terhubung:', err.message);
        res.status(500).json({ status: 'error', db: 'disconnected', message: err.message });
    }
});

app.get('/api/payment-logs', requireApiKey, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT id, phone, name, nama_pengirim, nominal, bank_pengirim,
                    no_referensi, tanggal, status, confidence, created_at
             FROM payment_logs ORDER BY created_at DESC LIMIT 100`
        );
        res.json(rows);
    } catch (err) {
        console.error('[API] ❌ payment-logs error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/chat-logs', requireApiKey, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT id, phone, name, type, message_in, context, created_at
             FROM chat_logs ORDER BY created_at DESC LIMIT 200`
        );
        res.json(rows);
    } catch (err) {
        console.error('[API] ❌ chat-logs error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// JALANKAN
// ============================================================
initDB()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`\n✅ Bimba Core Server berjalan di http://localhost:${PORT}`);
            console.log(`\nEndpoint aktif:`);
            console.log(`  POST /process-message      — terima pesan dari gateway`);
            console.log(`  POST /api/admin-sync       — sinkronisasi balasan manual admin`);
            console.log(`  POST /api/exit-human-mode  — admin keluar manual dari human mode`);
            console.log(`  GET  /health               — health check + status DB`);
            console.log(`  GET  /api/payment-logs     — log pembayaran masuk`);
            console.log(`  GET  /api/chat-logs        — log percakapan`);
            console.log(`\nSpam rules: teks ${SPAM_RULES.MAX_MSG}/mnt | gambar ${SPAM_RULES.MAX_IMG}/mnt | ban ${SPAM_RULES.BAN_DURATION / 60000} mnt\n`);
        });
    })
    .catch(err => {
        console.error('[FATAL] ❌ Gagal koneksi ke PostgreSQL:', err.message);
        console.error('[FATAL] Pastikan PostgreSQL berjalan dan konfigurasi .env sudah benar.');
        process.exit(1);
    });