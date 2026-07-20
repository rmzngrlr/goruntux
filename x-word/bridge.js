// X Rapor - Web Page to Extension Bridge Content Script

// 1. Mark that the extension is installed
document.documentElement.setAttribute('data-x-rapor-installed', 'true');

// Try to set version synchronously (Chrome)
let extVersion = "1.0";
try {
  if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getManifest === "function") {
    extVersion = chrome.runtime.getManifest().version;
  }
} catch (e) {
  // Firefox does not allow getManifest in content script
}
document.documentElement.setAttribute('data-x-rapor-version', extVersion);

// Fallback: request version from background script asynchronously (Firefox)
if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
  try {
    chrome.runtime.sendMessage({ action: "getExtensionVersion" }, (response) => {
      if (chrome.runtime.lastError) { return; }
      if (response && response.version) {
        document.documentElement.setAttribute('data-x-rapor-version', response.version);
      }
    });
  } catch (e) {
    // Ignore error
  }
}

// 1.5. Panel kaydi (server_origin + panel_tab_id) — SADECE GERCEK PANEL.
// Panel HTML'inde <meta name="x-rapor-panel"> isareti var. Yalnizca bu isareti tasiyan sayfa
// kendini panel olarak kaydeder. Boylece rastgele http sekmeleri ya da is-sekmeleri panel_tab_id'yi
// ele geciremez; "panel kapaninca iptal" ve "tek panel/yonlendir" davranislari guvenilir olur.
function xRaporRegisterPanel() {
  try {
    const currentOrigin = window.location.origin;
    const isValid = currentOrigin.startsWith('http://') || currentOrigin.startsWith('https://');
    if (!isValid) return;
    const marker = document.querySelector('meta[name="x-rapor-panel"]');
    if (!marker) return; // gercek GoruntuX paneli degil -> panel olarak kaydetme
    chrome.runtime.sendMessage({
      action: "registerPanel",
      origin: currentOrigin,
      client_id: localStorage.getItem('x_client_id') || ""
    }, (resp) => {
      if (chrome.runtime.lastError) { return; }
      // Zaten baska bir sekmede panel aciksa eklenti onu odaklayip BU sekmeyi kapatir (resp.duplicate).
      // Ekstra bir sey yapmaya gerek yok; ama kapanmadan once kisa bir bilgi gosterebiliriz.
      if (resp && resp.duplicate) {
        try { document.documentElement.innerHTML =
          '<body style="background:#0d1117;color:#c9d1d9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:18px;">Panel zaten baska bir sekmede acik, oraya yonlendiriliyorsunuz...</body>'; } catch (_) {}
      }
    });
  } catch (e) { /* ignore */ }
}

if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
  try {
    // Panel kaydini DOM hazir olunca yap (meta isareti okunabilsin).
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', xRaporRegisterPanel);
    } else {
      xRaporRegisterPanel();
    }
    // SILINDI (v3.62): setUserAuth cagrisi. Bu dosya HER http(s) sayfasinda calistigi icin
    // her ziyaret edilen siteden KOSULSUZ gonderiliyordu ve isleyicisi server_origin'i
    // sayfanin origin'inden yazabiliyordu. Ustelik username sabit "user" idi — yani hicbir
    // gercek kimlik tasimyordu. Onceki urunun oturum tesisatindan kalma.
  } catch (e) {
    // Safe to ignore
  }
}

