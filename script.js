// PWA: تسجيل Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js')
            .then(registration => {
                console.log('ServiceWorker registered successfully with scope: ', registration.scope);
            })
            .catch(error => {
                console.error('ServiceWorker registration failed: ', error);
            });
    });
}

const firebaseConfig = {
    apiKey: "AIzaSyDlEBzVFhJzFkDI4mWnTSEQbUGOYBoVvbI",
    authDomain: "group-2f790.firebaseapp.com",
    projectId: "group-2f790",
    storageBucket: "group-2f790.firebasestorage.app",
    messagingSenderId: "532610990999",
    appId: "1:532610990999:web:1ad2bf5149c68774e57ad2"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

function saveQuestionLocally(phone, questionObj) {
    if (!phone || !questionObj || !questionObj.medicine) return;
    const key = "savedUserQuestions_" + phone;
    let list = [];
    try { list = JSON.parse(localStorage.getItem(key) || "[]"); } catch (_) { list = []; }
    const idx = list.findIndex(item => (questionObj.id && item.id === questionObj.id) || item.medicine === questionObj.medicine);
    const merged = {
        id: questionObj.id || ("local_" + Date.now()),
        UserPhone: phone,
        medicine: questionObj.medicine,
        Status: questionObj.Status || "غير متوفر",
        createdAt: questionObj.createdAt || new Date().toISOString(),
        responses: Array.isArray(questionObj.responses) ? questionObj.responses : []
    };
    if (idx >= 0) {
        list[idx] = { ...list[idx], ...merged };
    } else {
        list.unshift(merged);
    }
    localStorage.setItem(key, JSON.stringify(list.slice(0, 40)));
}

function getLocalSavedQuestions(phone) {
    if (!phone) return [];
    try {
        return JSON.parse(localStorage.getItem("savedUserQuestions_" + phone) || "[]");
    } catch (_) {
        return [];
    }
}

function applyResponsesDirectlyToCards(responses, queryId = "") {
    if (!Array.isArray(responses) || !responses.length) return false;
    const seenReplyKeys = new Set();
    let updatedAny = false;

    responses.forEach((r, idx) => {
        if (!r || typeof r !== "object") return;
        const rAskId = String(r.askId || r.questionId || r.queryId || "").trim();
        if (queryId && rAskId && rAskId !== String(queryId).trim()) return;

        const replyUniqueId = String(r.id || r.replyId || r.stanzaId || r.messageId || "").trim();
        const dedupKey = replyUniqueId || [
            rAskId || queryId || "",
            String(r.pharmacyId || r.pharmacyPhone || r.senderPhone || r.phone || idx).trim(),
            String(r.status || r.rawReplyText || r.replyText || r.reply || r.text || "").trim()
        ].join("::");

        if (seenReplyKeys.has(dedupKey)) return;
        seenReplyKeys.add(dedupKey);

        const targetAskId = rAskId || queryId || "";
        if (applySinglePharmacyReplyToDOM(r, targetAskId)) {
            updatedAny = true;
        }
    });

    return updatedAny;
}

function applySinglePharmacyReplyToDOM(replyObj, fallbackQueryId = "") {
    if (!replyObj || typeof replyObj !== "object") return false;
    const container = document.getElementById("pharmaciesContainer");
    if (!container) return false;
    const cards = Array.from(container.querySelectorAll(".pharmacy"));
    if (!cards.length) return false;

    const rId = String(replyObj.pharmacyId || replyObj.sessionId || "").trim();
    const rName = String(replyObj.pharmacyName || replyObj.name || "").trim().toLowerCase();
    const rPhones = [
        replyObj.pharmacyPhone, replyObj.senderPhone, replyObj.phone, replyObj.jid
    ].map(normalizePhoneDigits).filter(Boolean);

    let matchedCard = null;
    for (const card of cards) {
        const cardId = String(card.dataset.id || "").trim();
        const cardText = String(card.textContent || "");
        const phoneMatch = cardText.match(/رقم الصيدلية[:\s]*([+\d\s-]{7,20})/);
        const cardPhone = normalizePhoneDigits(phoneMatch ? phoneMatch[1] : "");
        const titleEl = card.querySelector(".pharmacy-info strong");
        const cardName = String(titleEl ? titleEl.textContent : "").trim().toLowerCase();

        const idHit = rId && (cardId === rId || phonesMatch(cardId, rId));
        const phoneHit = rPhones.some(rp =>
            (cardPhone && phonesMatch(cardPhone, rp)) || (cardId && phonesMatch(cardId, rp))
        );
        const nameHit = rName && cardName && (cardName === rName || cardName.includes(rName) || rName.includes(cardName));

        if (idHit || phoneHit || nameHit) {
            matchedCard = card;
            break;
        }
    }

    if (!matchedCard && cards.length === 1) {
        matchedCard = cards[0];
    }
    if (!matchedCard) return false;

    const statusText = resolveDisplayStatus(replyObj, null);
    const isAvail = statusText === "متوفر";
    const statusClass = isAvail ? "status-available" : "status-unavailable";
    const borderClass = isAvail ? "status-available-border" : "status-unavailable-border";

    matchedCard.classList.remove("status-pending-border", "status-available-border", "status-unavailable-border");
    matchedCard.classList.add(borderClass);

    const statusSec = matchedCard.querySelector(".status-section");
    if (statusSec) {
        statusSec.classList.remove("status-pending", "status-available", "status-unavailable");
        statusSec.classList.add(statusClass);
        statusSec.innerHTML = `${getStatusIcon(statusText)}<span style="line-height:1.2;">${escapeHtmlText(statusText)}</span>`;
    }

    const responderPhone = replyObj.pharmacyPhone || replyObj.senderPhone || replyObj.phone || "";
    const rawReplyText = replyObj.rawReplyText || replyObj.replyText || replyObj.reply || replyObj.text || "";
    const refId = replyObj.askId || replyObj.questionId || fallbackQueryId || "";

    let detailsBox = matchedCard.querySelector(".live-response-details-box");
    if (!detailsBox) {
        detailsBox = document.createElement("div");
        detailsBox.className = "live-response-details-box";
        detailsBox.style.cssText = "font-size:12px; margin-top:6px; line-height:1.5; text-align:right; color:#222; background:#f8f9fa; padding:6px 8px; border-radius:6px; box-sizing:border-box;";
        if (statusSec && statusSec.parentNode) {
            statusSec.parentNode.appendChild(detailsBox);
        } else {
            matchedCard.appendChild(detailsBox);
        }
    }

    detailsBox.innerHTML =
        (responderPhone ? `<div><strong>رقم الصيدلية:</strong> ${escapeHtmlText(responderPhone)}</div>` : "") +
        (rawReplyText && rawReplyText !== statusText ? `<div><strong>الرد:</strong> ${escapeHtmlText(rawReplyText)}</div>` : "") +
        (refId ? `<div><strong>المرجع:</strong> ${escapeHtmlText(refId)}</div>` : "");

    if (typeof lucide !== "undefined" && lucide.createIcons) {
        lucide.createIcons();
    }
    return true;
}

function withTimeout(promise, ms = 3000, label = "operation") {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("انتهت مهلة: " + label)), ms))
    ]);
}

