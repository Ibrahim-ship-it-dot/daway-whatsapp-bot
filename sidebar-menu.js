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

    const hasCompletePharmacyIdentity = Boolean(phName && isSudan12(phPhone || digits));
    const isPharmacist = Boolean(hasCompletePharmacyIdentity && (hasPharmacyRecord || localStorage.getItem("accountType") === "pharmacist"));

    if (isPharmacist) {
      localStorage.setItem("accountType", "pharmacist");
      localStorage.setItem("pharmacyName", phName);
      localStorage.setItem("pharmacyPhone", phPhone || digits);
    } else if (localStorage.getItem("accountType") === "pharmacist" && !hasCompletePharmacyIdentity) {
      localStorage.removeItem("accountType");
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
    { href: "pharmacist-replies.html", label: "📩 الأسئلة الواردة ", bg: "#0369a1", role: "pharmacist", id: null },
    { href: "addph.html", label: "✏️ تعديل الرد السريع والصيدليه", bg: "#0f766e", role: "pharmacist", id: null },
    { href: "pharmacies.html", label: "🏥 إدارة الصيدليات", bg: "#0f766e", role: "admin", id: "adminPharmaciesLink" },
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
    const r = Math.PI / 180;
    const x = (c - a) * r;
    const y = (d - b) * r;
    const h = Math.sin(x / 2) * Math.sin(x / 2) + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) * Math.sin(y / 2);
    return 12742 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  const inSd = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= 3.5 && lat <= 23 && lng >= 21.5 && lng <= 39;

  let activePhone = "";
  let latestAskIds = [];
  let latestNotifIds = [];
  let incomingAsksCount = 0;
  let unreadRepliesCount = 0;

  function samePhone(a, b) {
    const da = digits(a);
    const dbDigits = digits(b);
    if (!da || !dbDigits) return false;
    if (da === dbDigits) return true;
    const ta = tail9(da);
    const tb = tail9(dbDigits);
    return ta.length >= 7 && ta === tb;
  }

  function seenSet(prefix, ph) {
    try {
      const arr = JSON.parse(localStorage.getItem(prefix + (ph || "default")) || "[]");
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch (_) {
      return new Set();
    }
  }

  function addSeenIds(prefix, ph, ids) {
    const keys = [prefix + "default"];
    if (ph) keys.push(prefix + ph);
    keys.forEach((k) => {
      try {
        const current = JSON.parse(localStorage.getItem(k) || "[]");
        const merged = Array.from(new Set([...(Array.isArray(current) ? current.map(String) : []), ...ids]));
        localStorage.setItem(k, JSON.stringify(merged));
      } catch (_) {}
    });
  }

  function markAllAsSeen(ph) {
    const targetPh = ph || activePhone || digits(document.getElementById("pharmacyPhone")?.value || localStorage.getItem("userPhone") || "");
    addSeenIds("seenAsks_", targetPh, latestAskIds);
    addSeenIds("seenReplyNotifs_", targetPh, latestNotifIds);
    incomingAsksCount = 0;
    unreadRepliesCount = 0;
    paintTopBell(0);
    paintSidebarAskBadge(0);
  }

  function targeted(d, ph, phDoc) {
    if (!d || !isSudan12(ph)) return false;
    const t9 = tail9(ph);
    const same = (x) => {
      const n = digits(x);
      return isSudan12(n) && (n === ph || (t9.length === 9 && tail9(n) === t9));
    };
    if ([d.targetPharmacyPhone, d.targetPharmacyId, d.pharmacyPhone, d.pharmacyId].some(same)) return true;
    for (const col of [d.targetPharmacies, d.targetedPharmacies, d.sentToPharmacies, d.matchedPharmacies, d.nearbyPharmacies]) {
      if (!col) continue;
      const items = Array.isArray(col) ? col : Object.entries(col).flatMap(([k, v]) => [k, v]);
      for (const it of items) {
        if (typeof it === "string" || typeof it === "number") {
          if (same(it)) return true;
        } else if (it && typeof it === "object" && same(it.phone || it.pharmacyPhone || it.pharmacyId || it.id || it.sessionId)) {
          return true;
        }
      }
    }
    const aLat = parseFloat(d.lat ?? d.userLat ?? d.latitude);
    const aLng = parseFloat(d.lng ?? d.userLng ?? d.longitude);
    const pLat = parseFloat(phDoc && phDoc.lat);
    const pLng = parseFloat(phDoc && phDoc.lng);
    const rng = parseFloat(d.range ?? d.searchRange);
    return inSd(aLat, aLng) && inSd(pLat, pLng) && rng > 0 && km(aLat, aLng, pLat, pLng) <= rng;
  }

  function paintTopBell(totalVal) {
    const n = Math.max(0, Number(totalVal) || 0);
    window.__topBellTotalCount = n;
    const topBadge = document.getElementById("resultsNotifBadgeCount");
    if (!topBadge) return;
    topBadge.textContent = String(n);
    topBadge.style.display = n > 0 ? "inline-block" : "none";
  }

  function paintSidebarAskBadge(val) {
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
    b.style.display = n > 0 ? "inline-block" : "none";
  }

  function refreshCombinedTopCounter() {
    const page = (window.location.pathname.split("/").pop() || "").toLowerCase();
    if (page === "notifications.html") {
      paintTopBell(0);
      return;
    }
    paintTopBell(incomingAsksCount + unreadRepliesCount);
  }

  window.clearTopNotifCounter = markAllAsSeen;

  if (typeof window.refreshSidebarMenu === "function" && !window.__wrappedSbCounter) {
    const prev = window.refreshSidebarMenu;
    window.__wrappedSbCounter = async function () {
      const r = await prev.apply(this, arguments);
      paintSidebarAskBadge(incomingAsksCount);
      refreshCombinedTopCounter();
      return r;
    };
    window.refreshSidebarMenu = window.__wrappedSbCounter;
  }

  async function init() {
    const page = (window.location.pathname.split("/").pop() || "").toLowerCase();
    const ph = digits(document.getElementById("pharmacyPhone")?.value || localStorage.getItem("userPhone") || "");
    if (ph) activePhone = ph;

    if (page === "notifications.html") {
      markAllAsSeen(activePhone);
    } else if (page === "pharmacist-replies.html") {
      addSeenIds("seenAsks_", activePhone, latestAskIds);
      incomingAsksCount = 0;
      paintSidebarAskBadge(0);
      refreshCombinedTopCounter();
    }

    const addphBadge = document.getElementById("incomingAsksCountBadge");
    if (addphBadge && !window.__addphBadgeObserved) {
      window.__addphBadgeObserved = true;
      incomingAsksCount = Math.max(0, Number(addphBadge.textContent) || 0);
      paintSidebarAskBadge(incomingAsksCount);
      refreshCombinedTopCounter();
      new MutationObserver(() => {
        incomingAsksCount = Math.max(0, Number(addphBadge.textContent) || 0);
        paintSidebarAskBadge(incomingAsksCount);
        refreshCombinedTopCounter();
      }).observe(addphBadge, { childList: true, characterData: true, subtree: true });
    }

    if (typeof db === "undefined" || !db || window.__sbCounterBound) return;
    if (!ph) return;
    window.__sbCounterBound = true;

    let phDoc = null;
    if (isSudan12(ph)) {
      try {
        const s = await db.collection("pharmacies").doc(ph).get();
        if (s.exists) phDoc = s.data() || {};
      } catch (_) {}
    }

    if (isSudan12(ph)) {
      db.collection("AskPharmacy").onSnapshot((snap) => {
        if (!snap) return;
        const currentPage = (window.location.pathname.split("/").pop() || "").toLowerCase();
        const seen = seenSet("seenAsks_", ph);
        let c = 0;
        const ids = [];
        snap.forEach((doc) => {
          const d = doc.data() || {};
          if (!targeted(d, ph, phDoc)) return;
          const idStr = String(doc.id);
          ids.push(idStr);
          if (currentPage === "pharmacist-replies.html" || currentPage === "notifications.html") return;
          const replied = (Array.isArray(d.responses) ? d.responses : []).some(
            (r) => samePhone(r && (r.pharmacyPhone || r.pharmacyId || r.phone), ph)
          );
          const isSeen = seen.has(idStr) || Boolean(d.seenByPharmacy && d.seenByPharmacy[ph]);
          if (!replied && !isSeen) c++;
        });
        latestAskIds = ids;
        incomingAsksCount = c;
        paintSidebarAskBadge(c);
        refreshCombinedTopCounter();
      }, () => {});
    }

    db.collection("notifications").onSnapshot((snap) => {
      if (!snap) return;
      const currentPage = (window.location.pathname.split("/").pop() || "").toLowerCase();
      const seenNotifs = seenSet("seenReplyNotifs_", ph);
      let rCount = 0;
      const nIds = [];
      snap.forEach((doc) => {
        const d = doc.data() || {};
        const ownerRef = d.userPhone || d.recipientPhone || d.phone || d.uniqueAccountRef || "";
        if (!samePhone(ownerRef, ph)) return;
        const idStr = String(doc.id);
        nIds.push(idStr);
        if (currentPage === "notifications.html") return;
        const isRead = Boolean(d.read || d.isRead || d.seen) || seenNotifs.has(idStr);
        if (!isRead) rCount++;
      });
      latestNotifIds = nIds;
      unreadRepliesCount = rCount;
      refreshCombinedTopCounter();
    }, () => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(init, 300);
      setTimeout(init, 1200);
    });
  } else {
    setTimeout(init, 300);
    setTimeout(init, 1200);
  }
})();

