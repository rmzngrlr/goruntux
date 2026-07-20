const originalFetch = fetch;
fetch = function(url, options = {}) {
  let urlStr = typeof url === 'string' ? url : (url.url || "");
  if (urlStr.includes('/api/')) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(['client_id'], (result) => {
        const clientId = result.client_id || "";
        if (clientId) {
          const delimiter = urlStr.includes('?') ? '&' : '?';
          urlStr = `${urlStr}${delimiter}client_id=${encodeURIComponent(clientId)}`;
          if (typeof url === 'string') {
            url = urlStr;
          } else {
            url = new Request(urlStr, url);
          }
        }
        originalFetch(url, options).then(resolve).catch(reject);
      });
    });
  }
  return originalFetch(url, options);
};

let pollIntervalId = null;

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (!tab.url) continue;
        if (tab.url.startsWith("http://") || tab.url.startsWith("https://")) {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["bridge.js"]
          }).catch(err => {});
        }
      }
    });
  } catch (e) {}
  startPolling();
});

// Sunucu gorevini GUVENILIR sekilde iptal et (status=idle). :3011 -> :3012 esler,
// client_id'yi global fetch sarmalayicisi ekler, "Failed to fetch" olursa retry eder.
// Boylece panel kapaninca gorev gercekten iptal olur ve panel yeniden acilinca DEVAM ETMEZ.
function resetServerJobReliable(rawOrigin, attempt) {
  attempt = attempt || 1;
  let origin = rawOrigin || "http://localhost:3012";
  if (origin.includes(":3011")) origin = origin.replace(":3011", ":3012");
  const url = `${origin}/api/auto/reset`; // client_id'yi sarmalayici ekler
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    .then(r => r.json())
    .then(() => logToServer(`[onRemoved] Backend gorevi iptal edildi (status=idle).`))
    .catch(e => {
      logToServer(`[onRemoved] Reset denemesi ${attempt} basarisiz: ${e && (e.message || e)}`);
      if (attempt < 4) setTimeout(() => resetServerJobReliable(rawOrigin, attempt + 1), 800);
    });
}

// GERCEK panel sekmesi kapaninca aktif taramayi iptal et.
// panel_tab_id artik yalnizca registerPanel (meta-isaretli gercek panel) tarafindan atandigi icin,
// bu handler asla bir is-sekmesi ya da yardimci sekmeyle yanlis tetiklenmez (2. tarama guvende).
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  chrome.storage.local.get(null, (allData) => {
    if (chrome.runtime.lastError) return;
    const panelTabId = allData.panel_tab_id;
    if (!panelTabId || panelTabId !== tabId) return; // sadece gercek panel kapanisi

    logToServer(`[onRemoved] Panel sekmesi (${tabId}) kapatildi. Aktif tarama iptal ediliyor...`);

    let keysToRemove = ['aktif_gorev', 'panel_tab_id'];
    let tabsToRemove = [];
    for (let key in allData) {
      if (key.startsWith('x_profil_gorevi_') || key.startsWith('x_word_taramasi_')) {
        let tId = parseInt(key.replace(/^x_(profil_gorevi|word_taramasi)_/, ''));
        if (!isNaN(tId)) tabsToRemove.push(tId);
        keysToRemove.push(key);
      }
    }
    tabsToRemove.forEach(tId => {
      chrome.tabs.remove(tId, () => { if (chrome.runtime.lastError) { /* ignore */ } });
    });
    chrome.storage.local.remove(keysToRemove, () => {
      logToServer(`[onRemoved] Eklenti gorev verileri temizlendi.`);
    });
    resetServerJobReliable(allData.server_origin);
  });
});

// ----------------- PLATFORM TESPITI (Faz FB-1) -----------------
// app.py'deki detect_platform / fb_canonical_link'in KOPYASI.
// !!! Bu TEK KACINILMAZ kopya: MV3 service worker uzaktan kod (/x-platform.js) YUKLEYEMEZ.
// app.py (Python) ve /x-platform.js (panel) ile AYNI SONUCU vermek ZORUNDA — ayrisirsa
// kuyruk eslesmesi ve gruplama bozulur. Degistirirken UCUNU BIRDEN degistir.
function xIsFbHost(h) {
  h = String(h || '').toLowerCase();
  return h === 'facebook.com' || /\.facebook\.com$/.test(h);
}
function xUrlOf(link) {
  let s = String(link == null ? '' : link).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try { return new URL(s); } catch (e) { return null; }
}
function xIsYtHost(h) {   // Faz YT-1 (Python: _is_yt_host, panel: XPlat.isYtHost)
  h = String(h || '').toLowerCase();
  return h === 'youtube.com' || /\.youtube\.com$/.test(h)
      || h === 'youtu.be'    || /\.youtu\.be$/.test(h);
}
function xIsTtHost(h) {   // Faz TT-1 (Python: _is_tt_host, panel: XPlat.isTtHost)
  h = String(h || '').toLowerCase();
  return h === 'tiktok.com' || /\.tiktok\.com$/.test(h);
}
// 'x' | 'ig' | 'fb' | 'tt'. BILINMEYEN -> 'x' (mevcut davranis korunur).
// MV3 servis worker'i uzaktan kod YUKLEYEMEZ -> /x-platform.js'i kullanamiyoruz;
// bu, kacinilmaz UCUNCU kopya. Python detect_platform + XPlat.platform ile SIRA DAHIL
// birebir ayni tutulmali.
function xPlatformOf(link) {
  const low = String(link == null ? '' : link).toLowerCase();
  if (low.indexOf('instagram.com') !== -1) return 'ig';
  const u = xUrlOf(link);
  if (u && xIsFbHost(u.hostname)) return 'fb';
  if (u && xIsTtHost(u.hostname)) return 'tt';
  if (u && xIsYtHost(u.hostname)) return 'yt';
  return 'x';
}
// Faz YT-1: /watch?v=ID kimligi SORGUDA; /shorts/ID ve /post/ID YOLDA.
// youtu.be/live/embed -> watch?v=ID (ayni video). Shorts AYRI (yerlesim farkli).
const XYT_KISA_HOSTLAR = ['youtu.be', 'www.youtu.be'];
function xYtVid(x) { return /^[A-Za-z0-9_-]{5,20}$/.test(x || '') ? x : null; }
function xYtCanonical(link) {
  try {
    const u = xUrlOf(link);
    if (!u || !xIsYtHost(u.hostname)) return link;
    const host = String(u.hostname).toLowerCase();
    const path = String(u.pathname || '/').replace(/\/+$/, '');
    let m;
    if (XYT_KISA_HOSTLAR.indexOf(host) !== -1) {
      m = path.match(/^\/([^/]+)$/);
      const v0 = m ? xYtVid(m[1]) : null;
      return v0 ? ('https://www.youtube.com/watch?v=' + v0) : ('https://www.youtube.com' + (path || '/'));
    }
    if (path.toLowerCase() === '/watch') {
      const v1 = xYtVid(u.searchParams.get('v'));
      return v1 ? ('https://www.youtube.com/watch?v=' + v1) : 'https://www.youtube.com/watch';
    }
    m = path.match(/^\/(?:live|embed|v)\/([^/]+)$/i);
    if (m) { const v2 = xYtVid(m[1]); if (v2) return 'https://www.youtube.com/watch?v=' + v2; }
    m = path.match(/^\/shorts\/([^/]+)$/i);
    if (m) { const v3 = xYtVid(m[1]); if (v3) return 'https://www.youtube.com/shorts/' + v3; }
    m = path.match(/^\/post\/([^/]+)$/i);
    if (m) return 'https://www.youtube.com/post/' + m[1];
    return 'https://www.youtube.com' + (path || '/');
  } catch (e) { return link; }
}
function xIsYtPostUrl(link) {
  try {
    if (xPlatformOf(link) !== 'yt') return false;
    const u = xUrlOf(xYtCanonical(link));
    if (!u) return false;
    const p = String(u.pathname || '').replace(/\/+$/, '');
    if (p.toLowerCase() === '/watch') return !!u.searchParams.get('v');
    if (/^\/shorts\/[^/]+$/i.test(p)) return true;
    if (/^\/post\/[^/]+$/i.test(p)) return true;
    return false;
  } catch (e) { return false; }
}
// Faz TT-1: kimlik YOLDA -> sorgu tamamen atilir. vm./vt. kisa host'lari KORUNUR.
const XTT_KISA_HOSTLAR = ['vm.tiktok.com', 'vt.tiktok.com'];
function xTtCanonical(link) {
  try {
    const u = xUrlOf(link);
    if (!u || !xIsTtHost(u.hostname)) return link;
    const host = String(u.hostname).toLowerCase();
    const path = String(u.pathname || '/').replace(/\/+$/, '');
    if (XTT_KISA_HOSTLAR.indexOf(host) !== -1) return 'https://' + host + (path || '/');
    return 'https://www.tiktok.com' + (path || '/');
  } catch (e) { return link; }
}
// Faz TT-1: TikTok GONDERI url'i mi (kapsam: video). Kisa linkler de gonderi sayilir —
// FB /share/ ile ayni: hedefi yonlenme cozer.
function xIsTtPostUrl(link) {
  try {
    if (xPlatformOf(link) !== 'tt') return false;
    const u = xUrlOf(link);
    if (!u) return false;
    const host = String(u.hostname).toLowerCase();
    const p = String(u.pathname || '').replace(/\/+$/, '');
    if (XTT_KISA_HOSTLAR.indexOf(host) !== -1) return /^\/[A-Za-z0-9]+$/.test(p);
    if (/^\/@[^/]+\/(?:video|photo)\/\d+$/i.test(p)) return true;
    if (/^\/t\/[^/]+$/i.test(p)) return true;
    return false;
  } catch (e) { return false; }
}
const XFB_ID_PARAMS = ['story_fbid', 'id', 'fbid', 'v'];   // SIRA ONEMLI
function xFbCanonical(link) {
  try {
    const s = String(link == null ? '' : link).trim();
    if (!s) return link;
    const u = xUrlOf(s);
    if (!u || !xIsFbHost(u.hostname)) return link;
    const path = String(u.pathname || '/').replace(/\/+$/, '');
    const low = path.toLowerCase();
    const g = (k) => { const v = u.searchParams.get(k); return (v === null || v === '') ? null : v; };
    const base = 'https://www.facebook.com';
    let m;
    m = path.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/([^/]+)$/i);
    if (m) return base + '/groups/' + m[1] + '/posts/' + m[2];
    m = path.match(/^\/([^/]+)\/posts\/([^/]+)$/i);
    if (m) return base + '/' + m[1] + '/posts/' + m[2];
    m = path.match(/^\/share\/([pvr])\/([^/]+)$/i);
    if (m) return base + '/share/' + m[1].toLowerCase() + '/' + m[2];
    m = path.match(/^\/reel\/([^/]+)$/i);
    if (m) return base + '/reel/' + m[1];
    if (low === '/watch' || low === '/video.php') { const v = g('v'); return v ? (base + '/watch/?v=' + v) : (base + low); }
    if (low === '/photo.php' || low === '/photo') { const f = g('fbid'); return f ? (base + '/photo/?fbid=' + f) : (base + low); }
    if (low === '/permalink.php' || low === '/story.php') {
      const sf = g('story_fbid'), pid = g('id');
      let out = base + low;
      if (sf) { out += '?story_fbid=' + sf; if (pid) out += '&id=' + pid; }
      return out;
    }
    const keep = [];
    for (const k of XFB_ID_PARAMS) { const v = g(k); if (v) keep.push(k + '=' + v); }
    let o = base + path;
    if (keep.length) o += '?' + keep.join('&');
    return o;
  } catch (e) { return link; }
}
// FB GONDERI linki mi? (sayfa/profil linkleri kapsam disi)
function xIsFbPostUrl(link) {
  try {
    if (xPlatformOf(link) !== 'fb') return false;
    const u = xUrlOf(link);
    if (!u) return false;
    const p = String(u.pathname || '').replace(/\/+$/, '');
    const low = p.toLowerCase();
    if (/^\/groups\/[^/]+\/(?:posts|permalink)\/[^/]+$/i.test(p)) return true;
    if (/^\/[^/]+\/posts\/[^/]+$/i.test(p)) return true;
    if (/^\/share\/[pvr]\/[^/]+$/i.test(p)) return true;
    if (/^\/reel\/[^/]+$/i.test(p)) return true;
    if ((low === '/watch' || low === '/video.php') && u.searchParams.get('v')) return true;
    if ((low === '/photo.php' || low === '/photo') && u.searchParams.get('fbid')) return true;
    if ((low === '/permalink.php' || low === '/story.php') && u.searchParams.get('story_fbid')) return true;
    return false;
  } catch (e) { return false; }
}