let userLocation = { lat: null, lng: null };
let isLocationAvailable = false;
let isQueryActive = false;
let cachedPharmaciesDocs = null;
let cachedPharmaciesTime = 0;

function closeSidebar(){ document.getElementById('sidebar').style.width='0'; }
function closeInfoSidebar(){ document.getElementById('infoSidebar').style.width='0'; }
function toggleSidebar(){ const sidebar=document.getElementById('sidebar'); sidebar.style.width = sidebar.style.width==='250px'?'0':'250px'; closeInfoSidebar(); }
function toggleInfoSidebar(){ const sidebar=document.getElementById('infoSidebar'); sidebar.style.width = sidebar.style.width==='250px'?'0':'250px'; closeSidebar(); }
function showSessionInfo(phone){
    const el = document.getElementById('sessionInfo');
    if(el) el.innerText="رقم الجلسة: "+phone;
}

function setSendingIndicator(show, customText = "⏳ جاري إظهار الصيدليات وإرسال السؤال لها...") {
    let banner = document.getElementById('sendingQuestionsBanner');
    const pharmContainer = document.getElementById('pharmaciesContainer');

    if (!banner && pharmContainer && pharmContainer.parentNode) {
        banner = document.createElement('div');
        banner.id = 'sendingQuestionsBanner';
        banner.style.cssText = [
            "max-width:600px",
            "margin:10px auto",
            "padding:9px 14px",
            "border-radius:8px",
            "background:#e0f7fa",
            "color:#006064",
            "border:1px solid #80deea",
            "font-size:13px",
            "font-weight:700",
            "text-align:center",
            "box-sizing:border-box"
        ].join(";");
        pharmContainer.parentNode.insertBefore(banner, pharmContainer);
    }

    if (!banner) return;
    if (show) {
        banner.textContent = customText;
        banner.classList.remove('hidden');
        banner.style.display = 'block';
    } else {
        banner.classList.add('hidden');
        banner.style.display = 'none';
    }
}

function getStatusIcon(statusText) {
    if (statusText === "متوفر") return `<i data-lucide="check-circle" style="width:15px; height:15px; flex-shrink:0;"></i>`;
    if (statusText === "غير متوفر" || statusText === "غير متصل" || statusText === "متوقف") {
        return `<i data-lucide="x-circle" style="width:15px; height:15px; flex-shrink:0;"></i>`;
    }
    return `<i data-lucide="hourglass" style="width:15px; height:15px; flex-shrink:0;"></i>`;
}

function normalizePhoneDigits(val) {
    return String(val || "").replace(/\D/g, "");
}

function phonesMatch(a, b) {
    const cleanA = normalizePhoneDigits(a);
    const cleanB = normalizePhoneDigits(b);
    if (!cleanA || !cleanB) return false;
    if (cleanA === cleanB) return true;
    const tailA = cleanA.length > 9 ? cleanA.slice(-9) : cleanA;
    const tailB = cleanB.length > 9 ? cleanB.slice(-9) : cleanB;
    return tailA.length >= 7 && tailA === tailB;
}

