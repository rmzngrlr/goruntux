// ============================================================================
// [WEBSHOT 2026-11-22 — ELEMAN SEÇİCİ] Sosyal-dışı sitelerde: toolbar -> sağ-üst SAYDAM menü
// (GörüntüX'e Git + Ekran Görüntüsü Al). "Ekran Görüntüsü Al" -> F12-vari ELEMAN SEÇİCİ:
// fareyle sayfadaki öğenin üstüne gelince kutuyla işaretlenir (dışı kararır), tıklayınca O ÖĞE
// yakalanır. Ekrana sığan öğe (kart/tweet/görsel/bölüm) -> TEK karede, kaydırmasız, gerçek
// piksellerle (captureVisibleTab + kırp) -> git-gel/dikiş/eksik-görsel YOK. Ekrandan uzun öğe ->
// o öğeyle sınırlı scroll-stitch. Serbest dikdörtgen de çizilebilir (sürükle). Sonuç -> havuz + pano
// (link = sayfa URL, başlık = og:title/title). Trusted-Types güvenli (createElement).
// ============================================================================
(function () {
  if (window.__xWebshotAktif) {
    var _m0 = document.getElementById('x-webshot-menu') || document.getElementById('x-webshot-blocker');
    if (_m0) { try { if (window.__xWebshotMenuTemiz) window.__xWebshotMenuTemiz(); else _m0.remove(); } catch (e) {} window.__xWebshotAktif = false; }
    return;
  }
  window.__xWebshotAktif = true;

  function bitir() { window.__xWebshotAktif = false; }

  // [SCROLLBAR] Yakalanan görselin sağ/alt kenarından ölçülen scrollbar kalınlığı kadar kırp (DOM'a dokunmadan).
  function scrollbarKirp(raw) {
    try {
      var sbW = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
      var sbH = Math.max(0, window.innerHeight - document.documentElement.clientHeight);
      if (sbW < 1 && sbH < 1) return raw;
      var sx = raw.naturalWidth / Math.max(1, window.innerWidth);
      var sy = raw.naturalHeight / Math.max(1, window.innerHeight);
      var cw = Math.max(1, Math.round(raw.naturalWidth - sbW * sx));
      var ch = Math.max(1, Math.round(raw.naturalHeight - sbH * sy));
      if (cw >= raw.naturalWidth && ch >= raw.naturalHeight) return raw;
      var tc = document.createElement('canvas'); tc.width = cw; tc.height = ch;
      tc.getContext('2d').drawImage(raw, 0, 0, cw, ch, 0, 0, cw, ch);
      return tc;
    } catch (e) { return raw; }
  }

  function originAl(cb) {
    try { chrome.storage.local.get({ server_origin: "https://goruntux.rgmedya.tr" }, function (r) { cb((r && r.server_origin) || "https://goruntux.rgmedya.tr"); }); }
    catch (e) { cb("https://goruntux.rgmedya.tr"); }
  }
  function baslikBul() {
    try { var m = document.querySelector('meta[property="og:title"], meta[name="og:title"]'); if (m && m.content && m.content.trim()) return m.content.trim().slice(0, 200); } catch (e) {}
    try { if (document.title && document.title.trim()) return document.title.trim().slice(0, 200); } catch (e) {}
    return "";
  }
  function yakala(cb, fast) {
    try {
      chrome.runtime.sendMessage({ action: 'captureTab', fast: !!fast }, function (resp) {
        if (chrome.runtime.lastError || !resp || resp.status !== 'success' || !resp.dataUrl) { cb(null); return; }
        cb(resp.dataUrl);
      });
    } catch (e) { cb(null); }
  }

  function bildir(msg, hata) {
    try {
      var t = document.createElement('div');
      t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;background:' + (hata ? '#b00020' : '#1d9bf0') + ';color:#fff;font:600 13px -apple-system,Segoe UI,Arial;padding:10px 16px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;';
      t.textContent = msg;
      document.documentElement.appendChild(t);
      setTimeout(function () { try { t.remove(); } catch (e) {} }, 2200);
    } catch (e) {}
  }

  // --- ENTRY: sağ-üst SAYDAM menü ---
  menuKur();

  function _svgIkon(tur) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', '22'); s.setAttribute('height', '22'); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', '#fff'); s.setAttribute('stroke-width', '1.9');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.style.flex = '0 0 auto';
    var d = ['M4.5 9V4.5h4.5', 'M15 4.5h4.5v4.5', 'M19.5 15v4.5h-4.5', 'M9 19.5H4.5v-4.5'];
    if (tur === 'x') { d.push('M9.6 9.6l4.8 4.8'); d.push('M14.4 9.6l-4.8 4.8'); }
    else { d.push('M12 8.5v7'); d.push('M8.5 12h7'); }
    d.forEach(function (dd) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', dd); s.appendChild(p); });
    return s;
  }
  function _btn(renk, bas, altMetin, ikon) {
    var b = document.createElement('button');
    b.type = 'button';
    b.style.cssText = 'all:unset;box-sizing:border-box;cursor:pointer;width:100%;display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;color:#fff;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:' + renk + ';box-shadow:0 6px 22px rgba(0,0,0,.30);';
    b.appendChild(_svgIkon(ikon));
    var txt = document.createElement('span');
    txt.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;text-align:left;';
    var t1 = document.createElement('span'); t1.textContent = bas; t1.style.cssText = 'font-weight:700;font-size:13.5px;';
    txt.appendChild(t1);
    if (altMetin) { var t2 = document.createElement('span'); t2.textContent = altMetin; t2.style.cssText = 'font-weight:500;font-size:11px;line-height:1.3;color:rgba(255,255,255,0.88);'; txt.appendChild(t2); }
    b.appendChild(txt);
    return b;
  }
  function menuKapat() {
    try { var m = document.getElementById('x-webshot-menu'); if (m) m.remove(); } catch (e) {}
    try { document.removeEventListener('keydown', _menuKey, true); } catch (e) {}
    try { document.removeEventListener('mousedown', _menuDis, true); } catch (e) {}
  }
  window.__xWebshotMenuTemiz = menuKapat;
  function _menuKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); menuKapat(); bitir(); } }
  function _menuDis(e) { var m = document.getElementById('x-webshot-menu'); if (m && !m.contains(e.target)) { menuKapat(); bitir(); } }
  function menuKur() {
    var menu = document.createElement('div');
    menu.id = 'x-webshot-menu';
    menu.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;width:264px;display:flex;flex-direction:column;gap:9px;';
    var bPanel = _btn('#1d9bf0', 'GörüntüX\'e Git', '', 'x');
    var bCap = _btn('#00ba7c', 'Ekran Görüntüsü Al', 'Bu sayfanın ekran görüntüsünü GörüntüX Raporu\'na ekleyin.', 'arti');
    bPanel.addEventListener('click', function () {
      menuKapat();
      originAl(function (org) { try { chrome.runtime.sendMessage({ action: 'goToPanel', origin: org }, function () { void chrome.runtime.lastError; }); } catch (e) {} });
      bitir();
    });
    bCap.addEventListener('click', function () { menuKapat(); seciciBaslat(); });
    menu.appendChild(bPanel); menu.appendChild(bCap);
    document.documentElement.appendChild(menu);
    setTimeout(function () {
      try { document.addEventListener('keydown', _menuKey, true); } catch (e) {}
      try { document.addEventListener('mousedown', _menuDis, true); } catch (e) {}
    }, 0);
  }

  // =================== ELEMAN SEÇİCİ (F12-vari) ===================
  function seciciBaslat() {
    var blocker = document.createElement('div');   // olayları yakalar (sayfa tıklaması/navigasyon engellenir)
    blocker.id = 'x-webshot-blocker';
    blocker.style.cssText = 'position:fixed;inset:0;z-index:2147483645;cursor:crosshair;background:transparent;';
    var hi = document.createElement('div');          // vurgulama kutusu + dışı karartma (box-shadow)
    hi.id = 'x-webshot-hi';
    hi.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;border:2px solid #1d9bf0;background:rgba(29,155,240,0.12);box-shadow:0 0 0 100000px rgba(10,14,20,0.42);border-radius:3px;pointer-events:none;';
    var ipuc = document.createElement('div');
    ipuc.id = 'x-webshot-ipuc';
    ipuc.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1d9bf0;color:#fff;font:600 13px -apple-system,Segoe UI,Arial;padding:8px 14px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap;';
    ipuc.textContent = 'Eklenecek öğeye tıkla · sürükle = serbest alan · ↑/↓ büyüt/küçült · Esc iptal';
    document.documentElement.appendChild(blocker);
    document.documentElement.appendChild(hi);
    document.documentElement.appendChild(ipuc);

    var hoverEl = null, lastX = 0, lastY = 0;
    var basla = null, suruklu = false;   // drag-rect

    function elAt(x, y) { blocker.style.pointerEvents = 'none'; var el = null; try { el = document.elementFromPoint(x, y); } catch (e) {} blocker.style.pointerEvents = 'auto'; return el; }
    function enIyi(el) {
      if (!el) return null;
      var e = el, t = 0;
      while (e.parentElement && e.parentElement !== document.documentElement && t < 10) {
        var r = e.getBoundingClientRect();
        if (r.width >= 36 && r.height >= 22) break;   // anlamlı blok
        e = e.parentElement; t++;
      }
      return e;
    }
    function hiKutu(r) { hi.style.left = r.left + 'px'; hi.style.top = r.top + 'px'; hi.style.width = Math.max(0, r.width) + 'px'; hi.style.height = Math.max(0, r.height) + 'px'; }
    function hover(x, y) {
      var el = elAt(x, y);
      if (!el) return;
      hoverEl = enIyi(el);
      if (hoverEl) hiKutu(hoverEl.getBoundingClientRect());
    }

    function mmove(e) {
      lastX = e.clientX; lastY = e.clientY;
      if (basla) {
        if (!suruklu && (Math.abs(e.clientX - basla.x) > 5 || Math.abs(e.clientY - basla.y) > 5)) suruklu = true;
        if (suruklu) { var L = Math.min(basla.x, e.clientX), T = Math.min(basla.y, e.clientY), W = Math.abs(e.clientX - basla.x), H = Math.abs(e.clientY - basla.y); hiKutu({ left: L, top: T, width: W, height: H }); hoverEl = null; return; }
      }
      hover(e.clientX, e.clientY);
    }
    function mdown(e) { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); basla = { x: e.clientX, y: e.clientY }; suruklu = false; }
    function mup(e) {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      if (suruklu && basla) {
        var L = Math.min(basla.x, e.clientX), T = Math.min(basla.y, e.clientY), W = Math.abs(e.clientX - basla.x), H = Math.abs(e.clientY - basla.y);
        basla = null; suruklu = false;
        if (W >= 6 && H >= 6) { kapat(); tekKareKirp({ left: L, top: T, width: W, height: H }); }
        return;
      }
      basla = null; suruklu = false;
      if (hoverEl) { var el = hoverEl; kapat(); secEl(el); }
    }
    function kd(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); kapat(); bitir(); return; }
      if (suruklu) return;
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); if (hoverEl && hoverEl.parentElement && hoverEl.parentElement !== document.documentElement) { hoverEl = hoverEl.parentElement; hiKutu(hoverEl.getBoundingClientRect()); } return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); hover(lastX, lastY); return; }   // en alttaki öğeye (imleç altı) dön
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (hoverEl) { var el2 = hoverEl; kapat(); secEl(el2); } return; }
    }
    function onScrollY() { if (!suruklu) hover(lastX, lastY); }   // sayfa kaydıkça vurguyu güncelle

    function kapat() {
      try { blocker.remove(); hi.remove(); ipuc.remove(); } catch (e) {}
      try { blocker.removeEventListener('mousemove', mmove, true); blocker.removeEventListener('mousedown', mdown, true); blocker.removeEventListener('mouseup', mup, true); } catch (e) {}
      try { document.removeEventListener('keydown', kd, true); window.removeEventListener('scroll', onScrollY, true); } catch (e) {}
    }
    window.__xWebshotMenuTemiz = function () { kapat(); };   // toggle-kapat için

    blocker.addEventListener('mousemove', mmove, true);
    blocker.addEventListener('mousedown', mdown, true);
    blocker.addEventListener('mouseup', mup, true);
    document.addEventListener('keydown', kd, true);
    window.addEventListener('scroll', onScrollY, true);
  }

  // Seçilen ÖĞE: ekrana sığıyorsa (gerekirse görünür yapıp) tek kare; uzunsa öğeyle sınırlı stitch.
  function secEl(el) {
    var r = el.getBoundingClientRect(), vh = window.innerHeight;
    if (r.height <= vh + 2) {
      if (r.top < 0 || r.bottom > vh) { try { el.scrollIntoView({ block: 'center' }); } catch (e) {} }
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        var r2 = el.getBoundingClientRect();
        tekKareKirp({ left: r2.left, top: r2.top, width: r2.width, height: r2.height });
      }); });
    } else {
      elementUzun(el);
    }
  }

  // Görünür alandaki bir dikdörtgeni (viewport CSS) tek captureVisibleTab ile al + kırp (kaydırma YOK).
  function tekKareKirp(rect) {
    yakala(function (dataUrl) {
      if (!dataUrl) { bitir(); bildir('Yakalanamadı.', true); return; }
      var im = new Image();
      im.onload = function () {
        var sc = scrollbarKirp(im);
        var iw = sc.naturalWidth || sc.width, ih = sc.naturalHeight || sc.height;
        var rx = iw / Math.max(1, document.documentElement.clientWidth), ry = ih / Math.max(1, document.documentElement.clientHeight);
        var cx = Math.max(0, Math.round(rect.left * rx)), cy = Math.max(0, Math.round(rect.top * ry));
        var cw = Math.min(iw - cx, Math.round(rect.width * rx)), ch = Math.min(ih - cy, Math.round(rect.height * ry));
        if (cw < 2 || ch < 2) { bitir(); bildir('Alan çok küçük.', true); return; }
        var oc = document.createElement('canvas'); oc.width = cw; oc.height = ch;
        oc.getContext('2d').drawImage(sc, cx, cy, cw, ch, 0, 0, cw, ch);
        ekle(oc);
      };
      im.onerror = function () { bitir(); bildir('Görsel yüklenemedi.', true); };
      im.src = dataUrl;
    }, true);
  }

  // Ekrandan UZUN öğe: öğenin sayfa-aralığını kaydırıp şeritler al, birleştir, öğe sütununa kırp.
  function elementUzun(el) {
    var vh = window.innerHeight, Y0 = window.scrollY;
    var r0 = el.getBoundingClientRect();
    var pageTop = r0.top + window.scrollY, elH = r0.height, elLeft = r0.left, elW = r0.width;
    var maxScroll = Math.max(0, document.documentElement.scrollHeight - vh);
    var strips = [], hedef = pageTop, bitisPage = pageTop + elH, sonGercek = -1, guard = 0;
    function adim() {
      if (guard++ > 60) { bitirle(); return; }
      try { window.scrollTo(0, Math.max(0, Math.min(hedef, maxScroll))); } catch (e) {}
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        var gercek = window.scrollY;
        yakala(function (dataUrl) {
          if (dataUrl) strips.push({ y: gercek, dataUrl: dataUrl });
          if (gercek <= sonGercek || gercek + vh >= bitisPage - 1 || gercek >= maxScroll) { bitirle(); return; }
          sonGercek = gercek; hedef = gercek + vh; adim();
        }, true);
      }); });
    }
    function bitirle() { try { window.scrollTo(0, Y0); } catch (e) {} stitchEl(strips, vh, pageTop, elLeft, elW, elH); }
    adim();
  }

  function stitchEl(strips, vh, pageTop, elLeft, elW, elH) {
    if (!strips.length) { bitir(); bildir('Yakalanamadı.', true); return; }
    var imgs = [], done = 0;
    strips.forEach(function (s, i) {
      var im = new Image();
      im.onload = function () { imgs[i] = { y: s.y, c: scrollbarKirp(im) }; if (++done === strips.length) comp(); };
      im.onerror = function () { imgs[i] = null; if (++done === strips.length) comp(); };
      im.src = s.dataUrl;
    });
    function comp() {
      var v = imgs.filter(Boolean);
      if (!v.length) { bitir(); bildir('Yakalanamadı.', true); return; }
      var c0 = v[0].c, sw0 = c0.naturalWidth || c0.width, sh0 = c0.naturalHeight || c0.height;
      var ry = sh0 / Math.max(1, vh), rx = sw0 / Math.max(1, document.documentElement.clientWidth);
      var fullH = Math.max(1, Math.round(elH * ry));
      var nc = document.createElement('canvas'); nc.width = sw0; nc.height = fullH;
      var nx = nc.getContext('2d');
      v.forEach(function (it) { var c = it.c; nx.drawImage(c, 0, Math.round((it.y - pageTop) * ry), c.naturalWidth || c.width, c.naturalHeight || c.height); });
      var cx = Math.max(0, Math.round(elLeft * rx)), cw = Math.min(sw0 - cx, Math.round(elW * rx));
      if (cw < 2 || fullH < 2) { bitir(); bildir('Alan çok küçük.', true); return; }
      var oc = document.createElement('canvas'); oc.width = cw; oc.height = fullH;
      oc.getContext('2d').drawImage(nc, cx, 0, cw, fullH, 0, 0, cw, fullH);
      ekle(oc);
    }
  }

  // Kırpılan canvas'ı havuza + panoya ekle.
  function ekle(canvas) {
    var out;
    try { out = canvas.toDataURL('image/png'); } catch (e) { bitir(); bildir('Görsel üretilemedi.', true); return; }
    var panoVar = false;
    try {
      if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
        panoVar = true;
        var blobP = new Promise(function (res) { try { canvas.toBlob(function (b) { res(b); }, 'image/png'); } catch (e) { res(null); } });
        navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })]).catch(function () {});
      }
    } catch (e) { panoVar = false; }
    var link = location.href, baslik = baslikBul();
    originAl(function (org) {
      try {
        chrome.runtime.sendMessage({ action: 'addToPool', origin: org, title: baslik, link: link, image: out, is_profile: false, group_override: '', dedup: false }, function (resp) {
          void chrome.runtime.lastError;
          bitir();
          if (resp && resp.status === 'success') bildir('Panele eklendi' + (panoVar ? ' · panoya kopyalandı' : '') + ' ✓');
          else bildir('Eklenemedi' + (resp && resp.message ? ': ' + resp.message : ''), true);
        });
      } catch (e) { bitir(); bildir('Eklenemedi.', true); }
    });
  }
})();