// Faz FB-2 (son parca): Facebook otomasyondan suphelenince gonderi yerine DOGRULAMA
// ekranina yonlendirir (/checkpoint/... veya /challenge/...). O noktada devam etmek
// (yeniden yukleme, sonraki gonderiye gecme) durumu KOTULESTIRIR -> tarama durdurulur.
//
// HIZ YAVASLATMA BILEREK YAPILMADI: plan 3-8sn rastgele bekleme ongoruyordu ama o
// rakam hicbir olcume dayanmiyordu. Olcum sunu gosterdi: gonderiler arasindaki 100ms
// (widget.js) istekler ARASI aralik degil, yakalama bittikten sonraki son sicrama;
// gercek dongu sayfa yuklenmesi + yorum gizleme + kaydir/birlestir + yukleme ile zaten
// SANIYELER suruyor ve sayfaya gore DEGISKEN (yani korunmak istenen "sabit aralik
// imzasi" pratikte zaten yok). Kullanici da sahada sorun yasamadigini bildirdi.
// Bu koruma ise BEDAVA: hicbir seyi yavaslatmaz, yalnizca FB zaten isaretlemisse calisir.
//
// Host'a duyarli (xIsFbHost) ve yol ONEKINE bakar: 'evil.com/?u=facebook.com/checkpoint'
// veya '/bir-sayfa/checkpoint-bilgi' KACMAZ.
function xIsFbCheckpointUrl(link) {
  try {
    if (xPlatformOf(link) !== 'fb') return false;
    const u = xUrlOf(link);
    if (!u) return false;
    const p = String(u.pathname || '').toLowerCase().replace(/\/+$/, '');
    return p === '/checkpoint' || p.startsWith('/checkpoint/')
        || p === '/challenge'  || p.startsWith('/challenge/');
  } catch (e) { return false; }
}

function normalizeUrl(url) {
  if (!url) return "";
  // Faz FB-1: FB'de KIMLIK SORGUDA olabilir (permalink.php?story_fbid=..&id=..) ->
  // '?' ile kesmek YASAK. Kesilirse TUM permalink.php gonderileri ayni degere iner ve
  // word_taramasi URL eslesmesi (background.js ~:193 'startsWith') HER gonderiyi
  // HER digerine eslestirir -> yanlis sayfada yakalama.
  if (xPlatformOf(url) === 'fb') {
    return xFbCanonical(url).split('#')[0].replace(/\/+$/, '').toLowerCase();
  }
  // Faz TT-1: kimlik YOLDA, sorgu atilabilir; ama xTtCanonical HOST'u da normalize
  // ediyor (m./çıplak -> www) -> m.tiktok.com ile www.tiktok.com AYNI degere iner.
  if (xPlatformOf(url) === 'tt') {
    return xTtCanonical(url).split('#')[0].replace(/\/+$/, '').toLowerCase();
  }
  // Faz YT-1: kimlik SORGUDA (/watch?v=) -> '?' ile kesmek YASAK; ayrica youtu.be/live/
  // embed ayni videoya iner -> hangi bicimde acilirsa acilsin ayni degere.
  if (xPlatformOf(url) === 'yt') {
    return xYtCanonical(url).split('#')[0].replace(/\/+$/, '').toLowerCase();
  }
  let clean = url.split('?')[0].toLowerCase().trim();
  clean = clean.replace('://twitter.com', '://x.com');
  if (clean.endsWith('/')) {
    clean = clean.slice(0, -1);
  }
  return clean;
}

function isValidOrigin(origin) {
  return origin && (origin.startsWith("http://") || origin.startsWith("https://"));
}

