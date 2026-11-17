const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const firebase = require("firebase/compat/app");
require("firebase/compat/firestore");

const app = express();
app.use(express.json());

// CORS
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

// تخزين واسترجاع بيانات الجلسة من Firebase Firestore لتجنب فقدانها عند إعادة تشغيل السيرفر
const useFirebaseAuthState = async (pharmacyId) => {
  const sessionRef = db.collection('whatsapp_sessions').doc(pharmacyId);
  const doc = await sessionRef.get();
  
  let creds = doc.exists && doc.data().creds ? doc.data().creds : undefined;
  let keys = doc.exists && doc.data().keys ? doc.data().keys : {};

  const saveState = async () => {
    await sessionRef.set({ creds, keys }, { merge: true });
  };

  return {
    state: {
      creds: creds || (await import('@whiskeysockets/baileys')).initAuthCreds(),
      keys: {
        get: async (type, ids) => {
          const dat = {};
          ids.forEach(id => {
            if (keys[type] && keys[type][id]) {
              dat[id] = keys[type][id];
            }
          });
          return dat;
        },
        set: async (data) => {
          for (const type of Object.keys(data)) {
            if (!keys[type]) keys[type] = {};
            for (const id of Object.keys(data[type])) {
              keys[type][id] = data[type][id];
            }
          }
          await saveState();
        }
      }
    },
    saveCreds: async () => {
      creds = (await useFirebaseAuthState(pharmacyId)).state.creds; // تحديث
      await saveState();
    }
  };
};

async function startPharmacySession(pharmacyId) {
  const { state, saveCreds } = await useFirebaseAuthState(pharmacyId);

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
      console.log(`📌 QR جديد جاهز للصيدلية: ${pharmacyId}`);
    }

    if (connection === 'open') {
      sessions[pharmacyId].qr = null;
      sessions[pharmacyId].status = 'CONNECTED';
      console.log(`✅ الصيدلية (${pharmacyId}) متصلة الآن بالواتساب!`);
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log(`🔄 إعادة اتصال الصيدلية (${pharmacyId})...`);
        startPharmacySession(pharmacyId);
      } else {
        console.log(`❌ تسجيل خروج الصيدلية (${pharmacyId})`);
        sessions[pharmacyId].status = 'LOGGED_OUT';
        await db.collection('whatsapp_sessions').doc(pharmacyId).delete();
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    if (text.includes("متوفر")) {
      console.log(`💊 الصيدلية (${pharmacyId}) أكدت توفر الدواء!`);
    }
  });
}

// استعادة الجلسات المخزنة في فايربيس تلقائياً عند إقلاع السيرفر
async function restoreSavedSessions() {
  try {
    const snapshot = await db.collection('whatsapp_sessions').get();
    snapshot.forEach(doc => {
      const pharmacyId = doc.id;
      console.log(`♻️ استعادة جلسة الصيدلية من Firebase: ${pharmacyId}`);
      startPharmacySession(pharmacyId);
    });
  } catch (e) {
    console.error("خطأ في استعادة الجلسات:", e);
  }
}

app.get('/', (req, res) => {
  res.send(`<h2>سيرفر دواي (Multi-Session + Firebase Auth) يعمل بنجاح 🚀</h2>`);
});

// مسار ربط الصيدلية وتوليد الـ QR
app.get('/connect/:pharmacyId', async (req, res) => {
  const { pharmacyId } = req.params;
  if (!pharmacyId) return res.status(400).json({ error: "رقم الصيدلية مطلوب" });

  if (!sessions[pharmacyId] || sessions[pharmacyId].status === 'LOGGED_OUT') {
    await startPharmacySession(pharmacyId);
    return res.json({ status: 'INITIALIZING', message: 'جاري توليد الكود...' });
  }

  const currentSession = sessions[pharmacyId];

  if (currentSession.status === 'CONNECTED') {
    return res.json({ status: 'CONNECTED', message: 'مرتبط بالواتساب ✅' });
  }

  if (currentSession.status === 'QR_READY' && currentSession.qr) {
    const qrImage = await qrcode.toDataURL(currentSession.qr);
    return res.json({ status: 'QR_READY', image: qrImage });
  }

  res.json({ status: 'WAITING', message: 'في انتظار الكود...' });
});

// مسار إرسال الاستعلام للصيدليات القريبة
app.post('/send', async (req, res) => {
  try {
    const { medicine, userPhone, askId } = req.body;
    const phSnap = await db.collection("pharmacies").get();
    let sentCount = 0;

    for (const doc of phSnap.docs) {
      const p = doc.data();
      const pharmacyId = p.phone;
      if (!pharmacyId) continue;

      const whatsappMessage = `💊 *استعلام جديد عن دواء*\n- الدواء: *${medicine}*\n- طالب الدواء: ${userPhone}\n- رقم الطلب: ${askId}\n\nيرجى الرد بكلمة: *متوفر*`;

      const pharmacySession = sessions[pharmacyId];
      if (pharmacySession && pharmacySession.status === 'CONNECTED' && pharmacySession.sock) {
        await pharmacySession.sock.sendMessage(pharmacyId + "@s.whatsapp.net", { text: whatsappMessage });
        sentCount++;
      }
    }

    res.json({ success: true, message: `تم الإرسال إلى ${sentCount} صيدلية متصلة` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
  restoreSavedSessions();
});
