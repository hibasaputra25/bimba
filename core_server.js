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

function getMsg(dotPath) {
    try {
        const raw  = fs.readFileSync(MESSAGES_PATH, 'utf-8');
        const msgs = JSON.parse(raw);
        return dotPath.split('.').reduce((o, k) => o?.[k], msgs) || '';
    } catch (err) {
        console.error('[MSG] Gagal baca messages.json:', err.message);
        return '';
    }
}

// Helper: replace semua {variabel} dalam template
function fillMsg(dotPath, vars = {}) {
    let tpl = getMsg(dotPath);
    for (const [k, v] of Object.entries(vars)) {
        tpl = tpl.replace(new RegExp(`\\{${k}\\}`, 'g'), v ?? '');
    }
    return tpl;
}

const fs   = require('fs');
const path = require('path');
const MESSAGES_PATH = path.join(__dirname, 'public', 'messages.json');
const express  = require('express');
const axios    = require('axios');
const { Pool } = require('pg');

const app  = express();
const PORT = 3001;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// FILE LOGGER — semua console.log juga ditulis ke file
// ============================================================
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

        CREATE TABLE IF NOT EXISTS bot_config (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS keyword_responses (
            id         SERIAL PRIMARY KEY,
            keywords   JSONB    NOT NULL DEFAULT '[]',
            response   TEXT     NOT NULL,
            active     BOOLEAN  NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
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

    // Migrasi: tambah kolom ocr_duration_ms di chat_logs jika belum ada
    await pool.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'chat_logs' AND column_name = 'ocr_duration_ms'
            ) THEN
                ALTER TABLE chat_logs ADD COLUMN ocr_duration_ms INTEGER;
                RAISE NOTICE 'Migrasi: kolom ocr_duration_ms ditambahkan ke chat_logs.';
            END IF;
        END
        $$;
    `);

    // RECOVERY: pulihkan timer untuk sesi human mode yang masih aktif dari sesi server sebelumnya.
    // Tanpa ini, user yang tercatat 'human' di DB tidak akan pernah mendapat respons bot
    // karena timernya hilang saat server restart (sesi zombie).
    const zombieRows = await dbAll(`SELECT phone FROM user_mode WHERE mode = 'human'`);
    if (zombieRows.length > 0) {
        console.warn(`[DB] ⚠️  Ditemukan ${zombieRows.length} sesi human zombie dari restart sebelumnya — memulihkan timer...`);
        for (const row of zombieRows) {
            startHumanTimer(row.phone);
            console.warn(`[DB] ↺  Timer dipulihkan untuk ${row.phone}`);
        }
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
                message: fillMsg('admin.sesi_berakhir', { nama: phone  })
            }, { timeout: 10000 });
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

PENTING:
- Balas HANYA dengan JSON object, tanpa markdown atau backtick.
- Untuk field "nominal": isi dengan angka bulat tanpa titik/koma/simbol mata uang. Contoh: jika tertulis "IDR 58,250.00" atau "Rp 58.250,00" maka isi "58250". Jika "Rp 1.500.000" maka isi "1500000".
- Untuk field "nominal_formatted": isi dengan teks asli seperti tertulis di struk.`;

// ============================================================
// OCR QUEUE — antrian in-memory, diproses satu per satu
// ============================================================
const ocrQueue = [];
let ocrQueueRunning = false;

/**
 * Tambahkan item ke antrian OCR.
 * Mengembalikan Promise yang resolve saat item selesai diproses.
 */
function enqueueOCR(base64Data, mimeType) {
    return new Promise((resolve, reject) => {
        const item = { base64Data, mimeType, resolve, reject, queuedAt: Date.now() };
        ocrQueue.push(item);
        console.log(`[QUEUE] Item ditambahkan. Antrian: ${ocrQueue.length} | Running: ${ocrQueueRunning}`);
        if (!ocrQueueRunning) processOCRQueue();
    });
}

async function processOCRQueue() {
    if (ocrQueueRunning || ocrQueue.length === 0) return;
    ocrQueueRunning = true;

    while (ocrQueue.length > 0) {
        const item = ocrQueue.shift();
        const waitMs = Date.now() - item.queuedAt;
        console.log(`[QUEUE] Memproses item (tunggu ${waitMs}ms). Sisa antrian: ${ocrQueue.length}`);
        try {
            const result = await analyzeImage(item.base64Data, item.mimeType);
            item.resolve(result);
        } catch (err) {
            item.reject(err);
        }
    }

    ocrQueueRunning = false;
    console.log('[QUEUE] Antrian kosong.');
}

// ============================================================
// TRACKING STATE — Groq rate limit & Gemini usage
// ============================================================
const apiStats = {
    groq: {
        remainingRequests:  null,  // dari x-ratelimit-remaining-requests (RPD)
        limitRequests:      null,  // dari x-ratelimit-limit-requests
        remainingTokens:    null,  // dari x-ratelimit-remaining-tokens (TPM)
        limitTokens:        null,  // dari x-ratelimit-limit-tokens
        resetRequests:      null,  // dari x-ratelimit-reset-requests
        resetTokens:        null,  // dari x-ratelimit-reset-tokens
        lastUpdated:        null,
        totalRequestsToday: 0,
        totalTokensToday:   0,
        successToday:       0,
        failToday:          0,
    },
    gemini: {
        totalTokensToday:        0,
        totalPromptTokensToday:  0,
        totalOutputTokensToday:  0,
        totalRequestsToday:      0,
        successToday:            0,
        failToday:               0,
        lastUpdated:             null,
    },
    queue: {
        processed: 0,
        failed:    0,
    },
    // Reset harian — dicatat tanggal terakhir reset
    lastResetDate: new Date().toISOString().slice(0, 10),
};

/** Reset counter harian jika hari sudah berganti */
function checkDailyReset() {
    const today = new Date().toISOString().slice(0, 10);
    if (apiStats.lastResetDate !== today) {
        apiStats.lastResetDate             = today;
        apiStats.groq.totalRequestsToday   = 0;
        apiStats.groq.totalTokensToday     = 0;
        apiStats.groq.successToday         = 0;
        apiStats.groq.failToday            = 0;
        apiStats.gemini.totalTokensToday       = 0;
        apiStats.gemini.totalPromptTokensToday = 0;
        apiStats.gemini.totalOutputTokensToday = 0;
        apiStats.gemini.totalRequestsToday     = 0;
        apiStats.gemini.successToday           = 0;
        apiStats.gemini.failToday              = 0;
        console.log('[STATS] Counter harian di-reset untuk hari baru:', today);
    }
}

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
        let abortTimeout;
        try {
            console.log(`[GROQ] Percobaan ${attempt}/${MAX_RETRY} — model: llama-4-scout-17b`);
            const t0 = Date.now();
            const abortController = new AbortController();
            abortTimeout = setTimeout(() => abortController.abort(), 30000);

            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                signal: abortController.signal,
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
            clearTimeout(abortTimeout);

            // Baca rate limit headers dari Groq
            checkDailyReset();
            const rlRemReq = res.headers.get('x-ratelimit-remaining-requests');
            const rlLimReq = res.headers.get('x-ratelimit-limit-requests');
            const rlRemTok = res.headers.get('x-ratelimit-remaining-tokens');
            const rlLimTok = res.headers.get('x-ratelimit-limit-tokens');
            const rlRstReq = res.headers.get('x-ratelimit-reset-requests');
            const rlRstTok = res.headers.get('x-ratelimit-reset-tokens');
            if (rlRemReq !== null) {
                apiStats.groq.remainingRequests = parseInt(rlRemReq);
                apiStats.groq.limitRequests     = parseInt(rlLimReq);
                apiStats.groq.remainingTokens   = parseInt(rlRemTok);
                apiStats.groq.limitTokens       = parseInt(rlLimTok);
                apiStats.groq.resetRequests     = rlRstReq;
                apiStats.groq.resetTokens       = rlRstTok;
                apiStats.groq.lastUpdated       = new Date().toISOString();
            }

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

            apiStats.groq.totalRequestsToday++;
            apiStats.groq.totalTokensToday += (usage.total_tokens || 0);
            apiStats.groq.successToday++;
            apiStats.queue.processed++;

            const parsed = parseModelJSON(rawText);
            if (!parsed) console.warn('[GROQ] ⚠️  Respons diterima tapi gagal di-parse sebagai JSON.');
            return { parsed, durationMs: elapsed };

        } catch (err) {
            clearTimeout(abortTimeout);
            const isAbort = err.name === 'AbortError';
            console.error(`[GROQ] ❌ Error percobaan ${attempt}/${MAX_RETRY}: ${isAbort ? 'Timeout 30s' : err.message}`);
            apiStats.groq.failToday++;
            if (attempt === MAX_RETRY) throw isAbort ? new Error('Groq timeout setelah 30 detik') : err;
            const delay = attempt * 4000;
            console.log(`[GROQ] Menunggu ${delay / 1000}s sebelum retry...`);
            await sleep(delay);
        }
    }
    return { parsed: null, durationMs: 0 };
}

