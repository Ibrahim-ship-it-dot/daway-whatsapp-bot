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

// CORS للسماح بالاتصال من موقعك على Netlify
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

const sessions = {}; // { pharmacyId: { sock, qr, status } }

// مجلد تخزين جلسات الواتساب محلياً لكل صيدلية
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// دالة تشغيل جلسة واتساب مستقلة وصاروخية لكل صيدلية
async function startPharmacySession(pharmacyId) {
  const sessionPath = path.join(SESSIONS_DIR, `session_${pharmacyId}`);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  sessions[pharmacyId] = { sock: null, qr: null, status: 'CONNECTING' };

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["Chrome (Linux)", "Desktop", "3.0"],
    logger: pino({ level: 'silent' })
  });

  sessions[pharmacyId].sock = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessions[pharmacyId].qr = qr;
      sessions[pharmacyId].status = 'QR_READY';
      console.log(`📌 QR جديد جاهز للصيدلية: ${pharmacyId}`);
    }

    if (connection === 'open') {
      sessions[pharmacyId].qr = null;
      sessions[pharmacyId].status = 'CONNECTED';
      console.log(`✅ الصيدلية (${pharmacyId}) متصلة بالواتساب بنجاح!`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        console.log(`🔄 إعادة اتصال الصيدلية (${pharmacyId})...`);
        setTimeout(() => startPharmacySession(pharmacyId), 3000);
      } else {
        console.log(`❌ تسجيل خروج الصيدلية (${pharmacyId})`);
        sessions[pharmacyId].status = 'LOGGED_OUT';
        try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // الاستماع لرد الصيدلي بكلمة متوفر وتحديث الطلب في Firebase
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const sender = msg.key.remoteJid;

    if (text.trim().toLowerCase().includes("متوفر") || text.trim().toLowerCase().includes("موجود")) {
      console.log(`💊 الصيدلية (${pharmacyId}) أكدت توفر الدواء!`);
      try {
        const requestsRef = db.collection("medicine_requests");
        const querySnapshot = await requestsRef.where("status", "==", "pending").get();

        if (!querySnapshot.empty) {
          for (const doc of querySnapshot.docs) {
            await doc.ref.update({
              status: "available",
              availablePharmacyPhone: pharmacyId,
              updatedAt: new Date().toISOString()
            });
            console.log(`✅ تم تحديث حالة الطلب (${doc.id}) في Firebase بنجاح`);
            await sock.sendMessage(sender, { text: "✅ تم تسجيل ردك بنجاح وإبلاغ العميل في منصة دواي. شكراً لك!" });
            break;
          }
        }
      } catch (err) {
        console.error("🔥 خطأ في تحديث الطلب:", err);
      }
    }
  });
}

function restoreLocalSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const folders = fs.readdirSync(SESSIONS_DIR);
  for (const folder of folders) {
    if (folder.startsWith('session_')) {
      const pharmacyId = folder.replace('session_', '');
      startPharmacySession(pharmacyId);
    }
  }
}

// مسار الصفحة الرئيسية (لوحة التحكم البسيطة لربط الصيدليات)
app.get('/', (req, res) => {
  res.send(`<h2>سيرفر بوت دواي (Multi-Session) يعمل بنجاح 🚀</h2>`);
});

app.get('/connect/:pharmacyId', async (req, res) => {
  const { pharmacyId } = req.params;
  if (!pharmacyId) return res.status(400).json({ error: "رقم الصيدلية مطلوب" });

  if (!sessions[pharmacyId] || sessions[pharmacyId].status === 'LOGGED_OUT') {
    await startPharmacySession(pharmacyId);
    return res.json({ status: 'INITIALIZING', message: 'جاري توليد الكود...' });
  }

  const currentSession = sessions[pharmacyId];
  if (currentSession.status === 'CONNECTED') return res.json({ status: 'CONNECTED', message: 'مرتبط بالواتساب ✅' });
  if (currentSession.status === 'QR_READY' && currentSession.qr) {
    const qrImage = await qrcode.toDataURL(currentSession.qr);
    return res.json({ status: 'QR_READY', image: qrImage });
  }

  res.json({ status: 'WAITING', message: 'في انتظار الكود...' });
});

app.post('/disconnect/:pharmacyId', async (req, res) => {
  try {
    const { pharmacyId } = req.params;
    const sessionPath = path.join(SESSIONS_DIR, `session_${pharmacyId}`);
    if (sessions[pharmacyId]?.sock) {
      try { await sessions[pharmacyId].sock.logout(); } catch(e){}
      delete sessions[pharmacyId];
    }
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    res.json({ success: true, message: "تم حذف الجلسة بنجاح" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// دوال حساب المسافة الجغرافية (Haversine Formula)
function deg2rad(deg) { return deg * (Math.PI / 180); }
function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2)**2 + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2)**2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// مسار استقبال الاستعلام من واجهة Netlify وإرساله للصيدليات القريبة ضمن النطاق
app.post('/send', async (req, res) => {
  try {
    const { medicine, userPhone, askId, lat, lng, range } = req.body;
    if (!medicine || !userPhone || !askId) return res.status(400).json({ error: "بيانات غير مكتملة" });

    let isLocationAvailable = (lat && lng);
    const searchRange = parseFloat(range) || 4; // النطاق الافتراضي 4 كم مطابقة لواجهتك
    const phSnap = await db.collection("pharmacies").get();
    let sentCount = 0;

    for (const doc of phSnap.docs) {
      const p = doc.data();
      const pharmacyId = p.phone || doc.id;
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

      const pharmacySession = sessions[pharmacyId];
      if (pharmacySession && pharmacySession.status === 'CONNECTED' && pharmacySession.sock) {
        await pharmacySession.sock.sendMessage(p.phone + "@s.whatsapp.net", { text: whatsappMessage });
        console.log(`📤 تم الإرسال عبر جلسة الصيدلية: ${p.name || pharmacyId} (المسافة: ${distanceKm?.toFixed(1)} كم)`);
        sentCount++;
      }
    }

    res.json({ success: true, message: `تم إرسال الاستعلام إلى ${sentCount} صيدلية متصلة ضمن النطاق` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
  restoreLocalSessions();
});
