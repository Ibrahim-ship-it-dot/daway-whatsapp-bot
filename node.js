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

// دالة لحفظ الـ creds في فايربيس
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

// دالة لاسترجاع الـ creds من فايربيس
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
  
  await restoreCredsFromFirestore(pharmacyId, sessionPath);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  sessions[pharmacyId] = { sock: null, qr: null, status: 'CONNECTING' };

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["Chrome (Linux)", "Desktop", "3.0"],
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    // معالجة صامتة لتجنب انهيار الاتصال عند وجود رسائل سابقة بتشفير قديم
    getMessage: async (key) => {
      return { conversation: "" };
    }
  });

  sessions[pharmacyId].sock = sock;

  // التقاط الأخطاء لمنع الـ Crash
  if (sock.ws) {
    sock.ws.on('error', (err) => {
      console.log('⚠️ تنبيه سوكت الواتساب:', err.message);
    });
  }

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

  // الاستماع للرد وتطبيق الشرط الحصري بكلمة "متوفر" فقط مع فلترة القنوات والمجموعات
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      
      const sender = msg.key.remoteJid;

      // 🛑 تجاهل تام لأي رسائل واردة من قنوات الواتساب أو المجموعات العامة
      if (sender.includes('@newsletter') || sender.endsWith('@g.us')) {
        return; 
      }

      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim().toLowerCase();

      console.log(`📥 رسالة واردة من الصيدلية (${pharmacyId}): "${text}"`);

      // الشرط الحصري: أن تكون الرسالة هي كلمة "متوفر" فقط لا غير
      if (text === "متوفر") {
        console.log(`💊 الصيدلية (${pharmacyId}) ردت بـ ("متوفر") وتم الحفظ في Firebase!`);
        try {
          const requestsRef = db.collection("medicine_requests");
          const querySnapshot = await requestsRef.where("status", "==", "pending").get();

          if (querySnapshot.empty) {
            console.log("⚠️ لا توجد طلبات معلقة (pending) حالياً.");
          } else {
            for (const doc of querySnapshot.docs) {
              await doc.ref.update({
                status: "available",
                availablePharmacyPhone: pharmacyId,
                responseCode: "متوفر", // حفظ الكلمة "متوفر" حصرياً في الحقل
                responseMessage: text,
                updatedAt: new Date().toISOString()
              });
              console.log(`✅ تم تحديث الطلب (${doc.id}) في Firebase بالقيمة ("متوفر") بنجاح`);
              await sock.sendMessage(sender, { text: "✅ تم تسجيل ردك (متوفر) بنجاح. شكراً لك!" });
              break;
            }
          }
        } catch (err) {
          console.error("🔥 خطأ في تحديث الطلب:", err);
        }
      } else {
        console.log(`ℹ️ الرسالة الواردة (${text}) لا تساوى كلمة "متوفر" حصرياً. تم تجاهلها.`);
      }
    } catch (err) {
      console.error("⚠️ خطأ معالجة الرسالة الواردة (تم تجاوزه):", err.message);
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

function deg2rad(deg) { return deg * (Math.PI / 180); }
function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2)**2 + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2)**2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// مسار استقبال الاستعلام وإرساله للصيدليات مع تنبيه الصيدلي بالرد بكلمة "متوفر" حصرياً
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

      const whatsappMessage = `💊 *استعلام جديد عبر دواي*\n- الدواء المطلوب: *${medicine}*\n- رقم الطالب: ${userPhone}\n- رقم الطلب: ${askId}\n- المسافة: ${distanceKm !== null ? distanceKm.toFixed(1) + ' كم' : 'غير محددة'}\n\nللرد بتوفر الدواء، اكتب كلمة: *متوفر* فقط.`;

      const pharmacySession = sessions[pharmacyId];
      if (pharmacySession && pharmacySession.status === 'CONNECTED' && pharmacySession.sock) {
        await pharmacySession.sock.sendMessage(p.phone + "@s.whatsapp.net", { text: whatsappMessage });
        console.log(`📤 تم الإرسال عبر جلسة الصيدلية: ${p.name || pharmacyId} (المسافة: ${distanceKm?.toFixed(1)} كم)`);
        sentCount++;
      }
    }

    // حفظ الاستعلام في medicine_requests مع تعيين القيمة الابتدائية بانتظار الرد
    await db.collection("medicine_requests").doc(askId).set({
      medicine,
      userPhone,
      askId,
      status: "pending",
      responseCode: "pending", // تبدأ بانتظار الرد وتتحول إلى "متوفر" عند الرد الصحيح
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
  await restoreAllSessionsFromFirebase();
});
