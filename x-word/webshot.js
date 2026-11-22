// ============================================================================
// [WEBSHOT 2026-11-22] Sosyal-dışı sitelerde: görünür ekranı yakala -> sayfa üstünde
// bizim macOS-vari KIRP aracımız (8 tutamaç + 3x3 ızgara + dışı buğulu/%30 + canlı WxH +
// klavye) -> kırp & okeyle -> havuza görsel (link = sayfa URL, başlık = og:title/title).
// Editördeki (app.py X_EDITOR_JS) kırp mantığının tek-görsel sade PORTU. Trusted-Types güvenli
// (innerHTML yok; createElement + textContent). FAZ 3: tek viewport (scroll-extend henüz yok).
// Popup'taki "Ekran Görüntüsü Al" bunu executeScript ile enjekte eder (idempotent).
// ============================================================================
(function () {
  if (window.__xWebshotAktif) return;   // çift-enjeksiyon guard (popup tekrar tıklanırsa)
  window.__xWebshotAktif = true;

  var DPR = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
  var KABA = false; try { KABA = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches); } catch (e) {}

  function bitir() { window.__xWebshotAktif = false; }

  function originAl(cb) {
    try { chrome.storage.local.get({ server_origin: "https://goruntux.rgmedya.tr" }, function (r) { cb((r && r.server_origin) || "https://goruntux.rgmedya.tr"); }); }
    catch (e) { cb("https://goruntux.rgmedya.tr"); }
  }
  function baslikBul() {
    try { var m = document.querySelector('meta[property="og:title"], meta[name="og:title"]'); if (m && m.content && m.content.trim()) return m.content.trim().slice(0, 200); } catch (e) {}
    try { if (document.title && document.title.trim()) return document.title.trim().slice(0, 200); } catch (e) {}
    return "";
  }
  function yakala(cb) {
    try {
      chrome.runtime.sendMessage({ action: 'captureTab' }, function (resp) {
        if (chrome.runtime.lastError || !resp || resp.status !== 'success' || !resp.dataUrl) { cb(null); return; }
        cb(resp.dataUrl);
      });
    } catch (e) { cb(null); }
  }

  // kısa, overlay-dışı bildirim (yakalama bittikten sonra)
  function bildir(msg, hata) {
    try {
      var t = document.createElement('div');
      t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;background:' + (hata ? '#b00020' : '#1d9bf0') + ';color:#fff;font:600 13px -apple-system,Segoe UI,Arial;padding:10px 16px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;';
      t.textContent = msg;
      document.documentElement.appendChild(t);
      setTimeout(function () { try { t.remove(); } catch (e) {} }, 2200);
    } catch (e) {}
  }

  // --- başlat: önce yakala (overlay GÖSTERME, yoksa captureVisibleTab onu da yakalar), sonra kırp UI ---
  yakala(function (dataUrl) {
    if (!dataUrl) { bitir(); bildir('Ekran görüntüsü alınamadı.', true); return; }
    var img = new Image();
    img.onload = function () { if (!img.naturalWidth) { bitir(); bildir('Ekran görüntüsü boş.', true); return; } kirpUIKur(img); };
    img.onerror = function () { bitir(); bildir('Görsel yüklenemedi.', true); };
    img.src = dataUrl;
  });

  // ======================= KIRP OVERLAY (editör portu) =======================
  function kirpUIKur(img) {
    var iw = img.naturalWidth, ih = img.naturalHeight;

    // ekrana sığdır
    var vw = window.innerWidth, vh = window.innerHeight;
    var padX = 24, ustH = 44, altH = 60;
    var availW = Math.max(60, vw - padX * 2), availH = Math.max(60, vh - ustH - altH);
    var scale = Math.min(availW / iw, availH / ih, 1);
    var cw = Math.max(1, Math.round(iw * scale)), ch = Math.max(1, Math.round(ih * scale));

    function S(v) { return v * scale; }
    function U(v) { return v / scale; }

    // --- DOM (Trusted-Types güvenli: createElement + textContent) ---
    var ov = document.createElement('div');
    ov.id = 'x-webshot-ov';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(10,14,20,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;';

    var ust = document.createElement('div');
    ust.style.cssText = 'display:flex;align-items:center;gap:8px;color:#e7e9ea;font-size:13px;font-weight:600;user-select:none;';
    var logo = document.createElement('span');
    logo.textContent = 'GörüntüX';
    logo.style.cssText = 'background:#1d9bf0;color:#fff;font-weight:800;padding:2px 8px;border-radius:6px;';
    var ipuc = document.createElement('span');
    ipuc.textContent = 'Kutuyu tutamaçlarla ayarla · Enter: ekle · Esc: iptal';
    ipuc.style.cssText = 'color:#8b98a5;font-weight:500;';
    ust.appendChild(logo); ust.appendChild(ipuc);

    var canvas = document.createElement('canvas');
    canvas.width = Math.round(cw * DPR); canvas.height = Math.round(ch * DPR);
    canvas.style.cssText = 'width:' + cw + 'px;height:' + ch + 'px;border-radius:4px;touch-action:none;cursor:crosshair;box-shadow:0 10px 40px rgba(0,0,0,.5);';
    var ctx = canvas.getContext('2d');

    var alt = document.createElement('div');
    alt.style.cssText = 'display:flex;align-items:center;gap:10px;';
    var iptalBtn = document.createElement('button');
    iptalBtn.textContent = '✕ İptal';
    iptalBtn.style.cssText = 'border:0;border-radius:10px;padding:10px 18px;font:600 13.5px -apple-system,Segoe UI,Arial;cursor:pointer;background:#1c2732;color:#e7e9ea;';
    var okBtn = document.createElement('button');
    okBtn.textContent = '✓ Kırp ve Ekle';
    okBtn.style.cssText = 'border:0;border-radius:10px;padding:10px 20px;font:700 13.5px -apple-system,Segoe UI,Arial;cursor:pointer;background:#1d9bf0;color:#fff;';
    alt.appendChild(iptalBtn); alt.appendChild(okBtn);

    ov.appendChild(ust); ov.appendChild(canvas); ov.appendChild(alt);
    document.documentElement.appendChild(ov);

    // --- kırp durumu (kaynak = görsel pikselleri) ---
    var crop = { x: 0, y: 0, w: iw, h: ih };   // açılış önerisi = tüm görsel
    var drag = null;

    function temizle() {
      try { document.removeEventListener('keydown', kd, true); } catch (e) {}
      try { ov.remove(); } catch (e) {}
      bitir();
    }

    function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

    function ciz() {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      var kx = S(crop.x), ky = S(crop.y), kw = S(crop.w), kh = S(crop.h);
      ctx.save();
      // dış bölge: bulanık görsel + %30 karartma (evenodd ile crop deliği)
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, cw, ch); ctx.rect(kx, ky, kw, kh); ctx.clip('evenodd');
      var bl = Math.max(3, Math.round(Math.min(cw, ch) * 0.015));
      try { ctx.filter = 'blur(' + bl + 'px)'; ctx.drawImage(img, 0, 0, cw, ch); ctx.filter = 'none'; } catch (e) {}
      ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
      // 3x3 ızgara
      if (kw > 26 && kh > 26) {
        ctx.strokeStyle = 'rgba(255,255,255,0.38)'; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(kx + kw / 3, ky); ctx.lineTo(kx + kw / 3, ky + kh); ctx.moveTo(kx + 2 * kw / 3, ky); ctx.lineTo(kx + 2 * kw / 3, ky + kh);
        ctx.moveTo(kx, ky + kh / 3); ctx.lineTo(kx + kw, ky + kh / 3); ctx.moveTo(kx, ky + 2 * kh / 3); ctx.lineTo(kx + kw, ky + 2 * kh / 3);
        ctx.stroke();
      }
      // çerçeve + köşe + kenar tutamaçları
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(kx, ky, kw, kh);
      var hs = 5; ctx.fillStyle = '#fff';
      [[crop.x, crop.y], [crop.x + crop.w, crop.y], [crop.x, crop.y + crop.h], [crop.x + crop.w, crop.y + crop.h]].forEach(function (c) { ctx.fillRect(S(c[0]) - hs, S(c[1]) - hs, hs * 2, hs * 2); });
      var bl2 = 9;
      ctx.fillRect(kx + kw / 2 - bl2, ky - 2, bl2 * 2, 4); ctx.fillRect(kx + kw / 2 - bl2, ky + kh - 2, bl2 * 2, 4);
      ctx.fillRect(kx - 2, ky + kh / 2 - bl2, 4, bl2 * 2); ctx.fillRect(kx + kw - 2, ky + kh / 2 - bl2, 4, bl2 * 2);
      // canlı WxH etiketi
      var lbl = Math.round(crop.w) + ' × ' + Math.round(crop.h);
      ctx.font = 'bold 12px -apple-system,Segoe UI,Arial'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      var tw = ctx.measureText(lbl).width, pw = tw + 14, ph = 22, lx = kx, ly = ky - 6 - ph / 2;
      if (ly - ph / 2 < 2) ly = ky + 6 + ph / 2;
      ctx.fillStyle = 'rgba(17,24,36,0.92)'; rr(ctx, lx, ly - ph / 2, pw, ph, 5); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(lbl, lx + 7, ly + 0.5);
      ctx.restore();
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
      var p = noktaSrc(e);
      if (!drag) { canvas.style.cursor = imlec(cropTut(p)); return; }
      var m = drag.mod, b = drag.o;
      if (m.tasi) { crop.x = b.x + (p.x - drag.sx); crop.y = b.y + (p.y - drag.sy); }
      else {
        var x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
        if (m.kenar) { if (m.kenar === 'w') x1 = p.x; else if (m.kenar === 'e') x2 = p.x; else if (m.kenar === 'n') y1 = p.y; else if (m.kenar === 's') y2 = p.y; }
        else {
          var movR = (m.kose.indexOf('xw') === 0), movB = (m.kose.indexOf('yh') >= 0), nx = p.x, ny = p.y;
          if (e.shiftKey && b.w > 0 && b.h > 0) {   // oran kilidi
            var ax = movR ? b.x : (b.x + b.w), ay = movB ? b.y : (b.y + b.h), ar = b.w / b.h, rw = Math.abs(nx - ax), rh = Math.abs(ny - ay), w2, h2;
            if (rw / ar >= rh) { w2 = rw; h2 = rw / ar; } else { h2 = rh; w2 = rh * ar; }
            nx = ax + (movR ? 1 : -1) * w2; ny = ay + (movB ? 1 : -1) * h2;
          }
          if (movR) x2 = nx; else x1 = nx; if (movB) y2 = ny; else y1 = ny;
        }
        crop.x = Math.min(x1, x2); crop.y = Math.min(y1, y2); crop.w = Math.abs(x2 - x1); crop.h = Math.abs(y2 - y1);
      }
      crop.x = Math.max(0, Math.min(crop.x, iw)); crop.y = Math.max(0, Math.min(crop.y, ih));
      crop.w = Math.max(1, Math.min(crop.w, iw - crop.x)); crop.h = Math.max(1, Math.min(crop.h, ih - crop.y));
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
      var link = location.href, baslik = baslikBul();
      okBtn.disabled = true; okBtn.textContent = 'Ekleniyor…';
      originAl(function (org) {
        try {
          chrome.runtime.sendMessage({ action: 'addToPool', origin: org, title: baslik, link: link, image: out, is_profile: false, group_override: '', dedup: false }, function (resp) {
            void chrome.runtime.lastError;
            temizle();
            if (resp && resp.status === 'success') bildir('Panele eklendi ✓');
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
    iptalBtn.addEventListener('click', function () { temizle(); });
    okBtn.addEventListener('click', function () { uygula(); });

    ciz();
  }
})();
