// =========================================================
// 🌐 ثوابت خاصة بصفحة إضافة صيدلية (لـ add_pharmacy.html)
// =========================================================

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