function mountTopCenterNotifIcon() {
  const page = (window.location.pathname.split("/").pop() || "").toLowerCase();
  if (page === "login.html" || page === "register.html" || page === "notifications.html") {
    return null;
  }
  if (!document.body) return null;
  if (document.getElementById("sidebarTopCenterNotifBtn")) {
    return document.getElementById("sidebarTopCenterNotifBtn");
  }

  const btn = document.createElement("a");
  btn.id = "sidebarTopCenterNotifBtn";
  btn.href = "notifications.html";
  btn.title = "الإشعارات";
  btn.style.cssText = [
    "position: fixed",
    "top: 14px",
    "left: 50%",
    "transform: translateX(-50%)",
    "z-index: 9999",
    "width: 42px",
    "height: 42px",
    "border-radius: 50%",
    "background: #ffffff",
    "color: #0f172a",
    "border: 1px solid #e2e8f0",
    "box-shadow: 0 4px 12px rgba(15, 23, 42, 0.16)",
    "display: inline-flex",
    "align-items: center",
    "justify-content: center",
    "text-decoration: none",
    "font-size: 19px",
    "cursor: pointer"
  ].join(";");

  const iconSpan = document.createElement("span");
  iconSpan.textContent = "🔔";

  const badgeSpan = document.createElement("span");
  badgeSpan.id = "resultsNotifBadgeCount";
  badgeSpan.textContent = "0";
  badgeSpan.style.cssText = [
    "position: absolute",
    "top: -4px",
    "right: -4px",
    "min-width: 19px",
    "height: 19px",
    "padding: 0 5px",
    "border-radius: 999px",
    "background: #ef4444",
    "color: #ffffff",
    "font-family: 'Cairo', sans-serif",
    "font-size: 11px",
    "font-weight: 800",
    "line-height: 19px",
    "text-align: center",
    "box-shadow: 0 2px 6px rgba(239, 68, 68, 0.45)",
    "display: none"
  ].join(";");

  btn.addEventListener("click", function () {
    if (typeof window.clearTopNotifCounter === "function") {
      window.clearTopNotifCounter();
    }
  });

  btn.appendChild(iconSpan);
  btn.appendChild(badgeSpan);
  document.body.appendChild(btn);
  return btn;
}

window.mountTopCenterNotifIcon = mountTopCenterNotifIcon;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () {
    mountTopCenterNotifIcon();
  });
} else {
  mountTopCenterNotifIcon();
}
