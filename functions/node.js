// =======================================================
// 📦 WhatsApp Bot (Baileys) + Firebase Firestore (Client SDK)
// =======================================================
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const firebase = require("firebase/compat/app");
require("firebase/compat/firestore");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

// ====== Firebase Config (Client SDK) ======
const firebaseConfig = {
  apiKey: "AIzaSyDlEBzVFhJzFkDI4mWnTSEQbUGOYBoVvbI",
  authDomain: "group-2f790.firebaseapp.com",
  projectId: "group-2f790",
  storageBucket: "group-2f790.firebasestorage.app",
  messagingSenderId: "532610990999",
  appId: "1:532610990999:web:1ad2bf5149c68774e57ad2",
};

// ====== Firebase Init ======
let db;
try {
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  console.log("✅ Firebase initialized (Client SDK)");
} catch (e) {
  console.error("🔥 Firebase Init Failed:", e);
}

// ====== إعدادات الجلسات والمهلة (15 دقيقة) ======
const SESSIONS_ROOT = path.join(__dirname, "sessions");
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // ربع ساعة

if (!fs.existsSync(SESSIONS_ROOT)) {
  fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
}

const sessionsMap = new Map();
// ربط معرف رسالة الاستعلام المرسلة ببيانات السؤال (askId, pharmacyId, medicine, questionText)
const sentQuestionMetaMap = new Map();

function cleanPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function phoneToJid(phone) {
  const cleaned = cleanPhone(phone);
  if (!cleaned || cleaned.length < 8) return null;
  return `${cleaned}@s.whatsapp.net`;
}

// 📐 دالة مساعدة لتحويل الدرجات إلى راديان
function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

// 🌐 دالة Haversine لحساب المسافة بين نقطتين بالكيلومتر
function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function unwrapMessage(message) {
  if (!message) return null;
  return (
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.editedMessage?.message ||
    message
  );
}

function extractMessageText(message) {
  const unwrapped = unwrapMessage(message);
  if (!unwrapped) return "";

  return (
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.imageMessage?.caption ||
    unwrapped.videoMessage?.caption ||
    unwrapped.buttonsResponseMessage?.selectedDisplayText ||
    unwrapped.listResponseMessage?.title ||
    ""
  ).trim();
}

// استخراج بيانات الرسالة المقتبسة كاملة
function extractQuotedMessageData(message, sess) {
  const unwrapped = unwrapMessage(message);
  if (!unwrapped) return null;

  const ctx =
    unwrapped.extendedTextMessage?.contextInfo ||
    unwrapped.imageMessage?.contextInfo ||
    unwrapped.videoMessage?.contextInfo ||
    unwrapped.documentMessage?.contextInfo ||
    null;

  if (!ctx) return null;

  const stanzaId = ctx.stanzaId || "";
  const participant = ctx.participant || "";
  const remoteJid = ctx.remoteJid || "";
  let quotedText = ctx.quotedMessage ? extractMessageText(ctx.quotedMessage) : "";

  if (!quotedText && stanzaId && sess?.sentMessagesStore?.has(stanzaId)) {
    quotedText = extractMessageText(sess.sentMessagesStore.get(stanzaId));
  }

  const matchedMeta = stanzaId ? sentQuestionMetaMap.get(stanzaId) : null;

  if (!quotedText && !stanzaId && !participant && !remoteJid && !matchedMeta) {
    return null;
  }

  return {
    stanzaId,
    participant,
    remoteJid,
    quotedText: quotedText || matchedMeta?.messageText || "",
    askId: matchedMeta?.askId || null,
    pharmacyId: matchedMeta?.pharmacyId || null,
    medicine: matchedMeta?.medicine || null,
  };
}

function getOrCreateSession(sessionId = "default") {
  const id = String(sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "") || "default";
  if (!sessionsMap.has(id)) {
    sessionsMap.set(id, {
      id,
      authDir: path.join(SESSIONS_ROOT, id),
      sock: null,
      status: "disconnected",
      manualClose: false,
      idleTimer: null,
      sentByBotIds: new Set(),
      sentMessagesStore: new Map(),
      lastAskContext: null,
      onConnectedCallbacks: [],
    });
  }
  return sessionsMap.get(id);
}