function findPharmacyResponse(responses, pharmacy) {
    const list = Array.isArray(responses) ? responses : [];
    if (!list.length || !pharmacy) return null;

    return (
        list.find(r => r && (r.pharmacyId === pharmacy.id || (pharmacy.phone && r.pharmacyId === pharmacy.phone))) ||
        list.find(r => r && phonesMatch(r.senderPhone || r.phone || r.pharmacyPhone, pharmacy.phone)) ||
        null
    );
}

function resolveDisplayStatus(response, sessionMeta = null) {
    if (response) {
        const candidate = String(
            response.status || response.rawReplyText || response.replyText || response.text || ""
        ).trim();
        if (candidate) {
            const lower = candidate.toLowerCase();
            if (lower.includes("غير متوفر") || lower === "لا" || lower.includes("ما متوفر") || lower === "no") {
                return "غير متوفر";
            }
            if (lower.includes("متوفر") || lower === "نعم" || lower.includes("موجود") || lower === "yes") {
                return "متوفر";
            }
            return candidate;
        }
    }

    if (!sessionMeta) {
        return "جاري الرد";
    }
    if (!sessionMeta.hasSavedSession) {
        return "متوقف";
    }
    if (!sessionMeta.isWhatsappConnected) {
        return "غير متصل";
    }
    return "جاري الرد";
}

function escapeHtmlText(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function getCachedPharmaciesList(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedPharmaciesDocs && (now - cachedPharmaciesTime) < 30000) {
        return cachedPharmaciesDocs;
    }
    try {
        const snap = await db.collection('pharmacies').get();
        const list = [];
        snap.forEach(phDoc => {
            const d = phDoc.data() || {};
            d.id = phDoc.id;
            list.push(d);
        });
        console.log("📦 عدد الصيدليات من Firestore (pharmacies):", list.length, list);
        cachedPharmaciesDocs = list;
        cachedPharmaciesTime = now;
        return list;
    } catch (err) {
        console.error("🔥 خطأ قراءة pharmacies من Firestore:", err);
        throw err;
    }
}

async function fetchPharmacySessionStatusesMap() {
    const map = new Map();
    try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 3500);
        const res = await fetch('/api/pharmacy-sessions', { signal: controller.signal });
        clearTimeout(tid);
        if (res.ok) {
            const data = await res.json();
            (data.pharmacies || []).forEach(item => {
                if (item.pharmacyId) map.set(String(item.pharmacyId), item);
                const digits = normalizePhoneDigits(item.phone);
                if (digits) map.set(digits, item);
            });
        }
    } catch (_) {}
    return map;
}

function showError(title,error){
    console.error("🔥",title,error);
    const box = document.getElementById('errorBox');
    if(box) {
        box.classList.remove('hidden');
        box.classList.remove('fade-out');
        box.innerText = `❌ ${title}:\n${error.message || error.toString()}`;

        setTimeout(() => {
            if(!box.classList.contains('hidden')){
                box.classList.add('fade-out');
                setTimeout(() => {
                    box.classList.add('hidden');
                    box.classList.remove('fade-out');
                }, 1000);
            }
        }, 5000);
    }
}

function distance(lat1, lon1, lat2, lon2){
    if(!lat1 || !lon1 || !lat2 || !lon2) return null;
    const R = 6371;
    const dLat = (lat2-lat1)*Math.PI/180;
    const dLon = (lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R*c;
}

function toggleAskButton(disabled) {
    const button = document.getElementById('askButton');
    if(!button) return;
    button.disabled = Boolean(disabled);
    button.textContent = disabled ? 'جاري العمل...' : 'اسأل الصيدليات';
    isQueryActive = Boolean(disabled);
}

function toggleSavePhoneButton(disabled) {
    const button = document.getElementById('savePhoneButton');
    if(!button) return;
    button.disabled = disabled;
    button.textContent = disabled ? 'جاري التأكيد...' : 'تأكيد';
}

function displayLocationError() {
    isLocationAvailable = false;
    setSendingIndicator(false);
    const errorBox = document.getElementById('locationErrorBox');
    const titleEl = document.getElementById('currentQueryTitle');
    const pharmContainer = document.getElementById('pharmaciesContainer');

    if(errorBox) errorBox.classList.remove('hidden');
    if(titleEl) titleEl.classList.add('hidden');
    if(pharmContainer) pharmContainer.innerHTML = '<div class="loading" style="color:var(--status-unavailable);">الرجاء **تفعيل خدمة الموقع (GPS)** أولاً للمتابعة.</div>';
}

async function getUserLocation() {
    const errorBox = document.getElementById('locationErrorBox');
    const locationIndicator = document.getElementById('locationSourceIndicator');

    if (errorBox) errorBox.classList.add('hidden');
    if (locationIndicator) locationIndicator.classList.add('hidden');

    isLocationAvailable = false;
    userLocation = { lat: null, lng: null };

    const phone = localStorage.getItem('userPhone');

    // محاولة سريعة لجلب الموقع المحفوظ مسبقاً في Firestore إذا لم يكن متاحاً فوراً
    if (phone) {
        try {
            const userDoc = await db.collection('Users').doc(phone).get();
            if (userDoc.exists && userDoc.data().lat && userDoc.data().lng) {
                userLocation.lat = userDoc.data().lat;
                userLocation.lng = userDoc.data().lng;
                isLocationAvailable = true;
                if (locationIndicator) {
                    locationIndicator.innerHTML = '💾 <strong>الموقع المستخدم:</strong> موقعك المحفوظ مسبقاً';
                    locationIndicator.classList.remove('hidden');
                }
            }
        } catch (_) {}
    }

    try {
        const position = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true, timeout: 3500, maximumAge: 15000
            });
        });
        userLocation.lat = position.coords.latitude;
        userLocation.lng = position.coords.longitude;
        isLocationAvailable = true;

        if (locationIndicator) {
            locationIndicator.innerHTML = '🛰️ <strong>الموقع المستخدم:</strong> GPS الحالي (الأكثر دقة)';
            locationIndicator.classList.remove('hidden');
        }

        if (phone) {
            db.collection('Users').doc(phone).update({ lat: userLocation.lat, lng: userLocation.lng }).catch(() => {});
        }
        return;
    } catch (_) {}

    if (!isLocationAvailable && window.location.pathname.includes('index.html')) {
        displayLocationError();
        const errBox = document.getElementById('locationErrorBox');
        if (errBox) {
            errBox.innerHTML += '<br><a href="profile.html" style="font-weight:bold; color: #856404; text-decoration: underline;">يمكنك تحديد موقعك يدوياً من هنا.</a>';
        }
    }
}

