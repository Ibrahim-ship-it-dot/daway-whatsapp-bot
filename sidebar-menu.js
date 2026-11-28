(function enforcePhoneSessionGuard() {
  const currentPage = (window.location.pathname.split("/").pop() || "").toLowerCase();
  if (currentPage === "login.html" || currentPage === "register.html") return;

  const phone = String(
    localStorage.getItem("userPhone") ||
    localStorage.getItem("loggedInPhone") ||
    localStorage.getItem("phone") ||
    sessionStorage.getItem("userPhone") ||
    ""
  ).trim();

  if (!phone) {
    try {
      window.location.replace("login.html");
    } catch (_) {
      window.location.href = "login.html";
    }
  }
})();

(function () {
  const ADMIN_PHONE = "249128514785";

  function digitsOnly(v) {
    return String(v || "").replace(/\D/g, "");
  }

  function isSudan12(d) {
    return /^249\d{9}$/.test(digitsOnly(d));
  }

  function tail9(v) {
    const d = digitsOnly(v);
    return d.length > 9 ? d.slice(-9) : d;
  }

  function checkIsAdmin(digits) {
    if (!digits) return false;
    return (
      digits === ADMIN_PHONE ||
      (tail9(digits).length === 9 && tail9(digits) === tail9(ADMIN_PHONE))
    );
  }

  async function detectRoleAndIdentity() {
    const digits = digitsOnly(localStorage.getItem("userPhone") || "");
    const isAdmin = checkIsAdmin(digits);

    let phName = String(localStorage.getItem("pharmacyName") || "").trim();
    let phPhone = digitsOnly(localStorage.getItem("pharmacyPhone") || digits);
    let hasPharmacyRecord = false;

    if (isSudan12(digits) && typeof db !== "undefined" && db) {
      try {
        const directSnap = await db.collection("pharmacies").doc(digits).get();
        if (directSnap.exists) {
          const d = directSnap.data() || {};
          hasPharmacyRecord = true;
          phName = String(d.name || d.pharmacyName || phName || "").trim();
          phPhone = digitsOnly(d.phone || digits);
        } else {
          const qSnap = await db.collection("pharmacies").where("phone", "==", digits).limit(1).get();
          if (!qSnap.empty) {
            const d = qSnap.docs[0].data() || {};
            hasPharmacyRecord = true;
            phName = String(d.name || d.pharmacyName || phName || "").trim();
            phPhone = digitsOnly(d.phone || digits);
          }
        }
      } catch (_) {}
    }

    // الشرط الصارم: اسم صيدلية + رقم صيدلية صحيح (12 رقم يبدأ بـ 249)
    const hasCompletePharmacyIdentity = Boolean(phName && isSudan12(phPhone || digits));
    const isPharmacist = Boolean(hasCompletePharmacyIdentity && (hasPharmacyRecord || localStorage.getItem("accountType") === "pharmacist"));

    if (isPharmacist) {
      localStorage.setItem("accountType", "pharmacist");
      localStorage.setItem("pharmacyName", phName);
      localStorage.setItem("pharmacyPhone", phPhone || digits);
    } else {
      if (localStorage.getItem("accountType") === "pharmacist" && !hasCompletePharmacyIdentity) {
        localStorage.removeItem("accountType");
      }
    }

    if (isAdmin) {
      localStorage.setItem("isAdmin", "true");
      localStorage.setItem("userRole", "admin");
    } else {
      localStorage.removeItem("isAdmin");
      if (localStorage.getItem("userRole") === "admin") {
        localStorage.removeItem("userRole");
      }
    }

    return { digits, isAdmin, isPharmacist, phName, phPhone: phPhone || digits };
  }

  const ORDERED_MENU_ITEMS = [
    // قائمة الصيدلي (تظهر فقط للصيدلي الذي يملك اسم صيدلية ورقم صيدلية، أو للأدمن)
    { href: "pharmacist-replies.html", label: "📩 الأسئلة الواردة ", bg: "#0369a1", role: "pharmacist", id: null },
    { href: "addph.html", label: "✏️ تعديل الرد السريع والصيدليه", bg: "#0f766e", role: "pharmacist", id: null },

    // قائمة الأدمن
    { href: "pharmacies.html", label: "🏥 إدارة الصيدليات", bg: "#0f766e", role: "admin", id: "adminPharmaciesLink" },

    // القائمة العامة
    { href: "index.html", label: "💊 صفحة الاستعلام عن دواء", bg: "#0284c7", role: "all", id: null },
    { href: "history.html", label: "📜سجل الاسئلة", bg: "#495057", role: "all", id: null },
    { href: "notifications.html", label: "🔔 الإشعارات", bg: "#475569", role: "all", id: null },
    { href: "profile.html", label: "⚙️ تعديل الملف الشخصي والموقع", bg: "#495057", role: "all", id: null },
    { href: "daway.html", label: "📱 تحميل تطبيق دواي السودان", bg: "#495057", role: "all", id: null }
  ];

  function rebuildAndOrderSidebar(sb, { digits, isAdmin, isPharmacist, phName }) {
    if (!sb) return;

    const headerEl = sb.querySelector(".sidebar-header");
    const prevContainer = sb.querySelector("#previousQuestionsContainer");

    const knownHrefs = new Set(ORDERED_MENU_ITEMS.map((i) => i.href));
    sb.querySelectorAll("a").forEach((a) => {
      const h = (a.getAttribute("href") || "").trim();
      if (knownHrefs.has(h) || a.id === "adminPharmaciesLink" || a.id === "addphSidebarIncomingAsksLink") {
        a.remove();
      }
    });

    const currentPage = (window.location.pathname.split("/").pop() || "").trim();

    ORDERED_MENU_ITEMS.forEach((item) => {
      const shouldShow =
        item.role === "admin"
          ? isAdmin
          : item.role === "pharmacist"
          ? Boolean((isPharmacist && phName) || isAdmin)
          : true;

      if (!shouldShow) return;

      const link = document.createElement("a");
      link.href = item.href;
      link.textContent = item.label;
      if (item.id) link.id = item.id;
      link.setAttribute("data-menu-role", item.role);

      const isCurrent = currentPage === item.href;
      link.style.cssText =
        "display: block !important; font-weight: 700; color: #ffffff; background: " +
        (isCurrent ? "#0f172a" : item.bg) +
        ";" +
        (isCurrent ? " border-right: 4px solid #38bdf8;" : "");

      if (prevContainer && prevContainer.parentNode === sb) {
        sb.insertBefore(link, prevContainer);
      } else {
        sb.appendChild(link);
      }
    });

    if (headerEl && headerEl.parentNode === sb && sb.firstElementChild !== headerEl) {
      sb.insertBefore(headerEl, sb.firstElementChild);
    }
  }

  async function renderAllMenus() {
    const info = await detectRoleAndIdentity();

    const sessionEl = document.getElementById("sessionInfo");
    if (sessionEl) {
      sessionEl.textContent =
        info.isPharmacist && info.phName
          ? info.phName + " (" + info.phPhone + ")"
          : info.digits || "غير مسجل";
    }

    const sidebars = document.querySelectorAll("#sidebar, .sidebar, nav.sidebar");
    sidebars.forEach((sb) => rebuildAndOrderSidebar(sb, info));
  }

  window.refreshSidebarMenu = renderAllMenus;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      renderAllMenus();
      setTimeout(renderAllMenus, 500);
    });
  } else {
    renderAllMenus();
    setTimeout(renderAllMenus, 500);
  }
})();
(function syncSidebarIncomingCounter() {
  const digits = (v) => String(v || "").replace(/\D/g, "");
  const isSudan12 = (d) => /^249\d{9}$/.test(digits(d));
  const tail9 = (d) => (d.length > 9 ? d.slice(-9) : d);
  const km = (a, b, c, d) => {
    const r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
    const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2;
    return 12742 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  const inSd = (lat, lng) => !isNaN(lat) && !isNaN(lng) && lat >= 3.5 && lat <= 23 && lng >= 21.5 && lng <= 39;

  function seenSet(ph) {
    try {
      const arr = JSON.parse(localStorage.getItem("seenAsks_" + (ph || "default")) || "[]");
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch (_) { return new Set(); }
  }

  function targeted(d, ph, phDoc) {
    if (!d || !isSudan12(ph)) return false;
    const t9 = tail9(ph);
    const same = (x) => { const n = digits(x); return isSudan12(n) && (n === ph || (t9.length === 9 && tail9(n) === t9)); };
    if ([d.targetPharmacyPhone, d.targetPharmacyId, d.pharmacyPhone, d.pharmacyId].some(same)) return true;
    for (const col of [d.targetPharmacies, d.targetedPharmacies, d.sentToPharmacies, d.matchedPharmacies, d.nearbyPharmacies]) {
      if (!col) continue;
      const items = Array.isArray(col) ? col : Object.entries(col).flatMap(([k, v]) => [k, v]);
      for (const it of items) {
        if (typeof it === "string" || typeof it === "number") { if (same(it)) return true; }
        else if (it && typeof it === "object" && same(it.phone || it.pharmacyPhone || it.pharmacyId || it.id || it.sessionId)) return true;
      }
    }
    const aLat = parseFloat(d.lat ?? d.userLat ?? d.latitude), aLng = parseFloat(d.lng ?? d.userLng ?? d.longitude);
    const pLat = parseFloat(phDoc && phDoc.lat), pLng = parseFloat(phDoc && phDoc.lng);
    const rng = parseFloat(d.range ?? d.searchRange);
    return inSd(aLat, aLng) && inSd(pLat, pLng) && rng > 0 && km(aLat, aLng, pLat, pLng) <= rng;
  }

  function paintBadge(val) {
    const n = Math.max(0, Number(val) || 0);
    window.__incomingAsksCount = n;
    const sb = document.getElementById("sidebar");
    if (!sb) return;
    let a = sb.querySelector("a[href='pharmacist-replies.html']");
    if (!a) return;
    a.style.display = "flex";
    a.style.alignItems = "center";
    a.style.justifyContent = "space-between";
    let b = a.querySelector("#sidebarIncomingAsksBadge");
    if (!b) {
      b = document.createElement("span");
      b.id = "sidebarIncomingAsksBadge";
      b.style.cssText = "background:#ef4444;color:#fff;border-radius:999px;padding:1px 7px;font-size:11.5px;font-weight:800;min-width:18px;text-align:center;";
      a.appendChild(b);
    }
    b.textContent = String(n);
  }

  if (typeof window.refreshSidebarMenu === "function" && !window.__wrappedSbCounter) {
    const prev = window.refreshSidebarMenu;
    window.__wrappedSbCounter = async function () {
      const r = await prev.apply(this, arguments);
      paintBadge(window.__incomingAsksCount);
      return r;
    };
    window.refreshSidebarMenu = window.__wrappedSbCounter;
  }

  async function init() {
    const addphBadge = document.getElementById("incomingAsksCountBadge");
    if (addphBadge && !window.__addphBadgeObserved) {
      window.__addphBadgeObserved = true;
      paintBadge(addphBadge.textContent);
      new MutationObserver(() => paintBadge(addphBadge.textContent)).observe(addphBadge, { childList: true, characterData: true, subtree: true });
    }
    if (typeof db === "undefined" || !db || window.__sbCounterBound) return;
    const ph = digits(document.getElementById("pharmacyPhone")?.value || localStorage.getItem("userPhone") || "");
    if (!isSudan12(ph)) return;
    window.__sbCounterBound = true;
    let phDoc = null;
    try { const s = await db.collection("pharmacies").doc(ph).get(); if (s.exists) phDoc = s.data() || {}; } catch (_) {}
    db.collection("AskPharmacy").onSnapshot((snap) => {
      if (!snap) return;
      const seen = seenSet(ph);
      let c = 0;
      snap.forEach((doc) => {
        const d = doc.data() || {};
        if (!targeted(d, ph, phDoc)) return;
        const replied = (Array.isArray(d.responses) ? d.responses : []).some((r) => digits(r.pharmacyPhone || r.pharmacyId || r.phone) === ph);
        const isSeen = seen.has(String(doc.id)) || Boolean(d.seenByPharmacy && d.seenByPharmacy[ph]);
        if (!replied && !isSeen) c++;
      });
      paintBadge(c);
    }, () => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { setTimeout(init, 300); setTimeout(init, 1200); });
  } else {
    setTimeout(init, 300); setTimeout(init, 1200);
  }
})();

(function closeSidebarOnOutsideClick() {
  if (window.__outsideCloseBound) return;
  window.__outsideCloseBound = true;

  function isSidebarOpen(sb) {
    if (!sb) return false;
    const w = parseFloat(window.getComputedStyle(sb).width || "0");
    return w > 10 || sb.classList.contains("open") || sb.classList.contains("active");
  }

  function closeAnyOpenSidebar() {
    if (typeof window.closeSidebar === "function") {
      try { window.closeSidebar(); } catch (_) {}
    }
    if (typeof window.closeInfoSidebar === "function") {
      try { window.closeInfoSidebar(); } catch (_) {}
    }
    document.querySelectorAll("#sidebar, .sidebar, nav.sidebar, #infoSidebar").forEach((sb) => {
      sb.style.width = "0";
      sb.classList.remove("open", "active");
    });
  }

  function handleOutsidePress(e) {
    const target = e.target;
    if (!target) return;

    const clickedInsideSidebar = target.closest("#sidebar, .sidebar, nav.sidebar, #infoSidebar");
    const clickedToggleBtn = target.closest(
      "[onclick*='toggleSidebar'], [onclick*='toggleInfoSidebar'], #menuBtn, #sidebarToggle, .menu-toggle, .hamburger"
    );

    if (clickedInsideSidebar || clickedToggleBtn) return;

    const openSidebars = Array.from(document.querySelectorAll("#sidebar, .sidebar, nav.sidebar, #infoSidebar")).filter(isSidebarOpen);
    if (openSidebars.length > 0) {
      closeAnyOpenSidebar();
    }
  }

  document.addEventListener("click", handleOutsidePress, true);
  document.addEventListener("touchstart", handleOutsidePress, { passive: true, capture: true });
})();