function clearSessionTimer(sess) {
  if (sess?.idleTimer) {
    clearTimeout(sess.idleTimer);
    sess.idleTimer = null;
  }
}

function scheduleSessionCloseAfter15Min(sess) {
  clearSessionTimer(sess);
  sess.idleTimer = setTimeout(async () => {
    console.log(`⏳ انتهت ربع ساعة بدون نشاط للجلسة [${sess.id}] -> إغلاق الجلسة...`);
    await closeWhatsAppSession(sess.id);
  }, SESSION_IDLE_TIMEOUT_MS);
}

async function closeWhatsAppSession(sessionId = "default") {
  const sess = sessionsMap.get(sessionId);
  if (!sess) return;
  clearSessionTimer(sess);
  sess.manualClose = true;
  if (sess.sock) {
    try {
      sess.sock.end(new Error("Session closed after idle timeout or manual close"));
    } catch (_) {}
    sess.sock = null;
  }
  sess.status = "closed";
  console.log(`🔒 تم إغلاق جلسة الواتساب [${sess.id}]`);
}

function waitUntilReady(sess, timeoutMs = 25000) {
  if (sess.status === "connected" && sess.sock) {
    return Promise.resolve(sess);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`انتهت مهلة اتصال جلسة الواتساب [${sess.id}]`));
    }, timeoutMs);

    const interval = setInterval(() => {
      if (sess.status === "connected" && sess.sock) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(sess);
      }
    }, 150);

    sess.onConnectedCallbacks.push(() => {
      clearTimeout(timer);
      clearInterval(interval);
      resolve(sess);
    });
  });
}

// تحديد حالة الرد (متوفر / غير متوفر) من نص الرد
function parseAvailabilityStatus(replyText) {
  const normalized = String(replyText || "").trim().toLowerCase();
  if (
    normalized.includes("غير متوفر") ||
    normalized === "لا" ||
    normalized.includes("ما متوفر") ||
    normalized.includes("خالص") ||
    normalized.includes("unavailable") ||
    normalized === "no"
  ) {
    return "غير متوفر";
  }
  if (
    normalized.includes("متوفر") ||
    normalized === "نعم" ||
    normalized.includes("موجود") ||
    normalized.includes("available") ||
    normalized === "yes"
  ) {
    return "متوفر";
  }
  return replyText.trim();
}