function logToServer(message) {
  try {
    chrome.storage.local.get({ server_origin: "http://localhost:3012" }, (res) => {
      const origin = res.server_origin || "http://localhost:3012";
      if (isValidOrigin(origin)) {
        const data = JSON.stringify({ message: message });
        fetch(`${origin}/api/extension/log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: data
        }).catch(e => {});
      }
    });
  } catch (err) {}
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  try {
    if ((changeInfo.status === 'complete' || changeInfo.url) && tab.url) {
      // SILINDI (v3.62): 'config_role.html' URL koklayicisi. HERHANGI bir sayfa
      // ?role=link_only&server_token=... ile acildiginda server_origin'i KENDI origin'ine
      // yaziyordu — yani ziyaret edilen bir site eklentinin "is sunucusunu" ele gecirebilirdi.
      // Kapisi da koda gomulu tek bir dizeydi ('secret_server_bypass_token_2026').
      // config_role.html bu depoda YOK; onceki programin rol/yetki tesisatindan kalma.
      // Yerine gecen dogrulanmis yol registerPanel'dir (meta[name=x-rapor-panel] kapisi).

      // Faz FB-1: FB'de kimlik SORGUDA olabilir -> '?' ile kesersek permalink.php/photo.php/
      // watch gonderileri ayirt edilemez. FB icin sorguyu KORU (kanonik forma indirgeyerek).
      let _plat = xPlatformOf(tab.url);
      // Faz TT-1: TikTok'ta sorgu (is_from_webapp, web_id) atilir + host normalize edilir.
      let temizUrl = (_plat === 'fb') ? xFbCanonical(tab.url)
                   : (_plat === 'tt') ? xTtCanonical(tab.url)
                   : (_plat === 'yt') ? xYtCanonical(tab.url)   // Faz YT-1: kimlik SORGUDA
                   : tab.url.split('?')[0];
      let urlObj;
      try {
        urlObj = new URL(temizUrl);
      } catch(e) {
        return;
      }
      
      let path = urlObj.pathname;
      let isInstagramPost = /^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[^/]+/i.test(temizUrl);
      let isFacebookPost = xIsFbPostUrl(temizUrl);   // Faz FB-1
      let isTiktokPost = xIsTtPostUrl(temizUrl);     // Faz TT-1
      let isYoutubePost = xIsYtPostUrl(temizUrl);    // Faz YT-1
      let tivitMi = /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(temizUrl) || isInstagramPost || isFacebookPost || isTiktokPost || isYoutubePost;
      let retweetSayfasiMi = temizUrl.endsWith('/retweets') || temizUrl.endsWith('/reposts') || temizUrl.endsWith('/quotes') || temizUrl.endsWith('/likes');

      let storageKey = `x_profil_gorevi_${tabId}`;

      chrome.storage.local.get([storageKey], (result) => {
        try {
          let gorev = result[storageKey];

          // FB DOGRULAMA EKRANI -> TARAMAYI ANINDA DURDUR (kullanici onayi 2026-07-17).
          // Eslestirme mantigindan ONCE: checkpoint URL'i hedefle eslesmez, dolayisiyla
          // asagidaki "eslesmedi" dali calisir ve gorev ya yeniden yonlendirilir ya da
          // asili kalir; ikisi de FB'ye baski yapmaya DEVAM etmek demektir.
          // Widget'a konamazdi: widgetiFirlat yalnizca URL ESLESIRSE cagriliyor, yani
          // checkpoint sayfasinda widget hic enjekte edilmiyor -> kontrol calismazdi.
          if (gorev && gorev.aktif && xIsFbCheckpointUrl(tab.url)) {
            logToServer(`[Facebook] DOGRULAMA EKRANI ALGILANDI (${path}) — tarama DURDURULUYOR. `
                      + `Devam etmek hesap riskini artirir. Lutfen facebook.com'da dogrulamayi `
                      + `tamamlayip taramayi yeniden baslatin.`);
            chrome.storage.local.remove(storageKey, () => {
              chrome.storage.local.get({ server_origin: "http://localhost:3012" }, (cfg) => {
                resetServerJobReliable(cfg.server_origin);
              });
            });
            return;
          }

          if (gorev && gorev.aktif) {
            let eslesiyor = false;

            if (gorev.asama === "profil_taramasi") {
              let expectedPath = "";
              if (gorev.is_list_scrape) {
                try {
                  expectedPath = new URL(gorev.profilAdi).pathname.toLowerCase();
                } catch(e) {
                  expectedPath = gorev.profilAdi.toLowerCase();
                  if (!expectedPath.startsWith("/")) {
                    expectedPath = "/" + expectedPath;
                  }
                }
              } else {
                expectedPath = "/" + gorev.profilAdi.toLowerCase();
                if (gorev.content_filter === "only_replies") {
                  expectedPath += "/with_replies";
                }
              }
              if (path.toLowerCase() === expectedPath) {
                eslesiyor = true;
              }
            } else if (gorev.asama === "detayli_tarama") {
              let normTemiz = normalizeUrl(temizUrl);
              let normAktif = normalizeUrl(gorev.aktifTivitUrl);
              if (normTemiz.startsWith(normAktif)) {
                eslesiyor = true;
              }
            } else if (gorev.asama === "word_taramasi") {
              // word_taramasi: kuyrukta sıradaki URL ile karşılaştır
              let normTemiz = normalizeUrl(temizUrl);
              let hedefUrl = (gorev.kuyruk && gorev.kuyruk.length > 0) ? (gorev.kuyruk[0].url || gorev.kuyruk[0]) : (gorev.aktifTivitUrl || "");
              let normHedef = normalizeUrl(hedefUrl);
              if (normTemiz === normHedef || normTemiz.startsWith(normHedef)) {
                eslesiyor = true;
              } else if (xPlatformOf(tab.url) === 'fb') {
                // Faz FB-2: FB /share/{p|v|r}/{kod} linklerini GERCEK gonderiye YONLENDIRIR.
                // SAHA (2026-07-16): kuyrukta /share/v/14jeAjQz7ZP vardi, FB
                //   /reel/2052772415581354/?rdid=...&share_url=https%3A%2F%2F...%2Fshare%2Fv%2F14jeAjQz7ZP
                // adresine goturdu -> duz karsilastirma "eslesmedi" dedi, widget HIC firlatilmadi.
                // FB neyse ki orijinal linki ?share_url= parametresinde TASIYOR.
                // DIKKAT: temizUrl sorgusuz (FB kanonigi) -> share_url icin TAM tab.url gerekli.
                let _suVar = false;
                try {
                  const _su = new URL(tab.url).searchParams.get('share_url');
                  if (_su) {
                    // share_url VARSA BELIRLEYICIDIR: eslesmiyorsa BASKA bir gonderidesin ->
                    // asagidaki yedege DUSME (yoksa yanlis gonderiyi "ulastik" sayip YANLIS
                    // gorseli dogru link altinda rapora koyariz — sessiz ariza).
                    _suVar = true;
                    if (normalizeUrl(_su) === normHedef) {
                      eslesiyor = true;
                      logToServer(`[onUpdated] FB yonlendirmesi share_url ile DOGRULANDI. hedef=${normHedef} -> gercek=${normTemiz}`);
                    } else {
                      logToServer(`[onUpdated] FB share_url BASKA gonderiyi isaret ediyor, eslesme YOK. share_url=${_su} hedef=${normHedef}`);
                    }
                  }
                } catch (e) {}
                // share_url YOKSA: hedef /share/... idi ve simdi bir FB GONDERI sayfasindayiz
                // -> FB yonlendirmis kabul et.
                if (!eslesiyor && !_suVar && /\/share\/[pvr]\//i.test(normHedef) && xIsFbPostUrl(temizUrl)) {
                  eslesiyor = true;
                  logToServer(`[onUpdated] FB /share/ yonlendirmesi kabul edildi (share_url yok). hedef=${normHedef} -> gercek=${normTemiz}`);
                }
              }
            } else if (gorev.asama === "arama_taramasi") {
              if (path.toLowerCase() === "/search") {
                eslesiyor = true;
              }
            }
            
            if (eslesiyor) {
              logToServer(`[onUpdated] URL eşleşti, widget fırlatılıyor. tabId=${tabId}, url=${temizUrl}`);
              widgetiFirlat(tabId);
            } else {
              // Eşleşmiyor ise transient veya login/home durumlarına göre yönlendirme yap ya da iptal et
              let lowerUrl = tab.url.toLowerCase();
              let isTransient = false;
              let isHomeOrRoot = false;
              
              if (lowerUrl.startsWith('chrome://') || lowerUrl.startsWith('chrome-extension://') || lowerUrl === 'about:blank') {
                isTransient = true;
              } else {
                try {
                  let urlObj = new URL(lowerUrl);
                  // Faz FB-1: FB eklenmezse her FB gezinmesi 'gecici sayfa' sayilir ->
                  // gorev NE iptal edilir NE ilerler, SONSUZA KADAR asili kalir.
                  // Faz TT-1: tiktok EKLENMEZSE her TikTok gezinmesi 'gecici sayfa' sayilir ->
                  // gorev NE iptal edilir NE ilerler, SONSUZA KADAR asili kalir (FB'de yasandi).
                  const isTargetHost = urlObj.hostname.includes('x.com') || urlObj.hostname.includes('twitter.com') || urlObj.hostname.includes('instagram.com') || xIsFbHost(urlObj.hostname) || xIsTtHost(urlObj.hostname) || xIsYtHost(urlObj.hostname);
                  if (!isTargetHost) {
                    isTransient = true;
                  } else {
                    let path = urlObj.pathname;
                    if (path === '/' || path === '/home') {
                      isHomeOrRoot = true;
                    } else if (path.includes('/login') || path.includes('/signup') || path.includes('/logout') || path.includes('/flow/')) {
                      isTransient = true;
                    }
                  }
                } catch(e) {
                  isTransient = true;
                }
              }
              
              if (isHomeOrRoot) {
                // Kullanıcı giriş yaptı veya anasayfaya yönlendi. Hedef URL'ye tekrar yönlendir.
                let targetUrl = "";
                if (gorev.asama === "profil_taramasi") {
                  if (gorev.is_list_scrape) {
                    targetUrl = gorev.profilAdi;
                  } else {
                    targetUrl = `https://x.com/${gorev.profilAdi}`;
                    if (gorev.content_filter === "only_replies") {
                      targetUrl += "/with_replies";
                    }
                  }
                } else if (gorev.asama === "detayli_tarama") {
                  targetUrl = gorev.aktifTivitUrl;
                } else if (gorev.asama === "arama_taramasi") {
                  const q = encodeURIComponent(gorev.searchQuery);
                  if (gorev.aktifAsama === "enson") {
                    targetUrl = `https://x.com/search?q=${q}&f=live`;
                  } else {
                    targetUrl = `https://x.com/search?q=${q}&f=top`;
                  }
                }
                if (targetUrl) {
                  logToServer(`[onUpdated] Anasayfadan hedef URL'ye yönlendiriliyor: ${targetUrl}`);
                  chrome.tabs.update(tabId, { url: targetUrl });
                }
              } else if (!isTransient) {
                // Sunucu görevlerinde çerez eksikliği, yönlendirmeler veya sayfa geçişleri nedeniyle
                // görevin kazayla iptal edilmesini önlüyoruz.
                if (gorev.is_server_job) {
                  // Faz FB-2 TANI: "eslesmedi" tek basina sebebi soylemiyor. Asama ve
                  // karsilastirilan iki degeri de yaz ki tahmin yurutmeyelim.
                  let _dbg = "";
                  try {
                    if (gorev.asama === "word_taramasi") {
                      const _h = (gorev.kuyruk && gorev.kuyruk.length > 0)
                        ? (gorev.kuyruk[0].url || gorev.kuyruk[0]) : (gorev.aktifTivitUrl || "");
                      _dbg = ` | TANI asama=${gorev.asama}`
                           + ` kuyrukLen=${gorev.kuyruk ? gorev.kuyruk.length : 0}`
                           + ` kuyruk0tip=${(gorev.kuyruk && gorev.kuyruk[0]) ? (gorev.kuyruk[0].type || 'string') : '-'}`
                           + ` normTemiz="${normalizeUrl(temizUrl)}"`
                           + ` normHedef="${normalizeUrl(_h)}"`
                           + ` hamHedef="${_h}"`
                           + ` temizUrl="${temizUrl}"`;
                    } else {
                      _dbg = ` | TANI asama=${gorev.asama} (word_taramasi DEGIL!)`
                           + ` profilAdi=${gorev.profilAdi || '-'}`;
                    }
                  } catch (e) { _dbg = " | TANI-hata: " + (e.message || e); }
                  logToServer(`[onUpdated] URL eşleşmedi ama sunucu görevi olduğu için iptal edilmedi. URL: ${tab.url}${_dbg}`);
                } else {
                  logToServer(`[onUpdated] Kullanıcı başka sayfaya gittiği için görev iptal edildi. URL: ${tab.url}`);
                  chrome.storage.local.remove(storageKey);
                }
              } else {
                logToServer(`[onUpdated] Geçici sayfa (login/flow vb.) algılandı, görev bekletiliyor. URL: ${tab.url}`);
              }
            }
          } else {
            // Normal zamanda X anasayfa veya profil sayfasındayken widget otomatik ÇIKMASIN.
            // Sadece tekil tweet detay sayfalarındayken çıksın.
            if (tivitMi && !retweetSayfasiMi) {
              chrome.storage.local.get({ otoWidgetAc: true }, (res) => {
                if (res.otoWidgetAc) {
                  widgetiFirlat(tabId);
                }
              });
            }
          }
        } catch (innerErr) {
          logToServer(`[onUpdated storage callback error] ${innerErr.stack || innerErr}`);
        }
      });
    }
  } catch (outerErr) {
    logToServer(`[onUpdated outer error] ${outerErr.stack || outerErr}`);
  }
});

function widgetiFirlat(tabId) {
  logToServer(`[widgetiFirlat] Başlatılıyor: tabId=${tabId}`);
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (id) => { window.xRaporTabId = id; },
    args: [tabId]
  }).then(() => {
    // ASAMA 3 / ADIM 1 (v3.63): zincir SADELESTIRILDI.
    // Eskiden sira su idi: tabId -> html2canvas.min.js -> xlsx.full.min.js -> widget.js.
    // Iki kutuphane de OLU (olculdu: 'html2canvas(' cagrisi 0; 'XLSX.' yalnizca hic
    // cagrilmayan excelDosyasiOlustur icinde) AMA zincirli olduklari icin CANLI yolun
    // on kosuluydular — biri yuklenemezse widget.js HIC enjekte edilmiyordu.
    // Once zinciri kisaltiyoruz; dosyalar SAHADA dogrulandiktan SONRA silinecek.
    // tabId adimi KALIYOR: widget.js:6004 window.xRaporTabId'yi okuyor, sira onemli.
    return chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ["widget.js"]
    });
  }).then(() => {
    logToServer(`[widgetiFirlat] widget.js başarıyla yüklendi!`);
  }).catch((err) => logToServer(`[widgetiFirlat] yükleme hatası: ${err.message || err}`));
}

// Clean up storage key when tab is closed to prevent stale tasks
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  let storageKey = `x_profil_gorevi_${tabId}`;
  chrome.storage.local.remove(storageKey);
});

// ----------------- MV3 SERVIS WORKER KEEPALIVE -----------------
// bridge.js (panel + x/instagram sayfaları) kalıcı bir port açar. Bağlı bir port olduğu
// sürece MV3 servis worker'ı SONLANDIRILMAZ. Böylece yoklama döngüsü ölmez ve tarama
// bittikten sonra yeni "Başlat" F5 beklemeden çalışır. Bağlantı gelince (ve SW yeni
// uyanmışsa) yoklama döngüsünü de yeniden kurarız.
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "x-rapor-keepalive") return;
  try {
    if (typeof startPolling === "function") startPolling();
  } catch (e) { /* ignore */ }
  // bridge.js her 15 sn ping gönderir. Bu mesaj olayı SW'yi canlı tutar; ayrıca her ping'de
  // yoklama döngüsünün ayakta olduğundan emin oluruz (tarama F5 beklemeden başlar).
  port.onMessage.addListener(() => {
    try {
      if (typeof startPolling === "function") startPolling();
      if (typeof checkServerJobs === "function") checkServerJobs();
    } catch (e) { /* ignore */ }
    try { port.postMessage({ t: "keepalive-pong" }); } catch (e) { /* ignore */ }
  });
  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) { /* ignore */ }
  });
});

// SILINDI (v3.62): configureStartupRole(). Acilista tum sekmeleri tarayip config_role.html
// arayan, bulursa server_origin'i o sayfanin origin'ine yazan fonksiyon. config_role.html
// bu depoda YOK -> islev olu, saldiri yuzeyi canliydi. Uc cagri yeri de asagida kaldirildi.