// ============================================================
// GEMINI VISION — Gemini 2.5 Flash (FALLBACK)
// ============================================================
async function callGeminiVision(base64Data, mimeType) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY tidak tersedia.');

        const MAX_RETRY = 3;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        let abortTimeout;
        try {
            console.log(`[GEMINI] Percobaan ${attempt}/${MAX_RETRY} — model: gemini-2.5-flash`);
            const t0 = Date.now();
            const abortController = new AbortController();
            abortTimeout = setTimeout(() => abortController.abort(), 30000);

            const res = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    signal: abortController.signal,
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
            clearTimeout(abortTimeout);

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

            checkDailyReset();
            apiStats.gemini.totalRequestsToday++;
            apiStats.gemini.totalTokensToday       += (usage.totalTokenCount        || 0);
            apiStats.gemini.totalPromptTokensToday += (usage.promptTokenCount       || 0);
            apiStats.gemini.totalOutputTokensToday += (usage.candidatesTokenCount   || 0);
            apiStats.gemini.successToday++;
            apiStats.gemini.lastUpdated = new Date().toISOString();
            apiStats.queue.processed++;

            const parsed = parseModelJSON(rawText);
            if (!parsed) console.warn('[GEMINI] ⚠️  Respons diterima tapi gagal di-parse sebagai JSON.');
            return { parsed, durationMs: elapsed };

        } catch (err) {
            clearTimeout(abortTimeout);
            const isAbort = err.name === 'AbortError';
            console.error(`[GEMINI] ❌ Error percobaan ${attempt}/${MAX_RETRY}: ${isAbort ? 'Timeout 30s' : err.message}`);
            apiStats.gemini.failToday++;
            apiStats.queue.failed++;
            if (attempt === MAX_RETRY) throw isAbort ? new Error('Gemini timeout setelah 30 detik') : err;
            const delay = attempt * 4000;
            console.log(`[GEMINI] Menunggu ${delay / 1000}s sebelum retry...`);
            await sleep(delay);
        }
    }
    return { parsed: null, durationMs: 0 };
}

