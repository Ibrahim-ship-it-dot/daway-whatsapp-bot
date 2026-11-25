const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const expressApp = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');

const app = expressApp();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(expressApp.json());

let latestQR = null;
let connectionStatus = 'disconnected';
let sock = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Chrome (Linux)", "", ""] // تحديد متصفح ثابت لمنع خطأ 405 من واتساب
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            connectionStatus = 'qr_ready';
            io.emit('status', { status: 'qr_ready', qr: latestQR });
            console.log('📱 QR Code جاهز، امسحه من الواجهة.');
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log('⚠️ انقطع الاتصال، السبب:', lastDisconnect.error?.message || lastDisconnect.error);

            if (shouldReconnect) {
                console.log('🔄 جاري إعادة المحاولة خلال 5 ثواني...');
                setTimeout(() => {
                    connectToWhatsApp();
                }, 5000); // انتظار 5 ثواني لتجنب الضغط على الـ WebSocket
            } else {
                console.log('🔴 تم تسجيل الخروج نهائياً.');
                connectionStatus = 'disconnected';
                io.emit('status', { status: 'disconnected' });
            }
        } else if (connection === 'open') {
            console.log('✅ متصل بالواتساب بنجاح!');
            connectionStatus = 'connected';
            latestQR = null;
            io.emit('status', { status: 'connected' });
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // استقبال الرسائل والرد عليها
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const sender = msg.key.remoteJid;
            const textMessage = msg.message.conversation || 
                                msg.message.extendedTextMessage?.text || '';

            console.log(`📩 رسالة من [${sender}]: ${textMessage}`);

            io.emit('new_message', {
                sender: sender,
                text: textMessage,
                time: new Date().toLocaleTimeString()
            });
        }
    });
}

// API لإرسال الرسائل من واجهة HTML
app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ success: false, error: 'الرقم والرسالة مطلوبين' });
    }

    try {
        let formattedPhone = phone.includes('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`;
        await sock.sendMessage(formattedPhone, { text: message });
        res.json({ success: true });
    } catch (err) {
        console.error('خطأ في إرسال الرسالة:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => {
    res.send('Daway WhatsApp Bot Server is running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 السيرفر شغال على البورت ${PORT}`);
    connectToWhatsApp();
});