// Clear all tasks on startup or install to ensure a fresh session
chrome.runtime.onStartup.addListener(() => {
  temizleTumGorevler();
  startPolling();
});
chrome.runtime.onInstalled.addListener(() => {
  temizleTumGorevler();
  chrome.storage.local.get(['server_origin'], (res) => {
    const origin = (res.server_origin && res.server_origin.startsWith('http')) ? res.server_origin : "http://localhost:3012";
    chrome.storage.local.set({
      browser_role: "word",
      server_origin: origin
    }, () => {
      startPolling();
    });
  });
});

// Run directly on script load (using session storage to detect fresh browser launch vs. service worker wakeup from suspension)
chrome.storage.session.get(["initialized"], (sessionRes) => {
  if (!sessionRes.initialized) {
    logToServer("[x-word] Fresh browser session detected. Initializing...");
    temizleTumGorevler();
    // SILINDI (v3.62): closeRestoredTabs() cagrisi — asagidaki nota bak.
    chrome.storage.local.get(['server_origin'], (res) => {
      const origin = (res.server_origin && res.server_origin.startsWith('http')) ? res.server_origin : "http://localhost:3012";
      chrome.storage.local.set({
        browser_role: "word",
        server_origin: origin
      }, () => {
        chrome.storage.session.set({ initialized: true }, () => {
          startPolling();
        });
      });
    });
  } else {
    startPolling();
  }
});

function temizleTumGorevler() {
  chrome.storage.local.get(null, (allStorage) => {
    for (let key in allStorage) {
      if (key.startsWith('x_profil_gorevi_')) {
        chrome.storage.local.remove(key);
      }
    }
  });
}

// SILINDI (v3.62): closeRestoredTabs(). Taze tarayici oturumu algilandiginda
// chrome.tabs.query({}) ile TUM sekmeleri dolasip chrome:// disindaki HEPSINI kapatiyordu.
// Onceki urunun "adanmis sunucu tarayicisi" modelinden kalma: orada makine yalnizca is
// yapar, acilista temiz baslamasi mantiklidir. Kullanicinin GUNLUK tarayicisinda ise bu,
// Chrome her acildiginda geri yuklenen sekmelerin kaybi demekti.
// Yanindaki `is_server: true` varsayilanlari da ayni modelden geliyordu, onlar da kaldirildi.

let savedWindowStates = {};