async function savePhone(){
    toggleSavePhoneButton(true);
    const phone = document.getElementById('phoneInput').value.trim();
    const errorEl = document.getElementById('phoneError');
    errorEl.innerText = "";
    try {
        if(phone.length < 5){ errorEl.innerText="الرجاء إدخال رقم هاتف صحيح!"; toggleSavePhoneButton(false); return; }

        await getUserLocation();
        localStorage.setItem('userPhone', phone);

        const userRef = db.collection('Users').doc(phone);
        await userRef.set({
            phone,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            lat: userLocation.lat || null,
            lng: userLocation.lng || null
        }, { merge: true });

        window.location.href = 'index.html';
    } catch(err){
        errorEl.innerText = "فشل في حفظ الرقم: " + (err.message || "خطأ غير معروف");
    }
    toggleSavePhoneButton(false);
}

function logout(){
    localStorage.removeItem('userPhone');
    window.location.href = 'login.html';
}

function renderPharmaciesListToDOM(pharmaciesRaw, selectedRange, medicineName, responses, queryId, sessionStatusMap = null) {
    const pharmContainer = document.getElementById('pharmaciesContainer');
    const titleEl = document.getElementById('currentQueryTitle');

    titleEl.textContent = `نتائج البحث عن: ${medicineName} (ضمن نطاق ${selectedRange} كم)`;
    titleEl.classList.remove('hidden');

    let pharmacies = pharmaciesRaw
        .map(d => ({
            ...d,
            distance: distance(userLocation.lat, userLocation.lng, d.lat, d.lng)
        }))
        .filter(d => d.distance !== null && d.distance <= selectedRange)
        .sort((a, b) => (a.distance || 0) - (b.distance || 0));

    pharmContainer.innerHTML = "";

    if (pharmacies.length === 0) {
        pharmContainer.innerHTML = `<div class="loading">لا توجد صيدليات ضمن نطاق ${selectedRange} كم.</div>`;
        return;
    }

    const fragment = document.createDocumentFragment();

    pharmacies.forEach(p => {
        const sessionMeta = sessionStatusMap
            ? (sessionStatusMap.get(String(p.id)) || sessionStatusMap.get(normalizePhoneDigits(p.phone)) || null)
            : null;

        const response = findPharmacyResponse(responses, p);
        const statusText = resolveDisplayStatus(response, sessionMeta);

        const statusClass =
            statusText === "متوفر"
                ? "status-available"
                : (statusText === "غير متوفر" || statusText === "غير متصل" || statusText === "متوقف")
                ? "status-unavailable"
                : "status-pending";

        const borderClass =
            statusText === "متوفر"
                ? "status-available-border"
                : (statusText === "غير متوفر" || statusText === "غير متصل" || statusText === "متوقف")
                ? "status-unavailable-border"
                : "status-pending-border";

        const div = document.createElement('div');
        div.dataset.id = p.id;
        div.style.overflow = "hidden";
        div.style.maxWidth = "100%";
        div.style.boxSizing = "border-box";
        div.className = `pharmacy ${borderClass}`;

        const mapLink = p.lat && p.lng
            ? `<a href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" class="pharmacy-map-link"><i data-lucide="map-pin" style="width:14px; height:14px;"></i> عرض الموقع</a>`
            : "";

        const deliveryInfo = p.delivery
            ? `<span class="delivery-badge delivery-available" title="توصيل متوفر"><i data-lucide="truck" style="width:18px; height:18px;"></i> توصيل</span>`
            : `<span class="delivery-badge delivery-unavailable" title="لا يوجد توصيل"><i data-lucide="x-circle" style="width:18px; height:18px;"></i> لا توصيل</span>`;

        let contactButtons = '';
        if (p.phone) {
            const userPhone = localStorage.getItem('userPhone') || 'غير محدد';
            const whatsappMessage = `مرحباً، هل يتوفر لديكم ${medicineName}؟ (أنا أبحث من تطبيق اسأل الصيدلية، ورقم هاتفي: ${userPhone})`;
            contactButtons += `<a href="tel:${p.phone}" class="contact-call"><i data-lucide="phone" style="width:16px; height:16px;"></i> اتصل</a>`;
            contactButtons += `<a href="https://wa.me/${p.phone}?text=${encodeURIComponent(whatsappMessage)}" target="_blank" class="contact-whatsapp"><i data-lucide="message-square" style="width:16px; height:16px;"></i> واتساب</a>`;
        }

        const responderPhone = (response && (response.senderPhone || response.phone || response.pharmacyPhone)) || p.phone || "";
        const rawReplyText = response && (response.rawReplyText || response.replyText || response.text || "");
        const qMeta = (response && response.quotedMessageData) || {};
        const referenceId = qMeta.askId || qMeta.stanzaId || (response && response.askId) || queryId || "";

        const replyDetailsHTML = response
            ? `<div style="font-size:12px; margin-top:6px; line-height:1.5; text-align:right; color:#222; background:#f8f9fa; padding:6px 8px; border-radius:6px; max-width:100%; overflow:hidden; overflow-wrap:anywhere; word-break:break-word; box-sizing:border-box;">
                ${responderPhone ? `<div><strong>رقم الصيدلية:</strong> ${escapeHtmlText(responderPhone)}</div>` : ""}
                ${rawReplyText && rawReplyText !== statusText ? `<div><strong>الرد:</strong> ${escapeHtmlText(rawReplyText)}</div>` : ""}
                ${referenceId ? `<div><strong>المرجع:</strong> ${escapeHtmlText(referenceId)}</div>` : ""}
               </div>`
            : "";

        const statusSectionHTML = `
            <div>
                <div class="status-section ${statusClass}" style="font-size:11.5px; padding:5px 8px; gap:4px; white-space:nowrap; max-width:115px;">${getStatusIcon(statusText)}<span style="line-height:1.2;">${escapeHtmlText(statusText)}</span></div>
                ${replyDetailsHTML}
            </div>
        `;

        const distanceText = p.distance !== null ? `${p.distance.toFixed(2)} كم` : 'غير محدد';

        div.innerHTML = `
            <div class="pharmacy-info" style="min-width:0; max-width:100%; overflow:hidden; overflow-wrap:anywhere; word-break:break-word;">
                <strong>${escapeHtmlText(p.name || 'صيدلية مجهولة')}</strong>
                <small>المسافة: <span style="font-weight: bold; color: var(--secondary-color);">${distanceText}</span></small>
                ${p.phone ? `<small>رقم الصيدلية: <span style="font-weight: bold;">${escapeHtmlText(p.phone)}</span></small>` : ""}
                <div style="display: flex; align-items: center; gap: 10px; margin-top: 8px;">
                    ${mapLink}
                    ${deliveryInfo}
                </div>
                <div class="contact-buttons-container">${contactButtons}</div>
            </div>
            ${statusSectionHTML}
        `;
        fragment.appendChild(div);
    });

    pharmContainer.appendChild(fragment);
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons();
    }
}

