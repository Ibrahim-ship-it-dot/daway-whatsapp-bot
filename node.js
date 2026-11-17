const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const firebase = require("firebase/compat/app");
require("firebase/compat/firestore");

const app = express();
app.use(express.json());

// السماح لموقع Netlify بالاتصال بالسيرفر
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// إعدادات Firebase
const firebaseConfig = {
  apiKey: "AIzaSyDlEBzVFhJzFkDI4mWnTSEQbUGOYBoVvbI",
  authDomain: "group-2f790.firebaseapp.com",
  projectId: "group-2f790",
  storageBucket: "group-2f790.firebasestorage.app",
  messagingSenderId: "532610990999",
  appId: "1:532610990999:web:1ad2bf5149c68774e57ad2",
};

let db;
try {
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  console.log("✅ Firebase initialized");
} catch (e) {
  console.error("🔥 Firebase Init Failed:", e);
}

// مخزن الجلسات النشطة في الذاكرة لكل الصيدليات
const sessions = {}; // { pharmacyId: { sock, qr, status } }

// التأكد من وجود مجلد حفظ الجلسات
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// دالة تشغيل جلسة واتساب مستقلة لكل صيدلية
async function startPharmacySession(pharmacyId) {
  const sessionPath = path.join(SESSIONS_DIR, `session_${pharmacyId}`);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  sessions[pharmacyId] = { sock: null, qr: null, status: 'CONNECTING' };

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' })
  });

  sessions[pharmacyId].sock = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessions[pharmacyId].qr = qr;
      sessions[pharmacyId].status = 'QR_READY';
      console.log(`📌 تم توليد QR جديد للصيدلية: ${pharmacyId}`);
    }

    if (connection === 'open') {
      sessions[pharmacyId].qr = null;
      sessions[pharmacyId].status = 'CONNECTED';
      console.log(`✅ الصيدلية (${pharmacyId}) اتصلت بالواتساب بنجاح!`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        console.log(`🔄 إعادة اتصال الصيدلية (${pharmacyId})...`);
        startPharmacySession(pharmacyId);
      } else {
        console.log(`❌ تم تسجيل خروج الصيدلية (${pharmacyId})`);
        sessions[pharmacyId].status = 'LOGGED_OUT';
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // الاستماع لردود الصيدلي على استعلامات الأدوية
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const sender = msg.key.remoteJid;

    if (text.includes("متوفر")) {
      console.log(`💊 رد من الصيدلية (${pharmacyId}): الدواء متوفر!`);
      // هنا يمكنك تحديث حالة الطلب في Firebase مباشرة ليظهر للعميل
    }
  });
}

// إعادة تشغيل الجلسات المحفوظة مسبقاً عند إقلاع السيرفر
function restoreAllSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const folders = fs.readdirSync(SESSIONS_DIR);
  for (const folder of folders) {
    if (folder.startsWith('session_')) {
      const pharmacyId = folder.replace('session_', '');
      console.log(`♻️ استعادة جلسة الصيدلية: ${pharmacyId}`);
      startPharmacySession(pharmacyId);
    }
  }
}

// الصفحة الرئيسية للسيرفر
app.get('/', (req, res) => {
  const activeCount = Object.keys(sessions).filter(id => sessions[id].status === 'CONNECTED').length;
  res.send(`
    <div style="font-family:sans-serif; text-align:center; margin-top:40px;">
      <h2>سيرفر بوت دواي (Multi-Session) يعمل بنجاح 🚀</h2>
      <p>عدد الصيدليات المتصلة حالياً: <strong>${activeCount}</strong></p>
    </div>
  `);
});

// مسار ربط صيدلية جديدة (يُستدعى من موقع Netlify)
app.get('/connect/:pharmacyId', async (req, res) => {
  const { pharmacyId } = req.params;
  if (!pharmacyId) return res.status(400).json({ error: "معرف الصيدلية مطلوب" });

  // إذا لم تكن هناك جلسة نشطة لهذه الصيدلية، ابدأ واحدة جديدة
  if (!sessions[pharmacyId] || sessions[pharmacyId].status === 'LOGGED_OUT') {
    await startPharmacySession(pharmacyId);
    return res.json({ status: 'INITIALIZING', message: 'جاري تجهيز الـ QR Code...' });
  }

  const currentSession = sessions[pharmacyId];

  if (currentSession.status === 'CONNECTED') {
    return res.json({ status: 'CONNECTED', message: 'هذه الصيدلية مرتبطة بالواتساب بالفعل ✅' });
  }

  if (currentSession.status === 'QR_READY' && currentSession.qr) {
    const qrImage = await qrcode.toDataURL(currentSession.qr);
    return res.json({ status: 'QR_READY', image: qrImage });
  }

  res.json({ status: 'WAITING', message: 'في انتظار توليد الكود...' });
});

// حساب المسافة الجغرافية
function deg2rad(deg) { return deg * (Math.PI / 180); }
function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2)**2 + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2)**2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// إرسال استعلام الدواء للصيدليات القريبة عبر جلساتها الخاصة
app.post('/send', async (req, res) => {
  try {
    const { medicine, userPhone, askId, lat, lng, range } = req.body;
    if (!medicine || !userPhone || !askId) return res.status(400).json({ error: "بيانات غير مكتملة" });

    let isLocationAvailable = (lat && lng);
    const searchRange = parseFloat(range) || 4;
    const phSnap = await db.collection("pharmacies").get();
    let sentCount = 0;

    for (const doc of phSnap.docs) {
      const p = doc.data();
      const pharmacyId = p.phone || doc.id; // استخدام رقم الصيدلية أو معرفها كـ ID للجلسة
      if (!p.phone) continue;

      let shouldSend = true;
      let distanceKm = null;

      if (isLocationAvailable && p.lat && p.lng) {
        distanceKm = getDistanceInKm(lat, lng, p.lat, p.lng);
        if (distanceKm > searchRange) shouldSend = false;
      } else if (isLocationAvailable && (!p.lat || !p.lng)) {
        shouldSend = false;
      }

      if (!shouldSend) continue;

      const whatsappMessage = `💊 *استعلام جديد عبر دواي*\n- الدواء المطلوب: *${medicine}*\n- رقم الطالب: ${userPhone}\n- رقم الطلب: ${askId}\n- المسافة: ${distanceKm !== null ? distanceKm.toFixed(1) + ' كم' : 'غير محددة'}\n\nللرد بتوفر الدواء، اكتب كلمة: *متوفر*`;

      // استخدام جلسة الصيدلية نفسها لإرسال التنبيه لرقمها
      const pharmacySession = sessions[pharmacyId];
      if (pharmacySession && pharmacySession.status === 'CONNECTED' && pharmacySession.sock) {
        await pharmacySession.sock.sendMessage(p.phone + "@s.whatsapp.net", { text: whatsappMessage });
        console.log(`📤 تم الإرسال عبر جلسة الصيدلية: ${p.name || pharmacyId}`);
        sentCount++;
      } else {
        console.log(`⚠️ الصيدلية (${p.name || pharmacyId}) غير متصلة بالبوت حالياً`);
      }
    }

    res.json({ success: true, message: `تم إرسال الاستعلام إلى ${sentCount} صيدلية متصلة` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
  restoreAllSessions();
});