// Web arayüzünden veya widget'tan gelen tarama başlatma / API isteklerini dinle
// captureVisibleTab, Chrome'un saniye-başı çağrı limitine ("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")
// takılınca hata döndürür. Çoklu gönderi taramasında bu, bir gönderinin ekran görüntüsüz atlanmasına
// yol açıyordu. Bu yardımcı, hata veya boş sonuç durumunda kısa bekleyip birkaç kez yeniden dener.
function captureVisibleWithRetry(windowId, opts, attempt, maxAttempts, cb) {
  try {
    chrome.tabs.captureVisibleTab(windowId, opts, (dataUrl) => {
      const err = chrome.runtime.lastError; // okumak, "unchecked error" uyarısını da bastırır
      const bos = !dataUrl || dataUrl.length < 1000;
      if ((err || bos) && attempt < maxAttempts) {
        const wait = 700; // limit ~2/sn olduğundan 700ms genelde yeterli
        logToServer(`[capture] Yakalama denemesi ${attempt}/${maxAttempts} başarısız (${err ? err.message : 'boş veri'}), ${wait}ms sonra tekrar...`);
        setTimeout(() => captureVisibleWithRetry(windowId, opts, attempt + 1, maxAttempts, cb), wait);
        return;
      }
      cb(err || null, dataUrl);
    });
  } catch (e) {
    if (attempt < maxAttempts) {
      setTimeout(() => captureVisibleWithRetry(windowId, opts, attempt + 1, maxAttempts, cb), 700);
    } else {
      cb({ message: e.message || String(e) }, null);
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "forcePollJobs") {
    // Panelden gelen dürtme. SW uykudan uyanmış veya yoklama döngüsü ölmüş olabilir;
    // bu yüzden SADECE bir kez yoklamak yetmiyor — F5'in yaptığı gibi 2 sn'lik yoklama
    // DÖNGÜSÜNÜ yeniden kuruyoruz. Böylece "Başlat" F5 beklemeden çalışır.
    if (typeof startPolling === "function") {
      startPolling();
    }
    if (typeof checkServerJobs === "function") {
      checkServerJobs();
    }
    sendResponse({ status: "success" });
    return false;
  }

  if (message.action === "startWordScan") {
    // Panel taramayı DOĞRUDAN başlatır (poll_job'a bağlı DEĞİL). Bu mesaj SW'yi uyandırır ve
    // processServerJob HEMEN sekmeyi açıp görevi depolar. Böylece "Başlat" F5 beklemeden çalışır
    // (çalışan referans eklentinin startScan deseni). Görev depolanınca checkServerJobs'un
    // activeJobFound koruması çift-başlatmayı engeller.
    const job = message.job;
    if (!job) { sendResponse({ status: "error", message: "job yok" }); return false; }
    // MV3 TUZAĞI: storage.get async'tir. Eskiden burada sendResponse senkron çağrılıp
    // return false yapılıyordu; boşta kalmış worker bu mesajla uyanıp cevabı verdiği an
    // Chrome onu TEKRAR askıya alıyor, async callback (processServerJob) HİÇ çalışmıyordu.
    // Sonuç: ikinci taramada "sayaç döndü ama tarama başlamadı" (F5 gerekiyordu).
    // Çözüm: return true ile kanalı açık tut → worker, işi bitirene kadar askıya ALINMAZ;
    // sendResponse'u async iş bitince çağır. Ayrıca yedek olarak yoklama döngüsünü yeniden
    // kur (worker askıya alınınca setInterval ölüyor) — doğrudan yol kaçarsa görev yakalanır.
    chrome.storage.local.get({ server_origin: "http://localhost:3012" }, (res) => {
      let raw = res.server_origin || "http://localhost:3012";
      let origin = (raw.startsWith("http://") || raw.startsWith("https://")) ? raw : "http://localhost:3012";
      try {
        if (typeof processServerJob === "function") processServerJob(job, origin);
      } catch (e) {
        try { logToServer("[startWordScan] hata: " + (e.message || e)); } catch (_) {}
      }
      try { if (typeof startPolling === "function") startPolling(); } catch (_) {}
      try { sendResponse({ status: "success" }); } catch (_) {}
    });
    return true; // kanalı açık tut: worker processServerJob çalışana kadar canlı kalsın
  }

  // SILINDI (v3.62) — ucu de widget.js'te SIFIR cagriya sahipti (grep ile dogrulandi):
  //   navigateTab : URL dogrulamasi olmayan zorla sekme yonlendirme. Canli bir gonderen
  //                 eklenirse dogrudan "keyfi yonlendirme" primitifi olurdu.
  //   setTabZoom  : v3.40'ta bilerek terk edilen IG zoom yolunun geride kalan ucu
  //                 (@0d9ca43 temizliginde widget tarafi silinmis, isleyici kalmis).
  //   cropImage   : captureAndCrop ile yer degistirmis eski iki-mesajli kirpma yolu.
  //                 DIKKAT: cropImageInBackground FONKSIYONU duruyor — canli yol onu kullaniyor.

  if (message.action === "captureTab") {
    const tabId    = sender.tab ? sender.tab.id     : null;
    const windowId = sender.tab ? sender.tab.windowId : null;

    // captureVisibleTab için sekmeyi önce aktif yap
    function doCaptureVisible() {
      captureVisibleWithRetry(windowId, { format: 'png' }, 1, 4, (err, dataUrl) => {
        if (err) {
          console.log("[captureTab] Hata:", err.message);
          sendResponse({ status: "error", message: err.message });
        } else if (!dataUrl || dataUrl.length < 1000) {
          console.log("[captureTab] boş veri:", dataUrl ? dataUrl.length : 0);
          sendResponse({ status: "error", message: "Ekran görüntüsü boş (uzunluk: " + (dataUrl ? dataUrl.length : 0) + ")" });
        } else {
          console.log("[captureTab] Başarılı:", dataUrl.length);
          sendResponse({ status: "success", dataUrl: dataUrl });
        }
      });
    }

    if (tabId && windowId) {
      chrome.windows.update(windowId, { focused: true }, () => {
        if (chrome.runtime.lastError) {
          console.log("[captureTab] windows.update hatası:", chrome.runtime.lastError.message);
        }
        chrome.tabs.update(tabId, { active: true }, () => {
          if (chrome.runtime.lastError) {
            console.log("[captureTab] tabs.update hatası:", chrome.runtime.lastError.message);
          }
          setTimeout(() => {
            chrome.tabs.get(tabId, (tab) => {
              if (chrome.runtime.lastError) {
                doCaptureVisible();
                return;
              }
              if (tab && tab.active) {
                doCaptureVisible();
              } else {
                chrome.tabs.update(tabId, { active: true }, () => {
                  setTimeout(doCaptureVisible, 300);
                });
              }
            });
          }, 800);
        });
      });
    } else {
      doCaptureVisible();
    }
    return true;
  }

  // captureAndCrop: Yakalama ve kırpmayı tek mesajda birleştir.
  // İki ayrı mesaj (captureTab + cropImage) arasında service worker uykuya geçerse
  // ikinci yanıt null gelir ve kırpma yapılamaz. Bu action her ikisini tek seferde yapar.
  if (message.action === "captureAndCrop") {
    const tabId    = sender.tab ? sender.tab.id     : null;
    const windowId = sender.tab ? sender.tab.windowId : null;
    const rect     = message.rect;
    const dpr      = message.dpr || 1;
    const vw       = message.vw || 0;   // Faz YT: olcek dpr'den DEGIL, yakalanan goruntuden turetilir

    function doCaptureAndCrop() {
      logToServer(`[captureAndCrop] Yakalıyor. rect=${JSON.stringify(rect)} dpr=${dpr}`);
      captureVisibleWithRetry(windowId, { format: 'png' }, 1, 4, async (err, dataUrl) => {
        if (err || !dataUrl || dataUrl.length < 1000) {
          const errMsg = err ? err.message : "boş veri";
          logToServer(`[captureAndCrop] Yakalama hatası: ${errMsg}`);
          sendResponse({ status: "error", message: errMsg });
          return;
        }
        logToServer(`[captureAndCrop] Yakalandı (${dataUrl.length}). Kırpılıyor...`);
        try {
          const croppedDataUrl = await cropImageInBackground(dataUrl, rect, dpr, vw);
          logToServer(`[captureAndCrop] Kırpma başarılı. Sonuç boyutu: ${croppedDataUrl.length}`);
          sendResponse({ status: "success", dataUrl: croppedDataUrl });
        } catch (cropErr) {
          logToServer(`[captureAndCrop] Kırpma hatası: ${cropErr.message || cropErr}`);
          sendResponse({ status: "error", message: cropErr.message || String(cropErr) });
        }
      });
    }

    if (tabId && windowId) {
      chrome.windows.update(windowId, { focused: true }, () => {
        chrome.tabs.update(tabId, { active: true }, () => {
          setTimeout(() => {
            chrome.tabs.get(tabId, (tab) => {
              if (chrome.runtime.lastError) { doCaptureAndCrop(); return; }
              if (tab && tab.active) {
                doCaptureAndCrop();
              } else {
                chrome.tabs.update(tabId, { active: true }, () => setTimeout(doCaptureAndCrop, 300));
              }
            });
          }, 800);
        });
      });
    } else {
      doCaptureAndCrop();
    }
    return true;
  }


  if (message.action === "fetchImageAsDataUrl") {
    fetch(message.url)
      .then(res => {
        if (!res.ok) throw new Error("Fetch failed: " + res.status);
        const contentType = res.headers.get("content-type") || "image/png";
        return res.arrayBuffer().then(buffer => ({ contentType, buffer }));
      })
      .then(({ contentType, buffer }) => {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        sendResponse({ status: "success", dataUrl: `data:${contentType};base64,${base64}` });
      })
      .catch(err => {
        console.log("[fetchImageAsDataUrl] error:", err);
        sendResponse({ status: "error", message: err.toString() });
      });
    return true; // Keep message channel open
  }

  if (message.action === "submitWordResult") {
    let origin = message.origin || "http://localhost:3012";
    let url = `${origin}/api/extension/submit_word_result`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: message.job_id,
        results: message.results,
        final: message.final
      })
    })
    .then(r => r.json())
    .then(res => sendResponse(res))
    .catch(err => {
      // TESHIS: submit fetch'i basarisiz olursa (or. "Failed to fetch") bunu SUNUCU loguna da yaz.
      // Boylece "capture'lar oldu ama submit sunucuya ulasmadi" durumunda NEDENINI ve HANGI URL'e
      // gidildigini goruruz (eskiden yalnizca console.log vardi, sunucu logunda gorunmuyordu).
      console.log("submitWordResult error:", err);
      try { logToServer(`[submitWordResult] FETCH HATASI: ${err && (err.message || err)} URL=${url} final=${message.final}`); } catch (_) {}
      sendResponse({ status: "error", message: err.toString() });
    });
    return true; // Keep message channel open
  }

  if (message.action === "resetServerJob") {
    let origin = message.origin || "http://localhost:3012";
    let clientId = message.client_id || "";
    let resetUrl = `${origin}/api/auto/reset`;
    if (clientId) {
      resetUrl += `?client_id=${encodeURIComponent(clientId)}`;
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    fetch(resetUrl, { method: 'POST', signal: controller.signal })
      .then(r => r.json())
      .then(res => { clearTimeout(timeoutId); sendResponse(res); })
      .catch(err => {
        clearTimeout(timeoutId);
        console.log("resetServerJob error:", err);
        sendResponse({ status: "error", message: err.toString() });
      });
    return true; // Keep message channel open
  }

  if (message.action === "updateWordProgress") {
    let origin = message.origin || "http://localhost:3012";
    let url = `${origin}/api/extension/update_progress`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: message.job_id,
        current: message.current,
        total: message.total
      })
    })
    .then(r => r.json())
    .then(res => sendResponse(res))
    .catch(err => {
      console.log("updateWordProgress error:", err);
      sendResponse({ status: "error", message: err.toString() });
    });
    return true; // Keep message channel open
  }

  if (message.action === "generateSingleWord") {
    let origin = message.origin || "http://localhost:3012";
    let url = `${origin}/api/extension/generate_single`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tweet_url: message.tweet_url,
        account_name: message.account_name,
        username: message.username,
        screenshot: message.screenshot
      })
    })
    .then(r => r.json())
    .then(res => sendResponse(res))
    .catch(err => {
      console.log("generateSingleWord error:", err);
      sendResponse({ status: "error", message: err.toString() });
    });
    return true; // Keep message channel open
  }

  // SILINDI (v3.62): "setUserAuth" isleyicisi. Cagirani (bridge.js) HER http(s) sayfasindan
  // kosulsuz gonderiyordu; isleyici de server_origin'i sayfanin origin'inden "bootstrap"
  // ediyordu. Sosyal medya host'lari haric tutulmustu ama kalan TUM internet haric DEGILDI.
  // Bootstrap'a gerek yok: yetkili kaynak registerPanel ve o zaten server_origin'i yaziyor
  // (meta[name=x-rapor-panel] kapisiyla). Tasidigi kimlik de sahteydi — username sabit "user".
  // Yazdigi is_authenticated / last_auth_time anahtarlarini HICBIR yer okumuyordu.

  if (message.action === "logToServer") {
    logToServer(message.message);
    sendResponse({ status: "success" });
    return false;
  }

  // Faz #1-A: panelden gelen yerel-goruntu bayragi. Widget bu bayraga gore ekran goruntusunu
  // SUNUCUYA gondermeyip panele iletir.
  if (message.action === "setLocalImages") {
    chrome.storage.local.set({ local_images: !!message.value }, () => {
      logToServer(`[setLocalImages] Yerel goruntu modu: ${!!message.value}`);
    });
    sendResponse({ status: "success" });
    return false;
  }

  // Faz #1-A: widget'tan gelen ekran goruntusunu (sunucuya GITMEYECEK) panel sekmesine ilet.
  if (message.action === "deliverLocalImage") {
    chrome.storage.local.get(['panel_tab_id'], (res) => {
      const panelTabId = res.panel_tab_id;
      if (!panelTabId) { try { sendResponse({ status: "error", message: "panel_tab_id yok" }); } catch (_) {} return; }
      chrome.tabs.sendMessage(panelTabId, {
        action: "localImage",
        link: message.link,
        dataUrl: message.dataUrl,
        mime: message.mime || ""
      }, () => {
        const err = chrome.runtime.lastError;
        try { sendResponse({ status: err ? "error" : "success", message: err ? err.message : "" }); } catch (_) {}
      });
    });
    return true; // async yanit
  }

  // SILINDI (v3.62): "savePanelOrigin" isleyicisi — registerPanel'in DOGRULAMASIZ atasi.
  // server_origin + panel_tab_id + client_id'yi meta[name=x-rapor-panel] kapisi OLMADAN
  // yaziyordu, yani herhangi bir sayfa kendini "panel" ilan edebilirdi. panel_tab_id
  // "panel kapaninca iptal" ve "tek panel" davranislarini surdugu icin bu ciddi bir saptir.
  // Cagirani yok; yerini registerPanel almis durumda.

  if (message.action === "registerPanel") {
    // SADECE gercek panel (meta-isaretli sayfa) buraya gelir. Iki is:
    //  (1) TEK PANEL: zaten canli bir panel sekmesi acikken yeni sekme panele girerse ->
    //      mevcut olani odakla, yeni sekmeyi KAPAT (kullanici acik panele yonlendirilir).
    //  (2) Aksi halde: bu sekmeyi guvenilir panel_tab_id olarak kaydet + server_origin/client_id.
    // Boylece panel_tab_id her zaman GERCEK paneli gosterir; onRemoved iptali ve tek-panel garantisi saglam olur.
    const rawOrigin = message.origin || "";
    const clientId = message.client_id || "";
    const senderTabId = sender.tab ? sender.tab.id : null;
    if (!rawOrigin || !senderTabId) { sendResponse({ status: "error", message: "origin/tab yok" }); return false; }
    let apiOrigin = rawOrigin;
    try { const u = new URL(rawOrigin); apiOrigin = u.protocol + "//" + u.hostname + ":3012"; } catch (e) {}

    chrome.storage.local.get(['panel_tab_id'], (res) => {
      const storedPanelTabId = res.panel_tab_id || null;
      const finalizeAsPanel = () => {
        let updateData = { server_origin: apiOrigin, panel_tab_id: senderTabId };
        if (clientId) updateData.client_id = clientId;
        chrome.storage.local.set(updateData, () => {
          logToServer(`[registerPanel] Panel kaydedildi. TabID=${senderTabId}, Origin=${apiOrigin}`);
        });
        try { sendResponse({ status: "success", duplicate: false }); } catch (_) {}
      };

      if (storedPanelTabId && storedPanelTabId !== senderTabId) {
        // Kayitli panel sekmesi hala canli ve gercekten ayni panel origin'inde mi?
        chrome.tabs.get(storedPanelTabId, (existingTab) => {
          const err = chrome.runtime.lastError;
          let liveSameOriginPanel = false;
          if (!err && existingTab && existingTab.url) {
            try { liveSameOriginPanel = (new URL(existingTab.url).origin === rawOrigin); } catch (e) {}
          }
          if (liveSameOriginPanel) {
            logToServer(`[registerPanel] Panel zaten acik (Tab ${storedPanelTabId}). Yeni sekme (${senderTabId}) kapatiliyor, mevcut odaklaniyor.`);
            chrome.tabs.update(storedPanelTabId, { active: true }, () => { if (chrome.runtime.lastError) { /* ignore */ } });
            if (existingTab.windowId != null) {
              chrome.windows.update(existingTab.windowId, { focused: true }, () => { if (chrome.runtime.lastError) { /* ignore */ } });
            }
            try { sendResponse({ status: "success", duplicate: true }); } catch (_) {}
            // Yeni (fazla) sekmeyi kisa gecikmeyle kapat.
            setTimeout(() => { chrome.tabs.remove(senderTabId, () => { if (chrome.runtime.lastError) { /* ignore */ } }); }, 400);
            return;
          }
          // Eski panel_tab_id olu/gecersiz -> bu sekmeyi panel yap.
          finalizeAsPanel();
        });
      } else {
        finalizeAsPanel();
      }
    });
    return true; // async yanit (chrome.tabs.get / sendResponse)
  }

  if (message.action === "completeJobAndFocusPanel") {
    const targetOrigin = message.origin || "http://localhost:3012";
    logToServer(`[completeJobAndFocusPanel] Otomasyon tamamlandı. Panel aranıyor: ${targetOrigin}`);
    
    let targetHost = "";
    try {
      targetHost = new URL(targetOrigin).hostname;
    } catch(e) {}

    chrome.tabs.query({}, (tabs) => {
      try {
        let panelTab = tabs.find(t => {
        if (!t.url) return false;
        
        let tabHost = "";
        try {
          tabHost = new URL(t.url).hostname;
        } catch(e) {}

        const hostMatch = targetHost && tabHost && targetHost === tabHost;
        const cleanTitle = t.title ? t.title.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
        const titleMatch = cleanTitle.includes("xrapor");

        return hostMatch || titleMatch;
      });
      
      if (panelTab) {
        // Sekmeyi aktif et ve pencereyi öne al
        chrome.tabs.update(panelTab.id, { active: true }, () => {
          chrome.windows.update(panelTab.windowId, { focused: true }, () => {
            // Sonrasında otomasyon yapılan tivit sekmesini kapat
            if (sender.tab && sender.tab.id) {
              chrome.tabs.remove(sender.tab.id);
            }
          });
        });
      } else {
        // Bulunamazsa yeni bir sekmede paneli aç
        let fallbackUrl = targetOrigin;
        if (fallbackUrl.includes(":3012")) {
          fallbackUrl = fallbackUrl.replace(":3012", ":3011");
        }
        chrome.tabs.create({ url: fallbackUrl, active: true }, (newTab) => {
          if (chrome.runtime.lastError) return;
          chrome.windows.update(newTab.windowId, { focused: true }, () => {
            if (sender.tab && sender.tab.id) {
              chrome.tabs.remove(sender.tab.id);
            }
          });
        });
      }
    } catch (err) {
        logToServer(`[completeJobAndFocusPanel query callback error] ${err.message}`);
      }
    });
    sendResponse({ status: "success" });
    return false;
  }

  if (message.action === "getExtensionVersion") {
    const version = chrome.runtime.getManifest().version;
    sendResponse({ version: version });
    return false;
  }

  // SILINDI (v3.62): "detectActiveProfile" isleyicisi. TUM sekmeleri tarayip acik bir X
  // profilinden kullanici adini cikariyor ve cagirana donduruyordu. Cagirani bridge.js'teki
  // (yine silinen) X_RAPOR_DETECT_ACTIVE_PROFILE daliydi ve o dal her sayfada dinleniyordu
  // -> herhangi bir site kurbanin X kullanici adini sorabilirdi. Panel bu yolu kullanmiyordu.

  // SILINDI (v3.62): "startScan" isleyicisi. Cagiranin verdigi job'a gore x.com'da sekme
  // aciyordu (profil/detayli/arama asamalari). Tek cagirani bridge.js'teki X_RAPOR_START_SCAN
  // daliydi; panel o olayi HIC gondermiyor (app.py grep'i ile dogrulandi). Kurdugu
  // gecerliVeri{retweets,quotes,likes} yapisi zaten onceki urunun kazima motoruna aitti.

  if (message.action === "updateServerStatus") {
    let origin = message.origin;
    if (isValidOrigin(origin)) {
      let url = `${origin}/api/extension/update_status`;
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: message.job_id,
          current: message.current,
          total: message.total,
          last_url: message.last_url
        })
      }).catch(err => console.log("updateServerStatus fetch error:", err));
    }
    return false;
  }

  if (message.action === "submitServerResult") {
    let origin = message.origin;
    if (isValidOrigin(origin)) {
      let url = `${origin}/api/extension/submit_result`;
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: message.job_id,
          status: message.status,
          error: message.error,
          data: message.data,
          duration_ms: message.duration_ms
        })
      }).then(r => r.json())
        .then(res => {
          sendResponse(res);
        })
        .catch(err => {
          console.log("submitServerResult fetch error:", err);
          sendResponse({ status: "error", message: err.toString() });
        });
      return true; // Keep message channel open
    } else {
      sendResponse({ status: "error", message: "Invalid origin" });
      return false;
    }
  }

  if (message.action === "closeActiveTab") {
    if (sender.tab && sender.tab.id) {
      chrome.tabs.remove(sender.tab.id);
    }
    sendResponse({ status: "success" });
    return;
  }

  if (message.action === "submitLocalResult") {
    let origin = message.origin;
    if (isValidOrigin(origin)) {
      chrome.storage.local.get(["auth_username"], (store) => {
        let url = `${origin}/api/extension/submit_local_result`;
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            target_username: message.target_username,
            status: message.status,
            error: message.error,
            data: message.data,
            settings: message.settings,
            username: store.auth_username || ""
          })
        }).then(r => r.json())
          .then(res => {
            sendResponse(res);
          })
          .catch(err => {
            console.log("submitLocalResult fetch error:", err);
            sendResponse({ status: "error", message: err.toString() });
          });
      });
      return true; // Keep message channel open
    } else {
      sendResponse({ status: "error", message: "Invalid origin" });
      return false;
    }
  }

  if (message.action === "updateTweetViews") {
    let origin = message.origin;
    if (isValidOrigin(origin)) {
      chrome.storage.local.get(["auth_username", "is_server"], (store) => {
        let url = `${origin}/api/tweets/update_views`;
        const isServer = !!store.is_server;
        const is_ext_val = isServer ? 0 : (message.is_extension !== undefined ? message.is_extension : 1);
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            tweet_url: message.tweet_url,
            views_count: message.views_count,
            likes_count: message.likes_count,
            tweet_text: message.tweet_text,
            username: store.auth_username || "",
            is_extension: is_ext_val
          })
        }).then(r => r.json())
          .then(res => {
            sendResponse(res);
          })
          .catch(err => {
            console.log("updateTweetViews fetch error:", err);
            sendResponse({ status: "error", message: err.toString() });
          });
      });
      return true; // Keep message channel open
    } else {
      sendResponse({ status: "error", message: "Invalid origin" });
      return false;
    }
  }

  if (message.action === "saveInteractionsToServer") {
    let origin = message.origin;
    if (isValidOrigin(origin)) {
      chrome.storage.local.get(["auth_username", "is_server"], (store) => {
        let url = `${origin}/api/tweets/save_interactions`;
        const isServer = !!store.is_server;
        const is_ext_val = isServer ? 0 : (message.is_extension !== undefined ? message.is_extension : 1);
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            tweet_url: message.tweet_url,
            tweet_text: message.tweet_text,
            tweet_date: message.tweet_date,
            interaction_type: message.interaction_type,
            users: message.users,
            username: store.auth_username || "",
            is_extension: is_ext_val,
            views_count: message.views_count,
            likes_count: message.likes_count
          })
        }).then(r => r.json())
          .then(res => {
            sendResponse(res);
          })
          .catch(err => {
            console.log("saveInteractionsToServer fetch error:", err);
            sendResponse({ status: "error", message: err.toString() });
          });
      });
      return true; // Keep message channel open
    } else {
      sendResponse({ status: "error", message: "Invalid origin" });
      return false;
    }
  }

  // SILINDI (v3.61): "syncTwitterCookies" isleyicisi. X oturum cerezlerini okuyup
  // CAGIRANI HIC DOGRULAMADAN geri donduruyordu (bu blokta 'origin' kelimesi bile
  // gecmiyordu). Cifti olan bridge.js dinleyicisi de her http(s) sayfasinda calisiyordu
  // -> ziyaret edilen herhangi bir site cerezleri isteyip sizdirabilirdi.
  // Ozellik ZATEN OLUYDU: panel bu olayi hicbir yerde tetiklemiyor (sunucu tarafi Word
  // uretimi tarayiciya tasinirken yol olmus, tesisati sokulmemis). Manifest'teki
  // "cookies" izni de kaldirildi — chrome.cookies'in tek kullanimi buydu.
});