async function displayPharmacies(queryId, medicineName, responses){
    const pharmContainer = document.getElementById("pharmaciesContainer");
    const titleEl = document.getElementById("currentQueryTitle");
    const selectedRange = parseFloat(document.getElementById("searchRange")?.value) || 4;

    if (!userLocation || !userLocation.lat || !userLocation.lng) {
      const lLat = parseFloat(localStorage.getItem("userLat") || localStorage.getItem("pharmacyLat") || "");
      const lLng = parseFloat(localStorage.getItem("userLng") || localStorage.getItem("pharmacyLng") || "");
      if (!isNaN(lLat) && !isNaN(lLng)) {
        userLocation = { lat: lLat, lng: lLng };
        isLocationAvailable = true;
      }
    }

    if (!isLocationAvailable || !userLocation.lat || !userLocation.lng) {
      if (titleEl) titleEl.classList.add("hidden");
      setSendingIndicator(false);
      if (pharmContainer && !pharmContainer.querySelector(".pharmacy")) {
        pharmContainer.innerHTML = '<div class="loading">⚠️ تعذر تحديد موقعك. يرجى تفعيل GPS أو <a href="profile.html">تحديد الموقع</a>.</div>';
      }
      return;
    }

    const locErr = document.getElementById("locationErrorBox");
    if (locErr) locErr.classList.add("hidden");

    try {
      const pharmaciesRaw = await withTimeout(getCachedPharmaciesList(false), 4000, "pharmacies");
      renderPharmaciesListToDOM(pharmaciesRaw, selectedRange, medicineName, responses, queryId, null);
    } catch (e) {
      if (pharmContainer && !pharmContainer.querySelector(".pharmacy")) {
        pharmContainer.innerHTML = '<div class="loading">⚠️ تعذر جلب الصيدليات حالياً.</div>';
      }
    } finally {
      setSendingIndicator(false);
    }

    fetchPharmacySessionStatusesMap().then(sessionStatusMap => {
      if (sessionStatusMap && sessionStatusMap.size > 0 && cachedPharmaciesDocs) {
        renderPharmaciesListToDOM(cachedPharmaciesDocs, selectedRange, medicineName, responses, queryId, sessionStatusMap);
      }
    }).catch(() => {});
  }

