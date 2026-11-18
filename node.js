const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());

let sock;
let qrCodeData = '';
let connectionStatus = 'disconnected';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['Daway Bot', 'Safari', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = qr;
            connectionStatus = 'qr_ready';
            io.emit('status', { status: 'qr_ready', qr });
            console.log('📱 QR Code جديد جاهز للربط!');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            connectionStatus = 'disconnected';
            io.emit('status', { status: 'disconnected' });
            console.log(`❌ انقطع الاتصال (السبب: ${statusCode || 'غير معروف'})`);
            
            if (shouldReconnect) {
                console.log('🔄 جاري إعادة محاولة الاتصال تلقائياً...');
                setTimeout(startBot, 3000);
            } else {
                console.log('⚠️ تم تسجيل الخروج نهائياً. يرجى مسح مجلد auth_info وإعادة ربط الباركود.');
            }
        } else if (connection === 'open') {
            connectionStatus = 'connected';
            qrCodeData = '';
            console.log('✅ تم اتصال البوت بنجاح وجاهز للعمل!');
            io.emit('status', { status: 'connected' });
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text) {
            console.log(`📩 رسالة واردة من [${sender}]: ${text}`);
            io.emit('new_message', { sender, text, time: new Date().toLocaleTimeString() });
        }
    });
}

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!sock || connectionStatus !== 'connected') {
        return res.status(400).json({ success: false, error: 'البوت غير متصل بالواتساب حالياً' });
    }

    try {
        const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'تم إرسال الرسالة بنجاح' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => {
    res.send('Daway WhatsApp Bot Server is active!');
});

io.on('connection', (socket) => {
    console.log('🔗 تم اتصال واجهة محلية بالـ Socket');
    socket.emit('status', { status: connectionStatus, qr: qrCodeData });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
    startBot();
});