// Extension icon click action: focus existing tab or open in a new tab
// #1: Panel ZATEN acikken yeni bir sekme panel URL'sine giderse, sayfa RENDER OLMADAN once
// o sekmeyi kapatip mevcut paneli odakla. Bu, registerPanel'den (DOMContentLoaded) DAHA ERKEN
// tetiklenir -> yeni panel hic "acilmadan" mevcut olana yonlendirilirsin (flas olmaz).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  try {
    const url = changeInfo.url || ((changeInfo.status === 'loading' && tab) ? tab.url : null);
    if (!url) return;
    let navHost = null, navPort = null;
    try { const u = new URL(url); navHost = u.hostname; navPort = u.port; } catch (e) { return; }
    if (navPort !== '3011') return; // yalnizca panel portu (worker sekmeleri x/instagram :443 -> etkilenmez)
    chrome.storage.local.get(['server_origin', 'panel_tab_id'], (res) => {
      const panelTabId = res.panel_tab_id;
      if (!panelTabId || panelTabId === tabId) return; // acik panel yok ya da bu ZATEN panel (F5 vb.)
      let panelHost = null;
      try { panelHost = new URL(res.server_origin || '').hostname; } catch (e) {}
      if (!panelHost || navHost !== panelHost) return; // farkli host -> dokunma
      chrome.tabs.get(panelTabId, (existing) => {
        if (chrome.runtime.lastError || !existing || !existing.url) return; // mevcut panel olu -> yeni sekme panel olsun
        // SERTLESTIRME: panel_tab_id bayat/cakisan olabilir (restart sonrasi Chrome id'leri yeniden atar).
        // Sadece "canli" degil, GERCEKTEN ayni-host :3011 paneli oldugunu dogrula; degilse yeni sekmeyi KAPATMA.
        let exHost = null, exPort = null;
        try { const eu = new URL(existing.url); exHost = eu.hostname; exPort = eu.port; } catch (e) { return; }
        if (exHost !== navHost || exPort !== '3011') return; // bayat id, gercek panel degil
        chrome.tabs.update(panelTabId, { active: true }, () => { if (chrome.runtime.lastError) { /* ignore */ } });
        if (existing.windowId != null) chrome.windows.update(existing.windowId, { focused: true }, () => { if (chrome.runtime.lastError) { /* ignore */ } });
        chrome.tabs.remove(tabId, () => { if (chrome.runtime.lastError) { /* ignore */ } });
      });
    });
  } catch (e) { /* ignore */ }
});

// Eklenti simgesine tiklaninca: panel ACIKSA o sekmeye git, DEGILSE yeni sekmede ac.
chrome.action.onClicked.addListener((tab) => {
  chrome.storage.local.get({ server_origin: "http://localhost:3012", panel_tab_id: null }, (res) => {
    let panelUrl = (res.server_origin || "http://localhost:3012").replace(':3012', ':3011') + '/';
    const focusTab = (t) => {
      chrome.tabs.update(t.id, { active: true }, () => { if (chrome.runtime.lastError) { /* ignore */ } });
      if (t.windowId != null) chrome.windows.update(t.windowId, { focused: true }, () => { if (chrome.runtime.lastError) { /* ignore */ } });
    };
    const findOrOpen = () => {
      chrome.tabs.query({}, (tabs) => {
        let existingTab = tabs.find(t => t.url && t.url.includes(':3011'));
        if (existingTab) focusTab(existingTab);
        else chrome.tabs.create({ url: panelUrl });
      });
    };
    // Once guvenilir panel_tab_id: canliysa dogrudan ona git.
    if (res.panel_tab_id) {
      chrome.tabs.get(res.panel_tab_id, (pt) => {
        if (!chrome.runtime.lastError && pt) focusTab(pt);
        else findOrOpen();
      });
    } else {
      findOrOpen();
    }
  });
});

// --- SERVER POLLING SYSTEM ---