async function askPharmacy(medicine, phone) {
    const searchRangeEl = document.getElementById('searchRange');
    const selectedRange = (searchRangeEl ? parseFloat(searchRangeEl.value) : parseFloat(new URLSearchParams(window.location.search).get('range'))) || 4;
    const nowIso = new Date().toISOString();

    // 1. حفظ السؤال مبدئياً في Firestore و localStorage حتى لو رفضت الصيدليات أو فشل الإرسال
    try { localStorage.removeItem("lastAskId"); } catch (_) {}
    if (typeof resetCardsToPendingState === "function") resetCardsToPendingState();
    let askId = "ask_" + Date.now();
    const initialDoc = {
        UserPhone: phone,
        medicine: medicine,
        Status: "قيد الانتظار",
        range: selectedRange,
        lat: userLocation?.lat || null,
        lng: userLocation?.lng || null,
        responses: [],
        createdAt: nowIso,
        updatedAt: nowIso
    };

    try {
        if (typeof db !== "undefined" && db) {
            const addedRef = await db.collection('AskPharmacy').add(initialDoc);
            askId = addedRef.id;
        }
    } catch (fsErr) {
        console.warn("⚠️ تعذر الحفظ الأولي في Firestore، تم الحفظ محلياً:", fsErr.message);
    }

    saveQuestionLocally(phone, { id: askId, ...initialDoc });
    try { localStorage.setItem("lastAskId", askId); } catch (_) {}
    if (typeof renderPreviousQuestions === "function") {
        renderPreviousQuestions().catch(() => {});
    }

    await displayPharmacies(askId, medicine, []);

    try {
        const res = await fetch('/api/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                medicine,
                userPhone: phone,
                askId,
                lat: userLocation?.lat || null,
                lng: userLocation?.lng || null,
                range: selectedRange
            })
        });
        const data = await res.json().catch(() => ({}));

        // إذا لم تُرسل لأي صيدلية أو رُفضت كلها، نحفظ الحالة كـ "غير متوفر" مع إبقاء السؤال في السجل
        if (!res.ok || !data.ok || Number(data.sentCount || 0) === 0) {
            const rejectedStatus = "غير متوفر";
            saveQuestionLocally(phone, { id: askId, medicine, Status: rejectedStatus, createdAt: nowIso });
            if (typeof db !== "undefined" && db && !askId.startsWith("ask_")) {
                await db.collection('AskPharmacy').doc(askId).set(
                    { Status: rejectedStatus, updatedAt: new Date().toISOString() },
                    { merge: true }
                ).catch(() => {});
            }
        }
    } catch (netErr) {
        saveQuestionLocally(phone, { id: askId, medicine, Status: "غير متوفر", createdAt: nowIso });
    } finally {
        setSendingIndicator(false);
        if (typeof renderPreviousQuestions === "function") {
            renderPreviousQuestions().catch(() => {});
        }
    }
}

async function checkPreviousQuestionAndAsk(){
    if(isQueryActive) return;
    toggleAskButton(true);
    setSendingIndicator(true, "⏳ جاري إظهار الصيدليات وإرسال السؤال لها...");

    try {
        const phone = localStorage.getItem('userPhone');
        const medicineEl = document.getElementById('medicineInput');
        const medicine = (medicineEl ? medicineEl.value : new URLSearchParams(window.location.search).get('medicine') || "").trim();

        if(!phone || medicine === ""){
            setSendingIndicator(false);
            showError("خطأ", {message: !phone ? "يرجى تسجيل الدخول أولاً!" : "الرجاء كتابة اسم الدواء!"});
            return;
        }

        // جلب الموقع بسرعة بدون تعطيل الصفحة
        await getUserLocation().catch(() => {});

        await askPharmacy(medicine, phone);
    } catch (err) {
        setSendingIndicator(false);
        showError("حدث خطأ أثناء تنفيذ السؤال", err);
    } finally {
      setSendingIndicator(false);
      toggleAskButton(false);
    }
}

