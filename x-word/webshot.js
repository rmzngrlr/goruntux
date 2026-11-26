// ============================================================================
// [WEBSHOT 2026-11-22 — GÖRÜNÜR EKRAN KIRP + ÖĞE SEÇ + DEVAMINI AL] Sosyal-dışı sitelerde:
// toolbar -> sağ-üst SAYDAM menü. "Ekran Görüntüsü Al" -> GÖRÜNÜR EKRANI yakalar (tek kare,
// git-gel yok) -> KAYDIRMALI kırp arayüzü (macOS-vari: 8 tutamaç+ızgara+dışı buğu/%30+WxH+klavye).
// Ek butonlar: [Öğe Seç] F12-vari eleman seçici -> kırp kutusu o öğeye oturur (sonra ince ayar);
// [Devamını Al ↓] görünenin ALTINI yakalayıp görsele ekler (opsiyonel; bu an kısa bir kayma olur).
// Onayla -> havuz + pano (link=URL, başlık=og:title). Trusted-Types güvenli (createElement).
// ============================================================================
(function () {
  // [SAĞ-TIK] Sağ-tık menüsünden gelen "doğrudan yakala" modu: yüzen menüyü ATLA, direkt kırpma yakalamasını
  // başlat. background, webshot.js enjekte etmeden ÖNCE window.__xWebshotDogrudanIstek=true kuruyor (aynı ISOLATED world).
  // [TEŞHİS] Sağ-tık webshot akışını sunucu /teshis log'una yolla (background üzerinden -> sayfa CSP'sine takılmaz).
  function _wlog(m, l) { try { chrome.runtime.sendMessage({ action: 'teshisLog', msg: m, lvl: (l || 'info') }, function () { void chrome.runtime.lastError; }); } catch (e) {} }
  // [DAYANIKLILIK] webshot.js YALNIZ sağ-tık menüsünden (doğrudan yakalama) enjekte edilir (toolbar artık panele gider,
  // yüzen menü emekli). Bu yüzden _dogrudan DAİMA true: bayrak set edilmese bile (SW/enjeksiyon yarışı) 'toggle-kapat'
  // ya da yüzen menü YERİNE her zaman TAZE yakalar -> "seçildi ama bir şey olmadı" hatası biter.
  var _zatenAktif = !!window.__xWebshotAktif;
  var _dogrudan = true; try { window.__xWebshotDogrudanIstek = false; } catch (e) {}
  _wlog("webshot.js çalıştı. _dogrudan=" + _dogrudan + " zatenAktif=" + _zatenAktif + " url=" + String(location.href || "").slice(0, 120));
  if (window.__xWebshotAktif) {
    var _m0 = document.getElementById('x-webshot-menu') || document.getElementById('x-webshot-ov') || document.getElementById('x-webshot-blocker');
    if (_dogrudan) {
      // Zaten açık (menü/UI) -> temizle ve TAZE yakalamaya geç (toolbar gibi toggle-KAPAT değil).
      try { if (window.__xWebshotMenuTemiz) window.__xWebshotMenuTemiz(); else if (_m0) _m0.remove(); } catch (e) {}
      window.__xWebshotAktif = false;
    } else {
      if (_m0) { try { if (window.__xWebshotMenuTemiz) window.__xWebshotMenuTemiz(); else _m0.remove(); } catch (e) {} window.__xWebshotAktif = false; }
      return;
    }
  }
  window.__xWebshotAktif = true;

  var KABA = false; try { KABA = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches); } catch (e) {}

  function bitir() { window.__xWebshotAktif = false; }
  function docH() { return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight); }

  // ===== [STICKY GİZLE] Scroll-stitch (Devamını Al / Öğe Seç oto-uzatma) sırasında site sabit/sticky
  // NAVBAR'ı her karede viewport tepesinde tekrar çizilip DİKİŞE giriyordu (navbar 2-3 kez + arkasındaki
  // içerik kaybı). Çözüm: UZATMA karesini yakalamadan önce viewport ÜST/ALT kenarına yapışık GENİŞ BARLARI
  // (fixed/sticky navbar/footer) geçici gizle (visibility:hidden -> layout BOZULMAZ, dikiş matematiği sağlam),
  // yakala, geri aç. İlk yakalama gizlemez -> navbar BİR KEZ (gerçek tepe) kalır. Bayrak x_webshot_sticky ('0'=kapalı).
  function _stickyAcik() { try { return localStorage.getItem('x_webshot_sticky') !== '0'; } catch (e) { return true; } }
  function _stickyGizle() {
    if (!_stickyAcik()) return null;
    var hidden = [], vh = window.innerHeight, vw = window.innerWidth;
    try {
      var all = document.querySelectorAll('body *');
      for (var i = 0; i < all.length; i++) {
        var el = all[i], cs;
        try { cs = getComputedStyle(el); } catch (e) { continue; }
        var p = cs.position;
        if (p !== 'fixed' && p !== 'sticky') continue;
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.05) continue;
        var r = el.getBoundingClientRect();
        if (r.width < vw * 0.5 || r.height < 2 || r.height > vh * 0.33) continue;   // GENİŞ ama İNCE bar (dar buton / uzun panel / tam-ekran overlay DEĞİL)
        // fixed = viewport'a sabit -> HANGİ konumda olursa olsun her karede dikişe girer (navbar + çerez/aydınlatma barı + footer).
        // sticky = yalnız bir kenara YAPIŞMIŞ (stuck) ise dikişe girer; akış-içi (orta) sticky'ye DOKUNMA.
        if (p === 'sticky' && !(r.top <= vh * 0.3 || r.bottom >= vh * 0.7)) continue;
        hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    } catch (e) {}
    return hidden;
  }
  function _stickyGoster(list) {
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { var el = list[i][0], v = list[i][1], pr = list[i][2]; if (v) el.style.setProperty('visibility', v, pr || ''); else el.style.removeProperty('visibility'); } catch (e) {}
    }
  }

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
      t.textContent = msg; document.documentElement.appendChild(t);
      setTimeout(function () { try { t.remove(); } catch (e) {} }, 2200);
    } catch (e) {}
  }

  // --- ENTRY: toolbar -> sağ-üst SAYDAM menü; sağ-tık -> doğrudan yakalama (menüsüz) ---
  if (_dogrudan) { baslatYakala(); } else { menuKur(); }
  function _svgIkon(tur) {
    var NS = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', '22'); s.setAttribute('height', '22'); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', '#fff'); s.setAttribute('stroke-width', '1.9');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.style.flex = '0 0 auto';
    var d = ['M4.5 9V4.5h4.5', 'M15 4.5h4.5v4.5', 'M19.5 15v4.5h-4.5', 'M9 19.5H4.5v-4.5'];
    if (tur === 'x') { d.push('M9.6 9.6l4.8 4.8'); d.push('M14.4 9.6l-4.8 4.8'); } else { d.push('M12 8.5v7'); d.push('M8.5 12h7'); }
    d.forEach(function (dd) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', dd); s.appendChild(p); });
    return s;
  }
  function _btn(renk, bas, altMetin, ikon) {
    var b = document.createElement('button'); b.type = 'button';
    b.style.cssText = 'all:unset;box-sizing:border-box;cursor:pointer;width:100%;display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;color:#fff;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:' + renk + ';box-shadow:0 6px 22px rgba(0,0,0,.30);';
    b.appendChild(_svgIkon(ikon));
    var txt = document.createElement('span'); txt.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;text-align:left;';
    var t1 = document.createElement('span'); t1.textContent = bas; t1.style.cssText = 'font-weight:700;font-size:13.5px;'; txt.appendChild(t1);
    if (altMetin) { var t2 = document.createElement('span'); t2.textContent = altMetin; t2.style.cssText = 'font-weight:500;font-size:11px;line-height:1.3;color:rgba(255,255,255,0.88);'; txt.appendChild(t2); }
    b.appendChild(txt); return b;
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
    var menu = document.createElement('div'); menu.id = 'x-webshot-menu';
    menu.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;width:264px;display:flex;flex-direction:column;gap:9px;';
    var bPanel = _btn('#1d9bf0', 'GörüntüX\'e Git', '', 'x');
    var bCap = _btn('#00ba7c', 'Ekran Görüntüsü Al', 'Bu sayfanın ekran görüntüsünü GörüntüX Raporu\'na ekleyin.', 'arti');
    bPanel.addEventListener('click', function () { menuKapat(); originAl(function (org) { try { chrome.runtime.sendMessage({ action: 'goToPanel', origin: org }, function () { void chrome.runtime.lastError; }); } catch (e) {} }); bitir(); });
    bCap.addEventListener('click', function () { menuKapat(); baslatYakala(); });
    menu.appendChild(bPanel); menu.appendChild(bCap); document.documentElement.appendChild(menu);
    setTimeout(function () { try { document.addEventListener('keydown', _menuKey, true); } catch (e) {} try { document.addEventListener('mousedown', _menuDis, true); } catch (e) {} }, 0);
  }

  // =================== GÖRÜNÜR EKRANI YAKALA -> KIRP ARAYÜZÜ ===================
  function baslatYakala() {
    var Y0 = window.scrollY;
    // Menü KALDIRILMASI ekrana işlensin -> yakalamaya girmesin (fast capture, menü silinmeden yakalayabiliyordu).
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      yakala(function (dataUrl) {
        if (!dataUrl) { _wlog("YAKALAMA BAŞARISIZ: captureTab null -> görüntü alınamadı.", "error"); bitir(); bildir('Ekran görüntüsü alınamadı.', true); return; }
        _wlog("yakalama OK -> kırp arayüzü açılıyor.");
        var im = new Image();
        im.onload = function () { if (!im.naturalWidth) { bitir(); bildir('Ekran görüntüsü boş.', true); return; } kirpUIKur(scrollbarKirp(im), Y0); };
        im.onerror = function () { bitir(); bildir('Görsel yüklenemedi.', true); };
        im.src = dataUrl;
      }, true);
    }); });
  }

  function kirpUIKur(img, Y0) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    var ratioY = ih / Math.max(1, document.documentElement.clientHeight);   // device-px / CSS-px (dikey) — Devamını Al + Öğe Seç için
    var ratioX = iw / Math.max(1, document.documentElement.clientWidth);
    var scale = 1, cw = iw, ch = ih, _uzatildi = false;   // _uzatildi: Devamını Al/Üstü ile uzatıldı mı (uzayınca yükseklik-sığdırma kalkar)

    function S(v) { return v * scale; } function U(v) { return v / scale; }

    var ov = document.createElement('div'); ov.id = 'x-webshot-ov';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(10,14,20,0.97);display:flex;flex-direction:column;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;';

    var ust = document.createElement('div'); ust.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 14px;background:rgba(0,0,0,0.35);color:#e7e9ea;font-size:13px;font-weight:600;user-select:none;';
    var logo = document.createElement('span'); logo.textContent = 'GörüntüX'; logo.style.cssText = 'background:#1d9bf0;color:#fff;font-weight:800;padding:2px 8px;border-radius:6px;';
    var ogeBtn = document.createElement('button'); ogeBtn.textContent = '⊹ Öğe Seç';
    ogeBtn.style.cssText = 'border:0;border-radius:8px;padding:6px 12px;font:600 12.5px -apple-system,Segoe UI,Arial;cursor:pointer;background:#2b3a4a;color:#e7e9ea;';
    var devBtn = document.createElement('button'); devBtn.type = 'button'; devBtn.textContent = '↕ Devamını Al';
    devBtn.style.cssText = 'border:0;border-radius:8px;padding:6px 12px;font:600 12.5px -apple-system,Segoe UI,Arial;cursor:pointer;background:#2b3a4a;color:#e7e9ea;';
    ust.appendChild(logo); ust.appendChild(ogeBtn); ust.appendChild(devBtn);

    var sar = document.createElement('div');
    sar.style.cssText = 'flex:1 1 auto;width:100%;overflow-x:hidden;overflow-y:auto;display:flex;justify-content:center;align-items:flex-start;background:#000;';
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;flex:0 0 auto;touch-action:none;cursor:crosshair;';
    sar.appendChild(canvas); var ctx = canvas.getContext('2d');

    var alt = document.createElement('div'); alt.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;justify-content:center;gap:10px;padding:8px;background:rgba(0,0,0,0.35);';
    var iptalBtn = document.createElement('button'); iptalBtn.textContent = '✕ İptal';
    iptalBtn.style.cssText = 'border:0;border-radius:10px;padding:10px 18px;font:600 13.5px -apple-system,Segoe UI,Arial;cursor:pointer;background:#1c2732;color:#e7e9ea;';
    var okBtn = document.createElement('button'); okBtn.textContent = '✓ Kırp ve Ekle';
    okBtn.style.cssText = 'border:0;border-radius:10px;padding:10px 20px;font:700 13.5px -apple-system,Segoe UI,Arial;cursor:pointer;background:#1d9bf0;color:#fff;';
    alt.appendChild(iptalBtn); alt.appendChild(okBtn);

    ov.appendChild(ust); ov.appendChild(sar); ov.appendChild(alt);
    document.documentElement.appendChild(ov);

    var blurCv = document.createElement('canvas');
    function _olcekle() {
      var availW = document.documentElement.clientWidth || window.innerWidth;   // scrollbar HARİÇ içerik genişliği -> gereksiz yatay scroll olmaz
      // [İLK AÇILIŞ SCROLL YOK] Uzatılmamış (ilk GÖRÜNÜR-ekran) yakalamada görseli kabın (sar) YÜKSEKLİĞİNE de sığdır ->
      // üst/alt çubuk payından doğan gereksiz küçük dikey scroll kalkar. Uzatınca (ih büyür) tam-genişlik + scroll'a döner.
      var fitH = 1;
      try { if (!_uzatildi) { var availH = sar.clientHeight || 0; if (availH > 60) fitH = availH / ih; } } catch (e) {}
      scale = Math.min(availW / iw, fitH, 16000 / ih, 1);   // tam genişlik VE (ilk açılışta) tam yükseklik -> scroll yok
      cw = Math.max(1, Math.round(iw * scale)); ch = Math.max(1, Math.round(ih * scale));
      canvas.width = cw; canvas.height = ch;
    }
    function blurGuncelle() {
      try { blurCv.width = cw; blurCv.height = ch; var bl = Math.max(3, Math.round(Math.min(cw, ch) * 0.012)); var bx = blurCv.getContext('2d'); bx.filter = 'blur(' + bl + 'px)'; bx.drawImage(img, 0, 0, cw, ch); bx.filter = 'none'; } catch (e) {}
    }
    _olcekle(); blurGuncelle();

    var crop = { x: 0, y: 0, w: iw, h: ih };
    var drag = null, _mesgul = false;
    var imgTopPage = Y0;   // görselin sayfadaki ÜST sınırı (CSS); Üstü/Devamı ile değişir

    function temizle() {
      try { document.removeEventListener('keydown', kd, true); } catch (e) {}
      try { ov.remove(); } catch (e) {}
      bitir();
    }
    function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
    function ciz() {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cw, ch); ctx.drawImage(img, 0, 0, cw, ch);
      var kx = S(crop.x), ky = S(crop.y), kw = S(crop.w), kh = S(crop.h);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, cw, ch); ctx.rect(kx, ky, kw, kh); ctx.clip('evenodd');
      ctx.drawImage(blurCv, 0, 0); ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fillRect(0, 0, cw, ch); ctx.restore();
      if (kw > 26 && kh > 26) {
        ctx.strokeStyle = 'rgba(255,255,255,0.38)'; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(kx + kw / 3, ky); ctx.lineTo(kx + kw / 3, ky + kh); ctx.moveTo(kx + 2 * kw / 3, ky); ctx.lineTo(kx + 2 * kw / 3, ky + kh);
        ctx.moveTo(kx, ky + kh / 3); ctx.lineTo(kx + kw, ky + kh / 3); ctx.moveTo(kx, ky + 2 * kh / 3); ctx.lineTo(kx + kw, ky + 2 * kh / 3); ctx.stroke();
      }
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(kx, ky, kw, kh);
      var hs = 5; ctx.fillStyle = '#fff';
      [[crop.x, crop.y], [crop.x + crop.w, crop.y], [crop.x, crop.y + crop.h], [crop.x + crop.w, crop.y + crop.h]].forEach(function (c) { ctx.fillRect(S(c[0]) - hs, S(c[1]) - hs, hs * 2, hs * 2); });
      var b2 = 9;
      ctx.fillRect(kx + kw / 2 - b2, ky - 2, b2 * 2, 4); ctx.fillRect(kx + kw / 2 - b2, ky + kh - 2, b2 * 2, 4);
      ctx.fillRect(kx - 2, ky + kh / 2 - b2, 4, b2 * 2); ctx.fillRect(kx + kw - 2, ky + kh / 2 - b2, 4, b2 * 2);
      var lbl = Math.round(crop.w) + ' × ' + Math.round(crop.h);
      ctx.font = 'bold 12px -apple-system,Segoe UI,Arial'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      var tw = ctx.measureText(lbl).width, pw = tw + 14, ph = 22, lx = kx, ly = ky - 6 - ph / 2; if (ly - ph / 2 < 2) ly = ky + 6 + ph / 2;
      ctx.fillStyle = 'rgba(17,24,36,0.92)'; rr(ctx, lx, ly - ph / 2, pw, ph, 5); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText(lbl, lx + 7, ly + 0.5);
    }
    function cropTut(p) {
      var t = (KABA ? 16 : 12) / scale;
      var kose = [['x', 'y', crop.x, crop.y], ['xw', 'y', crop.x + crop.w, crop.y], ['x', 'yh', crop.x, crop.y + crop.h], ['xw', 'yh', crop.x + crop.w, crop.y + crop.h]];
      for (var i = 0; i < kose.length; i++) { if (Math.abs(p.x - kose[i][2]) <= t && Math.abs(p.y - kose[i][3]) <= t) return { kose: kose[i][0] + '_' + kose[i][1] }; }
      var inX = (p.x >= crop.x - t && p.x <= crop.x + crop.w + t), inY = (p.y >= crop.y - t && p.y <= crop.y + crop.h + t);
      if (inX && Math.abs(p.y - crop.y) <= t) return { kenar: 'n' };
      if (inX && Math.abs(p.y - (crop.y + crop.h)) <= t) return { kenar: 's' };
      if (inY && Math.abs(p.x - crop.x) <= t) return { kenar: 'w' };
      if (inY && Math.abs(p.x - (crop.x + crop.w)) <= t) return { kenar: 'e' };
      if (p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h) return { tasi: true };
      return null;
    }
    function imlec(m) { if (!m) return 'crosshair'; if (m.tasi) return 'move'; if (m.kenar) return (m.kenar === 'n' || m.kenar === 's') ? 'ns-resize' : 'ew-resize'; if (m.kose) return (m.kose === 'x_y' || m.kose === 'xw_yh') ? 'nwse-resize' : 'nesw-resize'; return 'crosshair'; }
    function noktaSrc(e) { var r = canvas.getBoundingClientRect(); return { x: U(e.clientX - r.left), y: U(e.clientY - r.top) }; }
    function pd(e) {
      e.preventDefault(); var p = noktaSrc(e), ct = cropTut(p);
      if (ct) drag = { mod: ct, sx: p.x, sy: p.y, o: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } };
      else { crop = { x: p.x, y: p.y, w: 0, h: 0 }; drag = { mod: { kose: 'xw_yh' }, sx: p.x, sy: p.y, o: { x: p.x, y: p.y, w: 0, h: 0 } }; }
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {} ciz();
    }
    function pm(e) {
      if (drag) { var cr = sar.getBoundingClientRect(); if (e.clientY > cr.bottom - 26 && sar.scrollTop < sar.scrollHeight - sar.clientHeight) sar.scrollTop += 16; else if (e.clientY < cr.top + 26 && sar.scrollTop > 0) sar.scrollTop -= 16; }
      var p = noktaSrc(e);
      if (!drag) { canvas.style.cursor = imlec(cropTut(p)); return; }
      var m = drag.mod, b = drag.o;
      if (m.tasi) { crop.x = b.x + (p.x - drag.sx); crop.y = b.y + (p.y - drag.sy); crop.x = Math.max(0, Math.min(crop.x, Math.max(0, iw - crop.w))); crop.y = Math.max(0, Math.min(crop.y, Math.max(0, ih - crop.h))); }
      else {
        var x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
        if (m.kenar) { if (m.kenar === 'w') x1 = p.x; else if (m.kenar === 'e') x2 = p.x; else if (m.kenar === 'n') y1 = p.y; else if (m.kenar === 's') y2 = p.y; }
        else {
          var movR = (m.kose.indexOf('xw') === 0), movB = (m.kose.indexOf('yh') >= 0), nx = p.x, ny = p.y;
          if (e.shiftKey && b.w > 0 && b.h > 0) { var ax = movR ? b.x : (b.x + b.w), ay = movB ? b.y : (b.y + b.h), ar = b.w / b.h, rw = Math.abs(nx - ax), rh = Math.abs(ny - ay), w2, h2; if (rw / ar >= rh) { w2 = rw; h2 = rw / ar; } else { h2 = rh; w2 = rh * ar; } nx = ax + (movR ? 1 : -1) * w2; ny = ay + (movB ? 1 : -1) * h2; }
          if (movR) x2 = nx; else x1 = nx; if (movB) y2 = ny; else y1 = ny;
        }
        crop.x = Math.min(x1, x2); crop.y = Math.min(y1, y2); crop.w = Math.abs(x2 - x1); crop.h = Math.abs(y2 - y1);
        crop.x = Math.max(0, Math.min(crop.x, iw)); crop.y = Math.max(0, Math.min(crop.y, ih));
        crop.w = Math.max(1, Math.min(crop.w, iw - crop.x)); crop.h = Math.max(1, Math.min(crop.h, ih - crop.y));
      }
      ciz();
    }
    function pu(e) { drag = null; try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} }
    function kd(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); temizle(); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); uygula(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        var st = e.shiftKey ? 10 : 1, dx = (e.key === 'ArrowLeft' ? -st : (e.key === 'ArrowRight' ? st : 0)), dy = (e.key === 'ArrowUp' ? -st : (e.key === 'ArrowDown' ? st : 0));
        crop.x = Math.max(0, Math.min(crop.x + dx, iw - crop.w)); crop.y = Math.max(0, Math.min(crop.y + dy, ih - crop.h)); ciz();
      }
    }

    // ---- Öğe Seç: crop overlay'i gizle -> canlı sayfada F12-vari eleman seç -> kırp kutusunu o öğeye oturt ----
    function ogeSec() {
      ov.style.display = 'none';
      var blocker = document.createElement('div'); blocker.id = 'x-webshot-blocker';
      blocker.style.cssText = 'position:fixed;inset:0;z-index:2147483645;cursor:crosshair;background:rgba(10,14,20,0.12);';
      var kat = document.createElement('div'); kat.id = 'x-webshot-hilayer';   // kutular katmanı (tıklamayı engellemez)
      kat.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
      var hi = document.createElement('div');   // hover kutusu (kesikli)
      hi.style.cssText = 'position:fixed;left:0;top:0;border:2px dashed #1d9bf0;border-radius:3px;pointer-events:none;';
      kat.appendChild(hi);
      var bar = document.createElement('div'); bar.id = 'x-webshot-ipuc';
      bar.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;background:#0e141f;color:#fff;font:600 13px -apple-system,Segoe UI,Arial;padding:8px 10px 8px 14px;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.45);';
      var bilgi = document.createElement('span'); bilgi.style.cssText = 'color:#8b98a5;font-weight:500;white-space:nowrap;';
      var vazBtn = document.createElement('button'); vazBtn.type = 'button'; vazBtn.textContent = '✕ Vazgeç'; vazBtn.style.cssText = 'all:unset;cursor:pointer;background:#1c2732;color:#e7e9ea;padding:7px 12px;border-radius:9px;font-weight:600;';
      var okBtn2 = document.createElement('button'); okBtn2.type = 'button'; okBtn2.textContent = '✓ Onayla'; okBtn2.style.cssText = 'all:unset;cursor:pointer;background:#1d9bf0;color:#fff;padding:7px 14px;border-radius:9px;font-weight:700;';
      bar.appendChild(bilgi); bar.appendChild(vazBtn); bar.appendChild(okBtn2);
      document.documentElement.appendChild(blocker); document.documentElement.appendChild(kat); document.documentElement.appendChild(bar);

      var hoverEl = null, lx = 0, ly = 0, secili = [], secBoxlar = [];
      function elAt(x, y) { blocker.style.pointerEvents = 'none'; var el = null; try { el = document.elementFromPoint(x, y); } catch (e) {} blocker.style.pointerEvents = 'auto'; return el; }
      function enIyi(el) { if (!el) return null; var vw = document.documentElement.clientWidth || window.innerWidth; var e = el, t = 0; while (e.parentElement && e.parentElement !== document.body && e.parentElement !== document.documentElement && t < 12) { var r = e.getBoundingClientRect(); if (r.width >= vw * 0.25 && r.height >= 70) break; e = e.parentElement; t++; } return e; }   // GENİŞ blok (kart/bölüm); küçük detay değil
      function kutu(el) { var r = el.getBoundingClientRect(); hi.style.left = r.left + 'px'; hi.style.top = r.top + 'px'; hi.style.width = Math.max(0, r.width) + 'px'; hi.style.height = Math.max(0, r.height) + 'px'; }
      function hover(x, y) { var el = elAt(x, y); if (!el) return; hoverEl = enIyi(el); if (hoverEl) kutu(hoverEl); }
      function secCiz() {
        secBoxlar.forEach(function (b) { try { b.remove(); } catch (e) {} }); secBoxlar = [];
        secili.forEach(function (el) { var r = el.getBoundingClientRect(); var b = document.createElement('div'); b.style.cssText = 'position:fixed;border:2px solid #1d9bf0;background:rgba(29,155,240,0.22);border-radius:3px;pointer-events:none;left:' + r.left + 'px;top:' + r.top + 'px;width:' + Math.max(0, r.width) + 'px;height:' + Math.max(0, r.height) + 'px;'; kat.appendChild(b); secBoxlar.push(b); });
        bilgi.textContent = secili.length ? (secili.length + ' öğe seçili · tıkla ekle/çıkar') : 'Öğelere tıkla (birden çok seçebilirsin) · ↑/↓ büyüt-küçült';
      }
      function bitisik(a, b) { var g = 24, vOv = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top), hOv = Math.min(a.right, b.right) - Math.max(a.left, b.left); if (vOv > 12 && (Math.max(a.left, b.left) - Math.min(a.right, b.right)) <= g) return true; if (hOv > 12 && (Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)) <= g) return true; return false; }   // a,b KENAR paylaşan komşu mu: bir eksende örtüşme (>12) + diğerinde küçük boşluk (<=24)
      function komsuMu(el) { if (!secili.length) return true; var r = el.getBoundingClientRect(); for (var k = 0; k < secili.length; k++) { if (bitisik(r, secili[k].getBoundingClientRect())) return true; } return false; }   // seçili ÖĞELERDEN BİRİNE kenar-komşu mu (union DEĞİL)
      function toggle(el) {
        var i = secili.indexOf(el);
        if (i >= 0) { secili.splice(i, 1); secCiz(); return; }   // çıkarma serbest
        for (var j = 0; j < secili.length; j++) { if (secili[j].contains(el)) { bilgi.textContent = 'Bu alan zaten seçili kapsayıcının içinde'; try { setTimeout(secCiz, 1100); } catch (e) {} return; } }   // iç içe -> gereksiz, ekleme
        if (secili.length && !komsuMu(el)) { bilgi.textContent = 'Yalnız komşu öğe eklenebilir'; try { setTimeout(secCiz, 1100); } catch (e) {} return; }
        secili = secili.filter(function (s) { return !el.contains(s); });   // el, seçili öğeleri KAPSIYORSA onları çıkar (süper-küme)
        secili.push(el); secCiz();
      }
      function pkapat() { try { blocker.remove(); kat.remove(); bar.remove(); } catch (e) {} try { blocker.removeEventListener('mousemove', mm, true); blocker.removeEventListener('click', clk, true); document.removeEventListener('keydown', pk, true); window.removeEventListener('scroll', sc2, true); } catch (e) {} }
      function geriDon() { pkapat(); ov.style.display = 'flex'; window.__xWebshotMenuTemiz = temizle; }
      function onayla() {
        if (!secili.length) { geriDon(); ciz(); return; }
        var L = Infinity, T = Infinity, R = -Infinity, B = -Infinity, curY = window.scrollY;
        secili.forEach(function (el) { var r = el.getBoundingClientRect(); L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom); });
        var uT = T + curY, uB = B + curY;   // birleşiğin SAYFA koordinatı (CSS), scroll'dan bağımsız
        geriDon();   // picker kapat -> kırp UI'a dön
        function kapsaVeKirp() {   // görsel, union'u KAPSAYANA kadar uzat; sonra kırp kutusunu kur
          var imgBot = imgTopPage + ih / ratioY;
          if (!_mesgul && uB > imgBot + 1 && imgBot < docH() - 1) { _uzat('alt', kapsaVeKirp); return; }   // alta eksik -> uzat
          if (!_mesgul && uT < imgTopPage - 1 && imgTopPage > 1) { _uzat('ust', kapsaVeKirp); return; }    // üste eksik -> uzat
          crop = { x: Math.max(0, L * ratioX), y: Math.max(0, (uT - imgTopPage) * ratioY), w: (R - L) * ratioX, h: (uB - uT) * ratioY };
          crop.x = Math.min(crop.x, iw); crop.y = Math.min(crop.y, ih);
          crop.w = Math.max(1, Math.min(crop.w, iw - crop.x)); crop.h = Math.max(1, Math.min(crop.h, ih - crop.y));
          // [ÖĞE SEÇ TEK-ONAY] Öğeleri seçip "✓ Onayla" -> kırpma fine-tune adımı ATLANIR, çıktı DOĞRUDAN rapora
          // eklenir (kullanıcı isteği: tek onay). Bayrak x_webshot_oge_tekonay='0' -> eski 2-adım (seçim kırp
          // kutusuna oturur, ayrıca ana "✓ Kırp ve Ekle" gerekir).
          var _tekOnay = true; try { _tekOnay = localStorage.getItem('x_webshot_oge_tekonay') !== '0'; } catch (e) {}
          if (_tekOnay) { uygula(); return; }
          ciz();
          try { sar.scrollTop = Math.max(0, S(crop.y) - 40); } catch (e) {}
        }
        kapsaVeKirp();
      }
      function mm(e) { lx = e.clientX; ly = e.clientY; hover(e.clientX, e.clientY); }
      function clk(e) { e.preventDefault(); e.stopPropagation(); if (hoverEl) toggle(hoverEl); }
      function sc2() { secCiz(); hover(lx, ly); }   // sayfa kaydıkça kutuları tazele
      function pk(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); geriDon(); return; }
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onayla(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); if (hoverEl && hoverEl.parentElement && hoverEl.parentElement !== document.documentElement) { hoverEl = hoverEl.parentElement; kutu(hoverEl); } return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); hover(lx, ly); return; }
      }
      window.__xWebshotMenuTemiz = function () { pkapat(); temizle(); };
      blocker.addEventListener('mousemove', mm, true); blocker.addEventListener('click', clk, true); document.addEventListener('keydown', pk, true); window.addEventListener('scroll', sc2, true);
      vazBtn.addEventListener('click', function () { geriDon(); }); okBtn2.addEventListener('click', function () { onayla(); });
      secCiz();
    }

    // yon: 'alt' = aşağı, 'ust' = yukarı. Görünenin alt/üstünü yakalayıp görsele ekler. done = zincir devamı.
    function _uzat(yon, done) {
      function bit() { if (done) { try { done(); } catch (e) {} } }
      if (_mesgul) { bit(); return; } _mesgul = true;
      var alt = (yon === 'alt'), vh = window.innerHeight, onceki = window.scrollY;
      var imgBot = imgTopPage + ih / ratioY;   // görselin alt sınırı (sayfa CSS)
      var hedef;
      if (alt) {
        if (docH() - imgBot < 3) { _mesgul = false; if (!done) bildir('Sayfanın sonuna gelindi.', true); bit(); return; }
        hedef = Math.min(imgBot, Math.max(0, docH() - vh));
      } else {
        if (imgTopPage < 3) { _mesgul = false; if (!done) bildir('Sayfanın başına gelindi.', true); bit(); return; }
        hedef = Math.max(0, imgTopPage - vh);
      }
      try { window.scrollTo(0, hedef); } catch (e) {}
      var gercek = window.scrollY;
      var yeniCss = alt ? ((gercek + vh) - imgBot) : (imgTopPage - gercek);   // eklenecek CSS yükseklik
      if (yeniCss < 2) { try { window.scrollTo(0, onceki); } catch (e) {} _mesgul = false; if (!done) bildir(alt ? 'Sayfanın sonuna gelindi.' : 'Sayfanın başına gelindi.', true); bit(); return; }
      ov.style.visibility = 'hidden';
      var _sg = _stickyGizle();   // [STICKY GİZLE] uzatma karesinde sabit navbar/footer'ı gizle -> dikişe tekrar girmesin
      requestAnimationFrame(function () { requestAnimationFrame(function () {   // gizle PAINT olsun (overlay kadraja girmesin)
        yakala(function (dataUrl) {
          _stickyGoster(_sg); ov.style.visibility = ''; try { window.scrollTo(0, onceki); } catch (e) {}
          _mesgul = false;
          if (!dataUrl) { bildir('Yakalanamadı.', true); bit(); return; }
          var im2 = new Image();
          im2.onload = function () {
            var sc = scrollbarKirp(im2), sh = sc.naturalHeight || sc.height, sw = sc.naturalWidth || sc.width;
            var pxPerCss = sh / Math.max(1, vh), yeniDev = Math.max(1, Math.round(yeniCss * pxPerCss));
            var nc = document.createElement('canvas'); nc.width = iw; nc.height = ih + yeniDev; var nx = nc.getContext('2d');
            if (alt) {
              var srcY = Math.max(0, sh - yeniDev);
              nx.drawImage(img, 0, 0, iw, ih); nx.drawImage(sc, 0, srcY, sw, yeniDev, 0, ih, iw, yeniDev);
              img = nc; ih = nc.height; _uzatildi = true; _olcekle(); blurGuncelle(); ciz();
            } else {
              nx.drawImage(sc, 0, 0, sw, yeniDev, 0, 0, iw, yeniDev); nx.drawImage(img, 0, yeniDev, iw, ih);
              imgTopPage -= yeniCss; crop.y += yeniDev;
              if (drag) { if (drag.o) drag.o.y += yeniDev; if (typeof drag.sy === 'number') drag.sy += yeniDev; }
              var eskiScroll = sar.scrollTop; img = nc; ih = nc.height; _uzatildi = true; _olcekle(); blurGuncelle(); ciz();
              try { sar.scrollTop = eskiScroll + S(yeniDev); } catch (e) {}   // görünümü sabit tut (üste eklenince aşağı kaydır)
            }
            bit();
          };
          im2.onerror = function () { bit(); }; im2.src = dataUrl;
        }, true);
      }); });
    }
    // TEK buton, TEK işlem: hem üstü hem altı bir ekran genişletir (varsa). Önce üst, bitince alt.
    function devaminiAl() { var _oih = ih; _uzat('ust', function () { _uzat('alt', function () { if (ih === _oih) bildir('Sayfanın tamamı alındı.', true); }); }); }

    function uygula() {
      if (!crop || crop.w < 2 || crop.h < 2) { bildir('Kırpma alanı çok küçük.', true); return; }
      var oc = document.createElement('canvas'); oc.width = Math.round(crop.w); oc.height = Math.round(crop.h);
      try { oc.getContext('2d').drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, oc.width, oc.height); } catch (e) { bildir('Kırpma hatası.', true); return; }
      var out; try { out = oc.toDataURL('image/png'); } catch (e) { bildir('Görsel üretilemedi.', true); return; }
      var panoVar = false;
      try { if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) { panoVar = true; var bp = new Promise(function (res) { try { oc.toBlob(function (b) { res(b); }, 'image/png'); } catch (e) { res(null); } }); navigator.clipboard.write([new ClipboardItem({ 'image/png': bp })]).catch(function () {}); } } catch (e) { panoVar = false; }
      // [WEBSHOT ÇOKLU-GÖRSEL] Aynı sayfadan (aynı başlık+link) birden çok SS alınabilsin diye her
      // yakalamaya BENZERSİZ kimlik linki ver: xmanual://ws-<uid>?u=<gerçek sayfa URL'si>. Böylece
      //  - havuz/IndexedDB anahtarı (normalize sonrası xmanual://ws-<uid>) ÇAKIŞMAZ -> 2. görsel 1.yi
      //    EZMEZ, 2.yi silmek 1.yi silmez (eski kök-neden: link=sayfa URL -> tek anahtar).
      //  - group_override='mc-ws:'+sayfaURL -> aynı sayfanın tüm SS'leri TEK bölümde toplanır (başlık=
      //    sayfa başlığı). 'mc-' = ELLE grup -> komşuluktan bağımsız TAM birleş (RT-SS deseninin aynısı).
      //  - Gerçek URL '?u=' ile linkte taşınır; x_temizle_link xmanual'ı olduğu gibi geçirir, normalize
      //    '?'yi keser (anahtar yine benzersiz), xRaporLinkGoster '?u='yi çözüp raporda GERÇEK linki gösterir.
      // Sosyal yola (widget.js, dedup:true, gerçek permalink) HİÇ dokunulmaz -> mükerrer-engeli aynen durur.
      var sayfaUrl = location.origin + location.pathname + location.search;   // hash HARİÇ temiz sayfa URL'si
      var uid = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      var link = 'xmanual://ws-' + uid + '?u=' + encodeURIComponent(sayfaUrl);
      var grup = 'mc-ws:' + sayfaUrl.toLowerCase();
      var baslik = baslikBul(); okBtn.disabled = true; okBtn.textContent = 'Ekleniyor…';
      originAl(function (org) {
        try { chrome.runtime.sendMessage({ action: 'addToPool', origin: org, title: baslik, link: link, image: out, is_profile: false, group_override: grup, dedup: false }, function (resp) { void chrome.runtime.lastError; temizle(); if (resp && resp.status === 'success') bildir('Panele eklendi' + (panoVar ? ' · panoya kopyalandı' : '') + ' ✓'); else bildir('Eklenemedi' + (resp && resp.message ? ': ' + resp.message : ''), true); }); }
        catch (e) { temizle(); bildir('Eklenemedi.', true); }
      });
    }

    canvas.addEventListener('pointerdown', pd); canvas.addEventListener('pointermove', pm); canvas.addEventListener('pointerup', pu); canvas.addEventListener('pointercancel', pu);
    document.addEventListener('keydown', kd, true);
    ov.addEventListener('wheel', function (e) { if (!sar.contains(e.target)) { try { e.preventDefault(); } catch (_) {} } }, { passive: false });
    iptalBtn.addEventListener('click', function () { temizle(); });
    okBtn.addEventListener('click', function () { uygula(); });
    ogeBtn.addEventListener('click', function () { ogeSec(); });
    devBtn.addEventListener('click', function () { devaminiAl(); });
    window.__xWebshotMenuTemiz = temizle;
    ciz();
  }
})();
