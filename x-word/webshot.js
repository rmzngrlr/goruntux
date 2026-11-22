// ============================================================================
// [WEBSHOT 2026-11-22 — MODEL A] Sosyal-dışı sitelerde: toolbar -> sağ-üst SAYDAM menü
// (GörüntüX'e Git + Ekran Görüntüsü Al). "Ekran Görüntüsü Al" -> TÜM SAYFAYI bir kez
// yakalar (scroll-stitch, tek tarama) -> KAYDIRMALI kırp arayüzü (macOS-vari: 8 tutamaç +
// 3x3 ızgara + dışı buğulu/%30 + canlı WxH + klavye). Kullanıcı tam sayfanın üstünde
// HİÇ GİT-GEL olmadan (yakalama bitti) istediği alanı seçer -> "Kırp ve Ekle" -> havuza +
// panoya (link = sayfa URL, başlık = og:title/title). Trusted-Types güvenli (createElement).
// onClicked (background) bunu executeScript ile enjekte eder; ikinci tıklama menüyü toggle kapatır.
// ============================================================================
(function () {
  // Toolbar butonuna TEKRAR basınca açık menüyü kapat (toggle). Kırp UI açıkken (menü yok) dokunma.
  if (window.__xWebshotAktif) {
    var _m0 = document.getElementById('x-webshot-menu');
    if (_m0) { try { if (window.__xWebshotMenuTemiz) window.__xWebshotMenuTemiz(); else _m0.remove(); } catch (e) {} window.__xWebshotAktif = false; }
    return;
  }
  window.__xWebshotAktif = true;

  var KABA = false; try { KABA = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches); } catch (e) {}

  function bitir() { window.__xWebshotAktif = false; }

  // [SCROLLBAR] Sayfa scrollbar'ını DOM'a DOKUNMADAN temizle: yakalanan görselin sağ/alt kenarından
  // ölçülen scrollbar kalınlığı kadar kırp (reflow/flicker yok). Overlay scrollbar / Mac'te 0 -> dokunmaz.
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

  // kısa bildirim (yakalama/kırp bitince)
  function bildir(msg, hata) {
    try {
      var t = document.createElement('div');
      t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;background:' + (hata ? '#b00020' : '#1d9bf0') + ';color:#fff;font:600 13px -apple-system,Segoe UI,Arial;padding:10px 16px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;';
      t.textContent = msg;
      document.documentElement.appendChild(t);
      setTimeout(function () { try { t.remove(); } catch (e) {} }, 2200);
    } catch (e) {}
  }

  // --- ENTRY: sayfanın sağ-üstünde SAYDAM yüzen menü (2 buton) ---
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
    bCap.addEventListener('click', function () { menuKapat(); baslatYakala(); });
    menu.appendChild(bPanel); menu.appendChild(bCap);
    document.documentElement.appendChild(menu);
    setTimeout(function () {
      try { document.addEventListener('keydown', _menuKey, true); } catch (e) {}
      try { document.addEventListener('mousedown', _menuDis, true); } catch (e) {}
    }, 0);
  }

  // =================== TAM SAYFA YAKALAMA (scroll-stitch, tek tarama) ===================
  // Menü kaldırıldıktan sonra çalışır (ekranda bizim bir şeyimiz YOK -> captureVisibleTab temiz).
  // Sayfa 0'dan dibe bir kez taranır, şeritler birleştirilir, sonra scroll geri alınır.
  function baslatYakala() {
    // NOT: yakalama sırasında ekranda HİÇBİR şeyimiz olmamalı (toast/menü dahil) -> şeritlere girer.
    // Sayfanın kendisi tarama boyunca kayar; bu zaten görsel geri bildirimdir.
    tamYakala(function (full) {
      if (!full) { bitir(); bildir('Ekran görüntüsü alınamadı.', true); return; }
      kirpUIKur(full);
    });
  }

  function tamYakala(cb) {
    var vh = window.innerHeight, Y0 = window.scrollY;
    var tamH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, vh);
    var strips = [];               // { y: scrollY(CSS), dataUrl }
    var hedef = 0, sonGercek = -1, guard = 0;
    function adim() {
      if (guard++ > 60) { bitirle(); return; }   // güvenlik: en çok 60 şerit
      try { window.scrollTo(0, hedef); } catch (e) {}
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        var gercek = window.scrollY;
        yakala(function (dataUrl) {
          if (dataUrl) strips.push({ y: gercek, dataUrl: dataUrl });
          if (gercek <= sonGercek || gercek + vh >= tamH - 1) { bitirle(); return; }   // ilerlemedi ya da dibe vardı
          sonGercek = gercek; hedef = gercek + vh; adim();
        }, true);   // fast: 800ms odak gecikmesi yok (ekranda bizim bir şeyimiz yok -> güvenli)
      }); });
    }
    function bitirle() { try { window.scrollTo(0, Y0); } catch (e) {} stitch(strips, tamH, vh, cb); }
    adim();
  }

  function stitch(strips, tamH, vh, cb) {
    if (!strips.length) { cb(null); return; }
    var imgs = [], done = 0;
    strips.forEach(function (s, i) {
      var im = new Image();
      im.onload = function () { imgs[i] = { y: s.y, c: scrollbarKirp(im) }; if (++done === strips.length) comp(); };
      im.onerror = function () { imgs[i] = null; if (++done === strips.length) comp(); };
      im.src = s.dataUrl;
    });
    function comp() {
      var v = imgs.filter(Boolean);
      if (!v.length) { cb(null); return; }
      var c0 = v[0].c, sh0 = c0.naturalHeight || c0.height, sw0 = c0.naturalWidth || c0.width;
      var ratio = sh0 / Math.max(1, vh);   // device-px / CSS-px (dikey)
      var nc = document.createElement('canvas');
      nc.width = sw0; nc.height = Math.max(sh0, Math.round(tamH * ratio));
      var nx = nc.getContext('2d');
      v.forEach(function (it) {
        var c = it.c, sh = c.naturalHeight || c.height, sw = c.naturalWidth || c.width;
        nx.drawImage(c, 0, Math.round(it.y * ratio), sw, sh);   // örtüşme üstüne yazar (aynı içerik)
      });
      cb(nc);
    }
  }

  // ======================= KAYDIRMALI KIRP ARAYÜZÜ =======================
  function kirpUIKur(img) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    var vw = window.innerWidth, vh = window.innerHeight;
    var ustH = 42, altH = 56, pad = 14;
    var ekW = Math.max(160, Math.min(vw - pad * 2, 1100));
    var scale = Math.min(ekW / iw, 8000 / ih, 1);   // genişliğe sığdır (+ çok uzun sayfa için tavan)
    var cw = Math.max(1, Math.round(iw * scale)), ch = Math.max(1, Math.round(ih * scale));
    var sarH = Math.max(80, vh - ustH - altH - pad);

    function S(v) { return v * scale; }
    function U(v) { return v / scale; }

    // --- DOM ---
    var ov = document.createElement('div');
    ov.id = 'x-webshot-ov';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(10,14,20,0.94);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;';

    var ust = document.createElement('div');
    ust.style.cssText = 'display:flex;align-items:center;gap:8px;color:#e7e9ea;font-size:13px;font-weight:600;user-select:none;';
    var logo = document.createElement('span'); logo.textContent = 'GörüntüX';
    logo.style.cssText = 'background:#1d9bf0;color:#fff;font-weight:800;padding:2px 8px;border-radius:6px;';
    var ipuc = document.createElement('span'); ipuc.textContent = 'Sürükleyerek alan seç · tekerlekle kaydır · Enter: ekle · Esc: iptal';
    ipuc.style.cssText = 'color:#8b98a5;font-weight:500;';
    ust.appendChild(logo); ust.appendChild(ipuc);

    var sar = document.createElement('div');   // kaydırma kabı (tam sayfa görseli dikey kaydırılır)
    sar.style.cssText = 'overflow:auto;max-height:' + sarH + 'px;max-width:' + Math.min(vw - pad * 2, cw) + 'px;border-radius:4px;box-shadow:0 12px 44px rgba(0,0,0,.55);background:#000;';
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;   // CSS-px backing (uzun tuvalde performans için DPR'siz)
    canvas.style.cssText = 'display:block;touch-action:none;cursor:crosshair;';
    sar.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    var alt = document.createElement('div');
    alt.style.cssText = 'display:flex;align-items:center;gap:10px;';
    var iptalBtn = document.createElement('button'); iptalBtn.textContent = '✕ İptal';
    iptalBtn.style.cssText = 'border:0;border-radius:10px;padding:10px 18px;font:600 13.5px -apple-system,Segoe UI,Arial;cursor:pointer;background:#1c2732;color:#e7e9ea;';
    var okBtn = document.createElement('button'); okBtn.textContent = '✓ Kırp ve Ekle';
    okBtn.style.cssText = 'border:0;border-radius:10px;padding:10px 20px;font:700 13.5px -apple-system,Segoe UI,Arial;cursor:pointer;background:#1d9bf0;color:#fff;';
    alt.appendChild(iptalBtn); alt.appendChild(okBtn);

    ov.appendChild(ust); ov.appendChild(sar); ov.appendChild(alt);
    document.documentElement.appendChild(ov);

    // dışı-buğu için önceden-bulanık kopya (her karede filter yerine tek sefer -> uzun tuvalde hızlı)
    var blurCv = document.createElement('canvas'); blurCv.width = cw; blurCv.height = ch;
    try {
      var bl = Math.max(3, Math.round(Math.min(cw, ch) * 0.012));
      var bctx = blurCv.getContext('2d'); bctx.filter = 'blur(' + bl + 'px)'; bctx.drawImage(img, 0, 0, cw, ch); bctx.filter = 'none';
    } catch (e) {}

    // --- kırp durumu (kaynak = görsel pikselleri) ---
    var crop = { x: 0, y: 0, w: iw, h: Math.min(ih, Math.round(iw * (vh / Math.max(1, vw)))) || ih };   // öneri = ilk ekran yüksekliği kadar
    var drag = null;

    function temizle() {
      try { document.removeEventListener('keydown', kd, true); } catch (e) {}
      try { ov.remove(); } catch (e) {}
      bitir();
    }
    function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

    function ciz() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      var kx = S(crop.x), ky = S(crop.y), kw = S(crop.w), kh = S(crop.h);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, cw, ch); ctx.rect(kx, ky, kw, kh); ctx.clip('evenodd');
      ctx.drawImage(blurCv, 0, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
      if (kw > 26 && kh > 26) {
        ctx.strokeStyle = 'rgba(255,255,255,0.38)'; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(kx + kw / 3, ky); ctx.lineTo(kx + kw / 3, ky + kh); ctx.moveTo(kx + 2 * kw / 3, ky); ctx.lineTo(kx + 2 * kw / 3, ky + kh);
        ctx.moveTo(kx, ky + kh / 3); ctx.lineTo(kx + kw, ky + kh / 3); ctx.moveTo(kx, ky + 2 * kh / 3); ctx.lineTo(kx + kw, ky + 2 * kh / 3);
        ctx.stroke();
      }
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(kx, ky, kw, kh);
      var hs = 5; ctx.fillStyle = '#fff';
      [[crop.x, crop.y], [crop.x + crop.w, crop.y], [crop.x, crop.y + crop.h], [crop.x + crop.w, crop.y + crop.h]].forEach(function (c) { ctx.fillRect(S(c[0]) - hs, S(c[1]) - hs, hs * 2, hs * 2); });
      var b2 = 9;
      ctx.fillRect(kx + kw / 2 - b2, ky - 2, b2 * 2, 4); ctx.fillRect(kx + kw / 2 - b2, ky + kh - 2, b2 * 2, 4);
      ctx.fillRect(kx - 2, ky + kh / 2 - b2, 4, b2 * 2); ctx.fillRect(kx + kw - 2, ky + kh / 2 - b2, 4, b2 * 2);
      var lbl = Math.round(crop.w) + ' × ' + Math.round(crop.h);
      ctx.font = 'bold 12px -apple-system,Segoe UI,Arial'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      var tw = ctx.measureText(lbl).width, pw = tw + 14, ph = 22, lx = kx, ly = ky - 6 - ph / 2;
      if (ly - ph / 2 < 2) ly = ky + 6 + ph / 2;
      ctx.fillStyle = 'rgba(17,24,36,0.92)'; rr(ctx, lx, ly - ph / 2, pw, ph, 5); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(lbl, lx + 7, ly + 0.5);
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
      e.preventDefault();
      var p = noktaSrc(e), ct = cropTut(p);
      if (ct) drag = { mod: ct, sx: p.x, sy: p.y, o: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } };
      else { crop = { x: p.x, y: p.y, w: 0, h: 0 }; drag = { mod: { kose: 'xw_yh' }, sx: p.x, sy: p.y, o: { x: p.x, y: p.y, w: 0, h: 0 } }; }
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      ciz();
    }
    function pm(e) {
      // [KAYDIR] kutuyu kabın alt/üst kenarına getirince tuvali LOKAL kaydır (yakalama YOK -> git-gel YOK)
      if (drag) {
        var cr = sar.getBoundingClientRect();
        if (e.clientY > cr.bottom - 26 && sar.scrollTop < sar.scrollHeight - sar.clientHeight) sar.scrollTop += 16;
        else if (e.clientY < cr.top + 26 && sar.scrollTop > 0) sar.scrollTop -= 16;
      }
      var p = noktaSrc(e);
      if (!drag) { canvas.style.cursor = imlec(cropTut(p)); return; }
      var m = drag.mod, b = drag.o;
      if (m.tasi) {
        crop.x = b.x + (p.x - drag.sx); crop.y = b.y + (p.y - drag.sy);
        crop.x = Math.max(0, Math.min(crop.x, Math.max(0, iw - crop.w)));
        crop.y = Math.max(0, Math.min(crop.y, Math.max(0, ih - crop.h)));
      } else {
        var x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
        if (m.kenar) { if (m.kenar === 'w') x1 = p.x; else if (m.kenar === 'e') x2 = p.x; else if (m.kenar === 'n') y1 = p.y; else if (m.kenar === 's') y2 = p.y; }
        else {
          var movR = (m.kose.indexOf('xw') === 0), movB = (m.kose.indexOf('yh') >= 0), nx = p.x, ny = p.y;
          if (e.shiftKey && b.w > 0 && b.h > 0) {
            var ax = movR ? b.x : (b.x + b.w), ay = movB ? b.y : (b.y + b.h), ar = b.w / b.h, rw = Math.abs(nx - ax), rh = Math.abs(ny - ay), w2, h2;
            if (rw / ar >= rh) { w2 = rw; h2 = rw / ar; } else { h2 = rh; w2 = rh * ar; }
            nx = ax + (movR ? 1 : -1) * w2; ny = ay + (movB ? 1 : -1) * h2;
          }
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

    function uygula() {
      if (!crop || crop.w < 2 || crop.h < 2) { bildir('Kırpma alanı çok küçük.', true); return; }
      var oc = document.createElement('canvas');
      oc.width = Math.round(crop.w); oc.height = Math.round(crop.h);
      try { oc.getContext('2d').drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, oc.width, oc.height); }
      catch (e) { bildir('Kırpma hatası.', true); return; }
      var out;
      try { out = oc.toDataURL('image/png'); } catch (e) { bildir('Görsel üretilemedi.', true); return; }
      var panoVar = false;
      try {
        if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
          panoVar = true;
          var blobP = new Promise(function (res) { try { oc.toBlob(function (b) { res(b); }, 'image/png'); } catch (e) { res(null); } });
          navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })]).catch(function () {});
        }
      } catch (e) { panoVar = false; }
      var link = location.href, baslik = baslikBul();
      okBtn.disabled = true; okBtn.textContent = 'Ekleniyor…';
      originAl(function (org) {
        try {
          chrome.runtime.sendMessage({ action: 'addToPool', origin: org, title: baslik, link: link, image: out, is_profile: false, group_override: '', dedup: false }, function (resp) {
            void chrome.runtime.lastError;
            temizle();
            if (resp && resp.status === 'success') bildir('Panele eklendi' + (panoVar ? ' · panoya kopyalandı' : '') + ' ✓');
            else bildir('Eklenemedi' + (resp && resp.message ? ': ' + resp.message : ''), true);
          });
        } catch (e) { temizle(); bildir('Eklenemedi.', true); }
      });
    }

    canvas.addEventListener('pointerdown', pd);
    canvas.addEventListener('pointermove', pm);
    canvas.addEventListener('pointerup', pu);
    canvas.addEventListener('pointercancel', pu);
    document.addEventListener('keydown', kd, true);
    ov.addEventListener('wheel', function (e) { if (!sar.contains(e.target)) { try { e.preventDefault(); } catch (_) {} } }, { passive: false });   // ov boşluğunda sayfa kaymasın
    iptalBtn.addEventListener('click', function () { temizle(); });
    okBtn.addEventListener('click', function () { uygula(); });

    ciz();
  }
})();
