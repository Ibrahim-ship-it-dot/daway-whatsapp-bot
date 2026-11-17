const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const firebase = require("firebase/compat/app");
require("firebase/compat/firestore");

const app = express();
app.use(express.json());

// السماح بالاتصال من موقعك في Netlify
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

let latestQR = "";
let sock = null;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      latestQR = qr;
      console.log("📌 تم توليد QR Code جديد وجاهز في الرابط /qr");
    }

    if (connection === 'open') {
      latestQR = "CONNECTED";
      console.log("✅ تم الاتصال بالواتساب بنجاح!");
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("🔄 إعادة محاولة الاتصال...");
        startWhatsApp();
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// الصفحة الرئيسية تعرض الـ QR مباشرة كصورة
app.get('/', async (req, res) => {
  if (latestQR === "CONNECTED") {
    return res.send(`<div style="text-align:center; font-family:sans-serif; margin-top:50px;">
      <h2 style="color:green;">✅ بوت دواي متصل بالواتساب بنجاح!</h2>
    </div>`);
  }
  
  if (!latestQR) {
    return res.send(`<div style="text-align:center; font-family:sans-serif; margin-top:50px;">
      <h3>⏳ جاري توليد الـ QR Code... اعمل تحديث (Refresh) للصفحة بعد ثواني</h3>
      <script>setTimeout(() => location.reload(), 3000);</script>
    </div>`);
  }

  try {
    const qrImage = await qrcode.toDataURL(latestQR);
    res.send(`
      <div style="text-align:center; font-family:sans-serif; margin-top:30px;">
        <h2>امسح الكود لربط واتساب دواي 📱</h2>
        <img src="${qrImage}" style="width:300px; height:300px; border:2px solid #ccc; border-radius:10px;"/>
        <p style="color:#666;">يتم تحديث الصفحة تلقائياً كل 15 ثانية</p>
        <script>setTimeout(() => location.reload(), 15000);</script>
      </div>
    `);
  } catch (err) {
    res.status(500).send("خطأ في توليد الصورة");
  }
});

// مسار API مخصص لموقعك في Netlify لجلب الصورة والربط
app.get('/qr-data', async (req, res) => {
  if (latestQR === "CONNECTED") {
    return res.json({ status: "CONNECTED" });
  }
  if (!latestQR) {
    return res.json({ status: "WAITING" });
  }
  const qrImage = await qrcode.toDataURL(latestQR);
  res.json({ status: "QR_READY", image: qrImage });
});

// دالة حساب المسافة
function deg2rad(deg) { return deg * (Math.PI / 180); }
function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2)**2 + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2)**2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

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

      const whatsappMessage = `💊 استعلام جديد عن دواء:\n- الدواء: ${medicine}\n- طالب الدواء: ${userPhone}\n- معرف الطلب: ${askId}\n- المسافة: ${distanceKm !== null ? distanceKm.toFixed(1) + ' كم' : 'غير محددة'}\n\nيرجى الرد بـ (متوفر) أو (غير متوفر).`;
      
      if (sock && latestQR === "CONNECTED") {
        await sock.sendMessage(p.phone + "@s.whatsapp.net", { text: whatsappMessage });
      }

      console.log(`📤 توجيه الاستعلام للصيدلية (${p.name || p.phone})`);
      sentCount++;
    }

    res.json({ success: true, message: `تم إرسال السؤال إلى ${sentCount} صيدلية` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
  startWhatsApp();
});