function checkServerJobs() {
  try {
    chrome.storage.local.get(null, (allStorage) => {
      try {
        let rawOrigin = allStorage.server_origin || "http://localhost:3012";
        let origin = (rawOrigin.startsWith('http://') || rawOrigin.startsWith('https://'))
          ? rawOrigin
          : "http://localhost:3012";
        let role = allStorage.browser_role || "word";

        let activeJobFound = false;
        for (let key in allStorage) {
          if (key.startsWith('x_profil_gorevi_') && allStorage[key] && allStorage[key].aktif) {
            activeJobFound = true;
            break;
          }
        }

        if (activeJobFound) {
          // Aktif görev sürerken yeni görev ÇEKMİYORUZ (çift işleme olmasın) ama yine de
          // heartbeat gönderiyoruz. Böylece eklenti bir kez yüklendikten sonra tarama
          // sürerken bile panel "Eklenti bekleniyor" durumuna DÜŞMEZ.
          fetch(`${origin}/api/extension/heartbeat?role=${role}`).catch(() => {});
          return;
        }

        // logToServer(`[checkServerJobs] Sunucu sorgulanıyor. Rol: ${role}, Origin: ${origin}`);
        fetch(`${origin}/api/extension/poll_job?role=${role}`)
          .then(response => response.json())
          .then(data => {
            try {
              if (data.status === "success" && data.job) {
                logToServer(`[checkServerJobs] Görev alındı: ${data.job.job_id} (mod: ${data.job.scrape_mode})`);
                processServerJob(data.job, origin);
              } else if (data.status === "no_job" && data.close_browser) {
                logToServer(`[checkServerJobs] Görev yok, tarayıcı kapatılıyor...`);
                chrome.windows.getAll({}, (wins) => {
                  wins.forEach(w => {
                    chrome.windows.remove(w.id);
                  });
                });
              }
            } catch (innerErr) {
              logToServer(`[checkServerJobs fetch callback error] ${innerErr.stack || innerErr}`);
            }
          })
          .catch(err => {
            // Sunucu kapalı veya ulaşılamıyor
          });
      } catch (err) {
        logToServer(`[checkServerJobs storage callback error] ${err.stack || err}`);
      }
    });
  } catch (outerErr) {
    logToServer(`[checkServerJobs outer error] ${outerErr.stack || outerErr}`);
  }
}

function startPolling() {
  if (pollIntervalId) clearInterval(pollIntervalId);
  pollIntervalId = setInterval(checkServerJobs, 2000);
}

let __xJobStarting = false;
function processServerJob(job, origin) {
  try {
    // Senkron kilit: mesajla-başlatma (startWordScan) ile yoklama (checkServerJobs) aynı anda
    // çağırırsa iki sekme açılmasını engeller. Görev depolanınca activeJobFound koruması devralır.
    if (__xJobStarting) {
      logToServer(`[processServerJob] Zaten başlatılıyor, çift-başlatma atlandı. ID: ${job.job_id}`);
      return;
    }
    __xJobStarting = true;
    setTimeout(() => { __xJobStarting = false; }, 4000);
    logToServer(`[processServerJob] Sunucu görevi işlenmeye başlıyor. ID: ${job.job_id}`);
    chrome.tabs.query({}, (tabs) => {
      try {
        // X, Twitter, Instagram veya Facebook sekmesini bul (Faz FB-1: FB eklendi —
        // aksi halde acik bir FB sekmesi is-sekmesi olarak yeniden kullanilmaz, yenisi acilir)
        let workerTab = tabs.find(t => t.url && (t.url.includes('x.com') || t.url.includes('twitter.com') || t.url.includes('instagram.com') || xIsFbHost(xUrlOf(t.url) ? xUrlOf(t.url).hostname : '')));
        
        let targetUrl = "";
        let jobDetails = {};
        
        if (job.scrape_mode === 'word' && job.tweet_urls && job.tweet_urls.length > 0) {
          // Helper to extract username from URL
          const extractUsername = (url) => {
            if (url.includes('instagram.com')) {
              return "instagram";
            }
            // Faz FB-1: FB dali X regex'lerinden ONCE gelmeli. Yoksa FB linki null doner ve
            // asagida (`if (!username) return;`) SESSIZCE DUSER -> kuyruk bos, total_count 0,
            // is bir sekme acip cikmaza girer. Sunucudaki pool_group_key ile AYNI 'fb:' oneki.
            if (xPlatformOf(url) === 'fb') {
              const c = xFbCanonical(url);
              const u = xUrlOf(c);
              const p = u ? String(u.pathname || '').replace(/\/+$/, '') : '';
              let m = p.match(/^\/groups\/([^/]+)\/posts\//i);
              if (m) return 'fb:group:' + m[1].toLowerCase();
              m = p.match(/^\/([^/]+)\/posts\//i);
              if (m) return 'fb:' + m[1].toLowerCase();
              const low = p.toLowerCase();
              if (low === '/permalink.php' || low === '/story.php') {
                const id = u && u.searchParams.get('id');
                if (id) return 'fb:' + id.toLowerCase();
              }
              // /share/p, /reel, /watch, /photo -> URL'de isim YOK. null DONME (dusurur);
              // yer tutucu ver ki gonderi kuyruga girsin; gercek ad Faz 2'de yakalamadan gelecek.
              return 'fb:@facebook_user';
            }
            // Faz TT-1: TikTok dali da X regex'lerinden ONCE. Yoksa link null doner ve
            // `if (!username) return;` ile SESSIZCE DUSER -> kuyruk bos kalir (FB'de yasandi).
            // Sunucudaki pool_group_key ile AYNI 'tt:' oneki.
            // Faz YT-1: X regex'lerinden ONCE. Kanal kapsamdaki formlarda URL'de YOK ->
            // yer tutucu ver ki gonderi kuyruga GIRSIN (null donersek sessizce duser).
            if (xPlatformOf(url) === 'yt') {
              const u = xUrlOf(xYtCanonical(url));
              const p = u ? String(u.pathname || '').replace(/\/+$/, '') : '';
              const m = p.match(/^\/@([^/]+)/i);
              if (m) return 'yt:' + m[1].toLowerCase();
              return 'yt:@youtube_user';
            }
            if (xPlatformOf(url) === 'tt') {
              const u = xUrlOf(xTtCanonical(url));
              const p = u ? String(u.pathname || '').replace(/\/+$/, '') : '';
              const m = p.match(/^\/@([^/]+)\/(?:video|photo)\/\d+/i);
              if (m) return 'tt:' + m[1].toLowerCase();
              // Kisa link (vm./vt./t/) -> URL'de isim YOK; yer tutucu ver ki kuyruga girsin.
              return 'tt:@tiktok_user';
            }
            if (url.includes('/status/')) {
              let match = url.match(/(?:x|twitter)\.com\/([a-zA-Z0-9_]{1,15})\/status/i);
              return match ? match[1].toLowerCase() : null;
            }
            let match = url.match(/(?:x|twitter)\.com\/([a-zA-Z0-9_]{1,15})\/?$/i);
            return match ? match[1].toLowerCase() : null;
          };

          // Helper to guarantee absolute URL with protocol prefix
          const ensureAbsoluteUrl = (url) => {
            let u = url.trim();
            if (!u.startsWith('http://') && !u.startsWith('https://')) {
              u = 'https://' + u;
            }
            return u;
          };

          // Group links by username
          let groups = {};
          job.tweet_urls.forEach(url => {
            let absUrl = ensureAbsoluteUrl(url);
            let username = extractUsername(absUrl);
            if (!username) return;
            if (!groups[username]) {
              groups[username] = { profile: null, tweets: [] };
            }
            const isTweet = absUrl.includes('/status/');
            // Faz FB-1: FB gonderisi ONCE kontrol edilmeli. Yoksa FB linki bu satirdaki
            // '/p/' || '/reel/' testine takilmayip PROFIL sayilir ve yanlis gorev tipi
            // (profile_header) alir. (FB /reel/ zaten '/reel/' iceriyor — ayrimi platform yapar.)
            const isFacebookPost = xIsFbPostUrl(absUrl);
            // Faz TT-1: TikTok gonderisi de IG testinden ONCE dislanmali; aksi halde
            // /@user/photo/123 linki '/p/' iceriyor gibi gorunmez ama kisa linkler ve
            // ileride /photo/ formu yanlis gorev tipine dusebilir.
            const isTiktokPost = xIsTtPostUrl(absUrl);
            const isYoutubePost = xIsYtPostUrl(absUrl);   // Faz YT-1
            const isInstagramPost = !isFacebookPost && !isTiktokPost && !isYoutubePost && (absUrl.includes('/p/') || absUrl.includes('/reel/'));
            if (isTweet || isInstagramPost || isFacebookPost || isTiktokPost || isYoutubePost) {
              if (groups[username].tweets.indexOf(absUrl) === -1) {
                groups[username].tweets.push(absUrl);
              }
            } else {
              groups[username].profile = absUrl;
            }
          });

          // Build structured task queue
          let structuredQueue = [];
          Object.keys(groups).forEach(username => {
            // Schedule a profile header screenshot ONLY if the user explicitly provided the profile URL
            if (groups[username].profile) {
              structuredQueue.push({
                type: "profile_header",
                url: groups[username].profile,
                username: username
              });
            }
            // Schedule all tweets belonging to this profile group
            groups[username].tweets.forEach(tUrl => {
              structuredQueue.push({
                type: "tweet_article",
                url: tUrl,
                username: username
              });
            });
          });

          if (structuredQueue.length > 0) {
            targetUrl = structuredQueue[0].url;
          } else {
            targetUrl = job.tweet_urls[0];
          }

          jobDetails = {
            aktif: true,
            job_id: job.job_id,
            asama: "word_taramasi",
            kuyruk: structuredQueue,
            aktifTivitUrl: targetUrl,
            tivitAdimi: "basla",
            is_server_job: true,
            server_origin: origin,
            combinedData: [],
            total_count: structuredQueue.length
          };
          logToServer(`[processServerJob] Word tarama görevi oluşturuldu. Toplam kuyruk uzunluğu: ${structuredQueue.length}. İlk URL: ${targetUrl}`);
        } else if (job.scrape_mode === 'list' && job.tweet_urls && job.tweet_urls.length > 0) {
          targetUrl = job.tweet_urls[0];
          jobDetails = {
            aktif: true,
            job_id: job.job_id,
            asama: "detayli_tarama",
            kuyruk: job.tweet_urls,
            aktifTivitUrl: targetUrl,
            tivitAdimi: "basla",
            ayarlar: {
              rt: job.collect_retweets == 1,
              alinti: job.collect_quotes == 1,
              begeni: job.collect_likes == 1,
              sadeceSayisalBegeni: job.sadece_sayisal_begeni == 1,
              yorum: job.collect_replies == 1
            },
            collect_views: job.collect_views || 0,
            collect_likes: job.collect_likes || 0,
            collect_retweets: job.collect_retweets || 0,
            collect_quotes: job.collect_quotes || 0,
            collect_replies: job.collect_replies || 0,
            collect_text: job.collect_text || 0,
            is_server_job: true,
            server_origin: origin,
            combinedData: [],
            gecerliVeri: {
              ozet: null,
              yorumlar: [],
              retweets: [],
              quotes: [],
              likes: []
            }
          };
          logToServer(`[processServerJob] Liste detaylı tarama görevi oluşturuldu. İlk URL: ${targetUrl}, Yorum: ${jobDetails.ayarlar.yorum}, RT: ${jobDetails.ayarlar.rt}, Alıntı: ${jobDetails.ayarlar.alinti}, Beğeni: ${jobDetails.ayarlar.begeni}`);
        } else if (job.scrape_mode === 'list') {
          // Twitter List Scrape Modu
          let rawTargetUrl = job.target_username;
          if (!rawTargetUrl.startsWith('http')) {
            if (/^\d+$/.test(rawTargetUrl)) {
              rawTargetUrl = `https://x.com/i/lists/${rawTargetUrl}`;
            } else if (rawTargetUrl.startsWith('/')) {
              rawTargetUrl = `https://x.com${rawTargetUrl}`;
            } else {
              rawTargetUrl = `https://x.com/${rawTargetUrl}`;
            }
          }
          targetUrl = rawTargetUrl;
          jobDetails = {
            aktif: true,
            job_id: job.job_id,
            targetList: [targetUrl],
            targetIndex: 0,
            profilAdi: targetUrl,
            is_list_scrape: true,
            baslangicMs: parseDateToMs(job.start_date, job.start_time),
            bitisMs: parseDateToMs(job.end_date, job.end_time),
            asama: "profil_taramasi",
            collect_views: job.collect_views || 0,
            collect_likes: job.collect_likes || 0,
            collect_retweets: job.collect_retweets || 0,
            collect_quotes: job.collect_quotes || 0,
            collect_replies: job.collect_replies || 0,
            collect_text: job.collect_text || 0,
            is_server_job: true,
            server_origin: origin,
            combinedData: [],
            gecerliVeri: {
              ozet: null,
              yorumlar: [],
              retweets: [],
              quotes: [],
              likes: []
            }
          };
          logToServer(`[processServerJob] Twitter Listesi tarama görevi oluşturuldu. Hedef URL: ${targetUrl}`);
        } else {
          // Çoklu hedefleri virgüllerden temizle
          let targetList = job.target_username.split(',').map(t => t.trim().replace('@', '')).filter(Boolean);
          if (targetList.length === 0) {
            logToServer(`[processServerJob] Hata: Geçersiz hedef kullanıcı adı. Görev iptal ediliyor. ID: ${job.job_id}`);
            // Görevi başarısız yap
            let submitUrl = `${origin}/api/extension/submit_result`;
            fetch(submitUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                job_id: job.job_id,
                status: "failed",
                error: "Geçersiz hedef kullanıcı adı."
              })
            }).catch(e => {});
            return;
          }

          let targetProfile = targetList[0];
          targetUrl = `https://x.com/${targetProfile}`;
          if (job.content_filter === "only_replies") {
            targetUrl = `https://x.com/${targetProfile}/with_replies`;
          }

          jobDetails = {
            aktif: true,
            job_id: job.job_id,
            targetList: targetList,
            targetIndex: 0,
            profilAdi: targetProfile,
            baslangicMs: parseDateToMs(job.start_date, job.start_time),
            bitisMs: parseDateToMs(job.end_date, job.end_time),
            asama: "profil_taramasi",
            content_filter: job.content_filter,
            search_keyword: job.search_keyword,
            collect_views: job.collect_views || 0,
            collect_likes: job.collect_likes || 0,
            collect_retweets: job.collect_retweets || 0,
            collect_quotes: job.collect_quotes || 0,
            collect_replies: job.collect_replies || 0,
            collect_text: job.collect_text || 0,
            is_server_job: true,
            server_origin: origin,
            combinedData: [],
            gecerliVeri: {
              ozet: null,
              yorumlar: [],
              retweets: [],
              quotes: [],
              likes: []
            }
          };
          logToServer(`[processServerJob] Profil modu görevi oluşturuldu. Profil: @${targetProfile}`);
        }

        // Tüm gönderiler (X ve Instagram) doğrudan normal sayfada açılır; embed kullanılmaz.
        let navUrl = targetUrl;

        if (workerTab) {
          // Önce storage'a yaz, sonra sekmeyi yönlendir (onUpdated gelince storage hazır olsun)
          const storageKey = `x_profil_gorevi_${workerTab.id}`;
          let saveData = {};
          saveData[storageKey] = jobDetails;
          logToServer(`[processServerJob] Mevcut sekme yönlendiriliyor. Tab ID: ${workerTab.id}, URL: ${targetUrl}`);
          chrome.storage.local.set(saveData, () => {
            try {
              chrome.tabs.update(workerTab.id, { url: navUrl, active: true }, (tab) => {
                if (tab) {
                  chrome.windows.update(tab.windowId, { focused: true });
                }
              });
            } catch (tabUpdateErr) {
              logToServer(`[processServerJob tab update error] ${tabUpdateErr.stack || tabUpdateErr}`);
            }
          });
        } else {
          // Yeni sekme oluştur: Önce storage'a yaz, sonra sekmeyi aç (onUpdated tetiklenince storage hazır olacak)
          logToServer(`[processServerJob] Yeni sekme oluşturuluyor. URL: ${targetUrl}`);
          
          // Önce geçici bir tab ID ile storage yazıyoruz,
          // gerçek tab ID'yi tab oluştuğunda güncelleyeceğiz
          chrome.tabs.create({ url: navUrl, active: true }, (tab) => {
            try {
              if (!tab) {
                logToServer(`[processServerJob] Hata: chrome.tabs.create tab nesnesi döndürmedi.`);
                return;
              }
              const storageKey = `x_profil_gorevi_${tab.id}`;
              let saveData = {};
              saveData[storageKey] = jobDetails;
              logToServer(`[processServerJob] Yeni sekme oluşturuldu. Tab ID: ${tab.id}, storageKey: ${storageKey}`);
              // Storage'a yazılınca tab zaten yükleniyor olacak.
              // onUpdated complete olayı geldiğinde storage hazır olmayabilir,
              // bu yüzden kısa bir bekleme sonrasında widget'i tekrar fırlatıyoruz.
              chrome.storage.local.set(saveData, () => {
                logToServer(`[processServerJob] Local storage başarıyla güncellendi. Tab ID: ${tab.id}`);
                chrome.windows.update(tab.windowId, { focused: true });
                // Tab yükleme tamamlanmış olabilir ama storage geç yazıldıysa widget açılmamış olabilir.
                // Güvenlik için 1.5s sonra widget'i tekrar zorla fırlat.
                setTimeout(() => {
                  chrome.tabs.get(tab.id, (currentTab) => {
                    if (chrome.runtime.lastError || !currentTab) return;
                    if (currentTab.status === 'complete') {
                      logToServer(`[processServerJob] Gecikme ile widget tekrar firlatiyor. Tab ID: ${tab.id}`);
                      widgetiFirlat(tab.id);
                    }
                  });
                }, 1500);
              });
            } catch (tabCreateCallbackErr) {
              logToServer(`[processServerJob tab create callback error] ${tabCreateCallbackErr.stack || tabCreateCallbackErr}`);
            }
          });
        }
      } catch (innerErr) {
        logToServer(`[processServerJob query callback error] ${innerErr.stack || innerErr}`);
      }
    });
  } catch (outerErr) {
    logToServer(`[processServerJob outer error] ${outerErr.stack || outerErr}`);
  }
}