// معالجة الرد الواصل من واتساب وحفظه مع بيانات الرسالة المقتبسة في Firestore
async function handleIncomingWhatsAppReply(sess, msg) {
  const remoteJid = msg.key?.remoteJid || "";
  const msgId = msg.key?.id || String(Date.now());
  const text = extractMessageText(msg.message);
  if (!text || !remoteJid) return;

  if (msg.key?.id && msg.message) {
    sess.sentMessagesStore.set(msg.key.id, msg.message);
    if (sess.sentMessagesStore.size > 300) {
      const firstKey = sess.sentMessagesStore.keys().next().value;
      sess.sentMessagesStore.delete(firstKey);
    }
  }

  // تجاهل الرسائل اللي أرسلها البوت نفسه
  if (sess.sentByBotIds.has(msgId)) return;

  // تجديد عدّاد الربع ساعة عند استقبال أي رسالة
  scheduleSessionCloseAfter15Min(sess);

  const quotedMessageData = extractQuotedMessageData(msg.message, sess);
  const senderPhone = cleanPhone(remoteJid.split("@")[0]);

  // تحديد askId و pharmacyId إما من الرسالة المقتبسة أو من آخر استعلام مرتبط بالمرسل
  let askId = quotedMessageData?.askId || null;
  let pharmacyId = quotedMessageData?.pharmacyId || null;

  if (!askId && sess.lastAskContext) {
    askId = sess.lastAskContext.askId;
  }

  if (!pharmacyId && senderPhone && db) {
    const phSnap = await db
      .collection("pharmacies")
      .where("phone", "==", senderPhone)
      .limit(1)
      .get();
    if (!phSnap.empty) {
      pharmacyId = phSnap.docs[0].id;
    }
  }

  if (!askId || !db) return;

  try {
    const askDocRef = db.collection("AskPharmacy").doc(askId);
    const askDoc = await askDocRef.get();
    if (!askDoc.exists) return;

    const askData = askDoc.data();
    const resolvedPharmacyId = pharmacyId || remoteJid;
    const statusLabel = parseAvailabilityStatus(text);
    const responses = Array.isArray(askData.responses) ? [...askData.responses] : [];

    const replyRecord = {
      pharmacyId: resolvedPharmacyId,
      senderJid: remoteJid,
      senderPhone,
      status: statusLabel,
      rawReplyText: text,
      isQuotedReply: Boolean(quotedMessageData),
      quotedMessageData: quotedMessageData || null,
      respondedAt: new Date().toISOString(),
    };

    const existingIdx = responses.findIndex((r) => r.pharmacyId === resolvedPharmacyId);
    if (existingIdx >= 0) {
      responses[existingIdx] = replyRecord;
    } else {
      responses.push(replyRecord);
    }

    const availableCount = responses.filter((r) => r.status === "متوفر").length;
    const finalStatus = availableCount > 0 ? "متوفر" : "غير متوفر";

    await askDocRef.update({
      responses,
      Status: finalStatus,
      lastReplyText: text,
      lastQuotedMessageData: quotedMessageData || null,
      updatedAt: new Date().toISOString(),
    });

    console.log(
      `💾 تم حفظ رد واتساب في Firestore للاستعلام [${askId}] | الحالة: ${statusLabel} | مقتبس:`,
      quotedMessageData ? quotedMessageData.stanzaId || "نعم" : "لا"
    );

    // إشعار المستخدم عبر واتساب إذا كان له رقم/JID في مجموعة Users
    if (askData.UserPhone) {
      const cleanUserPhone = cleanPhone(askData.UserPhone);
      const userSnap = await db
        .collection("Users")
        .where("phone", "==", askData.UserPhone)
        .limit(1)
        .get();

      const fallbackUserSnap = userSnap.empty && cleanUserPhone
        ? await db.collection("Users").where("phone", "==", cleanUserPhone).limit(1).get()
        : userSnap;

      const userJid =
        (!fallbackUserSnap.empty && fallbackUserSnap.docs[0].data().whatsappJid) ||
        phoneToJid(askData.UserPhone);

      if (userJid && sess.sock) {
        await sess.sock.sendMessage(userJid, {
          text: `💬 تحديث بخصوص "${askData.medicine}": ${statusLabel}\nالرد: ${text}${
            quotedMessageData?.quotedText ? `\nالرسالة المقتبسة: ${quotedMessageData.quotedText}` : ""
          }`,
        });
      }
    }
  } catch (err) {
    console.error("🔥 خطأ أثناء حفظ الرد والرسالة المقتبسة في Firebase:", err);
  }
}

async function startWhatsAppSession(sessionId = "default") {
  const sess = getOrCreateSession(sessionId);
  sess.manualClose = false;
  scheduleSessionCloseAfter15Min(sess);

  if (sess.sock && sess.status === "connected") {
    return sess;
  }

  if (!fs.existsSync(sess.authDir)) {
    fs.mkdirSync(sess.authDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sess.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    getMessage: async (key) => {
      if (!key?.id) return undefined;
      return sess.sentMessagesStore.get(key.id);
    },
  });

  sess.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      sess.status = "connected";
      scheduleSessionCloseAfter15Min(sess);
      console.log(`✅ جلسة الواتساب [${sess.id}] متصلة وجاهزة`);
      const cbs = sess.onConnectedCallbacks.splice(0);
      cbs.forEach((cb) => cb(sess));
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      sess.sock = null;

      if (sess.manualClose) {
        clearSessionTimer(sess);
        sess.status = "closed";
        return;
      }

      sess.status = "disconnected";
      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          if (!sess.manualClose) startWhatsAppSession(sess.id);
        }, 1500);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      await handleIncomingWhatsAppReply(sess, msg);
    }
  });

  return sess;
}

