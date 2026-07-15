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

// 1.5. Panelin origin'ini background'a gönder (server_origin otomatik kayıt)
if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
  try {
    const currentOrigin = window.location.origin;
    const currentHost = window.location.hostname;
    // x.com veya twitter.com değilse ve geçerli bir http(s) sayfasıysa → bu panelin sunucusu olabilir
    // Is-sekmelerinin (x/twitter/instagram) panel gibi kaydolup server_origin ve panel_tab_id'yi
    // KIRLETMESINI onle. Instagram eskiden bu listede yoktu; bir instagram is-sekmesi savePanelOrigin
    // yollayip server_origin'i instagram.com'a, panel_tab_id'yi is-sekmesine yaziyordu -> sonraki
    // taramanin submit'leri yanlis adrese gidiyor / onRemoved yanlis tetikleniyordu.
    const isTargetSocial = currentHost === 'x.com' || currentHost === 'twitter.com' ||
                          currentHost.endsWith('.x.com') || currentHost.endsWith('.twitter.com') ||
                          currentHost === 'instagram.com' || currentHost.endsWith('.instagram.com');
    const isValid = currentOrigin.startsWith('http://') || currentOrigin.startsWith('https://');
    if (!isTargetSocial && isValid) {
      chrome.runtime.sendMessage({
        action: "savePanelOrigin",
        origin: currentOrigin,
        client_id: localStorage.getItem('x_client_id') || ""
      }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    }
    chrome.runtime.sendMessage({
      action: "setUserAuth",
      loggedIn: true,
      username: "user"
    }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  } catch (e) {
    // Safe to ignore
  }
}

// 2. Listen to postMessage events from the web app
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  // Handle Ping requests
  if (event.data && event.data.type === "X_RAPOR_PING") {
    window.postMessage({ type: "X_RAPOR_PONG" }, "*");
  }

  // Handle Start Scan requests
  if (event.data && event.data.type === "X_RAPOR_START_SCAN") {
    try {
      chrome.runtime.sendMessage({ action: "startScan", job: event.data.job }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch(e) {}
  }

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

  // Handle Active Profile Detection requests
  if (event.data && event.data.type === "X_RAPOR_DETECT_ACTIVE_PROFILE") {
    try {
      chrome.runtime.sendMessage({ action: "detectActiveProfile" }, (response) => {
        window.postMessage({ 
          type: "X_RAPOR_ACTIVE_PROFILE_RESPONSE", 
          username: response ? response.username : null 
        }, "*");
      });
    } catch (e) {
      // Background worker might be inactive
    }
  }
});

// CustomEvent listener for fetching x.com cookies specifically for the admin panel bridge
document.addEventListener('xrapor_request_cookies', (event) => {
    const targetUsername = event.detail.target_username;
    const origin = window.location.origin;
    const confirmed = event.detail.confirmed;

    // Güvenlik: Çerezlerin gönderileceği hedef adresi kullanıcıya açıkça sorup onay almak zorundayız,
    // aksi halde kötü niyetli bir sayfa DOM üzerinden bu eventi tetikleyip çerezleri çalabilir.
    // Eğer istek yapan sayfa SweetAlert2 ile önceden onay aldıysa (confirmed: true), confirm pencerisini atlarız.
    if (!confirmed) {
        if (!confirm(`DİKKAT: "${origin}" adresindeki sunucu, X.com (Twitter) çerezlerinize erişim istiyor.\n\nBu işlem, sunucunun sizin hesabınızla ("@${targetUsername}") işlem yapmasına olanak tanır.\n\nBu siteye GÜVENİYOR MUSUNUZ ve çerezlerinizin gönderilmesini onaylıyor musunuz?`)) {
            document.dispatchEvent(new CustomEvent('xrapor_cookies_response', {
                detail: { success: false, message: "Kullanıcı çerez erişimini reddetti." }
            }));
            return;
        }
    }

    // Send message to background script to sync cookies securely to backend
    try {
        chrome.runtime.sendMessage({ action: "syncTwitterCookies", targetUsername: targetUsername, origin: origin }, (response) => {
            // Dispatch response status back to the window, avoiding exposing cookies in DOM
            document.dispatchEvent(new CustomEvent('xrapor_cookies_response', { detail: response }));
        });
    } catch (e) {
        document.dispatchEvent(new CustomEvent('xrapor_cookies_response', {
            detail: { success: false, message: "Eklenti arka plan servisine ulaşılamadı. Lütfen sayfayı yenileyin." }
        }));
    }
});

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