// 2. Panelden gelen postMessage olaylari.
//
// GUVENLIK KAPISI (v3.62). Bu dosya HER http(s) sayfasinda calisiyor (manifest
// content_scripts matches: http://*/*, https://*/*). Eskiden tek kontrol
// `event.source !== window` idi — ama o, sayfanin KENDI JS'ini engellemez; yalnizca
// iframe/baska pencere kaynaklarini eler. Yani ZIYARET EDILEN HERHANGI BIR SITE
// asagidaki dallari tetikleyebiliyordu (silinen cerez koprusuyle ayni sinif).
//
// Artik xRaporRegisterPanel ile AYNI kapi kullaniliyor: yalnizca <meta name="x-rapor-panel">
// isaretini tasiyan GERCEK panel sayfasi bu olaylari gonderebilir. Isaret app.py:780'de
// <head> icinde basiliyor, yani her script'ten ONCE hazir — panel islevi etkilenmez.
//
// SILINEN DALLAR (panelde HIC gondericisi yoktu, app.py grep'i ile dogrulandi):
//   X_RAPOR_PING/PONG            -> varlik tespiti zaten data-x-rapor-installed ile yapiliyor
//   X_RAPOR_START_SCAN           -> sayfanin verdigi URL'i sekmede aciyordu
//   X_RAPOR_DETECT_ACTIVE_PROFILE-> kurbanin X kullanici adini sayfaya donduruyordu
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!document.querySelector('meta[name="x-rapor-panel"]')) return;   // yalnizca GERCEK panel

  // Handle Force Poll requests
  if (event.data && event.data.type === "X_RAPOR_FORCE_POLL") {
    try {
      chrome.runtime.sendMessage({ action: "forcePollJobs" }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch(e) {}
  }

  // Word taramasını DOĞRUDAN başlat (poll_job'a bağlı olmadan; SW'yi uyandırır).
  if (event.data && event.data.type === "X_RAPOR_START_WORD") {
    try {
      chrome.runtime.sendMessage({ action: "startWordScan", job: event.data.job }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch(e) {}
  }

  // Faz #1-A: yerel goruntu bayragini eklentiye bildir (widget bu bayraga gore goruntuyu
  // sunucuya gondermeyip panele iletir).
  if (event.data && event.data.type === "X_RAPOR_SET_LOCAL_IMAGES") {
    try {
      chrome.runtime.sendMessage({ action: "setLocalImages", value: !!event.data.value }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch(e) {}
  }

});

// Faz #1-A: SW'den gelen yerel goruntuyu panel sayfasina aktar (SW -> bridge -> panel).
// Panel (x-local-images.js) X_RAPOR_LOCAL_IMAGE mesajini dinleyip IndexedDB'ye yazar.
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg && msg.action === "localImage" && msg.link && msg.dataUrl) {
        window.postMessage({ type: "X_RAPOR_LOCAL_IMAGE", link: msg.link, dataUrl: msg.dataUrl, mime: msg.mime || "" }, "*");
        sendResponse && sendResponse({ status: "ok" });
      }
    } catch (e) {}
    return false;
  });
}

// SILINDI (v3.61): 'xrapor_request_cookies' dinleyicisi — X oturum cerezlerini
// sayfaya veren kod yolu. Bu dosya HER http(s) sayfasinda calistigi icin (manifest
// content_scripts matches: http://*/*, https://*/*) ziyaret edilen herhangi bir site
// bu olayi tetikleyebiliyordu. Uc kusur ust uste binmisti:
//   1) Cagiran 'confirmed: true' gonderdiginde onay penceresi TAMAMEN atlaniyordu.
//   2) background.js tarafi cagiranin kim oldugunu HIC dogrulamiyordu.
//   3) Yanit, cerezler icindeyken sayfanin DOM'una CustomEvent ile birakiliyordu —
//      hemen ustundeki yorum satiri "avoiding exposing cookies in DOM" diyordu ama
//      yaptigi tam tersiydi.
// Sonuc: auth_token dahil X oturumu sizdirilabilirdi (sifre/2FA atlanir).
// Ozellik ZATEN KULLANILMIYORDU: panel bu olayi hicbir yerde tetiklemiyor ve sunucuda
// cerez tuketen kod yok — sunucu tarafi Word uretimi tarayiciya tasinirken yol olmus,
// tesisati sokulmemis. Islev kaybi YOK.

// ----------------- MV3 SERVIS WORKER KEEPALIVE -----------------
// MV3'te service worker boşta kalınca sonlanır; bu yüzden tarama bitip yeni tarama
// başlatılınca "F5 yapmadan başlamıyor" sorunu oluşuyordu. Kalıcı bir bağlantı (port)
// açık olduğu sürece SW canlı kalır. Panel açık olduğu sürece yoklama döngüsü ölmez,
// böylece "Başlat" F5 beklemeden çalışır. Chrome portu bir süre sonra kapatabilir;
// koptuğunda yeniden bağlanırız.
(function () {
  function xRaporKeepAlive() {
    try {
      const p = chrome.runtime.connect({ name: "x-rapor-keepalive" });
      // Boş bir port bazı Chrome sürümlerinde SW'yi canlı tutmaya yetmiyor.
      // Asıl güvenilir yöntem: port üzerinden düzenli aktivite (her 15 sn ping).
      // Bu, MV3'ün ~30 sn'lik boşta-kalma zaman aşımını sürekli sıfırlar.
      const pinger = setInterval(function () {
        try { p.postMessage({ t: "keepalive-ping" }); }
        catch (e) { clearInterval(pinger); }
      }, 15000);
      p.onDisconnect.addListener(function () {
        clearInterval(pinger);
        if (chrome.runtime.lastError) { /* ignore */ }
        setTimeout(xRaporKeepAlive, 1000);
      });
    } catch (e) {
      setTimeout(xRaporKeepAlive, 2000);
    }
  }
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.connect) {
    xRaporKeepAlive();
  }
})();
