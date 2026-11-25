// PWA: تسجيل Service Worker
// يجب إضافة هذا الجزء في بداية ملف script.js
// ===========================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // يتم التسجيل على المسار /service-worker.js
        navigator.serviceWorker.register('/service-worker.js')
            .then(registration => {
                console.log('ServiceWorker registered successfully with scope: ', registration.scope);
            })
            .catch(error => {
                console.error('ServiceWorker registration failed: ', error);
            });
    });
}
// NOTE: This config is provided by the environment and is necessary for running the app.
// **يجب عليك تعديل هذا الكود ليناسب إعدادات مشروع Firebase الخاص بك**
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

let userLocation = { lat: null, lng: null };
let isLocationAvailable = false;
let isQueryActive = false;

// =========================================================
// 💡 وظائف التحكم في الواجهة (Interface Control)
// =========================================================

function closeSidebar(){ document.getElementById('sidebar').style.width='0'; }
function closeInfoSidebar(){ document.getElementById('infoSidebar').style.width='0'; }
function toggleSidebar(){ const sidebar=document.getElementById('sidebar'); sidebar.style.width = sidebar.style.width==='250px'?'0':'250px'; closeInfoSidebar(); }
function toggleInfoSidebar(){ const sidebar=document.getElementById('infoSidebar'); sidebar.style.width = sidebar.style.width==='250px'?'0':'250px'; closeSidebar(); }
function showSessionInfo(phone){
    const el = document.getElementById('sessionInfo');
    if(el) el.innerText="رقم الجلسة: "+phone;
}

