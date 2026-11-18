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

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// دالة لحفظ الـ creds في فايربيس لضمان عدم فقدانها عند ريستارت سيرفر Render
async function saveCredsToFirestore(pharmacyId, sessionPath) {
  try {
    const credsPath = path.join(sessionPath, 'creds.json');
    if (fs.existsSync(credsPath)) {
      const credsData = fs.readFileSync(credsPath, 'utf8');
      await db.collection("whatsapp_sessions").doc(pharmacyId).set({
        creds: credsData,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    }
  } catch (err) {
    console.error(`🔥 خطأ في رفع الجلسة لـ فايربيس للصيدلية ${pharmacyId}:`, err);
  }
}

// دالة لاسترجاع الـ creds من فايربيس قبل بدء الجلسة
async function restoreCredsFromFirestore(pharmacyId, sessionPath) {
  try {
    const doc = await db.collection("whatsapp_sessions").doc(pharmacyId).get();
    if (doc.exists && doc.data().creds) {
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
      }
      const credsPath = path.join(sessionPath, 'creds.json');
      fs.writeFileSync(credsPath, doc.data().creds, 'utf8');
      console.log(`🔄 تم استرجاع جلسة الصيدلية (${pharmacyId}) من فايربيس بنجاح.`);
    }
  } catch (err) {
    console.error(`🔥 خطأ في استرجاع الجلسة من فايربيس للصيدلية ${pharmacyId}:`, err);
  }
}

// دالة تشغيل جلسة واتساب مستقلة وصاروخية لكل صيدلية
async function startPharmacySession(pharmacyId) {
  const sessionPath = path.join(SESSIONS_DIR, `session_${pharmacyId}`);
  
  // استعادة الاعتمادات من فايربيس أولاً قبل تهيئة الحالة
  await restoreCredsFromFirestore(pharmacyId, sessionPath);

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
      // حفظ الاعتمادات في فايربيس فور الاتصال الناجح
      await saveCredsToFirestore(pharmacyId, sessionPath);
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
        try { 
          fs.rmSync(sessionPath, { recursive: true, force: true }); 
          await db.collection("whatsapp_sessions").doc(pharmacyId).delete();
        } catch (e) {}
      }
    }
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await saveCredsToFirestore(pharmacyId, sessionPath);
  });

  // الاستماع لرد الصيدلي بكلمة متوفر وتحديث الطلب في Firebase بدقة تامة
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const sender = msg.key.remoteJid;

    console.log(`📥 رسالة واردة من الصيدلية (${pharmacyId}): "${text}"`);

    if (text.trim().toLowerCase().includes("متوفر") || text.trim().toLowerCase().includes("موجود")) {
      console.log(`💊 الصيدلية (${pharmacyId}) أكدت توفر الدواء! جاري البحث عن أحدث طلب في Firebase...`);
      try {
        const requestsRef = db.collection("medicine_requests");
        
        // جلب أحدث طلب أُرسل لهذه الصيدلية أو أي طلب نشط
        const querySnapshot = await requestsRef
          .where("status", "==", "pending")
          .get();

        if (querySnapshot.empty) {
          console.log("⚠️ لا توجد طلبات بحالة pending حالياً في قاعدة البيانات.");
        } else {
          // تحديث أول طلب معلق وإثبات أن هذه الصيدلية هي التي ردت
          for (const doc of querySnapshot.docs) {
            await doc.ref.update({
              status: "available",
              availablePharmacyPhone: pharmacyId,
              updatedAt: new Date().toISOString()
            });
            console.log(`✅ تم تحديث حالة الطلب (${doc.id}) في Firebase بواسطة الصيدلية (${pharmacyId}) بنجاح`);
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

// استعادة الجلسات تلقائياً من فايربيس عند تشغيل السيرفر
async function restoreAllSessionsFromFirebase() {
  try {
    const snapshot = await db.collection("whatsapp_sessions").get();
    if (snapshot.empty) {
      console.log("ℹ️ لا توجد جلسات محفوظة مسبقاً في فايربيس.");
      return;
    }
    snapshot.forEach(doc => {
      const pharmacyId = doc.id;
      console.log(`🔄 جارٍ استعادة جلسة الصيدلية تلقائياً: ${pharmacyId}`);
      startPharmacySession(pharmacyId);
    });
  } catch (err) {
    console.error("🔥 خطأ في استعادة الجلسات من فايربيس:", err);
  }
}

// مسار الصفحة الرئيسية
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
    await db.collection("whatsapp_sessions").doc(pharmacyId).delete();
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

// مسار استقبال الاستعلام وإرساله للصيدليات وحفظه في medicine_requests
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

    // حفظ الاستعلام في medicine_requests بحالة pending ليتسنى للصيدلي تحديثه عند الرد
    await db.collection("medicine_requests").doc(askId).set({
      medicine,
      userPhone,
      askId,
      status: "pending",
      lat: lat || null,
      lng: lng || null,
      createdAt: new Date().toISOString()
    });

    res.json({ success: true, message: `تم إرسال الاستعلام إلى ${sentCount} صيدلية متصلة ضمن النطاق` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
  // استعادة الجلسات تلقائياً من فايربيس عند الإقلاع
  await restoreAllSessionsFromFirebase();
});