// 💊 دالة إرسال سؤال إلى الصيدليات عبر واتساب ضمن النطاق المحدد
async function handleAskPharmacy(
  sessionId = "default",
  { medicine, userPhone, askId, lat, lng, range }
) {
  try {
    const sess = await startWhatsAppSession(sessionId);
    await waitUntilReady(sess, 25000);
    scheduleSessionCloseAfter15Min(sess);

    let isLocationAvailable = false;
    if (lat && lng) {
      isLocationAvailable = true;
      console.log(`✅ الموقع متوفر: (${lat}, ${lng}). سيتم البحث ضمن نطاق ${range} كم.`);
    } else {
      console.warn("⚠️ الموقع (lat/lng) غير متوفر. يتم الإرسال لجميع الصيدليات.");
    }

    const searchRange = parseFloat(range) || 4;
    const phSnap = await db.collection("pharmacies").get();

    let sentCount = 0;
    let filteredCount = 0;

    sess.lastAskContext = { askId, medicine, userPhone };

    for (const doc of phSnap.docs) {
      const p = doc.data();
      const targetJid = p.whatsappJid || phoneToJid(p.phone);
      if (!targetJid) continue;

      let shouldSend = true;
      let distanceKm = null;

      if (isLocationAvailable && p.lat && p.lng) {
        distanceKm = getDistanceInKm(lat, lng, p.lat, p.lng);
        if (distanceKm > searchRange) {
          shouldSend = false;
          filteredCount++;
        }
      } else if (isLocationAvailable && (!p.lat || !p.lng)) {
        shouldSend = false;
        filteredCount++;
      }

      if (!shouldSend) continue;

      const messageText =
        `💊 استعلام جديد:\nالدواء: ${medicine}\nمن المستخدم: ${userPhone}\n(ID: ${askId})\n` +
        `${distanceKm !== null ? `(على بعد: ${distanceKm.toFixed(1)} كم)\n` : ""}` +
        `اعمل رد (Reply) على هذه الرسالة واكتب: متوفر أو غير متوفر`;

      const sentMsg = await sess.sock.sendMessage(targetJid, { text: messageText });

      if (sentMsg?.key?.id) {
        sess.sentByBotIds.add(sentMsg.key.id);
        if (sentMsg.message) {
          sess.sentMessagesStore.set(sentMsg.key.id, sentMsg.message);
        }
        sentQuestionMetaMap.set(sentMsg.key.id, {
          askId,
          pharmacyId: doc.id,
          medicine,
          messageText,
        });
      }

      scheduleSessionCloseAfter15Min(sess);
      sentCount++;
    }

    console.log(
      `✅ تم إرسال السؤال عبر واتساب إلى ${sentCount} صيدلية. تم تصفية ${filteredCount} صيدلية خارج النطاق.`
    );
  } catch (e) {
    console.error("🚫 فشل إرسال السؤال عبر واتساب:", e);
  }
}

// ====== Handler متوافق مع Netlify / Serverless ======
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: "OK",
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    if (body.medicine && body.userPhone && body.askId) {
      await handleAskPharmacy(body.sessionId || "default", body);
      return {
        statusCode: 200,
        body: "تم إرسال السؤال عبر واتساب إلى الصيدليات ضمن النطاق الجغرافي",
        headers: CORS_HEADERS,
      };
    }

    await startWhatsAppSession(body.sessionId || "default");
    return {
      statusCode: 200,
      body: "OK",
      headers: CORS_HEADERS,
    };
  } catch (err) {
    console.error("WhatsApp handler error:", err);
    return {
      statusCode: 500,
      body: `Error: ${err.message || err.toString()}`,
      headers: CORS_HEADERS,
    };
  }
};

// تشغيل الجلسة تلقائياً عند تشغيل السكربت مباشرة
if (require.main === module) {
  startWhatsAppSession("default").catch((e) => console.error("Startup error:", e));
}