function getStatusIcon(statusText) {
    if (statusText === "متوفر") return `<i data-lucide="check-circle" style="width:20px; height:20px;"></i>`;
    if (statusText === "غير متوفر") return `<i data-lucide="x-circle" style="width:20px; height:20px;"></i>`;
    return `<i data-lucide="hourglass" style="width:20px; height:20px;"></i>`;
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

function resolveDisplayStatus(response) {
    if (!response) return "جاري الرد";
    const candidate = String(
        response.status || response.rawReplyText || response.replyText || response.text || ""
    ).trim();
    if (!candidate) return "جاري الرد";
    const lower = candidate.toLowerCase();
    if (lower.includes("غير متوفر") || lower === "لا" || lower.includes("ما متوفر") || lower === "no") {
        return "غير متوفر";
    }
    if (lower.includes("متوفر") || lower === "نعم" || lower.includes("موجود") || lower === "yes") {
        return "متوفر";
    }
    return candidate;
}

function escapeHtmlText(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// 💡 تحديث: وظيفة showError مع الإخفاء التلقائي
function showError(title,error){
    console.error("🔥",title,error);
    const box = document.getElementById('errorBox');
    if(box) {
        box.classList.remove('hidden');
        box.classList.remove('fade-out'); // للتأكد من إزالة فئة الإخفاء السابقة
        box.innerText = `❌ ${title}:\n${error.message || error.toString()}`;

        // إخفاء تلقائي بعد 5 ثواني (5000ms)
        setTimeout(() => {
            // إضافة فئة الإخفاء التدريجي (fade-out)
            if(!box.classList.contains('hidden')){
                box.classList.add('fade-out');
                // إخفاء العنصر بالكامل بعد انتهاء الانتقال (1000ms)
                setTimeout(() => {
                    box.classList.add('hidden');
                    box.classList.remove('fade-out'); // للتجهيز للاستخدام التالي
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
    button.disabled = disabled;
    button.textContent = disabled ? 'جاري العمل...' : 'اسأل الصيدليات';
    isQueryActive = disabled;
}

function toggleSavePhoneButton(disabled) {
    const button = document.getElementById('savePhoneButton');
    if(!button) return;
    button.disabled = disabled;
    button.textContent = disabled ? 'جاري التأكيد...' : 'تأكيد';
}

function displayLocationError() {
    isLocationAvailable = false;
    const errorBox = document.getElementById('locationErrorBox');
    const titleEl = document.getElementById('currentQueryTitle');
    const pharmContainer = document.getElementById('pharmaciesContainer');

    if(errorBox) errorBox.classList.remove('hidden');
    if(titleEl) titleEl.classList.add('hidden');
    if(pharmContainer) pharmContainer.innerHTML = '<div class="loading" style="color:var(--status-unavailable);">الرجاء **تفعيل خدمة الموقع (GPS)** أولاً للمتابعة.</div>';
}

// =========================================================
// User & Location Management
// =========================================================

async function getUserLocation() {
    const errorBox = document.getElementById('locationErrorBox');
    const locationIndicator = document.getElementById('locationSourceIndicator');

    // إخفاء رسائل الخطأ والمؤشر في البداية
    if (errorBox) errorBox.classList.add('hidden');
    if (locationIndicator) locationIndicator.classList.add('hidden');

    isLocationAvailable = false;
    userLocation = { lat: null, lng: null };

    // 1. محاولة الحصول على الموقع من GPS أولاً
    try {
        const position = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true, timeout: 5000, maximumAge: 0
            });
        });
        userLocation.lat = position.coords.latitude;
        userLocation.lng = position.coords.longitude;
        isLocationAvailable = true;
        console.log("✅ تم الحصول على الموقع من GPS.");

        // تحديث المؤشر لإعلام المستخدم
        if (locationIndicator) {
            locationIndicator.innerHTML = '🛰️ <strong>الموقع المستخدم:</strong> GPS الحالي (الأكثر دقة)';
            locationIndicator.classList.remove('hidden');
        }

        const phone = localStorage.getItem('userPhone');
        if (phone) {
            await db.collection('Users').doc(phone).update({ lat: userLocation.lat, lng: userLocation.lng });
        }
        return; // الخروج من الدالة بعد النجاح

    } catch (gpsError) {
        console.warn("⚠️ فشل الـ GPS:", gpsError.message);

        // 2. إذا فشل GPS، حاول جلب الموقع المحفوظ يدوياً من Firestore
        const phone = localStorage.getItem('userPhone');
        if (phone) {
            try {
                const userDoc = await db.collection('Users').doc(phone).get();
                if (userDoc.exists && userDoc.data().lat && userDoc.data().lng) {
                    userLocation.lat = userDoc.data().lat;
                    userLocation.lng = userDoc.data().lng;
                    isLocationAvailable = true;
                    console.log("✅ تم استخدام الموقع المحفوظ يدوياً من Firestore.");

                    // تحديث المؤشر لإعلام المستخدم
                    if (locationIndicator) {
                        locationIndicator.innerHTML = '💾 <strong>الموقع المستخدم:</strong> موقعك المحفوظ يدوياً';
                        locationIndicator.classList.remove('hidden');
                    }
                    return; // الخروج من الدالة بعد النجاح
                }
            } catch (dbError) {
                console.error("🔥 خطأ في جلب الموقع من Firestore:", dbError);
            }
        }
    }

    // 3. إذا فشل كل شيء، قم بإظهار رسالة الخطأ الرئيسية مع رابط لصفحة التعديل
    if (!isLocationAvailable && window.location.pathname.includes('index.html')) {
        console.error("🚫 تعذر تحديد الموقع نهائياً.");
        displayLocationError();
        const errorBox = document.getElementById('locationErrorBox');
        if (errorBox) {
            errorBox.innerHTML += '<br><a href="profile.html" style="font-weight:bold; color: #856404; text-decoration: underline;">يمكنك تحديد موقعك يدوياً من هنا.</a>';
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

// =========================================================
// Pharmacy Display & Query Logic
// =========================================================

async function displayPharmacies(queryId, medicineName, responses){
    const pharmContainer = document.getElementById('pharmaciesContainer');
    const titleEl = document.getElementById('currentQueryTitle');
    // 🚨 هنا يتم قراءة نطاق البحث من القيمة الحالية في حقل الإدخال
    const selectedRange = parseFloat(document.getElementById('searchRange').value) || 4;

    if (!isLocationAvailable) {
        titleEl.classList.add('hidden');
        return;
    }
    document.getElementById('locationErrorBox').classList.add('hidden');

    titleEl.textContent = `نتائج البحث عن: ${medicineName} (ضمن نطاق ${selectedRange} كم)`;
    titleEl.classList.remove('hidden');
    pharmContainer.innerHTML = `<div class="loading">جاري عرض الصيدليات القريبة...</div>`;

    const allPharmaciesSnap = await db.collection('pharmacies').get();
    let pharmacies = [];
    allPharmaciesSnap.forEach(phDoc=>{
        const d = phDoc.data();
        d.id = phDoc.id;
        // 🚨 هنا يتم استخدام selectedRange (القيمة الجديدة)
        d.distance = distance(userLocation.lat, userLocation.lng, d.lat, d.lng);
        if(d.distance !== null && d.distance <= selectedRange) {
            pharmacies.push(d);
        }
    });
    pharmacies.sort((a,b)=> (a.distance||0) - (b.distance||0) );

    pharmContainer.innerHTML = "";

    if(pharmacies.length === 0){
        pharmContainer.innerHTML = `<div class="loading">لا توجد صيدليات ضمن نطاق ${selectedRange} كم.</div>`;
    }

    pharmacies.forEach(p=>{
        const response = findPharmacyResponse(responses, p);
        const statusText = resolveDisplayStatus(response);

        const statusClass = statusText==="متوفر"?"status-available":statusText==="غير متوفر"?"status-unavailable":"status-pending";
        const borderClass = statusText==="متوفر"?"status-available-border":statusText==="غير متوفر"?"status-unavailable-border":"status-pending-border";

        const div = document.createElement('div');
        div.dataset.id = p.id;

        let mapLink = p.lat && p.lng ? `<a href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" class="pharmacy-map-link"><i data-lucide="map-pin" style="width:14px; height:14px;"></i> عرض الموقع</a>` : "";

        // 🟢 تحديث: إضافة شارة التوصيل الجديدة (متوفر أو غير متوفر)
        let deliveryInfo = '';
        if (p.delivery) {
            deliveryInfo = `<span class="delivery-badge delivery-available" title="توصيل متوفر">
                <i data-lucide="truck" style="width:18px; height:18px;"></i> توصيل
            </span>`;
        } else {
            deliveryInfo = `<span class="delivery-badge delivery-unavailable" title="لا يوجد توصيل">
                <i data-lucide="x-circle" style="width:18px; height:18px;"></i>   لا توصيل
            </span>`;
        }

        let contactButtons = '';
        if (p.phone) {
            const userPhone = localStorage.getItem('userPhone') || 'غير محدد';
            const whatsappMessage = `مرحباً، هل يتوفر لديكم ${medicineName}؟ (أنا أبحث من تطبيق اسأل الصيدلية، ورقم هاتفي: ${userPhone})`;

            contactButtons += `<a href="tel:${p.phone}" class="contact-call"><i data-lucide="phone" style="width:16px; height:16px;"></i> اتصل</a>`;
            contactButtons += `<a href="https://wa.me/${p.phone}?text=${encodeURIComponent(whatsappMessage)}" target="_blank" class="contact-whatsapp"><i data-lucide="message-square" style="width:16px; height:16px;"></i> واتساب</a>`;
        }

        const responderPhone = (response && (response.senderPhone || response.phone || response.pharmacyPhone)) || p.phone || "";
        const rawReplyText = response && (response.rawReplyText || response.replyText || response.text || "");
        const quotedText =
            (response && response.quotedMessageData && response.quotedMessageData.quotedText) ||
            (response && response.quotedText) ||
            "";

        const replyDetailsHTML = response
            ? `<div style="font-size:12px; margin-top:6px; line-height:1.5; text-align:right; color:#222; background:#f8f9fa; padding:6px 8px; border-radius:6px;">
                ${responderPhone ? `<div><strong>رقم الصيدلية:</strong> ${escapeHtmlText(responderPhone)}</div>` : ""}
                ${rawReplyText && rawReplyText !== statusText ? `<div><strong>الرد:</strong> ${escapeHtmlText(rawReplyText)}</div>` : ""}
                ${quotedText ? `<div><strong>مقتبس:</strong> ${escapeHtmlText(quotedText)}</div>` : ""}
               </div>`
            : "";

        let statusSectionHTML = '';
        if((p.chatId && p.chatId.trim() !== '') || p.phone || response) {
            statusSectionHTML = `
                <div>
                    <div class="status-section ${statusClass}">${getStatusIcon(statusText)}<span>${escapeHtmlText(statusText)}</span></div>
                    ${replyDetailsHTML}
                </div>
            `;
            div.className=`pharmacy ${borderClass}`;
        } else {
            div.className='pharmacy';
            statusSectionHTML = `<div style="font-size: 13px; color: #999; text-align: center; min-width: 110px;">(لا تتلقى استعلامات)</div>`;
        }

        const distanceText = p.distance !== null ? `${p.distance.toFixed(2)} كم` : 'غير محدد';

        div.innerHTML=`
            <div class="pharmacy-info">
                <strong>${p.name || 'صيدلية مجهولة'}</strong>
                <small>المسافة: <span style="font-weight: bold; color: var(--secondary-color);">${distanceText}</span></small>
                ${p.phone ? `<small>رقم الصيدلية: <span style="font-weight: bold;">${escapeHtmlText(p.phone)}</span></small>` : ""}
                <div style="display: flex; align-items: center; gap: 10px; margin-top: 8px;">
                    ${mapLink}
                    ${deliveryInfo} </div>
                <div class="contact-buttons-container">${contactButtons}</div>
            </div>
            ${statusSectionHTML}
        `;
        pharmContainer.appendChild(div);
    });

    lucide.createIcons();
}

async function askPharmacy(medicine, phone){
    const searchRange = parseFloat(document.getElementById('searchRange').value) || 4;

    try {
        await db.collection('Users').doc(phone).update({ lat: userLocation.lat, lng: userLocation.lng });

        const qRef = await db.collection('AskPharmacy').add({
            medicine,
            UserPhone:phone,
            Status:"جاري الرد",
            createdAt:firebase.firestore.FieldValue.serverTimestamp(),
            responses:[],
            searchRange: searchRange
        });
        const queryId = qRef.id;

        await displayPharmacies(queryId, medicine, []);

        await fetch('https://daway.netlify.app/.netlify/functions/node', {
            method:'POST',
            headers:{ 'Content-Type':'application/json' },
            body: JSON.stringify({
                medicine, askId:queryId, userPhone:phone,
                lat:userLocation.lat, lng:userLocation.lng, range: searchRange
            })
        });

        await renderPreviousQuestions();
    } catch(err){ showError("فشل في إرسال الاستعلام", err); }
}

async function checkPreviousQuestionAndAsk(){
    if(isQueryActive) return;
    toggleAskButton(true);

    const phone = localStorage.getItem('userPhone');
    const medicine = document.getElementById('medicineInput').value.trim();
    if(!phone || medicine === ""){
        showError("خطأ", {message: !phone ? "يرجى تسجيل الدخول أولاً!" : "الرجاء كتابة اسم الدواء!"});
        toggleAskButton(false);
        return;
    }

    await getUserLocation();
    if (!isLocationAvailable) {
        toggleAskButton(false);
        return;
    }

    // 💡 التحقق من وجود سؤال سابق مطابق للدواء (للمستخدم الحالي فقط)
    const previousQuerySnap = await db.collection('AskPharmacy')
        .where('UserPhone', '==', phone)
        .where('medicine', '==', medicine)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();

    if (!previousQuerySnap.empty) {
        const doc = previousQuerySnap.docs[0];
        const queryId = doc.id;
        const medicineName = doc.data().medicine;

        console.log(`✅ تم العثور على سؤال سابق للدواء: ${medicineName}. جاري جلب الردود.`);
        await loadPreviousResponses(queryId, medicineName, true);

    } else {
        await askPharmacy(medicine, phone);
    }

    toggleAskButton(false);
}

// 🚨 التعديل المطلوب: ملء حقل الإدخال باسم الدواء
async function loadPreviousResponses(queryId, medicineName, fromMainQuery = false){
    if(isQueryActive && !fromMainQuery) return;

    if (!fromMainQuery) {
        toggleAskButton(true);
        closeSidebar();
        closeInfoSidebar();
    }

    try {
        const queryDoc = await db.collection('AskPharmacy').doc(queryId).get();
        if(!queryDoc.exists){ throw new Error("الاستعلام غير موجود!"); }

        const d = queryDoc.data();

        // 🟢 التعديل الجديد: ملء خانة الدواء باسم الدواء السابق
        document.getElementById('medicineInput').value = medicineName;

        await getUserLocation();
        if (!isLocationAvailable) {
            if (!fromMainQuery) toggleAskButton(false);
            return;
        }

        await displayPharmacies(queryId, medicineName, d.responses || []);

    } catch(err){
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
    const phone = localStorage.getItem('userPhone');
    if(!phone) return;

    db.collection('AskPharmacy').where('UserPhone','==',phone).orderBy('createdAt','desc').limit(1)
        .onSnapshot(async snapshot=>{
            if(snapshot.empty) return;

            const latestQueryDoc = snapshot.docs[0];
            const latestQuery = latestQueryDoc.data();
            const queryId = latestQueryDoc.id;

            const currentTitleText = document.getElementById('currentQueryTitle')?.textContent;
            if (currentTitleText && currentTitleText.includes(latestQuery.medicine) && !isQueryActive && isLocationAvailable) {
                if(latestQuery.searchRange) {
                    document.getElementById('searchRange').value = latestQuery.searchRange.toString();
                }
                await displayPharmacies(queryId, latestQuery.medicine, latestQuery.responses);
                renderPreviousQuestions();
            }
        });
}

// =========================================================
// 🌐 ثوابت خاصة بصفحة إضافة صيدلية (لـ add_pharmacy.html)
// =========================================================

// **الإحداثيات الأولية: بحري، السودان**
const INITIAL_LAT = 15.6322;
const INITIAL_LNG = 32.5939;

let map, marker;

function showMessage(msg, isError, isGpsMessage = false) {
    const box = document.getElementById('errorBox');
    const successBox = document.getElementById('errorBox');
    const gpsBox = document.getElementById('gpsMessageBox');
    const permanentSuccess = document.getElementById('successMessage');

    if (permanentSuccess) permanentSuccess.classList.add('hidden');
    if (gpsBox) gpsBox.classList.add('hidden');

    if (isGpsMessage) {
        if (gpsBox) {
            gpsBox.textContent = msg;
            gpsBox.classList.remove('hidden');
            gpsBox.className = isError ? 'gps-error' : 'gps-success';
        }
        return;
    }

    if (!isError && msg.includes('تم تحديث الموقع')) {
        if (successBox) {
            successBox.className = 'success';
            successBox.textContent = msg;
            successBox.style.display = 'block';
            setTimeout(() => successBox.style.display = 'none', 3000);
        }
        return;
    }

    if (box) {
        box.className = 'error';
        box.textContent = msg;
        box.style.display = 'block';
    }
}

function initMap(initialLat, initialLng) {
    if (map) {
        map.remove();
        map = null;
    }

    const gpsBox = document.getElementById('gpsMessageBox');
    if (gpsBox) gpsBox.classList.add('hidden');

    const defaultLat = initialLat || INITIAL_LAT;
    const defaultLng = initialLng || INITIAL_LNG;

    map = L.map('map').setView([defaultLat, defaultLng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    marker = L.marker([defaultLat, defaultLng], {
        draggable: true
    }).addTo(map);

    marker.on('dragend', function(e) {
        const coords = marker.getLatLng();
        document.getElementById('lat').value = coords.lat.toFixed(6);
        document.getElementById('lng').value = coords.lng.toFixed(6);
        showMessage('📍 تم تحديث الموقع يدوياً من الخريطة. احفظ الإضافة!', false);
    });

    map.on('click', function(e) {
        const coords = e.latlng;
        marker.setLatLng(coords);
        document.getElementById('lat').value = coords.lat.toFixed(6);
        document.getElementById('lng').value = coords.lng.toFixed(6);
        showMessage('📍 تم تحديث الموقع يدوياً بالنقر. احفظ الإضافة!', false);
    });

    document.getElementById('lat').value = defaultLat.toFixed(6);
    document.getElementById('lng').value = defaultLng.toFixed(6);

    setTimeout(() => {
        if (map) {
            map.invalidateSize();
        }
    }, 50);
}

async function locateMe() {
    showMessage('🛰️ جاري محاولة تحديد الموقع عبر GPS...', false, true);

    try {
        const position = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true, timeout: 7000, maximumAge: 0
            });
        });

        const newLat = position.coords.latitude;
        const newLng = position.coords.longitude;

        map.setView([newLat, newLng], 16);
        marker.setLatLng([newLat, newLng]);

        document.getElementById('lat').value = newLat.toFixed(6);
        document.getElementById('lng').value = newLng.toFixed(6);

        showMessage("✅ تم تحديد الموقع التلقائي بنجاح. احفظ الإضافة الآن.", false, true);

    } catch (error) {
        showMessage(`❌ فشل تحديد الموقع: ${error.message}. يرجى سحب الدبوس الأخضر في الخريطة لتحديد الموقع يدوياً أو النقر على الخريطة.`, true, true);
    }
}

async function saveNewPharmacyToFirestore(name, phone, lat, lng, details, offersDelivery = false) {
    const docRef = db.collection('pharmacies').doc(phone);

    const existingSnap = await docRef.get();

    const dataToSave = {
        name: name,
        phone: phone,
        lat: lat,
        lng: lng,
        details: details || "",
        delivery: Boolean(offersDelivery),
    };

    if (existingSnap.exists) {
        await docRef.update(dataToSave);
        return 'updated';
    } else {
        dataToSave.chatId = "";
        dataToSave.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        await docRef.set(dataToSave);
        return 'created';
    }
}

function submitPharmacy() {
    const name = document.getElementById('pharmacyName').value.trim();
    const phone = document.getElementById('pharmacyPhone').value.trim();
    const lat = parseFloat(document.getElementById('lat').value);
    const lng = parseFloat(document.getElementById('lng').value);
    const details = document.getElementById('pharmacyDetails').value.trim();
    const submitBtn = document.getElementById('submitPharmacyBtn');
    const errorBox = document.getElementById('errorBox');
    const successMsg = document.getElementById('successMessage');

    if (errorBox) errorBox.classList.add('hidden');
    if (successMsg) successMsg.classList.add('hidden');
    if (errorBox) errorBox.style.display = 'none';
    const gpsBox = document.getElementById('gpsMessageBox');
    if (gpsBox) gpsBox.classList.add('hidden');

    if (!name || !phone || isNaN(lat) || isNaN(lng)) {
        if (errorBox) {
            errorBox.innerHTML = "❌ الرجاء تعبئة اسم الصيدلية ورقم الهاتف وتحديد الموقع على الخريطة.";
            errorBox.classList.remove('hidden');
            errorBox.style.display = 'block';
        }
        return;
    }

    if (phone.length < 8) {
        if (errorBox) {
            errorBox.innerHTML = "❌ رقم الهاتف غير صحيح. الرجاء إدخال رقم صحيح.";
            errorBox.classList.remove('hidden');
            errorBox.style.display = 'block';
        }
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'جاري الحفظ...';
    }

    saveNewPharmacyToFirestore(name, phone, lat, lng, details)
        .then(status => {
            if (successMsg) {
                if (status === 'created') {
                    successMsg.innerHTML = "✅ **تم إضافة الصيدلية بنجاح!** شكراً لك.";
                } else if (status === 'updated') {
                    successMsg.innerHTML = "📝 **تم تحديث بيانات الصيدلية بنجاح!** (باستخدام نفس الرقم). شكراً لك.";
                }

                successMsg.classList.remove('hidden');
            }
            document.getElementById('pharmacyName').value = '';
            document.getElementById('pharmacyPhone').value = '';
            document.getElementById('pharmacyDetails').value = '';
            initMap(INITIAL_LAT, INITIAL_LNG);
        })
        .catch(err => {
            if (errorBox) {
                errorBox.innerHTML = `🔥 فشل الحفظ: ${err.message || err.toString()}`;
                errorBox.classList.remove('hidden');
                errorBox.style.display = 'block';
            }
        })
        .finally(() => {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'إضافة الصيدلية';
            }
        });
}

function initializeAddPharmacyPage() {
    if (document.getElementById('map')) {
        initMap(INITIAL_LAT, INITIAL_LNG);
    }
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons();
    }
}
