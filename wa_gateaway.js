require('dotenv').config(); // ← WAJIB di baris pertama sebelum process.env dibaca

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode-terminal');
const axios   = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const CORE_SERVICE_URL = 'http://127.0.0.1:3001/process-message';
const GATEWAY_PORT     = 3002;

// Nomor admin dari .env — sudah tersedia sejak proses start, tidak perlu resolusi chat
const ADMIN_NUMBER_ENV = (process.env.ADMIN_WA_NUMBER || '').trim();
// adminRawId di-init dari .env; di-override ke @lid jika WA versi baru mendeteksinya
let adminRawId = ADMIN_NUMBER_ENV || null;

const app = express();
app.use(bodyParser.json());

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions'
        ]
    }
});

// ── EVENT LISTENER ────────────────────────────────────────────────────────────

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading: ${percent}% - ${message}`);
});

client.on('qr', (qr) => {
    console.log('📸 QR Code muncul — scan dengan WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('🔐 Authenticated!');
});

client.on('auth_failure', msg => {
    console.error('❌ Gagal Login:', msg);
});

client.on('ready', async () => {
    console.log('\n✅ WhatsApp Client SIAP & TERHUBUNG!');

    if (!ADMIN_NUMBER_ENV) {
        console.warn('[GATEWAY] ⚠️  ADMIN_WA_NUMBER kosong di .env — notif admin tidak akan terkirim.');
        return;
    }

    // Coba resolve @lid admin dari daftar chat (WA versi baru kadang pakai @lid)
    // Jika tidak ditemukan, adminRawId tetap pakai nilai .env dan itu sudah cukup
    try {
        const adminNumber = ADMIN_NUMBER_ENV.split('@')[0];
        const chats = await client.getChats();
        for (const chat of chats) {
            const chatNumber = chat.id.user || chat.id._serialized?.split('@')[0];
            if (chatNumber === adminNumber) {
                adminRawId = chat.id._serialized;
                console.log(`[GATEWAY] Admin ID: ${adminRawId}`);
                return;
            }
        }
        // Tidak ditemukan di chat list — pakai .env, normal jika admin belum pernah chat
        console.log(`[GATEWAY] Admin ID: ${adminRawId} (dari .env)`);
    } catch (err) {
        console.error('[GATEWAY] Gagal resolve admin @lid:', err.message);
    }
});

// ── PESAN MASUK DARI USER ─────────────────────────────────────────────────────

client.on('message', async (msg) => {
    if (msg.from.endsWith('@g.us')) return;          // abaikan pesan dari grup
    if (!msg.body && !msg.hasMedia) return;
    if (msg.from === 'status@broadcast') return;

    const userName   = msg._data.notifyName || 'User';
    const text       = msg.body;
    const replyTo    = msg.from;                         // format asli WA, untuk sendMessage
    const realNumber = msg.from.split('@')[0];
    const from       = `${realNumber}@c.us`;             // selalu @c.us, untuk DB & logika core

    console.log(`\n📩 ${userName} (${realNumber})`);

    const payload = {
        from,
        text,
        userName,
        realNumber,
        hasMedia:  msg.hasMedia,
        mediaData: null,
        mediaType: null
    };

    if (msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();

            if (!media || !media.mimetype.startsWith('image/')) {
                payload.mediaType = media?.mimetype || 'unknown';
            } else if (Math.ceil(media.data.length * 0.75) > 5 * 1024 * 1024) {
                console.warn(`[GATEWAY] ⚠️  Gambar terlalu besar, dilewati.`);
                payload.mediaType = 'image_too_large';
            } else {
                payload.mediaData = media.data;
                payload.mediaType = media.mimetype;
            }
        } catch (err) {
            console.error(`[GATEWAY] ❌ Gagal download media:`, err.message);
            payload.mediaType = 'download_failed';
        }
    }

    // Kirim pesan "sedang diproses" saat ada gambar agar user tidak menunggu bingung
    if (payload.mediaData) {
        try {
            await client.sendMessage(replyTo, '⏳ Sedang membaca bukti transfer kamu, mohon tunggu sebentar...');
        } catch (_) {}
    }

    try {
        const response = await axios.post(CORE_SERVICE_URL, payload, {
            timeout: 60000,
            headers: { 'x-api-key': process.env.INTERNAL_API_KEY || 'bimba-secret-key' }
        });

        if (response.data?.reply) {
            const replyData = response.data.reply;
            if (Array.isArray(replyData)) {
                for (const txt of replyData) {
                    await client.sendMessage(replyTo, txt);
                    await new Promise(r => setTimeout(r, 500));
                }
            } else {
                await client.sendMessage(replyTo, replyData);
            }
        }
    } catch (error) {
        console.error(`[GATEWAY] ❌ Error Core:`, error.message);
    }
});

// ── ADMIN MEMBALAS LANGSUNG VIA HP ────────────────────────────────────────────

client.on('message_create', async msg => {
    if (!msg.fromMe) return;

    // Override adminRawId ke @lid jika WA versi baru menggunakannya
    if (msg.from?.includes('@lid') && adminRawId !== msg.from) {
        adminRawId = msg.from;
        console.log(`[GATEWAY] Admin @lid di-update: ${adminRawId}`);
    }

    // Perintah #selesai <nomor> → paksa keluar human mode
    const exitMatch = msg.body?.match(/^#selesai\s+(\S+)/i);
    if (exitMatch) {
        const targetPhone = `${exitMatch[1].trim().replace(/@\S+$/, '')}@c.us`;
        try {
            const res = await axios.post('http://127.0.0.1:3001/api/exit-human-mode', { targetNumber: targetPhone }, { headers: { 'x-api-key': process.env.INTERNAL_API_KEY || 'bimba-secret-key' } });
            const ok  = res.data?.wasActive
                ? `✅ Human mode untuk ${targetPhone} dinonaktifkan. Bot aktif kembali.`
                : `ℹ️ Nomor ${targetPhone} tidak sedang dalam human mode.`;
            await client.sendMessage(msg.from, ok);
        } catch (_) {
            await client.sendMessage(msg.from, '❌ Gagal menonaktifkan human mode.');
        }
        return;
    }

    // Trigger admin-sync hanya jika tujuan pesan sedang dalam human mode
    const rawTo      = msg._data?.to || msg.to || '';
    const syncTarget = `${rawTo.split('@')[0]}@c.us`;
    try {
        const modeRes = await axios.get(`http://127.0.0.1:3001/api/user-mode/${encodeURIComponent(syncTarget)}`, { headers: { 'x-api-key': process.env.INTERNAL_API_KEY || 'bimba-secret-key' } });
        if (modeRes.data?.mode !== 'human') return;
    } catch (_) {
        return;
    }

    try {
        await axios.post('http://127.0.0.1:3001/api/admin-sync', { targetNumber: syncTarget }, { headers: { 'x-api-key': process.env.INTERNAL_API_KEY || 'bimba-secret-key' } });
    } catch (_) {}
});

// ── ENDPOINT PUSH (kirim pesan dari core ke WA) ───────────────────────────────

app.post('/send-direct', async (req, res) => {
    try {
        const { to, message } = req.body;
        if (!to || !message) {
            return res.status(400).json({ error: "Parameter 'to' dan 'message' wajib diisi." });
        }

        // Kirim ke admin → pakai adminRawId (sudah di-resolve, bisa @c.us atau @lid)
        // Kirim ke user biasa → pakai 'to' apa adanya
        const adminNumber = ADMIN_NUMBER_ENV.split('@')[0];
        const isAdmin     = adminNumber && to.split('@')[0] === adminNumber;
        const resolvedTo  = isAdmin ? adminRawId : to;

        await client.sendMessage(resolvedTo, message);
        return res.status(200).json({ status: 'success' });

    } catch (error) {
        console.error('[GATEWAY] ❌ Gagal send-direct:', error.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────

client.initialize();

app.listen(GATEWAY_PORT, () => {
    console.log(`📡 Gateway berjalan di port ${GATEWAY_PORT}`);
});