function parseDateToMs(dateStr, timeStr) {
  try {
    let parts = dateStr.split('-');
    let day = parseInt(parts[0]);
    let month = parseInt(parts[1]) - 1;
    let year = parseInt(parts[2]);
    
    let timeParts = timeStr.split(':');
    let hour = parseInt(timeParts[0]);
    let minute = parseInt(timeParts[1]);
    
    let d = new Date(year, month, day, hour, minute);
    return d.getTime();
  } catch(e) {
    return Date.now();
  }
}

async function cropImageInBackground(dataUrl, rect, dpr, vw) {
  try {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    const blob = new Blob([u8arr], { type: mime });
    const imageBitmap = await createImageBitmap(blob);
    
    const srcW = imageBitmap.width;
    const srcH = imageBitmap.height;

    // OLCEK: dpr'ye GUVENME, yakalanan goruntuden TURET.
    //
    // SAHA HATASI (2026-07-20, YouTube): CSS px -> goruntu px cevirimi dpr ile yapiliyordu,
    // ama gercek olcek srcW/viewportGenisligi'dir. Ikisi AYNI DEGIL — en yaygin sebep
    // KAYDIRMA CUBUGU: window.innerWidth cubugu ICERIR, yakalanan goruntu ise icerik
    // alanidir (olculdu: innerWidth=1280, documentElement.clientWidth=1265 -> %1.2 fark).
    // Etkisi CARPANSAL, dolayisiyla hata neredeyse TAMAMEN SAG kenarda birikir:
    //     sag kenar = R2 * (dpr/s),  sol kenar = L * (dpr/s)
    // YouTube'da L~8, R2~803 -> solda 0.1px (gorunmez), sagda ~10px -> tam olarak
    // kullanicinin bildirdigi "ince, tum yukseklikte SAG SERIT" (oneri kucuk resimleri).
    // Ayrica bu, R2'yi kucultmenin neden ise yaramadigini aciklar: serit = R2*(d-1),
    // R2 953->859 seridi 11.3px'ten 10.2px'e indirir (BIR piksel).
    // Olcegi olcerek turetmek kaydirma cubugu / tarayici yakinlastirmasi / kesirli dpr
    // durumlarinin HEPSINI birden cozer.
    let olcek = dpr;
    if (vw > 0 && srcW > 0) {
        const s2 = srcW / vw;
        // Akil sagligi: makul araligin disindaysa dpr'ye don (bozuk yakalama vb.)
        if (s2 > 0.2 && s2 < 8) olcek = s2;
    }
    // NOT (v3.60): burada bir "[crop TANI]" satiri vardi ve DAIRESELDI — vw>0 iken
    // olcek ZATEN srcW/vw'ye esit oldugu icin hesaplanan fark tanim geregi ~0 cikiyordu,
    // yani hicbir olcek uyusmazligini yakalayamazdi. Silindi. Gercek sorun kirpmada
    // degil kadraj dikdortgeninde cikti (widget.js, YouTube sag kenar siniri).
    if (Math.abs(olcek - dpr) > 0.005) {
        logToServer(`[crop] OLCEK duzeltildi: dpr=${dpr} -> olcek=${olcek.toFixed(4)} (srcW=${srcW}, vw=${vw})`);
    }

    let cropX = Math.round(rect.left * olcek);
    let cropY = Math.round(rect.top * olcek);
    let cropW = Math.round(rect.width * olcek);
    let cropH = Math.round(rect.height * olcek);
    
    // Sınırları kaynağa göre sınırla (out-of-bounds hatalarını engelle)
    if (cropX < 0) cropX = 0;
    if (cropY < 0) cropY = 0;
    if (cropX >= srcW) cropX = srcW - 1;
    if (cropY >= srcH) cropY = srcH - 1;
    
    if (cropX + cropW > srcW) {
      cropW = srcW - cropX;
    }
    if (cropY + cropH > srcH) {
      cropH = srcH - cropY;
    }
    
    if (cropW <= 0 || cropH <= 0) {
      return dataUrl;
    }
    
    const canvas = new OffscreenCanvas(cropW, cropH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    
    const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
    const buffer = await croppedBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    return `data:image/png;base64,${base64}`;
  } catch (err) {
    console.log("cropImageInBackground error:", err);
    throw err;
  }
}