async function loadPreviousResponses(queryId, medicineName, fromMainQuery = false){
    if(isQueryActive && !fromMainQuery) return;

    if (!fromMainQuery) {
        toggleAskButton(true);
        closeSidebar();
        closeInfoSidebar();
        setSendingIndicator(true, "⏳ جاري إظهار الصيدليات...");
    }

    try {
        const queryDoc = await db.collection('AskPharmacy').doc(queryId).get();
        if(!queryDoc.exists){ throw new Error("الاستعلام غير موجود!"); }

        const d = queryDoc.data();
        document.getElementById('medicineInput').value = medicineName;

        if (!isLocationAvailable) {
            await getUserLocation();
        }
        if (!isLocationAvailable) {
            if (!fromMainQuery) toggleAskButton(false);
            return;
        }

        await displayPharmacies(queryId, medicineName, d.responses || []);
        setSendingIndicator(false);
    } catch(err){
        setSendingIndicator(false);
        showError(`فشل في جلب الردود`, err);
    } finally {
        if (!fromMainQuery) {
            toggleAskButton(false);
        }
    }
}

async function renderPreviousQuestions(){
    const phone = localStorage.getItem('userPhone');
    const container = document.getElementById('previousQuestionsContainer');

    if(!container || !phone) return;

    container.innerHTML="<h5 style='color:white; padding:10px 20px; font-weight: 700; border-bottom: 1px solid #555; margin-top: 0;'>الأسئلة السابقة</h5>";

    try {
        const qSnap = await db.collection('AskPharmacy')
            .where('UserPhone','==',phone)
            .orderBy('createdAt','desc')
            .limit(10)
            .get();

        if(qSnap.empty){
            container.innerHTML+="<p style='color:white; padding:0 20px; font-size: 14px;'>لا توجد أسئلة سابقة.</p>";
            return;
        }
        qSnap.forEach(doc=>{
            const d = doc.data();
            const rangeText = d.searchRange ? ` (${d.searchRange} كم)` : '';
            const statusIndicator = d.Status === "متوفر" ? '✅' : d.Status === "غير متوفر" ? '❌' : '⏳';
            const dateStr = d.createdAt?.toDate().toLocaleDateString() || '...';

            const a = document.createElement('a');
            a.href = "#";
            a.textContent=`${statusIndicator} ${d.medicine} ${rangeText} (${dateStr})`;
            a.onclick = (e) => { e.preventDefault(); loadPreviousResponses(doc.id, d.medicine); };
            container.appendChild(a);
        });
    } catch(err){
        console.error("فشل في جلب الأسئلة السابقة", err);
        container.innerHTML+="<p style='color:#ffc107; padding:0 20px; font-size: 14px;'>فشل في جلب الأسئلة.</p>";
    }
}

async function syncResponses(){
    const phone = localStorage.getItem("userPhone");
    if(!phone || typeof db === "undefined" || !db) return;

    const params = new URLSearchParams(window.location.search || "");
    const pinnedId = String(params.get("askId") || params.get("queryId") || localStorage.getItem("lastAskId") || "").trim();
    const targetMed = String(params.get("medicine") || document.getElementById("medicineInput")?.value || "").trim();

    if (pinnedId && !pinnedId.startsWith("pending_") && !pinnedId.startsWith("ask_")) {
      db.collection("AskPharmacy").doc(pinnedId).onSnapshot(async (doc) => {
        if (!doc || !doc.exists) return;
        const d = doc.data() || {};
        const responses = Array.isArray(d.responses) ? d.responses : [];
        if (responses.length > 0 && typeof applyResponsesDirectlyToCards === "function") {
          applyResponsesDirectlyToCards(responses, doc.id);
        }
      }, () => {});
      return;
    }

    db.collection("AskPharmacy").where("UserPhone","==",phone)
      .onSnapshot(async (snapshot) => {
        if(!snapshot || snapshot.empty) return;
        const activeId = String(localStorage.getItem("lastAskId") || "").trim();
        let chosen = null;
        snapshot.forEach((doc) => {
          const d = doc.data() || {};
          if (activeId && doc.id === activeId) {
            chosen = { id: doc.id, data: d };
          } else if (!chosen && targetMed && String(d.medicine || "").trim() === targetMed) {
            chosen = { id: doc.id, data: d };
          }
        });
        if (!chosen) return;
        const responses = Array.isArray(chosen.data.responses) ? chosen.data.responses : [];
        if (responses.length > 0 && typeof applyResponsesDirectlyToCards === "function") {
          applyResponsesDirectlyToCards(responses, chosen.id);
        }
      }, () => {});
  }

window.addEventListener("load", async () => {
    const pharmContainer = document.getElementById("pharmaciesContainer");
    if (!pharmContainer) return;

    const params = new URLSearchParams(window.location.search);
    const medParam = (params.get("medicine") || "").trim();
    const rangeParam = (params.get("range") || "").trim();
    const queryIdParam = (params.get("queryId") || params.get("askId") || "").trim();

    const medInput = document.getElementById("medicineInput");
    if (medInput && medParam && !medInput.value) medInput.value = medParam;
    const rangeInput = document.getElementById("searchRange");
    if (rangeInput && rangeParam) rangeInput.value = rangeParam;

    if (medParam || queryIdParam) {
        await getUserLocation().catch(() => {});
        if (queryIdParam) {
            await loadPreviousResponses(queryIdParam, medParam || "دواء", true);
        } else {
            await checkPreviousQuestionAndAsk();
        }
    }
});