// ============================================================
// ORCHESTRATOR — Groq utama, Gemini fallback
// ============================================================
/**
 * analyzeImage — panggil Groq lalu Gemini sebagai fallback.
 * Mengembalikan { ...parsedResult, _model, _durationMs } atau null.
 */
async function analyzeImage(base64Data, mimeType) {
    console.log(`[OCR] Memulai analisis gambar (${mimeType})...`);

    if (GROQ_API_KEY) {
        try {
            console.log('[OCR] → Mencoba Groq Llama 4 Scout (model utama)...');
            const { parsed, durationMs } = await callGroqVision(base64Data, mimeType);
            if (parsed) {
                console.log(`[OCR] ✅ Berhasil via Groq | jenis=${parsed.jenis} confidence=${parsed.confidence} durasi=${durationMs}ms`);
                return { ...parsed, _model: 'groq/llama-4-scout', _durationMs: durationMs };
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
            const { parsed, durationMs } = await callGeminiVision(base64Data, mimeType);
            if (parsed) {
                console.log(`[OCR] ✅ Berhasil via Gemini | jenis=${parsed.jenis} confidence=${parsed.confidence} durasi=${durationMs}ms`);
                return { ...parsed, _model: 'gemini/2.5-flash', _durationMs: durationMs };
            }
            console.warn('[OCR] ⚠️  Gemini mengembalikan null.');
        } catch (err) {
            console.error(`[OCR] ❌ Gemini juga gagal: ${err.message}`);
        }
    } else {
        console.warn('[OCR] Gemini dilewati (GEMINI_API_KEY kosong).');
    }

    console.error('[OCR] ❌ Semua model gagal — tidak ada hasil OCR.');
    apiStats.queue.failed++;
    return null;
}

// ============================================================
// PESAN BALASAN
// ============================================================
function msgMenu(name) {
    return fillMsg('menu.sambutan', { nama: name });
}

function msgInfoPembayaran() {
    return fillMsg('opsi_1.info_pembayaran', {
        bank:          process.env.BIMBA_NAMA_BANK     || '',
        nama_rekening: process.env.BIMBA_NAMA_REKENING || '',
        no_rekening:   process.env.BIMBA_NO_REKENING   || '',
    });
}

function msgKonfirmasiTransfer(result, userName) {
    const nominal  = result.nominal_formatted || result.nominal || '(tidak terbaca)';
    const pengirim = result.nama_pengirim     || '(tidak terbaca)';
    const bank     = result.bank_pengirim     || '(tidak terbaca)';
    const tgl      = result.tanggal           || '(tidak terbaca)';
    const waktu    = result.waktu ? ` ${result.waktu}` : '';
    const ref      = result.no_referensi      || '-';
    const status   = result.status_transaksi  || 'TIDAK DIKETAHUI';
    const emoji    = status === 'BERHASIL' ? '✅' : status === 'GAGAL' ? '❌' : '⏳';
    return fillMsg('pembayaran.konfirmasi', {
        emoji, nama: userName, pengirim, nominal,
        bank, tanggal: tgl + waktu, referensi: ref, status,
    });
}

function msgNotifAdmin(userName, phone, result) {
    return fillMsg('admin.notif_transfer', {
        nama:       userName,
        nomor:      phone,
        nominal:    result.nominal_formatted || result.nominal || '?',
        pengirim:   result.nama_pengirim || '?',
        referensi:  result.no_referensi  || '-',
        status:     result.status_transaksi || '?',
        confidence: result.confidence || 0,
    });
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
            return fillMsg('spam.terlalu_banyak_pesan');
        }
        return null;
    }

    // 3. Proses gambar
    if (hasMedia) {
        if (mediaType === 'image_too_large') {
            console.warn(`[MSG] ⚠️  Gambar dari ${name} terlalu besar — tolak.`);
            return fillMsg('opsi_2.gambar_terlalu_besar');
        }
        if (mediaType === 'download_failed') {
            console.warn(`[MSG] ⚠️  Gambar dari ${name} gagal diunduh gateway.`);
            return fillMsg('opsi_2.gagal_download');
        }
        if (!mediaData) {
            console.warn(`[MSG] ⚠️  hasMedia=true tapi mediaData kosong (tipe: ${mediaType}) — tolak.`);
            return fillMsg('opsi_2.bukan_gambar');
        }

                console.log(`[MSG] Meneruskan gambar ke OCR queue...`);
        const result = await enqueueOCR(mediaData, mediaType);

        if (!result) {
            console.error(`[MSG] ❌ OCR gagal total untuk ${name} (${realNumber})`);
            return fillMsg('opsi_2.ocr_gagal');
        }

                // Log ke DB (termasuk durasi OCR jika tersedia)
        await dbQuery(
            `INSERT INTO chat_logs (phone, name, type, message_in, message_out, context, ocr_duration_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [phone, name, 'image', '[GAMBAR]', JSON.stringify(result), result.jenis, result._durationMs || null]
        );
        console.log(`[DB] chat_log tersimpan: jenis=${result.jenis}`);

        if (result.jenis !== 'bukti_transfer') {
            console.log(`[MSG] Gambar bukan bukti transfer — deskripsi: ${result.deskripsi}`);
            return fillMsg('opsi_2.bukan_bukti_transfer', { deskripsi: result.deskripsi || 'gambar tidak dikenali' });
        }

        // ── Cek deduplication berdasarkan no_referensi ─────────────
        const noRef = (result.no_referensi || '').trim();
        
        // Fitur Cek Duplikasi
        const CEK_DUPLIKAT = process.env.CEK_DUPLIKAT !== 'false';

        if (CEK_DUPLIKAT && noRef) {
            const dupCheck = await dbGet(
                `SELECT id, created_at FROM payment_logs WHERE no_referensi = $1 LIMIT 1`,
                [noRef]
            );
            if (dupCheck) {
                console.warn(`[DB] ⚠️  Duplikat! no_referensi=${noRef} sudah ada (id=${dupCheck.id}). Diabaikan.`);
                return fillMsg('opsi_2.duplikat');
            }
        }

        // ── Validasi rekening tujuan ──────────────────────────────
        const rekeningOCR   = (result.no_rekening_tujuan || '').replace(/\D/g, '');
        const rekeningBimba = BIMBA_NO_REKENING.replace(/\D/g, '');
        let paymentStatus   = 'pending_review';
        let rekeningValid   = true;

        // Fitur Validasi Rekening
        const VALIDASI_REKENING = process.env.VALIDASI_REKENING !== 'false';

        if (VALIDASI_REKENING && rekeningOCR && rekeningBimba && rekeningOCR !== rekeningBimba) {
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
                    message: fillMsg('admin.notif_rekening_salah', { nama: name, nomor: realNumber, rekening_ocr: result.no_rekening_tujuan||'(tidak terbaca)', rekening_bimba: process.env.BIMBA_NO_REKENING||'', nominal: result.nominal_formatted||result.nominal||'?' })
                }, { timeout: 10000 }).catch(() => {});
            }
            return fillMsg('pembayaran.rekening_salah', { bank: process.env.BIMBA_NAMA_BANK||'', no_rekening: process.env.BIMBA_NO_REKENING||'', nama_rekening: process.env.BIMBA_NAMA_REKENING||'' });
        }

        // ── Notif admin (rekening benar) ─────────────────────────
        if (ADMIN_WA_NUMBER) {
            console.log(`[NOTIF] Mengirim notif bukti TF ke admin (${ADMIN_WA_NUMBER})...`);
                        axios.post(WA_GATEWAY_URL, { to: ADMIN_WA_NUMBER, message: msgNotifAdmin(name, realNumber, result) }, { timeout: 10000 })
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
        return fillMsg('opsi_2.teks_saat_waiting');
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
        return fillMsg('opsi_2.minta_bukti');
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
                message: fillMsg('admin.notif_human_mode', { nama: name, nomor: realNumber })
            })
            .then(() => console.log(`[MSG] ✅ Notif human mode terkirim ke admin.`))
            .catch(err => console.error(`[MSG] ❌ Gagal kirim notif human mode: ${err.message}`));
        }
        return fillMsg('opsi_3.menghubungkan');
    }

    // ── Cek keyword_responses dari admin panel ───────────────
    const kwRows = await dbAll(
        `SELECT keywords, response FROM keyword_responses WHERE active = true ORDER BY created_at ASC`
    ).catch(() => []);

    for (const kw of kwRows) {
        const keywords = Array.isArray(kw.keywords) ? kw.keywords : JSON.parse(kw.keywords || '[]');
        const matched  = keywords.some(k => input.includes(k.toLowerCase()));
        if (matched) {
            const reply = kw.response.replace(/\{nama\}/gi, name);
            console.log(`[MSG] → Keyword match: "${keywords.join(',')}"`);
            await dbQuery(
                `INSERT INTO chat_logs (phone, name, type, message_in, context) VALUES ($1, $2, $3, $4, $5)`,
                [phone, name, 'text', text, 'keyword_response']
            );
            return reply;
        }
    }

    // Fallback
    console.log(`[MSG] → Tidak cocok ke menu mana pun — tampilkan menu utama (fallback)`);
    clearSession(phone);
    return msgMenu(name);
}

// ============================================================
// ENDPOINTS
// ============================================================
app.post('/process-message', requireApiKey, async (req, res) => {
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

app.post('/api/admin-sync', requireApiKey, async (req, res) => {
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

app.post('/api/exit-human-mode', requireApiKey, async (req, res) => {
    const { targetNumber } = req.body;
    if (!targetNumber) return res.status(400).json({ error: 'targetNumber wajib.' });

    const phonePrefix = targetNumber.replace(/@\S+$/, '');

    // Coba exact match dulu, fallback ke LIKE agar cocok baik @c.us maupun @lid
    let row = await dbGet(
        `SELECT phone, mode FROM user_mode WHERE phone = $1`,
        [targetNumber]
    );
    if (!row) {
        row = await dbGet(
            `SELECT phone, mode FROM user_mode WHERE phone LIKE $1`,
            [`${phonePrefix}@%`]
        );
    }

    const actualPhone = row?.phone || `${phonePrefix}@c.us`;
    // Anggap aktif jika DB bilang human ATAU masih ada timer berjalan
    const wasActive   = row?.mode === 'human' || !!humanTimers[actualPhone];

    console.log(`[EXIT HUMAN] targetNumber=${targetNumber} → actualPhone=${actualPhone} | dbMode=${row?.mode} | timer=${!!humanTimers[actualPhone]} | wasActive=${wasActive}`);

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
                message: fillMsg('admin.sesi_selesai')
            }, { timeout: 10000 });
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

// GET /api/health-detail — health check lengkap dengan stats API & queue
app.get('/api/health-detail', requireApiKey, async (req, res) => {
    try {
        // DB check
        const dbStart = Date.now();
        await pool.query('SELECT 1');
        const dbLatencyMs = Date.now() - dbStart;

        // Stats OCR dari DB hari ini
        const today = new Date().toISOString().slice(0, 10);
        const ocrStats = await dbGet(`
            SELECT
                COUNT(*)                                              AS total_ocr,
                COUNT(*) FILTER (WHERE ocr_duration_ms IS NOT NULL)   AS total_with_duration,
                ROUND(AVG(ocr_duration_ms) FILTER (WHERE ocr_duration_ms IS NOT NULL))::int AS avg_duration_ms,
                MIN(ocr_duration_ms) FILTER (WHERE ocr_duration_ms IS NOT NULL) AS min_duration_ms,
                MAX(ocr_duration_ms) FILTER (WHERE ocr_duration_ms IS NOT NULL) AS max_duration_ms,
                COUNT(*) FILTER (WHERE message_out LIKE '%bukti_transfer%' OR context = 'bukti_transfer') AS ocr_transfer,
                COUNT(*) FILTER (WHERE context = 'image' AND message_out IS NOT NULL) AS ocr_success
            FROM chat_logs
            WHERE type = 'image'
              AND created_at >= NOW() - INTERVAL '24 hours'
        `);

        checkDailyReset();

        res.json({
            server: {
                status:     'ok',
                uptime_sec: Math.floor(process.uptime()),
                uptime_fmt: (() => {
                    const s = Math.floor(process.uptime());
                    const h = Math.floor(s / 3600);
                    const m = Math.floor((s % 3600) / 60);
                    return `${h}j ${m}m`;
                })(),
                timestamp:  new Date().toISOString(),
            },
            database: {
                status:      'connected',
                latency_ms:  dbLatencyMs,
            },
            queue: {
                size:          ocrQueue.length,
                running:       ocrQueueRunning,
                processed_session: apiStats.queue.processed,
                failed_session:    apiStats.queue.failed,
            },
            ocr_today: {
                total:        parseInt(ocrStats?.total_ocr        || 0),
                avg_ms:       parseInt(ocrStats?.avg_duration_ms  || 0),
                min_ms:       parseInt(ocrStats?.min_duration_ms  || 0),
                max_ms:       parseInt(ocrStats?.max_duration_ms  || 0),
            },
            groq: {
                active:              !!GROQ_API_KEY,
                requests_today:      apiStats.groq.totalRequestsToday,
                tokens_today:        apiStats.groq.totalTokensToday,
                success_today:       apiStats.groq.successToday,
                fail_today:          apiStats.groq.failToday,
                // Data dari response headers (update setiap request)
                remaining_requests:  apiStats.groq.remainingRequests,  // sisa RPD
                limit_requests:      apiStats.groq.limitRequests,       // limit RPD
                remaining_tokens:    apiStats.groq.remainingTokens,     // sisa TPM
                limit_tokens:        apiStats.groq.limitTokens,         // limit TPM
                reset_requests:      apiStats.groq.resetRequests,       // kapan RPD reset
                reset_tokens:        apiStats.groq.resetTokens,         // kapan TPM reset
                last_updated:        apiStats.groq.lastUpdated,
            },
            gemini: {
                active:               !!GEMINI_API_KEY,
                requests_today:       apiStats.gemini.totalRequestsToday,
                tokens_today:         apiStats.gemini.totalTokensToday,
                prompt_tokens_today:  apiStats.gemini.totalPromptTokensToday,
                output_tokens_today:  apiStats.gemini.totalOutputTokensToday,
                success_today:        apiStats.gemini.successToday,
                fail_today:           apiStats.gemini.failToday,
                // Gemini tidak expose sisa quota via API — hanya usage yang kita track sendiri
                last_updated:         apiStats.gemini.lastUpdated,
            },
        });
    } catch (err) {
        console.error('[HEALTH-DETAIL] ❌ Error:', err.message);
        res.status(500).json({ error: err.message });
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

// ============================================================
// ENDPOINTS ADMIN PANEL
// ============================================================

// GET /api/stats
app.get('/api/stats', requireApiKey, async (req, res) => {
    try {
        const pembayaran = await dbGet(`
            SELECT
                COUNT(*)                                          AS total,
                COUNT(*) FILTER (WHERE status='pending_review')  AS pending,
                COUNT(*) FILTER (WHERE status='verified')        AS verified,
                COUNT(*) FILTER (WHERE status='wrong_account')   AS wrong_account
            FROM payment_logs
        `);
        const humanAktif  = await dbGet(`SELECT COUNT(*) AS cnt FROM user_mode WHERE mode='human'`);
        const chatHariIni = await dbGet(`SELECT COUNT(*) AS cnt FROM chat_logs WHERE created_at >= NOW() - INTERVAL '24 hours'`);
        res.json({
            pembayaran: {
                total:         parseInt(pembayaran?.total         || 0),
                pending:       parseInt(pembayaran?.pending       || 0),
                verified:      parseInt(pembayaran?.verified      || 0),
                wrong_account: parseInt(pembayaran?.wrong_account || 0),
            },
            human_mode_aktif: parseInt(humanAktif?.cnt  || 0),
            chat: { hari_ini: parseInt(chatHariIni?.cnt || 0) },
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/payment-logs/detail
app.get('/api/payment-logs/detail', requireApiKey, async (req, res) => {
    try {
        const { status, limit = 100 } = req.query;
                let sql = `SELECT id, phone, name, nama_pengirim, nominal,
                    CASE
                        WHEN nominal IS NULL OR nominal = '' THEN '—'
                        WHEN REGEXP_REPLACE(nominal, '[^0-9]', '', 'g') = '' THEN nominal
                        ELSE 'Rp ' || TO_CHAR(
                            CASE
                                -- Jika nominal sudah angka bulat bersih (dari OCR prompt baru)
                                WHEN nominal ~ '^[0-9]+$' THEN nominal::numeric
                                -- Format desimal Amerika: 58,250.00 → hapus koma, buang .xx
                                WHEN nominal ~ '^[0-9,]+\\.[0-9]{1,2}$' THEN REGEXP_REPLACE(nominal, '[^0-9]', '', 'g')::numeric / 100
                                -- Format desimal Indonesia: 58.250,00 → hapus titik, buang ,xx
                                WHEN nominal ~ '^[0-9.]+,[0-9]{1,2}$' THEN REGEXP_REPLACE(nominal, '[^0-9]', '', 'g')::numeric / 100
                                -- Fallback: hapus semua non-angka
                                ELSE REGEXP_REPLACE(nominal, '[^0-9]', '', 'g')::numeric
                            END,
                        'FM999,999,999')
                    END AS nominal_formatted,
                    bank_pengirim, no_referensi, tanggal, status, confidence, created_at
                   FROM payment_logs`;
        const params = [];
        if (status) { sql += ` WHERE status = $1`; params.push(status); }
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(parseInt(limit));
        const rows = await dbAll(sql, params);
        res.json({ rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/payment-logs/:id/status
app.patch('/api/payment-logs/:id/status', requireApiKey, async (req, res) => {
    try {
        const { status } = req.body;
        const allowed = ['verified','rejected','pending_review','wrong_account','unverified_account'];
        if (!allowed.includes(status)) return res.status(400).json({ error: 'Status tidak valid.' });
        await dbQuery(`UPDATE payment_logs SET status=$1 WHERE id=$2`, [status, parseInt(req.params.id)]);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/human-active
app.get('/api/human-active', requireApiKey, async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT um.phone, um.updated_at,
                   cl.name AS last_name, cl.message_in AS last_message
            FROM user_mode um
            LEFT JOIN LATERAL (
                SELECT name, message_in FROM chat_logs
                WHERE phone = um.phone ORDER BY created_at DESC LIMIT 1
            ) cl ON true
            WHERE um.mode = 'human'
            ORDER BY um.updated_at DESC
        `);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/bot-config
app.get('/api/bot-config', requireApiKey, async (req, res) => {
    try {
        const rows = await dbAll(`SELECT key, value FROM bot_config`).catch(() => []);
        const cfg = {};
        for (const r of rows) cfg[r.key] = r.value;
        const defaults = {
            BIMBA_NAMA_BANK:     process.env.BIMBA_NAMA_BANK     || '',
            BIMBA_NO_REKENING:   process.env.BIMBA_NO_REKENING   || '',
            BIMBA_NAMA_REKENING: process.env.BIMBA_NAMA_REKENING || '',
            ADMIN_WA_NUMBER:     process.env.ADMIN_WA_NUMBER     || '',
            VALIDASI_REKENING:   process.env.VALIDASI_REKENING   || 'true',
            CEK_DUPLIKAT:        process.env.CEK_DUPLIKAT        || 'true',
            HUMAN_MODE_TIMEOUT:  process.env.HUMAN_MODE_TIMEOUT  || '10',
            MSG_WELCOME: '', MSG_INFO_PEMBAYARAN: '',
            MSG_REQUEST_TF: '', MSG_HUMAN_MODE: '',
        };
        res.json({ ...defaults, ...cfg });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/bot-config
app.put('/api/bot-config', requireApiKey, async (req, res) => {
    try {
        for (const [key, value] of Object.entries(req.body)) {
            await dbQuery(`
                INSERT INTO bot_config (key, value) VALUES ($1, $2)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            `, [key, String(value)]);
            process.env[key] = String(value); // reload in-memory
        }
        console.log(`[CONFIG] Bot config diperbarui: ${Object.keys(req.body).join(', ')}`);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET /api/messages — baca messages.json
app.get('/api/messages', requireApiKey, (req, res) => {
    try {
        const raw  = fs.readFileSync(MESSAGES_PATH, 'utf-8');
        res.json(JSON.parse(raw));
    } catch (err) {
        res.status(500).json({ error: 'Gagal membaca messages.json: ' + err.message });
    }
});

// PUT /api/messages — tulis messages.json
app.put('/api/messages', requireApiKey, (req, res) => {
    try {
        const backup = MESSAGES_PATH + '.bak';
        if (fs.existsSync(MESSAGES_PATH)) fs.copyFileSync(MESSAGES_PATH, backup);
        fs.writeFileSync(MESSAGES_PATH, JSON.stringify(req.body, null, 2), 'utf-8');        console.log('[CONFIG] messages.json diperbarui via admin panel');
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Gagal menulis messages.json: ' + err.message });
    }
});

// GET /api/keyword-responses
app.get('/api/keyword-responses', requireApiKey, async (req, res) => {
    try {
        const rawRows = await dbAll(`SELECT id, keywords, response, active, created_at FROM keyword_responses ORDER BY created_at DESC`);
        // Normalize keywords: pastikan selalu array, bukan string
        const rows = rawRows.map(r => ({
            ...r,
            keywords: Array.isArray(r.keywords)
                ? r.keywords
                : (typeof r.keywords === 'string' ? JSON.parse(r.keywords) : r.keywords)
        }));
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/keyword-responses
app.post('/api/keyword-responses', requireApiKey, async (req, res) => {
    try {
        const { keywords, response, active = true } = req.body;
        if (!keywords?.length || !response) return res.status(400).json({ error: 'keywords dan response wajib.' });
        const kwArr = Array.isArray(keywords) ? keywords : JSON.parse(keywords);
        const row = await dbGet(
            `INSERT INTO keyword_responses (keywords, response, active) VALUES ($1, $2, $3) RETURNING id`,
            [kwArr, response, active]
        );
        res.json({ ok: true, id: row.id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/keyword-responses/:id
app.put('/api/keyword-responses/:id', requireApiKey, async (req, res) => {
    try {
        const { keywords, response, active } = req.body;
        const kwArrUpd = Array.isArray(keywords) ? keywords : JSON.parse(keywords);
        await dbQuery(
            `UPDATE keyword_responses SET keywords=$1, response=$2, active=$3, updated_at=NOW() WHERE id=$4`,
            [kwArrUpd, response, active, parseInt(req.params.id)]
        );
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/keyword-responses/:id
app.delete('/api/keyword-responses/:id', requireApiKey, async (req, res) => {
    try {
        await dbQuery(`DELETE FROM keyword_responses WHERE id=$1`, [parseInt(req.params.id)]);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/spam-list — daftar nomor yang sedang atau pernah kena spam filter
app.get('/api/spam-list', requireApiKey, (req, res) => {
    const now = Date.now();
    const list = Object.entries(spamData).map(([phone, d]) => ({
        phone,
        banned:          d.bannedUntil > now,
        banned_until:    d.bannedUntil > now ? new Date(d.bannedUntil).toISOString() : null,
        sisa_detik:      d.bannedUntil > now ? Math.ceil((d.bannedUntil - now) / 1000) : 0,
        msg_count:       d.count,
        img_count:       d.imgCount,
        notified:        d.notifiedBan,
    }));
    // Urutkan: yang dibanned dulu, lalu sisanya
    list.sort((a, b) => (b.banned ? 1 : 0) - (a.banned ? 1 : 0));
    res.json(list);
});

// POST /api/spam-unban — hapus ban untuk nomor tertentu
app.post('/api/spam-unban', requireApiKey, (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone wajib.' });
    if (!spamData[phone]) return res.status(404).json({ error: 'Nomor tidak ditemukan di spam data.' });
    const wasBanned = spamData[phone].bannedUntil > Date.now();
    // Reset semua counter untuk nomor ini
    delete spamData[phone];
    console.log(`[SPAM] ✅ Ban untuk ${phone} dicabut oleh admin. wasBanned=${wasBanned}`);
    res.json({ ok: true, wasBanned, phone });
});


// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
async function shutdown(signal) {
    console.log(`[SHUTDOWN] ${signal} diterima, menutup koneksi...`);
    try { await pool.end(); console.log('[SHUTDOWN] Pool DB ditutup.'); } catch (_) {}
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// JALANKAN
// ============================================================
initDB()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`\n✅ Bimba Core Server berjalan di http://localhost:${PORT}`);
            console.log(`🖥️  Admin Panel     : http://localhost:${PORT}/index.html`);
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