function showIncomingReplyToast(notif) {
    if (!notif || typeof document === "undefined") return;
    const statusStr = String(notif.status || notif.rawReplyText || "رد جديد");
    const isAvail = statusStr.includes("متوفر") && !statusStr.includes("غير");

    let toast = document.getElementById("liveReplyNotificationToast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "liveReplyNotificationToast";
        toast.style.cssText = [
            "position:fixed",
            "top:14px",
            "left:14px",
            "right:14px",
            "max-width:520px",
            "margin:0 auto",
            "z-index:10000",
            "background:#ffffff",
            "color:#111827",
            "border-radius:12px",
            "padding:12px 14px",
            "box-shadow:0 8px 24px rgba(0,0,0,0.18)",
            "display:flex",
            "align-items:center",
            "justify-content:space-between",
            "gap:10px",
            "font-family:Cairo,sans-serif"
        ].join(";");
        document.body.appendChild(toast);
    }

    toast.style.borderRight = "5px solid " + (isAvail ? "#2e7d32" : "#c62828");
    toast.innerHTML = `
        <div style="text-align:right; font-size:13px; line-height:1.45;">
            <div><strong>🔔 رد جديد من ${escapeHtmlText(notif.pharmacyName || "صيدلية")}</strong></div>
            <div>الحالة: <strong style="color:${isAvail ? "#1b5e20" : "#b71c1c"}">${escapeHtmlText(statusStr)}</strong>${notif.medicine ? " — " + escapeHtmlText(notif.medicine) : ""}</div>
        </div>
        <a href="notifications.html" style="background:#00bcd4; color:#fff; text-decoration:none; padding:6px 10px; border-radius:8px; font-size:12px; font-weight:700; white-space:nowrap;">عرض الإشعارات</a>
    `;
    toast.style.display = "flex";

    clearTimeout(window.__replyToastTimer);
    window.__replyToastTimer = setTimeout(() => {
        if (toast) toast.style.display = "none";
    }, 7000);
}

let seenNotifIds = new Set();
let isFirstNotifSnapshot = true;

function initAccountNotificationsListener() {
    const phone = localStorage.getItem("userPhone");
    if (!phone || typeof db === "undefined" || !db) return;
    const myTail = normalizePhoneDigits(phone).slice(-9);

    db.collection("notifications").onSnapshot((snap) => {
        if (isFirstNotifSnapshot) {
            snap.forEach(d => seenNotifIds.add(d.id));
            isFirstNotifSnapshot = false;
            return;
        }
        snap.docChanges().forEach((change) => {
            if (change.type === "added" || change.type === "modified") {
                const d = change.doc.data() || {};
                const refPhone = d.userPhone || d.recipientPhone || d.uniqueAccountRef || "";
                const refTail = normalizePhoneDigits(refPhone).slice(-9);
                const belongsToUser = (myTail.length >= 7 && refTail === myTail) || normalizePhoneDigits(refPhone) === normalizePhoneDigits(phone);
                if (belongsToUser && !seenNotifIds.has(change.doc.id)) {
                    seenNotifIds.add(change.doc.id);
                    showIncomingReplyToast(d);
                }
            }
        });
    }, () => {});
}

window.addEventListener("DOMContentLoaded", () => {
    initAccountNotificationsListener();
    if (document.getElementById("pharmaciesContainer")) syncPharmacyCardsFromNotificationsLive();
});


function syncPharmacyCardsFromNotificationsLive(activeAskId = "") {
  const phone = localStorage.getItem("userPhone") || "";
  if (!phone || typeof db === "undefined" || !db) return;

  const cleanDigits = (v) => String(v || "").replace(/\D/g, "");
  const phoneTail9 = (v) => {
    const d = cleanDigits(v);
    return d.length > 9 ? d.slice(-9) : d;
  };
  const belongsToCurrentPhone = (item, myPhone) => {
    const myTail = phoneTail9(myPhone);
    const refPhone = item.userPhone || item.recipientPhone || item.uniqueAccountRef || "";
    return cleanDigits(refPhone) === cleanDigits(myPhone) || (myTail.length >= 7 && phoneTail9(refPhone) === myTail);
  };

  if (window.__resultsNotifUnsub) {
    try { window.__resultsNotifUnsub(); } catch (_) {}
  }

  window.__resultsNotifUnsub = db.collection("notifications").onSnapshot((snap) => {
    const params = new URLSearchParams(window.location.search || "");
    const currentAskId = String(
      activeAskId ||
      params.get("askId") ||
      params.get("queryId") ||
      localStorage.getItem("lastAskId") ||
      ""
    ).trim();

    if (!currentAskId) return;

    const matchedReplies = [];
    snap.forEach((doc) => {
      const item = Object.assign({ id: doc.id }, doc.data() || {});
      if (!belongsToCurrentPhone(item, phone)) return;

      const itemAskId = String(item.askId || item.questionId || item.queryId || "").trim();
      if (itemAskId && itemAskId === currentAskId) {
        matchedReplies.push(item);
      }
    });

    if (matchedReplies.length && typeof applyResponsesDirectlyToCards === "function") {
      applyResponsesDirectlyToCards(matchedReplies, currentAskId);
    }
  }, () => {});
}
