(function() {
    // Prevent duplicate execution on the same URL
    if (window.xRaporLastUrl === window.location.href) {
        console.log("X Rapor: Bu URL için betik zaten çalışıyor, tekrar yükleme atlanıyor.");
        return;
    }
    window.xRaporLastUrl = window.location.href;

    function normalizeUrl(url) {
        if (!url) return "";
        let clean = url.split('?')[0].toLowerCase().trim();
        clean = clean.replace('://twitter.com', '://x.com');
        // Instagram embed URL'si ile normal URL'yi aynı kabul et.
        // Embed URL'si sonu slash'lı gelebildiği için ('/embed/'), slash'lı da slash'sız da eşleştir.
        clean = clean.replace(/\/embed\/?$/, '');
        if (clean.endsWith('/')) {
            clean = clean.slice(0, -1);
        }
        return clean;
    }

    function logToServer(message) {
        chrome.runtime.sendMessage({ action: "logToServer", message: `[WIDGET] ${message}` }).catch(err => {});
    }

    function baslat() {
        if (!document.body) {
            setTimeout(baslat, 50);
            return;
        }

        try {
            // 1. Clean up old widget if exists
            const eskiWidget = document.getElementById('x-downloader-widget'); 
            if (eskiWidget) { eskiWidget.remove(); } 

            // Inject widget style if not already present
            let styleEl = document.getElementById('x-rapor-widget-style');
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = 'x-rapor-widget-style';
                styleEl.textContent = `
                    #x-downloader-widget {
                        --w-bg: #15202b;
                        --w-text: #ffffff;
                        --w-text-muted: #8899a6;
                        --w-border: #38444d;
                        --w-card-bg: #192734;
                        --w-shadow: rgba(255, 255, 255, 0.15);
                    }
                    #x-downloader-widget.light-theme {
                        --w-bg: #ffffff;
                        --w-text: #0f1419;
                        --w-text-muted: #536471;
                        --w-border: #eff3f4;
                        --w-card-bg: #f7f9fa;
                        --w-shadow: rgba(0, 0, 0, 0.1);
                    }
                `;
                document.head.appendChild(styleEl);
            }

            // 2. Create new widget element
            const widget = document.createElement('div'); 
            widget.id = 'x-downloader-widget'; 
            widget.style.cssText = `
                position: fixed; top: 100px; right: 20px; width: 290px;
                background-color: var(--w-bg); color: var(--w-text); border: 1px solid var(--w-border);
                border-radius: 16px; box-shadow: 0 4px 24px var(--w-shadow);
                z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                padding: 14px; user-select: none; box-sizing: border-box;
            `; 

            // Load theme
            chrome.storage.local.get({ lightTheme: false }, (result) => {
                widget.classList.toggle('light-theme', result.lightTheme);
            });

            if (window.xRaporThemeListener) {
                chrome.storage.onChanged.removeListener(window.xRaporThemeListener);
            }
            window.xRaporThemeListener = (changes, areaName) => {
                if (areaName === 'local' && changes.hasOwnProperty('lightTheme')) {
                    const widgetEl = document.getElementById('x-downloader-widget');
                    if (widgetEl) {
                        widgetEl.classList.toggle('light-theme', changes.lightTheme.newValue);
                    }
                }
            };
            chrome.storage.onChanged.addListener(window.xRaporThemeListener);

            const baslik = document.createElement('div'); 
            baslik.style.cssText = `
                font-weight: bold; font-size: 13px; border-bottom: 1px solid var(--w-border);
                padding-bottom: 8px; margin-bottom: 12px; cursor: move;
                display: flex; justify-content: space-between; align-items: center;
            `; 
            const baslikText = document.createElement('span'); 
            baslikText.innerText = "GörüntüX";
            baslik.appendChild(baslikText); 

            const kapatButon = document.createElement('span'); 
            kapatButon.innerText = "✕"; 
            kapatButon.style.cssText = `cursor: pointer; color: var(--w-text-muted); font-weight: bold; padding: 2px 6px;`; 
            kapatButon.onclick = () => widget.style.display = 'none'; 
            baslik.appendChild(kapatButon); 
            widget.appendChild(baslik); 

            const tivitBilgiKutusu = document.createElement('div');
            tivitBilgiKutusu.id = 'w-tivit-bilgi';
            tivitBilgiKutusu.style.cssText = `
                font-size: 11px; background: var(--w-card-bg); border: 1px solid var(--w-border); 
                padding: 8px; border-radius: 8px; margin-bottom: 12px; color: var(--w-text);
                display: none; word-break: break-word; line-height: 1.4;
            `;
            widget.appendChild(tivitBilgiKutusu);

            const progressBox = document.createElement('div');
            progressBox.id = 'w-progress-box';
            progressBox.style.cssText = `
                font-size: 11px; background: var(--w-card-bg); border: 1px solid var(--w-border); 
                padding: 10px; border-radius: 8px; margin-bottom: 12px; color: var(--w-text);
                display: none; flex-direction: column; gap: 6px; line-height: 1.4;
            `;
            progressBox.innerHTML = `
                <div style="display:flex; justify-content:space-between; font-weight: 500;">
                    <span>Tarama İlerlemesi:</span>
                    <span id="w-progress-counter" style="font-weight:bold; color:var(--w-text);">0 / 0</span>
                </div>
                <div style="display:flex; justify-content:space-between; font-weight: 500;">
                    <span>Geçen Süre:</span>
                    <span id="w-progress-timer" style="font-weight:bold; color:var(--w-text);">⏱ 00:00</span>
                </div>
                <div style="width:100%; height:6px; background:var(--w-border); border-radius:3px; overflow:hidden; margin-top:2px;">
                    <div id="w-progress-bar-fill" style="width:0%; height:100%; background:#1d9bf0; transition:width 0.3s;"></div>
                </div>
            `;
            widget.appendChild(progressBox);

            const durumText = document.createElement('div'); 
            durumText.id = 'w-durum'; 
            durumText.style.cssText = `font-size: 12px; color: var(--w-text-muted); margin-bottom: 14px; line-height: 1.5;`; 
            widget.appendChild(durumText); 

            const buton = document.createElement('button'); 
            buton.id = 'w-buton'; 
            buton.style.cssText = `
                width: 100%; color: #fff; border: none; padding: 11px; font-weight: bold; 
                font-size: 13px; border-radius: 99px; cursor: pointer; transition: background 0.2s; box-sizing: border-box;
            `; 
            widget.appendChild(buton); 
            document.body.appendChild(widget); 

            function cropScreenshot(dataUrl, rect) {
                return new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => {
                        try {
                            const canvas = document.createElement('canvas');
                            const dpr = window.devicePixelRatio || 1;
                            
                            const cropX = Math.round(rect.left * dpr);
                            const cropY = Math.round(rect.top  * dpr);
                            const cropW = Math.round(rect.width  * dpr);
                            const cropH = Math.round(rect.height * dpr);
                            
                            if (cropW <= 0 || cropH <= 0) {
                                printLog("cropScreenshot: Geçersiz kırpma boyutu, orijinal alınıyor.");
                                resolve(dataUrl);
                                return;
                            }
                            
                            canvas.width  = cropW;
                            canvas.height = cropH;
                            
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
                            
                            let croppedDataUrl = "";
                            try {
                                croppedDataUrl = canvas.toDataURL('image/png');
                            } catch (secErr) {
                                // Canvas kirletilmiş (tainted) — orijinali kullan
                                printLog("cropScreenshot: Canvas SecurityError, orijinal görsel kullanılıyor: " + secErr.message);
                                resolve(dataUrl);
                                return;
                            }
                            
                            // Boş/hatalı veri kontrolü
                            if (!croppedDataUrl || croppedDataUrl.length < 1000) {
                                printLog("cropScreenshot: Kırpılmış görsel çok küçük, orijinal alınıyor.");
                                resolve(dataUrl);
                                return;
                            }
                            
                            printLog(`cropScreenshot: Başarılı — ${cropW}x${cropH}px @ DPR=${dpr}`);
                            resolve(croppedDataUrl);
                        } catch (e) {
                            printLog("cropScreenshot genel hata: " + e.message);
                            reject(e);
                        }
                    };
                    img.onerror = (err) => {
                        printLog("cropScreenshot: Görsel yüklenemedi.");
                        reject(new Error("Görsel yüklenemedi"));
                    };
                    img.src = dataUrl;
                });
            }

            function stitchScreenshots(dataUrl1, dataUrl2, rect1, actualScrollDelta, dpr) {
                return new Promise((resolve, reject) => {
                    const img1 = new Image();
                    const img2 = new Image();
                    let loadedCount = 0;
                    
                    function checkLoaded() {
                        loadedCount++;
                        if (loadedCount === 2) {
                            try {
                                const canvas = document.createElement('canvas');
                                const ctx = canvas.getContext('2d');
                                
                                const cropX = Math.round(rect1.left * dpr);
                                const cropW = Math.round(rect1.width * dpr);
                                const canvasH = Math.round(rect1.height * dpr);
                                
                                canvas.width = cropW;
                                canvas.height = canvasH;
                                
                                // Draw Screenshot 1 (Top part)
                                const vHPhys = Math.round(window.innerHeight * dpr);
                                const cropY1 = Math.round(Math.max(0, rect1.top) * dpr);
                                const drawHeight1 = Math.min(canvasH, vHPhys - cropY1);
                                ctx.drawImage(img1, cropX, cropY1, cropW, drawHeight1, 0, 0, cropW, drawHeight1);
                                
                                // Draw Screenshot 2 (Bottom part)
                                const remainingHeight = canvasH - drawHeight1;
                                if (remainingHeight > 0) {
                                    const cropY2_CSS = (rect1.top - actualScrollDelta) + (drawHeight1 / dpr);
                                    const cropY2 = Math.round(cropY2_CSS * dpr);
                                    ctx.drawImage(img2, cropX, Math.max(0, cropY2), cropW, remainingHeight, 0, drawHeight1, cropW, remainingHeight);
                                }
                                
                                resolve(canvas.toDataURL('image/png'));
                            } catch (e) {
                                printLog("Stitch canvas hatası: " + e.message);
                                resolve(dataUrl1); // hata durumunda ilkini döndür
                            }
                        }
                    }
                    
                    img1.onload = checkLoaded;
                    img1.onerror = () => {
                        printLog("Stitch: Image 1 yüklenemedi.");
                        resolve(dataUrl1);
                    };
                    img1.src = dataUrl1;
                    
                    img2.onload = checkLoaded;
                    img2.onerror = () => {
                        printLog("Stitch: Image 2 yüklenemedi.");
                        resolve(dataUrl1);
                    };
                    img2.src = dataUrl2;
                });
            }

            // Birden fazla ekran görüntüsünü dikey olarak birleştirir (herhangi bir sayıda parça)
            function stitchMultipleScreenshots(dataUrls, rect, vH, dpr) {
                return new Promise((resolve) => {
                    // Tek-çözüm koruması + zaman aşımı: bir görsel ne onload ne onerror tetiklemezse
                    // (bozuk/boş dataURL) promise asla çözülmez ve tarama "birleştiriliyor"da DONAR.
                    // 8 sn içinde bitmezse eldeki ilk görselle devam et (donma yerine kısmi sonuç).
                    let settled = false;
                    const done = (val) => { if (settled) return; settled = true; clearTimeout(stitchTimer); resolve(val); };
                    const stitchTimer = setTimeout(() => {
                        printLog("Birleştirme zaman aşımı, ilk görselle devam ediliyor.");
                        done(dataUrls[0]);
                    }, 8000);

                    const imgs = dataUrls.map(() => new Image());
                    let loaded = 0;

                    const onLoaded = () => {
                        loaded++;
                        if (loaded < imgs.length) return;
                        try {
                            const canvas = document.createElement('canvas');
                            const ctx = canvas.getContext('2d');

                            const cX       = Math.round(rect.left   * dpr);
                            const cW       = Math.round(rect.width  * dpr);
                            const cH       = Math.round(rect.height * dpr);
                            const vHPhys   = Math.round(vH          * dpr);
                            const startYPh = Math.round(Math.max(0, rect.top) * dpr);

                            canvas.width  = cW;
                            canvas.height = cH;

                            // İlk ekran görüntüsü: tweet tepesinden (rect.top) viewport sonuna kadar
                            const h1 = Math.min(cH, vHPhys - startYPh);
                            if (h1 > 0) {
                                ctx.drawImage(imgs[0], cX, startYPh, cW, h1, 0, 0, cW, h1);
                            }

                            // Sonraki ekran görüntüleri: her biri viewport'un y=0'dan başlayan tam dolu karede
                            let canvasY = h1;
                            for (let i = 1; i < imgs.length; i++) {
                                const remaining = cH - canvasY;
                                if (remaining <= 0) break;
                                const h = Math.min(vHPhys, remaining);
                                ctx.drawImage(imgs[i], cX, 0, cW, h, 0, canvasY, cW, h);
                                canvasY += h;
                            }

                            done(canvas.toDataURL('image/png'));
                        } catch (e) {
                            printLog("Coklu stitch hatasi: " + e.message);
                            done(dataUrls[0]);
                        }
                    };

                    imgs.forEach((img, i) => {
                        img.onload  = onLoaded;
                        img.onerror = () => done(dataUrls[0]);
                        img.src     = dataUrls[i];
                    });
                });
            }

            // Faz IG-1: Instagram no-zoom capture icin dikey parca birlestirme.
            // Her parca viewport-tepesine hizali cekildiginden (fixed elementi yukari kaydirarak),
            // parcalar basitce ust uste eklenir (dpr-olcekli boyutlarda).
            function igVerticalStitch(dataUrls) {
                return new Promise(function (resolve) {
                    var settled = false;
                    var done = function (v) { if (settled) return; settled = true; clearTimeout(t); resolve(v); };
                    var t = setTimeout(function () { done(dataUrls[0]); }, 9000);
                    var imgs = dataUrls.map(function () { return new Image(); });
                    var loaded = 0;
                    var onload = function () {
                        loaded++;
                        if (loaded < imgs.length) return;
                        try {
                            var W = imgs[0].naturalWidth;
                            var totalH = 0, i;
                            for (i = 0; i < imgs.length; i++) totalH += imgs[i].naturalHeight;
                            var canvas = document.createElement('canvas');
                            canvas.width = W; canvas.height = totalH;
                            var ctx = canvas.getContext('2d');
                            var y = 0;
                            for (i = 0; i < imgs.length; i++) { ctx.drawImage(imgs[i], 0, y); y += imgs[i].naturalHeight; }
                            done(canvas.toDataURL('image/png'));
                        } catch (e) { done(dataUrls[0]); }
                    };
                    imgs.forEach(function (img, i) { img.onload = onload; img.onerror = function () { done(dataUrls[0]); }; img.src = dataUrls[i]; });
                });
            }

            // Faz IG-1: Instagram gonderi kartini (media iceren article) guvenilir sec.
            // 'main article' bazen yanlis/tam-genislik element donduruyordu; medyayi iceren article'i tercih et.
            function igFindPost() {
                try {
                    // 1) En büyük medyayı (video/img) bul.
                    var media = null, best = 0;
                    document.querySelectorAll('video, img').forEach(function (m) {
                        var r = m.getBoundingClientRect(); var a = r.width * r.height;
                        if (a > best && r.width > 250 && r.height > 250) { best = a; media = m; }
                    });
                    var firstArt = document.querySelector('article');
                    if (!media) return firstArt;
                    var mediaArt = media.closest('article');
                    // 2) Post etkileşim/like butonu (her iki düzende de post kartının parçası).
                    var eng = document.querySelector('svg[aria-label*="Beğen" i], svg[aria-label*="Like" i]')
                           || document.querySelector('svg[aria-label*="Yorum" i], svg[aria-label*="Comment" i]');
                    // 3) mediaArt etkileşimi de içeriyorsa (TEK sütun) -> article yeterli (medya+açıklama içinde).
                    if (mediaArt && eng && mediaArt.contains(eng)) return mediaArt;
                    // 4) Aksi halde (İKİ sütun: medya ile açıklama/etkileşim ayrı) media + eng ORTAK atası = post kartı (iki sütun).
                    if (eng) {
                        var chain = []; var n = media; while (n) { chain.push(n); n = n.parentElement; }
                        var setM = new Set(chain);
                        var c = eng; while (c) { if (setM.has(c)) return c; c = c.parentElement; }
                    }
                    return mediaArt || firstArt;
                } catch (e) { return document.querySelector('article'); }
            }

            // Görselleri data: URL formatına çevir (Blob'ları yerel, haricileri background ile okur, CSS background-image'leri de kapsar)
            async function prefetchImages(element) {
                const imgs = Array.from(element.querySelectorAll('img'));
                const svgImgs = Array.from(element.querySelectorAll('image')); // SVG <image>
                
                // background-image'e sahip tüm elemanları bul
                const bgImgEls = Array.from(element.querySelectorAll('*')).filter(el => {
                    try {
                        const bg = window.getComputedStyle(el).backgroundImage;
                        return bg && bg !== 'none' && bg.includes('url(');
                    } catch(e) { return false; }
                });

                async function fetchAndReplace(el, attrName, isCssBg = false) {
                    let src = "";
                    if (isCssBg) {
                        const bg = window.getComputedStyle(el).backgroundImage;
                        const match = bg.match(/url\((['"]?)(.*?)\1\)/);
                        if (match && match[2]) src = match[2];
                    } else {
                        src = el.getAttribute(attrName);
                    }

                    if (!src || src.startsWith('data:')) return;
                    try {
                        let dataUrl = "";
                        if (src.startsWith('blob:')) {
                            const res = await fetch(src);
                            const blob = await res.blob();
                            dataUrl = await new Promise(resolve => {
                                const reader = new FileReader();
                                reader.onload = () => resolve(reader.result);
                                reader.readAsDataURL(blob);
                            });
                        } else {
                            const response = await new Promise(resolve => {
                                chrome.runtime.sendMessage({ action: "fetchImageAsDataUrl", url: src }, resolve);
                            });
                            if (response && response.status === "success" && response.dataUrl) {
                                dataUrl = response.dataUrl;
                            }
                        }

                        if (dataUrl) {
                            if (isCssBg) {
                                el.setAttribute('data-orig-bg', el.style.backgroundImage || 'none');
                                el.style.backgroundImage = `url("${dataUrl}")`;
                            } else {
                                el.setAttribute('data-orig-' + attrName, src);
                                el.removeAttribute('crossorigin');
                                
                                const srcset = el.getAttribute('srcset');
                                if (srcset) {
                                    el.setAttribute('data-orig-srcset', srcset);
                                    el.removeAttribute('srcset');
                                }
                                
                                await new Promise(resolve => {
                                    el.onload  = resolve;
                                    el.onerror = resolve;
                                    el.setAttribute(attrName, dataUrl);
                                    setTimeout(resolve, 300);
                                });
                            }
                        }
                    } catch (e) {
                        printLog("Görsel prefetch hatası: " + e.message);
                    }
                }

                await Promise.all([
                    ...imgs.map(img => fetchAndReplace(img, 'src')),
                    ...svgImgs.map(img => fetchAndReplace(img, 'href') || fetchAndReplace(img, 'xlink:href')),
                    ...bgImgEls.map(el => fetchAndReplace(el, null, true))
                ]);
            }

            // Orijinal src değerlerini geri yükle
            function restoreImages(element) {
                element.querySelectorAll('[data-orig-src]').forEach(el => {
                    el.src = el.getAttribute('data-orig-src');
                    el.removeAttribute('data-orig-src');
                    
                    const origSrcset = el.getAttribute('data-orig-srcset');
                    if (origSrcset) {
                        el.setAttribute('srcset', origSrcset);
                        el.removeAttribute('data-orig-srcset');
                    }
                });
                element.querySelectorAll('[data-orig-href]').forEach(el => {
                    el.setAttribute('href', el.getAttribute('data-orig-href'));
                    el.removeAttribute('data-orig-href');
                });
                element.querySelectorAll('[data-orig-bg]').forEach(el => {
                    const origBg = el.getAttribute('data-orig-bg');
                    if (origBg === 'none') {
                        el.style.backgroundImage = '';
                    } else {
                        el.style.backgroundImage = origBg;
                    }
                    el.removeAttribute('data-orig-bg');
                });
            }

            // Client-side screenshot compressor (converts transparent/colored PNG to JPEG and scales down)
            function compressScreenshot(dataUrl, maxWidth = 900, quality = 0.85) {
                return new Promise((resolve) => {
                    // Tek-çözüm + zaman aşımı: görsel ne onload ne onerror verirse (bozuk dataURL)
                    // burada da donabiliyordu ("birleştiriliyor" ekranında asılı kalma). 8 sn'de
                    // bitmezse ham görselle devam et.
                    let settled = false;
                    const done = (v) => { if (settled) return; settled = true; clearTimeout(cmpTimer); resolve(v); };
                    const cmpTimer = setTimeout(() => { printLog("Sıkıştırma zaman aşımı, ham görselle devam."); done(dataUrl); }, 8000);
                    const img = new Image();
                    img.onload = () => {
                        try {
                            const canvas = document.createElement('canvas');
                            const ctx = canvas.getContext('2d');
                            
                            let w = img.width;
                            let h = img.height;
                            if (w > maxWidth) {
                                h = Math.round((h * maxWidth) / w);
                                w = maxWidth;
                            }
                            
                            canvas.width = w;
                            canvas.height = h;
                            
                            // Fill canvas background to avoid transparent black areas in JPEG
                            const isDark = document.body.style.backgroundColor === 'rgb(0, 0, 0)' || 
                                           document.body.style.backgroundColor === 'rgb(21, 32, 43)' ||
                                           (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
                            ctx.fillStyle = isDark ? '#15202b' : '#ffffff';
                            ctx.fillRect(0, 0, w, h);
                            
                            ctx.drawImage(img, 0, 0, w, h);
                            
                            const compressed = canvas.toDataURL('image/jpeg', quality);
                            done(compressed);
                        } catch (e) {
                            console.error("Görsel sıkıştırma hatası:", e);
                            done(dataUrl);
                        }
                    };
                    img.onerror = () => done(dataUrl);
                    img.src = dataUrl;
                });
            }

            // Tweet elementini yakala (Yerel captureVisibleTab, Scroll Spacer ve Scroll-and-Stitch entegrasyonuyla)
            // 1) Sayfadaki tüm resimlerin yüklenmesini bekle
            // 2) Tweetin tarih/saat satırından sonrasını (beğeni/rt sayıları, butonlar) gizle
            // 3) Sayfa altına geçici büyük boşluk (spacer) ekle ki tweet en üste kayabilsin
            // 4) Yapışkan (sticky/fixed) barları ve eklenti widget'ını gizle
            // 5) Tweeti en üste kaydır, Screenshot 1'i al
            // 6) Eğer tweet viewport'a sığıyorsa tek ekran görüntüsü kırp, sığmıyorsa aşağı kaydırıp Screenshot 2'yi al ve birleştir (Stitch)
            async function captureArticle(element) {
                // Disable smooth scrolling temporarily to prevent animation delays
                const disableSmoothScrollStyles = document.createElement('style');
                disableSmoothScrollStyles.innerHTML = '* { scroll-behavior: auto !important; }';
                document.head.appendChild(disableSmoothScrollStyles);

                const spacer = document.createElement('div');
                spacer.id = 'w-temp-spacer';
                spacer.style.height = '1800px';
                spacer.style.width = '100%';
                spacer.style.background = 'transparent';
                spacer.style.pointerEvents = 'none';
                document.body.appendChild(spacer);

                const stickyElements = [];
                const hiddenFooterElements = [];
                const widgetEl = document.getElementById('x-downloader-widget');
                const cbWidgetEl = document.getElementById('w-cb-container');
                let origWidgetDisplay = "";
                let origCbWidgetDisplay = "";
                let igMsgHidden = []; // Faz IG-1: no-zoom modunda gizlenen Instagram "Mesajlar" (DM) balonu
                let dateTimeRow = null;
                const isInstagram = window.location.hostname.includes('instagram.com');

                // Faz IG-1 (sade no-zoom): kırpma hedefi = TÜM post kartı (article) — solda medya + sağda
                // kullanıcı adı/açıklama/hashtag/yorum/etkileşim sütunu. Böylece açıklama da görüntüye girer.
                // (Sadece medya elementini ölçünce sağ sütun/açıklama kırpma dışında kalıyordu.)
                if (isInstagram && xWidgetIgNoZoom) {
                    const igPost = igFindPost();
                    if (igPost) element = igPost;
                }

                try {
                    if (isInstagram && !xWidgetIgNoZoom) {
                        // zoom-to-fit modunda widget gizlenir (article tam ekrana alındığından üzerine binebilir).
                        if (widgetEl) {
                            origWidgetDisplay = widgetEl.style.display;
                            widgetEl.style.display = 'none';
                        }
                        if (cbWidgetEl) {
                            origCbWidgetDisplay = cbWidgetEl.style.display;
                            cbWidgetEl.style.display = 'none';
                        }
                    } else if (isInstagram && xWidgetIgNoZoom) {
                        // Faz IG-1 (sade no-zoom): iki-sütun kırpması widget'ın üzerine binebildiğinden, widget'ı
                        // YOK ETMEDEN görünmez yap (visibility:hidden -> reflow/flaş yok), yakalama sonrası geri aç.
                        try {
                            [widgetEl, cbWidgetEl].forEach(function (w) {
                                if (w) { igMsgHidden.push({ el: w, v: w.style.visibility }); w.style.setProperty('visibility', 'hidden', 'important'); }
                            });
                        } catch (e) {}
                        // Instagram "Mesajlar" (DM) balonunu gizle (sağ-altta sabit, içeriğe binebilir).
                        try {
                            let anchor = document.querySelector('svg[aria-label="Mesajlar"], svg[aria-label="Messages"], svg[aria-label*="Mesaj" i], svg[aria-label*="Message" i]');
                            if (!anchor) {
                                const cand = Array.from(document.querySelectorAll('div,span'));
                                for (const e of cand) {
                                    const t = (e.textContent || '').trim().toLowerCase();
                                    const rr = e.getBoundingClientRect();
                                    if ((t === 'mesajlar' || t === 'messages') && rr.top > window.innerHeight * 0.5 && rr.left > window.innerWidth * 0.4) { anchor = e; break; }
                                }
                            }
                            if (anchor) {
                                let node = anchor, target = null;
                                for (let i = 0; i < 8 && node && node !== document.body; i++) {
                                    const cs = window.getComputedStyle(node);
                                    if (cs.position === 'fixed' || cs.position === 'absolute') target = node;
                                    node = node.parentElement;
                                }
                                target = target || anchor;
                                igMsgHidden.push({ el: target, v: target.style.visibility });
                                target.style.setProperty('visibility', 'hidden', 'important');
                                printLog("[Instagram] Mesajlar balonu gizlendi.");
                            }
                        } catch (e) {}
                        // Giriş-yapmış hesabın profil resmini (post altındaki "Yorum ekle..." kutusu avatarı) gizle.
                        // Yalnızca yorum-yazma satırındaki KÜÇÜK avatarı hedefler; post sahibinin/yorumcuların avatarına dokunmaz.
                        try {
                            const igp = igFindPost();
                            const form = igp ? igp.querySelector('form') : null;
                            if (form) {
                                let row = form.parentElement;
                                for (let i = 0; i < 4 && row && row !== igp; i++) {
                                    if (row.getBoundingClientRect().height < 120) break;
                                    row = row.parentElement;
                                }
                                (row || form).querySelectorAll('img, canvas').forEach(function (el) {
                                    const rr = el.getBoundingClientRect();
                                    if (rr.width > 0 && rr.width < 60 && rr.height < 60) {
                                        igMsgHidden.push({ el: el, v: el.style.visibility });
                                        el.style.setProperty('visibility', 'hidden', 'important');
                                        printLog("[Instagram] Yorum kutusu avatarı gizlendi.");
                                    }
                                });
                            }
                        } catch (e) {}
                    }
                    // Tüm img'lerin yüklenmesini bekle (max 3s)
                    const imgs = Array.from(element.querySelectorAll('img'));
                    await Promise.all(imgs.map(img =>
                        img.complete ? Promise.resolve() :
                        new Promise(resolve => {
                            img.onload  = resolve;
                            img.onerror = resolve;
                            setTimeout(resolve, 3000);
                        })
                    ));

                    // A. Tweet alt kısmını (beğeni, rt sayıları ve etkileşim butonları) bul ve gizle
                    const timeEl = element.querySelector('time');
                    if (timeEl) {
                        let contentColumn = timeEl.parentElement;
                        while (contentColumn && contentColumn !== element) {
                            if (contentColumn.querySelector('[role="group"]')) {
                                break;
                            }
                            contentColumn = contentColumn.parentElement;
                        }
                        
                        if (contentColumn) {
                            dateTimeRow = timeEl;
                            while (dateTimeRow && dateTimeRow.parentElement !== contentColumn) {
                                dateTimeRow = dateTimeRow.parentElement;
                            }
                            
                            if (dateTimeRow) {
                                let next = dateTimeRow.nextElementSibling;
                                while (next) {
                                    hiddenFooterElements.push({ el: next, origDisplay: next.style.display });
                                    next.style.display = 'none';
                                    next = next.nextElementSibling;
                                }
                            }
                        }
                    }

                    // C. Viewport tepesindeki tüm sticky/fixed elemanları bul ve gizle
                    if (isInstagram) {
                        // Instagram: Sayfadaki TÜM yapışkan (fixed/sticky) elemanları bul ve gizle
                        document.querySelectorAll('*').forEach(el => {
                            try {
                                if (element && (el === element || element.contains(el))) {
                                    return;
                                }
                                if (widgetEl && (el === widgetEl || widgetEl.contains(el))) {
                                    return;
                                }
                                if (cbWidgetEl && (el === cbWidgetEl || cbWidgetEl.contains(el))) {
                                    return;
                                }
                                
                                const style = window.getComputedStyle(el);
                                if (style.position === 'fixed' || style.position === 'sticky') {
                                    stickyElements.push({ el, origDisplay: el.style.display });
                                    el.style.display = 'none';
                                }
                            } catch(e){}
                        });
                    } else {
                        // Twitter/X: Sadece viewport tepesindeki küçük sticky/fixed elemanları (üst bar vb.) gizle
                        document.querySelectorAll('*').forEach(el => {
                            try {
                                const style = window.getComputedStyle(el);
                                if (style.position === 'fixed' || style.position === 'sticky') {
                                    const rect = el.getBoundingClientRect();
                                    if (rect.top <= 15 && rect.bottom > 0 && el.offsetHeight < 100) {
                                        stickyElements.push({ el, origDisplay: el.style.display });
                                        el.style.display = 'none';
                                    }
                                }
                            } catch(e){}
                        });
                    }

                    const vH = window.innerHeight;
                    const vW = window.innerWidth;
                    const dpr = window.devicePixelRatio || 1;

                    // === Faz IG-1: SADE no-zoom Instagram yakalama (izolasyon/zoom YOK) ===
                    // Tüm post kartını (article = header + medya + AÇIKLAMA + etkileşim) window-scroll ile
                    // parça parça yakalayıp dikey birleştirir. Mesajlar balonu yukarıda gizlendi; widget'a
                    // dokunulmaz (kırpma bölgesi zaten dışarıda bırakır). article'ın tamamı alındığından açıklama da girer.
                    if (isInstagram && xWidgetIgNoZoom) {
                        try {
                            const post = igFindPost() || element;
                            // Tepeye çık ve article'ın MUTLAK sayfa konumunu al (video/yerleşme payı için kısa bekle).
                            window.scrollTo(0, 0);
                            await new Promise(r => setTimeout(r, 250));
                            const pRect0 = post.getBoundingClientRect();
                            const startY = (window.scrollY || document.documentElement.scrollTop || 0) + pRect0.top;
                            const cropLeft = Math.max(0, Math.round(pRect0.left));
                            const cropWidth = Math.round(Math.min(vW - cropLeft, pRect0.width));
                            const fullH = Math.round(pRect0.height);
                            // Kaydırmanın article SONUNA (açıklamaya) ulaşabilmesi için bol spacer.
                            spacer.style.height = (Math.ceil(fullH) + vH * 2 + 400) + 'px';
                            const segs = [];
                            let y = 0, guard = 0;
                            while (y < fullH && guard < 40) {
                                guard++;
                                // article'ın [y .. y+vH] dilimini MUTLAK konumla viewport tepesine getir (delta-break YOK).
                                window.scrollTo(0, Math.max(0, Math.round(startY + y)));
                                await new Promise(r => setTimeout(r, 200));
                                const sliceH = Math.round(Math.min(vH, fullH - y));
                                if (sliceH <= 2) break;
                                const segRes = await new Promise(resolve => {
                                    swSendReliable({ action: "captureAndCrop", rect: { top: 0, left: cropLeft, width: cropWidth, height: sliceH }, dpr: dpr }, resolve);
                                });
                                if (!segRes || segRes.status !== "success" || !segRes.dataUrl) break;
                                segs.push(segRes.dataUrl);
                                y += sliceH;
                            }
                            printLog(`[Instagram] Sade no-zoom: ${segs.length} parça (${Math.round(cropWidth)}x${fullH}).`);
                            if (segs.length > 0) {
                                const igRaw = (segs.length === 1) ? segs[0] : await igVerticalStitch(segs);
                                return await compressScreenshot(igRaw);
                            }
                            printLog("[Instagram] Sade no-zoom parça alınamadı, eski yola dönülüyor.");
                        } catch (e) {
                            printLog("[Instagram] Sade no-zoom hata: " + (e.message || e));
                        }
                    }

                    // E. Tweeti viewport tepesine hizala (spacer sayesinde bu işlem her zaman başarılı olur)
                    element.scrollIntoView({ block: 'start', behavior: 'instant' });
                    
                    if (isInstagram) {
                        // Instagram: Kart yüksekliği ekran boyundan büyükse sığması için dinamik olarak küçült (zoom out)
                        // Faz IG-1: no-zoom modunda KÜÇÜLTME yok — X gibi kaydır+birleştir yapılır.
                        const originalZoom = element.style.zoom;
                        const rectBeforeZoom = element.getBoundingClientRect();
                        if (!xWidgetIgNoZoom && rectBeforeZoom.height > vH - 30) {
                            const igZoom = (vH - 30) / rectBeforeZoom.height;
                            stickyElements.push({ el: element, origZoom: originalZoom });
                            element.style.setProperty('zoom', igZoom, 'important');
                            // Yeniden hizala
                            element.scrollIntoView({ block: 'start', behavior: 'instant' });
                            await new Promise(r => setTimeout(r, 150));
                        }

                        // Instagram'da bazen üst sarmalayıcıların overflow stilleri kaydırmayı engeller, bunları geçici olarak düzelt
                        let parent = element.parentNode;
                        while (parent && parent !== document.body) {
                            const style = window.getComputedStyle(parent);
                            if (style.overflowY === 'hidden') {
                                stickyElements.push({ el: parent, origOverflow: parent.style.overflowY });
                                parent.style.setProperty('overflow-y', 'auto', 'important');
                            }
                            parent = parent.parentNode;
                        }
                        
                        const rectBefore = element.getBoundingClientRect();
                        if (rectBefore.top > 0) {
                            // Ana kaydırıcıyı doğrudan hedef al (Instagram standalone posts için)
                            const mainContainer = document.querySelector('main[role="main"]') ? document.querySelector('main[role="main"]').parentNode : null;
                            if (mainContainer) {
                                mainContainer.scrollTop += rectBefore.top;
                            }
                            
                            let parentScroll = element.parentNode;
                            let scrolledAny = false;
                            while (parentScroll && parentScroll !== document.body) {
                                if (parentScroll.scrollHeight > parentScroll.clientHeight) {
                                    parentScroll.scrollTop += rectBefore.top;
                                    scrolledAny = true;
                                }
                                parentScroll = parentScroll.parentNode;
                            }
                            if (!scrolledAny) {
                                window.scrollBy(0, rectBefore.top);
                                document.documentElement.scrollTop += rectBefore.top;
                                document.body.scrollTop += rectBefore.top;
                            }
                        }
                    }
                    await new Promise(r => setTimeout(r, 300)); // Kaydırma sonlanma payı
                    
                    // Tweet koordinatlarını ölç (Spacer sayesinde r.top garantili olarak 0 olacaktır)
                    const r = element.getBoundingClientRect();

                    // Gerçek içerik yüksekliğini hesapla (Profil ise takipçi satırına kadar, tivit ise zaman satırına kadar)
                    let articleHeight = r.height;
                    const isProfile = !window.location.href.includes('/status/') && (window.location.hostname.includes('x.com') || window.location.hostname.includes('twitter.com'));
                    if (isProfile) {
                        let followersLink = element.querySelector('a[href*="/verified_followers"], a[href*="/followers"], a[href*="/following"]');
                        if (!followersLink) {
                            const anchors = Array.from(element.querySelectorAll('a'));
                            followersLink = anchors.find(a => {
                                const href = (a.getAttribute('href') || '').toLowerCase();
                                return href.includes('/followers') || href.includes('/following');
                            });
                        }
                        if (followersLink) {
                            const followersRect = followersLink.getBoundingClientRect();
                            articleHeight = followersRect.bottom - r.top + 12;
                        } else {
                            articleHeight = 620; // Safe fallback height representing clean profile card
                        }
                    } else if (dateTimeRow && !window.location.hostname.includes('instagram.com')) {
                        const timeRect = dateTimeRow.getBoundingClientRect();
                        articleHeight = timeRect.bottom - r.top;
                    }
                    
                    if (window.location.hostname.includes('instagram.com')) {
                        if (xWidgetIgNoZoom) {
                            // Faz IG-1 (sade no-zoom): tam yüksekliği ölç; X yolu kaydırıp birleştirerek tamamını alır.
                            articleHeight = r.height;
                        } else {
                            // Instagram (zoom-to-fit): tek karede sığacak şekilde dikey crop.
                            articleHeight = Math.min(vH, r.height);
                        }
                    }

                    const measuredRect = {
                        top: r.top,
                        left: r.left,
                        width: r.width,
                        height: articleHeight,
                        right: r.right,
                        bottom: r.top + articleHeight
                    };

                    // Spacer'ı tweet yüksekliğine göre dinamik olarak büyüt
                    // Böylece çok uzun tweet'lerde bile kaydırma hiç durmaz
                    const requiredSpacer = Math.max(1800, Math.ceil(articleHeight) + 500);
                    spacer.style.height = requiredSpacer + 'px';

                    // F. Ekran görüntüsünü al ve kırp
                    printLog("Ekran görüntüsü alınıyor...");
                    const snapshots = [];
                    let rawResult = "";

                    if (isInstagram && !xWidgetIgNoZoom) {
                        // Instagram (zoom-to-fit): CSS izolasyon + captureVisibleTab.
                        // NOT: no-zoom modunda bu blok ATLANIR; aşağıdaki X yolu (kaydır+birleştir) kullanılır.
                        printLog("[Instagram] CSS izolasyon ile ekran görüntüsü alınıyor...");

                        const isProfilePage = !window.location.href.includes('/p/') && !window.location.href.includes('/reel/');
                        let articleEl = null;
                        if (isProfilePage) {
                            articleEl = element;
                        } else {
                            articleEl = document.querySelector('.Embed');
                            if (!articleEl) {
                                const mainEl = document.querySelector('main[role="main"]') || document.querySelector('main');
                                if (mainEl && mainEl.children.length > 0) {
                                    articleEl = mainEl.children[0];
                                }
                            }
                            if (!articleEl) {
                                articleEl = document.querySelector('article');
                            }
                        }
                        if (!articleEl) {
                            const mediaEl = document.querySelector('img[style*="object-fit"], video, img');
                            if (mediaEl) {
                                let p = mediaEl.parentNode;
                                while (p && p !== document.body) {
                                    const r = p.getBoundingClientRect();
                                    if (p.tagName === 'MAIN' || p.tagName === 'BODY') break;
                                    if (r.width > 200) { articleEl = p; break; }
                                    p = p.parentNode;
                                }
                            }
                        }

                        if (!articleEl) {
                            printLog("[Instagram] article, dialog veya Embed elementi bulunamadı, null dönülüyor.");
                            return null;
                        }

                        // Geri yükleme için orijinal stilleri sakla
                        const igStyled = [];
                        function igSet(el, prop, val) {
                            igStyled.push({ el, prop, orig: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
                            el.style.setProperty(prop, val, 'important');
                        }
                        function igRestoreAll() {
                            igStyled.forEach(({ el, prop, orig, priority }) => {
                                if (orig) {
                                    el.style.setProperty(prop, orig, priority);
                                } else {
                                    el.style.removeProperty(prop);
                                }
                            });
                        }

                        try {
                            // 1. article'ın ata zincirini bul (bunlar gizlenmeyecek)
                            const ancestors = new Set();
                            let cur = articleEl;
                            while (cur && cur !== document.documentElement) {
                                ancestors.add(cur);
                                cur = cur.parentNode;
                            }

                            // 2. Her atanın kardeşlerini gizle
                            ancestors.forEach(ancestor => {
                                const parent = ancestor.parentNode;
                                if (!parent) return;
                                Array.from(parent.children).forEach(child => {
                                    if (!ancestors.has(child)) {
                                        igSet(child, 'display', 'none');
                                    }
                                });
                            });

                            // Asenkron yüklenen önerileri ve footer'ı temizleme fonksiyonu
                            function hideIgExtras() {
                                if (articleEl === document.body) return;
                                // Footer temizliği
                                document.querySelectorAll('footer, .Footer, [role="contentinfo"]').forEach(el => {
                                    if (el !== articleEl && !articleEl.contains(el)) {
                                        igSet(el, 'display', 'none');
                                    }
                                });
                                // Önerilen gönderiler başlığı ve grid temizliği (Metin tabanlı arama)
                                const textNodes = [];
                                const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                                let node;
                                while (node = walk.nextNode()) {
                                    const txt = node.nodeValue.toLowerCase();
                                    if (txt.includes('diğer gönderi') || txt.includes('more posts') || txt.includes('see more posts') || txt.includes('diğer gönderiler')) {
                                        textNodes.push(node);
                                    }
                                }
                                textNodes.forEach(node => {
                                    let p = node.parentElement;
                                    while (p && p !== document.body) {
                                        if (p.contains(articleEl)) {
                                            break;
                                        }
                                        const rect = p.getBoundingClientRect();
                                        if (rect.height > 80) {
                                            igSet(p, 'display', 'none');
                                            break;
                                        }
                                        p = p.parentNode;
                                    }
                                });
                            }

                            // İlk faz temizlik
                            hideIgExtras();

                            // Ekstra önlem: footer, h2, hr ve More Posts (Diğer Gönderiler) elemanlarını doğrudan gizle
                            const extraHides = document.querySelectorAll('footer, h2, hr, [class*="morePosts"]');
                            extraHides.forEach(el => {
                                if (el !== articleEl && !articleEl.contains(el)) {
                                    igSet(el, 'display', 'none');
                                }
                            });

                            // 3. Nokta atışı: "Yorum ekle..." (yorum yazma) satırındaki KENDİ profil resmini gizle.
                            // Gönderi görselini ve yazar avatarını KORU; yalnızca yorum-yazma satırındaki küçük avatarı gizle.
                            // "Yorum ekle..." yazısı kalır, sadece resim gider.
                            try {
                                // Yorum yazma girişini bul (placeholder / aria-label ile)
                                const commentEntry = Array.from(articleEl.querySelectorAll(
                                    'textarea, input, [contenteditable="true"], [role="textbox"]'
                                )).find(el => {
                                    const ph = (el.getAttribute('placeholder') || '').toLowerCase();
                                    const al = (el.getAttribute('aria-label') || '').toLowerCase();
                                    return ph.includes('yorum') || ph.includes('comment') ||
                                           al.includes('yorum') || al.includes('comment');
                                });
                                if (commentEntry) {
                                    // Yorum satırının kapsayıcısını bul: yukarı çık ama satır KISA kalsın (≈<160px),
                                    // böylece yanlışlıkla gönderi medyasını içeren büyük kapsayıcıyı seçmeyiz.
                                    let row = commentEntry.parentElement;
                                    let composerRow = commentEntry.parentElement;
                                    for (let i = 0; i < 6 && row && row !== articleEl; i++) {
                                        const h = row.getBoundingClientRect().height;
                                        if (h > 0 && h < 160) composerRow = row;
                                        else if (h >= 160) break;
                                        row = row.parentElement;
                                    }
                                    // Bu kısa satırdaki avatarı gizle: img / canvas ve arka-plan-resimli küçük span/div.
                                    // Satır kısa olduğu için burada gönderi medyası bulunmaz; güvenle gizlenir.
                                    composerRow.querySelectorAll('img, canvas').forEach(el => {
                                        igSet(el, 'display', 'none');
                                    });
                                    composerRow.querySelectorAll('span, div').forEach(el => {
                                        const bg = window.getComputedStyle(el).backgroundImage;
                                        const r = el.getBoundingClientRect();
                                        if (bg && bg !== 'none' && r.width > 0 && r.width < 60 && r.height < 60) {
                                            igSet(el, 'display', 'none');
                                        }
                                    });
                                }
                            } catch (e) { /* sessiz geç */ }

                            // Yedek yöntem: form yapısına göre de dene (giriş alanı bulunamazsa).
                            // Yalnızca küçük görselleri (avatar) hedefle; büyük gönderi medyasına dokunma.
                            const commentForm = articleEl.querySelector('form');
                            if (commentForm && commentForm.parentNode) {
                                commentForm.parentNode.querySelectorAll('img, canvas').forEach(el => {
                                    const r = el.getBoundingClientRect();
                                    if (r.width > 0 && r.width < 60 && r.height < 60) {
                                        igSet(el, 'display', 'none');
                                    }
                                });
                            }

                            // Ekran görüntüsü almadan önce article'ın güncel orijinal (doğal) boyutunu ölçüyoruz
                            const originalRect = articleEl.getBoundingClientRect();
                            const naturalWidth = originalRect.width > 0 ? originalRect.width + 'px' : 'auto';
                            const naturalHeight = originalRect.height > 0 ? originalRect.height + 'px' : 'auto';

                            // 4. article'ı izole et ancak kendi doğal boyutlarında bırak
                            igSet(articleEl, 'box-sizing', 'border-box');
                            igSet(articleEl, 'position', 'fixed');
                            igSet(articleEl, 'top', '0');
                            igSet(articleEl, 'left', '0');
                            igSet(articleEl, 'width', naturalWidth);
                            igSet(articleEl, 'max-width', '100vw');
                            igSet(articleEl, 'height', naturalHeight);
                            igSet(articleEl, 'max-height', 'none');
                            igSet(articleEl, 'z-index', '2147483647');
                            igSet(articleEl, 'background-color', '#ffffff');
                            igSet(articleEl, 'margin', '0');
                            igSet(articleEl, 'padding', '0');
                            igSet(articleEl, 'overflow', 'visible');
                            igSet(document.body, 'overflow', 'hidden');
                            igSet(document.body, 'background-color', '#ffffff');

                            // Ayrıca gövde background'unu temizle (artık margin vb beyaz gözükmesin diye transparan)
                            // igSet(document.body, 'background-color', 'transparent'); // Eğer body'i transparent yaparsak dışarısı siyah çıkabilir capture sırasında. Beyaz kalması ama cropRect'in tam içeriğe odaklanması daha güvenli

                            // Article'ın arka planı şeffaf olsun ki dış sınırlarındaki olası dolgular beyaz gözükmesin (sadece iç kartın kendi rengi kalır)
                            igSet(articleEl, 'background-color', 'transparent');
                            igSet(document.documentElement, 'overflow', 'hidden');

                            // 5. Reflow bekle
                            await new Promise(r => setTimeout(r, 400));

                            // İkinci faz temizlik (Asenkron gelen yapıları avlamak için)
                            hideIgExtras();

                            // 6. Kartın yeni yüksekliğine göre dikey sığdırma (Dynamic Zoom)
                            // Faz IG-1: no-zoom bayragi acikken KUCULTME uygulanmaz; kart uzunsa asagida
                            // kaydir+birlestir ile tam cozunurlukte yakalanir.
                            if (!xWidgetIgNoZoom) {
                                const rectAfterLayout = articleEl.getBoundingClientRect();
                                if (rectAfterLayout.height > vH - 20) {
                                    const newZoom = (vH - 20) / rectAfterLayout.height;
                                    igSet(articleEl, 'zoom', newZoom);
                                }
                            }

                            // 7. İçerikteki gerçek boyutları sağlayan asıl container'ı bul
                            // Instagram'da dış wrapper bazen ekranı kaplar veya padding içerir. İçteki asıl flex container kartın kendisidir.
                            // ÖNEMLİ: Aday kutu GERÇEKTEN medyayı (görsel/video) içermeli. Aksi halde "en büyük alan"
                            // sezgisi, özellikle yatay/kısa görsellerde yanlışlıkla açıklama/yorum bloğuna kilitlenip
                            // boş/yanlış bölge kırpabiliyor (aralıklı boş görüntü sorununun ana nedeni).
                            const igMediaEl = articleEl.querySelector('img[srcset], img[style*="object-fit"], video') || articleEl.querySelector('img');
                            let contentBox = articleEl;
                            let candidateBox = null;
                            const innerDivs = Array.from(articleEl.querySelectorAll('div'));
                            for (let div of innerDivs) {
                                const r = div.getBoundingClientRect();
                                // Kartlar genellikle ekrandan belirgin şekilde dardır ama çok da ufak değillerdir.
                                // Ana kapsayıcılar genelde width > 400 ve height > 300'dür ve originalRect'ten dardır.
                                if (r.width > 300 && r.height > 300 && r.width <= originalRect.width && r.height <= originalRect.height
                                    && (!igMediaEl || div.contains(igMediaEl))) {
                                    // En büyük hacimli (alanı) container asıl karttır diyebiliriz, ama articleEl'in kendisi hariç
                                    if (!candidateBox || (r.width * r.height > candidateBox.getBoundingClientRect().width * candidateBox.getBoundingClientRect().height)) {
                                        candidateBox = div;
                                    }
                                }
                            }
                            if (candidateBox && (candidateBox.getBoundingClientRect().width < originalRect.width || candidateBox.getBoundingClientRect().height < originalRect.height)) {
                                contentBox = candidateBox;
                            }

                            const ar = contentBox.getBoundingClientRect();

                            if (xWidgetIgNoZoom && ar.height > vH + 4) {
                                // Faz IG-1 (no-zoom): kart viewport'tan uzun -> fixed article'i her adimda
                                // yukari kaydirarak dilim dilim yakala, sonra dikey birlestir. Zoom YOK => tam cozunurluk.
                                const dprI = window.devicePixelRatio || 1;
                                const boxLeft = Math.max(0, Math.round(ar.left));
                                const boxWidth = Math.round(ar.width);
                                const fullH = ar.height;
                                const boxOffset = ar.top; // contentBox'un fixed-article(top:0) icindeki viewport ofseti
                                const nSeg = Math.ceil(fullH / vH);
                                const igSegs = [];
                                for (let si = 0; si < nSeg; si++) {
                                    igSet(articleEl, 'top', (-(boxOffset + si * vH)) + 'px');
                                    await new Promise(r => setTimeout(r, 180));
                                    const sliceH = Math.max(1, Math.round(Math.min(vH, fullH - si * vH)));
                                    const segRes = await new Promise(resolve => {
                                        chrome.runtime.sendMessage({ action: "captureAndCrop", rect: { top: 0, left: boxLeft, width: boxWidth, height: sliceH }, dpr: dprI }, resolve);
                                    });
                                    if (segRes && segRes.status === "success" && segRes.dataUrl) igSegs.push(segRes.dataUrl);
                                    else break;
                                }
                                igSet(articleEl, 'top', '0');
                                if (igSegs.length > 0) {
                                    printLog(`[Instagram] No-zoom ${igSegs.length} parça birleştiriliyor.`);
                                    rawResult = (igSegs.length === 1) ? igSegs[0] : await igVerticalStitch(igSegs);
                                } else {
                                    printLog("[Instagram] No-zoom yakalama başarısız, zoom-to-fit yoluna dönülüyor.");
                                }
                            }

                            if (!rawResult) {
                                // Mevcut yol: zoom-to-fit (ya da no-zoom kısa kart) -> tek çekim.
                                const arS = contentBox.getBoundingClientRect();
                                const cropRect = {
                                    top:    Math.max(0, Math.round(arS.top)),
                                    left:   Math.max(0, Math.round(arS.left)),
                                    width:  Math.round(arS.width),
                                    height: Math.round(Math.min(arS.height, vH))
                                };

                                printLog(`[Instagram] CSS izolasyon rect: ${JSON.stringify(cropRect)}`);

                                // Ekran görüntüsü al (X/Twitter ile aynı mekanizma)
                                const igResult = await new Promise(resolve => {
                                    chrome.runtime.sendMessage({
                                        action: "captureAndCrop",
                                        rect:   cropRect,
                                        dpr:    window.devicePixelRatio || 1
                                    }, resolve);
                                });

                                if (igResult && igResult.status === "success" && igResult.dataUrl) {
                                    rawResult = igResult.dataUrl;
                                } else {
                                    printLog("[Instagram] captureAndCrop hatası: " + (igResult ? igResult.message : "yanıt yok") + ", fallback olarak tam sayfa çekimi deneniyor.");
                                    const ssFallback = await new Promise(resolve => {
                                        chrome.runtime.sendMessage({ action: "captureTab" }, resolve);
                                    });
                                    if (ssFallback && ssFallback.status === "success" && ssFallback.dataUrl) {
                                        rawResult = await cropScreenshot(ssFallback.dataUrl, cropRect);
                                    } else {
                                        return null;
                                    }
                                }
                            }
                        } finally {
                            // 7. Her koşulda stilleri geri yükle
                            igRestoreAll();
                        }
                    } else {
                        const ssFirst = await new Promise(resolve => {
                            swSendReliable({ action: "captureTab" }, resolve);
                        });

                        if (!ssFirst || ssFirst.status !== "success" || !ssFirst.dataUrl) {
                            printLog("Ekran görüntüsü alma hatası (1)");
                            return null;
                        }
                        snapshots.push(ssFirst.dataUrl);

                        // G. Tweet viewport'a sığıyorsa tek çekim yeterli
                        if (measuredRect.height <= vH) {
                            const crop = {
                                top:    Math.max(0, measuredRect.top),
                                left:   Math.max(0, measuredRect.left),
                                width:  Math.min(vW, measuredRect.right) - Math.max(0, measuredRect.left),
                                height: Math.min(vH, measuredRect.bottom) - Math.max(0, measuredRect.top)
                            };
                            rawResult = await cropScreenshot(ssFirst.dataUrl, crop);
                        } else {
                            // H. Uzun tweet: viewport yüksekliği kadar kaydırarak çoklu çekim yap
                            printLog(`Uzun tivit algılandı, tam boy çekim yapılıyor...`);
                            let totalScrolled = 0;

                            while (totalScrolled + vH < measuredRect.height) {
                                const scrollBefore = window.scrollY || document.documentElement.scrollTop;
                                window.scrollBy({ top: vH, left: 0, behavior: 'instant' });
                                await new Promise(r => setTimeout(r, 250));
                                const scrollAfter = window.scrollY || document.documentElement.scrollTop;
                                const delta = scrollAfter - scrollBefore;

                                if (delta < 5) {
                                    printLog("Sayfa sonu: kaydirma durdu.");
                                    break;
                                }
                                totalScrolled += delta;

                                const ssN = await new Promise(resolve => {
                                    swSendReliable({ action: "captureTab" }, resolve);
                                });

                                if (!ssN || ssN.status !== "success" || !ssN.dataUrl) {
                                    printLog(`Ekran goruntüsü alma hatası (${snapshots.length + 1}), mevcut parcalar kullaniliyor.`);
                                    break;
                                }
                                snapshots.push(ssN.dataUrl);
                            }

                            // I. Tüm parçaları birleştir
                            printLog(`Ekran görüntüleri birleştiriliyor...`);
                            rawResult = await stitchMultipleScreenshots(snapshots, measuredRect, vH, dpr);
                        }
                    }

                    // Compress the final image on the client side
                    return await compressScreenshot(rawResult);

                } finally {
                    // Geri yüklemeleri her durumda yap
                    spacer.remove();
                    disableSmoothScrollStyles.remove();

                    if (isInstagram && !xWidgetIgNoZoom) {
                        if (widgetEl && origWidgetDisplay !== undefined) {
                            widgetEl.style.display = origWidgetDisplay;
                        }
                        if (cbWidgetEl && origCbWidgetDisplay !== undefined) {
                            cbWidgetEl.style.display = origCbWidgetDisplay;
                        }
                    }
                    // Faz IG-1: gizlenen Instagram "Mesajlar" balonunu geri aç.
                    for (const h of igMsgHidden) {
                        try { if (h.v) h.el.style.setProperty('visibility', h.v); else h.el.style.removeProperty('visibility'); } catch (e) {}
                    }

                    for (const item of stickyElements) {
                        if (item.origOverflow !== undefined) {
                            item.el.style.overflowY = item.origOverflow;
                        } else if (item.origZoom !== undefined) {
                            if (item.origZoom) {
                                item.el.style.zoom = item.origZoom;
                            } else {
                                item.el.style.removeProperty('zoom');
                            }
                        } else {
                            item.el.style.display = item.origDisplay;
                        }
                    }
                    for (const item of hiddenFooterElements) {
                        if (item.origDisplay !== undefined) {
                            item.el.style.display = item.origDisplay;
                        }
                    }
                    // Eski scroll konumuna geri kaydır
                    window.scrollTo({ top: 0, behavior: 'instant' });
                }
            }

            // Global timer and progress helper states
            let timerIntervalId = null;

            function initWidgetTimer(gorev, storageKey) {
                if (!gorev || !gorev.aktif) return;
                
                const startTime = gorev.start_time || Date.now();
                if (!gorev.start_time) {
                    gorev.start_time = startTime;
                    let upd = {}; upd[storageKey] = gorev;
                    chrome.storage.local.set(upd);
                }
                
                const timerEl = document.getElementById('w-progress-timer');
                if (timerEl) {
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
                    const sec = String(elapsed % 60).padStart(2, '0');
                    timerEl.innerText = "⏱ " + min + ":" + sec;
                }
                
                if (timerIntervalId) clearInterval(timerIntervalId);
                timerIntervalId = setInterval(() => {
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
                    const sec = String(elapsed % 60).padStart(2, '0');
                    const liveTimerEl = document.getElementById('w-progress-timer');
                    if (liveTimerEl) {
                        liveTimerEl.innerText = "⏱ " + min + ":" + sec;
                    }
                }, 1000);
            }

            function updateWidgetProgress(gorev) {
                const box = document.getElementById('w-progress-box');
                const counter = document.getElementById('w-progress-counter');
                const fill = document.getElementById('w-progress-bar-fill');
                
                if (!box || !gorev || !gorev.aktif) {
                    if (box) box.style.display = 'none';
                    return;
                }
                
                box.style.display = 'flex';
                
                const completed = (gorev.combinedData) ? gorev.combinedData.length : 0;
                let total = 0;
                if (gorev.total_count) {
                    total = gorev.total_count;
                } else if (gorev.kuyruk) {
                    total = completed + gorev.kuyruk.length;
                }
                
                if (counter) {
                    counter.innerText = `${completed} / ${total}`;
                }
                if (fill) {
                    const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
                    fill.style.width = `${pct}%`;
                }
            }

            // Live DOM logging helper
            function printLog(msg) {
                console.log("X Rapor Log:", msg);
                logToServer(msg);
                
                // Hide technical/code statements and show simple, clean Turkish messages
                let cleanMsg = msg;
                if (msg.includes("cropScreenshot") || msg.includes("Stitch") || msg.includes("canvas") || msg.includes("stitch") || msg.includes("Coklu stitch") || msg.includes("prefetch")) {
                    cleanMsg = "Görsel işleniyor ve optimize ediliyor...";
                } else if (msg.includes("Uzun tweet")) {
                    cleanMsg = "Uzun tivit algılandı, tam boy çekim yapılıyor...";
                } else if (msg.includes("parca alindi") || msg.includes("Birlestiriliyor")) {
                    cleanMsg = "Ekran görüntüleri birleştiriliyor...";
                } else if (msg.includes("Betik başlatıldı") || msg.includes("sorgulama sonucu") || msg.includes("aktif görev") || msg.includes("Sayfa Analizi") || msg.includes("çağrıldı") || msg.includes("kontrolü yapılıyor")) {
                    cleanMsg = "Hazırlanıyor...";
                } else if (msg.includes("retry_count") || msg.includes("Yeniden deneme")) {
                    cleanMsg = "Yükleme bekleniyor, tekrar deneniyor...";
                } else if (msg.includes("Sıradaki profile yönlendiriliyor")) {
                    cleanMsg = "Profil taranıyor, sonraki hesaba geçiliyor...";
                } else if (msg.includes("Sıradaki listeye yönlendiriliyor")) {
                    cleanMsg = "Liste taranıyor, sonraki sayfaya geçiliyor...";
                }
                
                durumText.style.color = "var(--w-text-muted)";
                durumText.innerHTML = cleanMsg;
            }

    // Error rendering helper
    // MV3 service worker bazen istegi islerken oldurulur/askiya alinir. Iki basarisizlik bicimi var:
    //  (1) callback HIC gelmez (worker olur) -> timeout ile yakalanir,
    //  (2) worker'in sunucuya fetch'i "Failed to fetch" verir ve handler {status:"error"} DONER
    //      -> bu gecerli bir yanit gibi gelir; eskiden yeniden denenmezdi, widget hatayi yutup
    //         ilerlerdi ve SONUC SUNUCUYA ULASMAZDI (havuz bos kalirdi). Artik hata yanitinda da
    //         mesaji YENIDEN yolluyoruz (yeni/taze worker'i uyandirir, fetch'i tekrar dener).
    // Tum denemeler basarisizsa cb(null) ile akisi kilitlemeden devam ettiririz (donma olmaz).
    // Not: 'cancelled' is-mantigi geregi gecerli bir sonuctur, ASLA yeniden denenmez.
    //      submit tekrari sunucuda link normalizasyonuyla ELENIR, cift kayit olusmaz.
    function swSendReliable(msg, cb, timeoutMs = 12000, retries = 3) {
        let finished = false;
        const finish = (resp) => { if (finished) return; finished = true; try { cb(resp); } catch (e) {} };
        const attempt = (left) => {
            let localDone = false;
            const retryOrGiveUp = (why) => {
                if (left > 0) {
                    try { logToServer("[swSend] " + why + ", yeniden deneniyor: " + (msg && msg.action)); } catch (e) {}
                    setTimeout(() => attempt(left - 1), 600);
                } else {
                    try { logToServer("[swSend] " + why + ", denemeler bitti: " + (msg && msg.action)); } catch (e) {}
                    finish(null);
                }
            };
            const timer = setTimeout(() => {
                if (localDone) return; localDone = true;
                retryOrGiveUp("Yanit yok (timeout)");
            }, timeoutMs);
            try {
                chrome.runtime.sendMessage(msg, (resp) => {
                    if (localDone) return; localDone = true; clearTimeout(timer);
                    if (chrome.runtime.lastError) { retryOrGiveUp("Kanal hatasi"); return; }
                    // Fetch hatasi ( or. "Failed to fetch") -> {status:"error"} -> yeniden dene.
                    if (resp && resp.status === "error") { retryOrGiveUp("Sunucu/fetch hatasi"); return; }
                    finish(resp);
                });
            } catch (e) {
                clearTimeout(timer);
                retryOrGiveUp("Gonderim istisnasi");
            }
        };
        attempt(retries);
    }

    // Faz #1-A: Yerel goruntu modu. Panel bayragi SW'ye yaziyor (chrome.storage.local.local_images).
    // Bu bayrak acikken ekran goruntusunu SUNUCUYA gondermeyip panele iletiyoruz; sunucuya yalnizca
    // metadata (baslik/link) gidiyor (screenshot bos). Bayrak kapaliyken her sey bugunkuyle ayni.
    var xWidgetLocalImages = false;
    try { chrome.storage.local.get(['local_images'], function (r) { xWidgetLocalImages = !!(r && r.local_images); }); } catch (e) {}

    // Instagram artık VARSAYILAN olarak zoom'suz (X gibi kaydır+birleştir) yakalanır (toggle kaldırıldı).
    var xWidgetIgNoZoom = true;

    function xStripForServer(resItem, gorev) {
        try {
            if (xWidgetLocalImages && resItem && resItem.screenshot && resItem.link) {
                // Faz #1-D (tam kaldırma): görüntü SADECE panele iletilir, sunucuya ASLA gitmez; kurtarma-fallback YOK.
                // swSendReliable teslimi retry eder; aktif tarama boyunca panel açık olduğundan (panel kapanınca
                // tarama iptal) teslim güvenilir.
                swSendReliable({ action: "deliverLocalImage", link: resItem.link, dataUrl: resItem.screenshot }, function () {});
                var copy = {}; for (var k in resItem) copy[k] = resItem[k];
                copy.screenshot = ''; // sunucuya GÖRSELSİZ
                return copy;
            }
        } catch (e) {}
        return resItem;
    }

    function showError(err) {
        console.error("X Rapor Hata:", err);
        logToServer(`HATA: ${err.message || err}`);
        durumText.style.color = "#ff4a4a";
        durumText.innerHTML = `⚠️ <b>Hata Oluştu:</b><br>${err.message || err}`;
        buton.innerText = "Yenile";
        buton.style.backgroundColor = "#38444d";
        buton.disabled = false;
        buton.onclick = () => location.reload();
    }

    // Attach global error listeners
    window.onerror = function(message, source, lineno, colno, error) {
        showError(message + " (Satır: " + lineno + ")");
        return false;
    };
    
    window.onunhandledrejection = function(event) {
        showError("Promise Rejection: " + event.reason);
    };

    // Print initial log
    printLog("Betik başlatıldı. storage aranıyor...");

    // Draggable header
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    baslik.onmousedown = (e) => { 
        if (e.target === kapatButon) return; 
        e.preventDefault(); 
        pos3 = e.clientX; 
        pos4 = e.clientY; 
        document.onmouseup = () => { 
            document.onmouseup = null; 
            document.onmousemove = null; 
        }; 
        document.onmousemove = (ev) => { 
            ev.preventDefault(); 
            pos1 = pos3 - ev.clientX; 
            pos2 = pos4 - ev.clientY; 
            pos3 = ev.clientX; 
            pos4 = ev.clientY; 
            widget.style.top = (widget.offsetTop - pos2) + "px"; 
            widget.style.left = (widget.offsetLeft - pos1) + "px"; 
            widget.style.right = "auto"; 
        }; 
    }; 

    // Utility: Extract date from Tweet ID (Snowflake ID)
    function tivitIdZamaniBul(tweetIdStr) {
        try {
            let tweetIdBigInt = BigInt(tweetIdStr); 
            return Number((tweetIdBigInt >> 22n) + 1288834974657n); 
        } catch (e) { return null; } 
    }

    // Utility: Format Timestamp to String
    function zamanFormatla(ms) {
        let d = new Date(ms); 
        if (isNaN(d.getTime())) return "bilinmeyen-tarih"; 
        let yil = d.getFullYear(); 
        let ay = String(d.getMonth() + 1).padStart(2, '0'); 
        let gun = String(d.getDate()).padStart(2, '0'); 
        let saat = String(d.getHours()).padStart(2, '0'); 
        let dakika = String(d.getMinutes()).padStart(2, '0'); 
        return `${yil}-${gun}-${ay} ${saat}:${dakika}`;
    }

    // Utility: UI Info writer
    function tivitBilgisiniYazdir(tarih, metin) {
        if (!metin || metin === "Metin Yok/Medya." || metin === "Bulunamadı") {
            metin = "<i>[Metinsiz veya Medya Tiviti]</i>";
        } else {
            metin = metin.length > 45 ? metin.substring(0, 45) + "..." : metin;
        }
        tivitBilgiKutusu.style.display = 'block';
        tivitBilgiKutusu.innerHTML = `📅 <b>Tarih:</b> ${tarih}<br>📝 <b>Metin:</b> "${metin}"`;
    }

    // Utility: Format elapsed time
    function gecenSureyiBul(baslangicMs) {
        let gecenSureMs = Date.now() - baslangicMs;
        let saniye = Math.floor((gecenSureMs / 1000) % 60);
        let dakika = Math.floor((gecenSureMs / (1000 * 60)) % 60);
        let saat = Math.floor((gecenSureMs / (1000 * 60 * 60)));
        
        let zamanStr = "";
        if (saat > 0) { zamanStr += saat.toString().padStart(2, '0') + ":"; }
        zamanStr += `${dakika.toString().padStart(2, '0')}:${saniye.toString().padStart(2, '0')}`;
        return zamanStr;
    }

    // Utility: Chronometer
    function kronometreyiBaslat(baslangicMs) {
        return setInterval(() => {
            let zamanStr = gecenSureyiBul(baslangicMs);
            let sureEl = document.getElementById('w-tarama-sure');
            if (sureEl) { sureEl.innerText = zamanStr; }
        }, 1000);
    }

    // Utility: Check if task is active in storage
    async function isGorevActive(storageKey) {
        return new Promise(res => {
            chrome.storage.local.get([storageKey], (result) => {
                let g = result[storageKey];
                res(!!(g && g.aktif));
            });
        });
    }

    // Utility: Parse abbreviated numbers (e.g. 1.2K, 5M, 1.103) into actual numbers
    function sayiCozumle(str) {
        if (!str) return 0;
        let temiz = str.trim().replace(/\s/g, '');
        let lower = temiz.toLowerCase();
        
        let hasSuffix = lower.endsWith('k') || lower.endsWith('b') || lower.endsWith('m') || lower.endsWith('mn');
        
        if (hasSuffix) {
            let carpan = 1;
            if (lower.endsWith('k') || lower.endsWith('b')) {
                carpan = 1000;
                temiz = temiz.substring(0, temiz.length - 1);
            } else if (lower.endsWith('m')) {
                carpan = 1000000;
                temiz = temiz.substring(0, temiz.length - 1);
            } else if (lower.endsWith('mn')) {
                carpan = 1000000;
                temiz = temiz.substring(0, temiz.length - 2);
            }
            temiz = temiz.replace(/,/g, '.');
            let sayi = parseFloat(temiz) || 0;
            return Math.round(sayi * carpan);
        } else {
            temiz = temiz.replace(/[.,]/g, '');
            return parseInt(temiz) || 0;
        }
    }

    // DOM Parser: Extract Tweet stats
    function tivitIstatistikleriniBul(articleElement, options = {}) {
        let stats = {
            views: null,
            likes: null,
            retweets: null,
            quotes: null,
            replies: null,
            yazar: "Bilinmiyor",
            tarih: "Bilinmeyen Tarih",
            metin: ""
        };
        
        let article = articleElement || document.querySelector('article[data-testid="tweet"]');
        if (!article) return stats;

        const extractAll = (options.extractAll !== false);
        const extractViews = extractAll || options.extractViews;
        const extractLikes = extractAll || options.extractLikes;
        const extractRetweets = extractAll || options.extractRetweets;
        const extractQuotes = extractAll || options.extractQuotes;
        const extractReplies = extractAll || options.extractReplies;

        // Yazar
        let nameEl = article.querySelector('[data-testid="User-Name"]');
        if (nameEl) {
            let linkEl = nameEl.querySelector('a[href^="/"]');
            if (linkEl) {
                let href = linkEl.getAttribute('href') || "";
                let username = href.replace('/', '').trim();
                if (username) {
                    stats.yazar = "@" + username;
                } else {
                    stats.yazar = nameEl.innerText.replace(/\n/g, ' ').trim();
                }
            } else {
                stats.yazar = nameEl.innerText.replace(/\n/g, ' ').trim();
            }
        }

        // Metin
        let textEl = article.querySelector('[data-testid="tweetText"]');
        if (textEl) {
            stats.metin = textEl.innerText || textEl.textContent || "";
        }

        // Tarih
        let timeEl = article.querySelector('time');
        if (timeEl) {
            let dt = timeEl.getAttribute('datetime');
            if (dt) {
                stats.tarih = zamanFormatla(new Date(dt).getTime());
            }
        }
        if (!stats.tarih || stats.tarih === "Bilinmeyen Tarih") {
            let tweetId = null;
            let links = article.querySelectorAll('a[href*="/status/"]');
            for (let l of links) {
                let href = l.getAttribute('href') || "";
                let matches = href.match(/status\/(\d+)/);
                if (matches && matches[1]) {
                    tweetId = matches[1];
                    break;
                }
            }
            if (!tweetId && !articleElement) {
                let matches = window.location.href.match(/status\/(\d+)/);
                if (matches && matches[1]) {
                    tweetId = matches[1];
                }
            }
            if (tweetId) {
                let idTime = tivitIdZamaniBul(tweetId);
                if (idTime) {
                    stats.tarih = zamanFormatla(idTime);
                }
            }
        }

        // İstatistikler (Linkler)
        if (extractRetweets || extractQuotes || extractLikes) {
            let links = article.querySelectorAll('a[href]');
            links.forEach(link => {
                let href = link.getAttribute('href') || "";
                let temizHref = href.split('?')[0];
                let text = link.innerText || "";
                if (extractRetweets && (temizHref.endsWith('/retweets') || temizHref.endsWith('/reposts'))) {
                    stats.retweets = text.replace(/[^0-9KMB,.]/g, '').trim() || "0";
                } else if (extractQuotes && temizHref.endsWith('/quotes')) {
                    stats.quotes = text.replace(/[^0-9KMB,.]/g, '').trim() || "0";
                } else if (extractLikes && temizHref.endsWith('/likes')) {
                    stats.likes = text.replace(/[^0-9KMB,.]/g, '').trim() || "0";
                }
            });
        }

        // Buton aria-label fallbacks
        if (extractLikes) {
            let likeBtn = article.querySelector('[data-testid="like"]');
            if (likeBtn) {
                if (stats.likes === null || stats.likes === "0") {
                    let label = likeBtn.getAttribute('aria-label') || "";
                    let match = label.match(/(\d+[\d,.\s]*)/);
                    if (match) stats.likes = match[1].trim();
                    else stats.likes = "0";
                }
            }
        }

        if (extractRetweets) {
            let rtBtn = article.querySelector('[data-testid="retweet"]');
            if (rtBtn) {
                if (stats.retweets === null || stats.retweets === "0") {
                    let label = rtBtn.getAttribute('aria-label') || "";
                    let match = label.match(/(\d+[\d,.\s]*)/);
                    if (match) stats.retweets = match[1].trim();
                    else stats.retweets = "0";
                }
            }
        }

        if (extractReplies) {
            let replyBtn = article.querySelector('[data-testid="reply"]');
            if (replyBtn) {
                if (stats.replies === null || stats.replies === "0") {
                    let label = replyBtn.getAttribute('aria-label') || "";
                    let match = label.match(/(\d+[\d,.\s]*)/);
                    if (match) stats.replies = match[1].trim();
                    else stats.replies = "0";
                }
            }
        }

        if (extractViews) {
            let viewLink = article.querySelector('a[href*="/analytics"]');
            if (viewLink) {
                let text = viewLink.innerText || "";
                stats.views = text.replace(/[^0-9KMB,.]/g, '').trim() || "0";
            } else {
                let spans = article.querySelectorAll('span');
                spans.forEach(span => {
                    let text = span.innerText || "";
                    if (text.includes('Görüntüleme') || text.includes('Views')) {
                        let val = text.replace(/[^0-9KMB,.]/g, '').trim();
                        if (val) stats.views = val;
                    }
                });
            }
        }

        return stats;
    }

    // DOM Parser: Scrape Comments/Replies
    function yorumlariKazı(usersMap, mainTweetId) {
        // Find recommendation header (like "Daha fazlasını keşfet" or "Discover more")
        let recommendedHeader = null;
        const keywords = [
            "daha fazlasını keşfet", 
            "x genelinden getirilenler", 
            "discover more", 
            "more posts", 
            "suggested posts",
            "recommended posts",
            "other posts"
        ];
        
        const possibleHeaders = document.querySelectorAll('span, h2, h3, div');
        for (let el of possibleHeaders) {
            if (el.children.length === 0 || (el.children.length === 1 && el.children[0].children.length === 0)) {
                const text = el.innerText ? el.innerText.trim().toLowerCase() : "";
                if (text && keywords.some(kw => text === kw || text.includes(kw))) {
                    if (text.length < 40) {
                        recommendedHeader = el;
                        break;
                    }
                }
            }
        }

        let articles = document.querySelectorAll('article[data-testid="tweet"]');
        articles.forEach(article => {
            // Skip nested articles (like quote card previews inside a tweet/reply)
            if (article.parentElement.closest('article[data-testid="tweet"]')) {
                return;
            }

            // Skip recommended tweets (positioned after the recommended header in DOM)
            if (recommendedHeader && (recommendedHeader.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                return;
            }

            // Find the time element and get its closest link wrapping it
            let timeEl = article.querySelector('time');
            if (!timeEl) return;
            let linkEl = timeEl.closest('a');
            if (!linkEl) return;
            
            let href = linkEl.getAttribute('href');
            let match = href.match(/\/([^\/]+)\/status\/(\d+)/);
            if (!match) return;
            let replyId = match[2];
            if (replyId === mainTweetId) return; // Skip main tweet

            let username = "@" + match[1];
            let name = "";
            let nameEl = article.querySelector('[data-testid="User-Name"]');
            if (nameEl) {
                let spans = nameEl.querySelectorAll('span');
                if (spans.length > 0) name = spans[0].innerText.trim();
            }

            let text = "";
            let textEl = article.querySelector('[data-testid="tweetText"]');
            if (textEl) {
                text = (textEl.innerText || textEl.textContent || "").trim();
            }

            let date = "";
            let dt = timeEl.getAttribute('datetime');
            if (dt) date = zamanFormatla(new Date(dt).getTime());
            if (!date) {
                date = zamanFormatla(tivitIdZamaniBul(replyId));
            }

            let commentUrl = window.location.origin + href;

            if (!usersMap.has(replyId)) {
                usersMap.set(replyId, { name, username, text, date, url: commentUrl });
            }
        });
    }

    // DOM Parser: Scrape Quote Tweets
    function alintilariKazı(quotesMap) {
        let articles = document.querySelectorAll('article[data-testid="tweet"]');
        articles.forEach(article => {
            let linkEl = article.querySelector('a[href*="/status/"]');
            if (!linkEl) return;
            let href = linkEl.getAttribute('href');
            let match = href.match(/\/([^\/]+)\/status\/(\d+)/);
            if (!match) return;
            let quoteId = match[2];

            let username = "@" + match[1];
            let name = "";
            let nameEl = article.querySelector('[data-testid="User-Name"]');
            if (nameEl) {
                let spans = nameEl.querySelectorAll('span');
                if (spans.length > 0) name = spans[0].innerText.trim();
            }

            let text = "";
            let textEl = article.querySelector('[data-testid="tweetText"]');
            if (textEl) {
                text = (textEl.innerText || textEl.textContent || "").trim();
            }

            let date = "";
            let timeEl = article.querySelector('time');
            if (timeEl) {
                let dt = timeEl.getAttribute('datetime');
                if (dt) date = zamanFormatla(new Date(dt).getTime());
            }
            if (!date) {
                date = zamanFormatla(tivitIdZamaniBul(quoteId));
            }

            let type = "Metin";
            if (article.querySelector('video, [data-testid="videoPlayer"]')) {
                type = "Video";
            } else if (article.querySelector('[data-testid="tweetPhoto"]')) {
                type = "Görsel";
            }

            if (!quotesMap.has(quoteId)) {
                quotesMap.set(quoteId, { name, username, text, date, type, url: "https://x.com" + href });
            }
        });
    }

    // DOM Parser: Scrape User Cells (Retweets / Likes)
    function kullanıcılarıKazı(usersMap) {
        let anaGövde = document.querySelector('main[role="main"] section') || document.querySelector('main[role="main"]') || document; 
        let userCells = anaGövde.querySelectorAll('[data-testid="UserCell"]');
        userCells.forEach(cell => {
            if (cell.closest('aside') || cell.closest('[data-testid="sidebarColumn"]')) return;
            let userLink = cell.querySelector('a[href^="/"]');
            if (userLink) {
                let handle = userLink.getAttribute('href').replace('/', '@');
                if (["@home", "@explore", "@notifications", "@messages", "@bookmarks", "@i", "@settings", "@privacy"].includes(handle.toLowerCase())) return;
                let cellText = cell.innerText.split('\n');
                let displayName = cellText[0];
                if (!displayName || (displayName.startsWith('@') && cellText.length > 1)) {
                    displayName = cellText[1];
                }
                usersMap.set(handle, displayName);
            }
        });
    }

    // Stop and clear helper
    function durdurVeTemizle(storageKey, interval, serverOrigin) {
        if (interval) clearInterval(interval);
        chrome.storage.local.get({ server_origin: "http://localhost:3012", client_id: "" }, (res) => {
            const origin = serverOrigin || res.server_origin;
            const clientId = res.client_id || "";
            
            // Storage'ı temizle ve panele geç - sunucu yanıtından BAĞIMSIZ çalışır
            function doCleanup() {
                chrome.storage.local.remove(storageKey, () => {
                    chrome.runtime.sendMessage({ 
                        action: "completeJobAndFocusPanel", 
                        origin: origin 
                    });
                });
            }

            // Sunucuya reset isteği at, ama yanıt gelmese bile 5 sn içinde temizle
            let cleanupDone = false;
            const cleanupTimer = setTimeout(() => {
                if (!cleanupDone) {
                    cleanupDone = true;
                    doCleanup();
                }
            }, 5000);

            chrome.runtime.sendMessage({
                action: "resetServerJob",
                origin: origin,
                client_id: clientId
            }, () => {
                if (!cleanupDone) {
                    cleanupDone = true;
                    clearTimeout(cleanupTimer);
                    doCleanup();
                }
            });
        });
    }

    // Excel Exporter using XML Spreadsheet Format (SpreadsheetML) - 100% CSP Friendly!
    function excelDosyasıOlustur(data) {
        if (typeof XLSX === 'undefined') {
            console.error("XLSX kütüphanesi yüklenemedi. Rapor indirilemiyor.");
            alert("X Rapor Hatası: XLSX kütüphanesi yüklenemedi. Lütfen sayfayı yenileyip tekrar deneyin.");
            return;
        }

        let replyCount = data.yorumlar && data.yorumlar.length > 0 
            ? data.yorumlar.length 
            : sayiCozumle(data.ozet.replies);
            
        let retweetCount = data.retweets && data.retweets.length > 0 
            ? data.retweets.length 
            : sayiCozumle(data.ozet.retweets);
            
        let quoteCount = data.quotes && data.quotes.length > 0 
            ? data.quotes.length 
            : sayiCozumle(data.ozet.quotes);
            
        let likeCount = data.likes && data.likes.length > 0 
            ? data.likes.length 
            : sayiCozumle(data.ozet.likes);
            
        let viewCount = sayiCozumle(data.ozet.views);

        // 1. Özet Sayfası
        const ozetData = [
            ["Tweet Analiz Özeti"],
            [],
            ["Tweet URL", data.ozet.url],
            ["Yazar", data.ozet.yazar],
            ["Tarih", data.ozet.tarih],
            ["Metin", data.ozet.metin],
            [],
            ["Görüntülenme Sayısı", viewCount],
            ["Yorum Sayısı", replyCount],
            ["Retweet Sayısı", retweetCount],
            ["Alıntı Sayısı", quoteCount],
            ["Beğeni Sayısı", likeCount]
        ];

        const wsOzet = XLSX.utils.aoa_to_sheet(ozetData);
        wsOzet['!cols'] = [{ wch: 20 }, { wch: 45 }];

        // Köprü bağlantılarını ekle (Hyperlinks)
        if (replyCount > 0 && data.yorumlar && data.yorumlar.length > 0) {
            wsOzet['B9'] = { t: 'n', v: replyCount, f: 'HYPERLINK("#\'Yorumlar\'!A1", ' + replyCount + ')' };
        }
        if (retweetCount > 0 && data.retweets && data.retweets.length > 0) {
            wsOzet['B10'] = { t: 'n', v: retweetCount, f: 'HYPERLINK("#\'Retweetler\'!A1", ' + retweetCount + ')' };
        }
        if (quoteCount > 0 && data.quotes && data.quotes.length > 0) {
            wsOzet['B11'] = { t: 'n', v: quoteCount, f: 'HYPERLINK("#\'Alintilar\'!A1", ' + quoteCount + ')' };
        }
        if (likeCount > 0 && data.likes && data.likes.length > 0) {
            wsOzet['B12'] = { t: 'n', v: likeCount, f: 'HYPERLINK("#\'Begeniler\'!A1", ' + likeCount + ')' };
        }

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, wsOzet, "Ozet");

        // 2. Retweetler Sayfası
        if (data.retweets && data.retweets.length > 0) {
            const rtData = [["Hesap Adı", "Kullanıcı Adı"]];
            data.retweets.forEach(item => {
                rtData.push([item.name, item.handle]);
            });
            const wsRt = XLSX.utils.aoa_to_sheet(rtData);
            wsRt['!cols'] = [{ wch: 25 }, { wch: 25 }];
            XLSX.utils.book_append_sheet(wb, wsRt, "Retweetler");
        }

        // 3. Alıntılar Sayfası
        if (data.quotes && data.quotes.length > 0) {
            const qData = [["Hesap Adı", "Kullanıcı Adı", "Alıntı Metni", "Alıntı Tarihi", "İçerik Türü"]];
            data.quotes.forEach(item => {
                qData.push([item.name, item.username, item.text, item.date, item.type || 'Metin']);
            });
            const wsQ = XLSX.utils.aoa_to_sheet(qData);
            wsQ['!cols'] = [{ wch: 25 }, { wch: 25 }, { wch: 45 }, { wch: 20 }, { wch: 15 }];
            XLSX.utils.book_append_sheet(wb, wsQ, "Alintilar");
        }

        // 4. Beğeniler Sayfası
        if (data.likes && data.likes.length > 0) {
            const lData = [["Hesap Adı", "Kullanıcı Adı"]];
            data.likes.forEach(item => {
                lData.push([item.name, item.handle]);
            });
            const wsL = XLSX.utils.aoa_to_sheet(lData);
            wsL['!cols'] = [{ wch: 25 }, { wch: 25 }];
            XLSX.utils.book_append_sheet(wb, wsL, "Begeniler");
        }

        // 5. Yorumlar Sayfası
        if (data.yorumlar && data.yorumlar.length > 0) {
            const yData = [["Hesap Adı", "Kullanıcı Adı", "Yorum Metni", "Yorum Tarihi", "Yorum Linki"]];
            data.yorumlar.forEach(item => {
                yData.push([item.name, item.username, item.text, item.date, item.url]);
            });
            const wsY = XLSX.utils.aoa_to_sheet(yData);
            wsY['!cols'] = [{ wch: 25 }, { wch: 25 }, { wch: 45 }, { wch: 20 }, { wch: 35 }];
            XLSX.utils.book_append_sheet(wb, wsY, "Yorumlar");
        }

        // Binary XLSX dosyasını yaz
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'binary', cellFormula: true });
        
        function s2ab(s) {
            const buf = new ArrayBuffer(s.length);
            const view = new Uint8Array(buf);
            for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xFF;
            return buf;
        }

        const blob = new Blob([s2ab(wbout)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        
        let kisaMetin = data.ozet.metin
            .replace(/[\r\n]+/g, " ")
            .replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ\s]/g, "")
            .trim()
            .substring(0, 25)
            .replace(/\s+/g, "-");
        if (!kisaMetin) kisaMetin = "rapor";
        
        let safeTarih = data.ozet.tarih.replace(/[: ]/g, '-');
        link.download = `${safeTarih}_${kisaMetin}_analiz.xlsx`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // STATE MACHINE: Detailed scraping management
    async function detayliTaramaYonetimi(gorev, storageKey) {
        let hamUrl = window.location.href.split('?')[0];
        let aktifTivit = gorev.kuyruk[0];
        
        if (!aktifTivit) {
            tivitBilgiKutusu.style.display = 'none';
            chrome.storage.local.get({ server_origin: "http://localhost:3012" }, (res) => {
                const origin = gorev.server_origin || res.server_origin;
                durumText.innerHTML = `🎉 <b>Tüm İşlemler Başarıyla Tamamlandı!</b><br>Analiz sonuçları sisteme kaydedildi. Raporları Kullanıcı Paneli -> Son 24 Saat Taramaları altından Excel olarak indirebilirsiniz.<br><a href="${origin}/user/history#v-pills-extension" target="_blank" style="color:#1d9bf0;text-decoration:underline;font-weight:bold;margin-top:8px;display:inline-block;">📋 Geçmiş Taramalarıma Git</a>`;
            });
            buton.innerText = "Kapat";
            buton.style.backgroundColor = "#1d9bf0";
            buton.onclick = () => {
                chrome.storage.local.remove(storageKey, () => {
                    location.reload();
                });
            };
            return;
        }
        
        if (!gorev.gecerliVeri) {
            gorev.gecerliVeri = { ozet: null, yorumlar: [], retweets: [], quotes: [], likes: [] };
        }
        
        if (gorev.tivitAdimi === "basla") {
            gorev.tivitAdimi = "ozet_ve_yorumlar";
            let updateObj = {}; updateObj[storageKey] = gorev;
            chrome.storage.local.set(updateObj, () => {
                window.location.href = aktifTivit;
            });
            return;
        }
        
        if (gorev.gecerliVeri && gorev.gecerliVeri.ozet) {
            tivitBilgisiniYazdir(gorev.gecerliVeri.ozet.tarih, gorev.gecerliVeri.ozet.metin);
        } else {
            tivitBilgiKutusu.style.display = 'none';
        }
        
        // Helper: build status checklist html
        function checklistHtml(step, countText = "") {
            let items = [
                { id: "ozet_ve_yorumlar", label: "Tweet Metni & Yorumlar", active: false, status: "⏳" },
                { id: "retweets", label: "Retweetler", active: false, status: "⏳" },
                { id: "quotes", label: "Alıntılar", active: false, status: "⏳" },
                { id: "likes", label: "Beğeniler", active: false, status: "⏳" }
            ];
            
            if (!gorev.ayarlar.yorum) {
                items[0].label = "Tweet Metni & İstatistikler";
            }
            
            let filteredItems = items.filter(item => {
                if (item.id === "ozet_ve_yorumlar") return true; 
                if (item.id === "retweets") return gorev.ayarlar.rt;
                if (item.id === "quotes") return gorev.ayarlar.alinti;
                if (item.id === "likes") return gorev.ayarlar.begeni && !gorev.ayarlar.sadeceSayisalBegeni;
                return false;
            });
            
            let currentIdx = filteredItems.findIndex(item => item.id === step);
            filteredItems.forEach((item, idx) => {
                if (idx < currentIdx) {
                    item.status = "✅ Bitti";
                } else if (idx === currentIdx) {
                    item.status = `🔄 Taranıyor ${countText}`;
                    item.active = true;
                } else {
                    item.status = "⏳ Bekliyor";
                }
            });
            
            let html = `<div class="w-checklist" style="margin-top: 10px; margin-bottom: 10px; padding: 8px; background: var(--w-card-bg); border: 1px solid var(--w-border); border-radius: 8px; font-size: 11px; text-align: left;">`;
            filteredItems.forEach(item => {
                let color = item.active ? "#1d9bf0" : (item.status.startsWith("✅") ? "#00ba7c" : "var(--w-text-muted)");
                let weight = item.active ? "bold" : "normal";
                html += `<div style="display: flex; justify-content: space-between; margin-bottom: 4px; color: ${color}; font-weight: ${weight};">`;
                html += `<span>${item.label}</span>`;
                html += `<span>${item.status}</span>`;
                html += `</div>`;
            });
            html += `</div>`;
            return html;
        }
        
        if (!gorev.gorevBaslangicMs) {
            gorev.gorevBaslangicMs = Date.now();
        }
        let baslangicMs = gorev.gorevBaslangicMs;
        let sayacInterval = kronometreyiBaslat(baslangicMs);
        
        buton.innerText = "🛑 Taramayı Durdur";
        buton.disabled = false;
        buton.style.backgroundColor = "#e0245e";
        let iptalEdildi = false;
        buton.onclick = () => { iptalEdildi = true; };
        
        // STEP 1: Tweet details + Comments
        if (gorev.tivitAdimi === "ozet_ve_yorumlar") {
            if (normalizeUrl(hamUrl) !== normalizeUrl(aktifTivit)) {
                durumText.innerHTML = `🔄 Yönlendiriliyorsunuz...`;
                window.location.href = aktifTivit;
                clearInterval(sayacInterval);
                return;
            }
            
            let articleLoaded = false;
            for (let i = 0; i < 60; i++) {
                if (document.querySelector('article[data-testid="tweet"]')) {
                    articleLoaded = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 500));
            }
            
            if (!articleLoaded) {
                // Hata durumunda hemen vazgeçmeyip 1 kere sayfayı yenileyerek tekrar yüklemeyi deneyelim
                let retryKey = `${storageKey}_retry_${aktifTivit}`;
                let retryResult = await new Promise(res => {
                    chrome.storage.local.get([retryKey], (val) => res(val[retryKey]));
                });
                
                if (!retryResult) {
                    printLog("Tweet yüklenemedi. Sayfa yenilenip tekrar denenecek...");
                    let setObj = {};
                    setObj[retryKey] = true;
                    await new Promise(res => {
                        chrome.storage.local.set(setObj, () => res());
                    });
                    clearInterval(sayacInterval);
                    location.reload();
                    return;
                }
                
                // Zaten 1 kere yenilenip tekrar yüklenemedi ise, retry anahtarını temizleyip geçelim
                chrome.storage.local.remove([retryKey]);

                printLog("Hata: Tweet yüklenemedi! Sıradaki tivite geçiliyor...");
                clearInterval(sayacInterval);
                if (gorev.is_server_job) {
                    // Chrome 2 (istatistik/yorum tarayıcı) tivitleri asla silindi olarak işaretlemez.
                    // Bu işlem sadece Chrome 1 (link toplama motoru) sorumluluğundadır.
                    // Yüklenemeyen tivitin eski verilerini bozmamak için null değerler gönderilir.
                    printLog("Tweet yüklenemedi. Silindi olarak İŞARETLENMİYOR, eski veriler korunuyor.");
                    gorev.combinedData.push({
                        Link: aktifTivit,
                        Date: "",
                        Username: "",
                        Views: null,
                        Likes: null,
                        Retweets: null,
                        Quotes: null,
                        Replies: null,
                        Text: null,
                        is_deleted: false
                    });
                    
                    // Shift queue and load next
                    gorev.kuyruk.shift();
                    if (gorev.kuyruk.length > 0) {
                        gorev.tivitAdimi = "basla";
                        gorev.aktifTivitUrl = gorev.kuyruk[0];
                        gorev.gecerliVeri = { ozet: null, yorumlar: [], retweets: [], quotes: [], likes: [] };
                        let updateObj = {}; updateObj[storageKey] = gorev;
                        chrome.storage.local.set(updateObj, () => {
                            window.location.href = gorev.kuyruk[0];
                        });
                    } else {
                        // Send results
                        durumText.innerHTML = `⏳ <b>Sonuçlar kaydediliyor...</b><br>Lütfen sekmeyi kapatmayın.`;
                        let submitData = {
                            action: "submitServerResult",
                            origin: gorev.server_origin,
                            job_id: gorev.job_id,
                            status: "completed",
                            data: gorev.combinedData,
                            duration_ms: Date.now() - (gorev.gorevBaslangicMs || Date.now())
                        };
                        chrome.runtime.sendMessage(submitData, (response) => {
                            chrome.storage.local.remove(storageKey, () => {
                                printLog("Tüm tweet listesi bitti. Keşfet sayfasına geri dönülüyor.");
                                location.href = "https://x.com/explore";
                            });
                        });
                    }
                } else {
                    alert("Tweet yüklenemedi. Görev iptal ediliyor.");
                    chrome.storage.local.remove(storageKey, () => {
                        location.href = "https://x.com/explore";
                    });
                }
                return;
            }
            
            let stats = tivitIstatistikleriniBul(null, {
                extractAll: false,
                extractViews: true,
                extractLikes: !!(gorev && gorev.ayarlar && (gorev.ayarlar.begeni || gorev.ayarlar.sadeceSayisalBegeni))
            });
            gorev.gecerliVeri.ozet = {
                url: aktifTivit,
                yazar: stats.yazar,
                tarih: stats.tarih,
                metin: stats.metin,
                views: stats.views,
                likes: stats.likes,
                retweets: stats.retweets,
                quotes: stats.quotes,
                replies: stats.replies
            };
            
            tivitBilgisiniYazdir(stats.tarih, stats.metin);
            izlenmeleriSunucuyaKaydet(stats, gorev, aktifTivit);
            
            let commentsMap = new Map();
            let mainTweetId = aktifTivit.match(/status\/(\d+)/)?.[1];
            
            if (gorev.ayarlar.yorum) {
                let retries = 0;
                let previousCount = 0;
                
                while (!iptalEdildi) {
                    // SPA URL Check: Check if user navigated away from the tweet
                    let currentUrl = window.location.href;
                    if (!normalizeUrl(currentUrl).startsWith(normalizeUrl(aktifTivit))) {
                        printLog("Tivitten ayrılma algılandı. Tarama durduruluyor.");
                        break;
                    }

                    // Storage task check: Check if task was aborted/deleted from storage
                    let active = await isGorevActive(storageKey);
                    if (!active) {
                        printLog("Görev iptal edildi, tarama durduruluyor.");
                        break;
                    }

                    let currentSureText = gecenSureyiBul(baslangicMs);

                    durumText.innerHTML = `
                        🤖 <b>Yorumlar Toplanıyor</b><br>
                        Kalan Tweet: <b>${gorev.kuyruk.length}</b><br>
                        ${checklistHtml("ozet_ve_yorumlar", `(${commentsMap.size})`)}
                        Geçen Süre: <b id="w-tarama-sure">${currentSureText}</b>
                    `;
                    
                    yorumlariKazı(commentsMap, mainTweetId);

                    // Spam veya gizlenmiş yorumları gösteren butonları tespit edip tıklar
                    try {
                        const buttons = document.querySelectorAll('div[role="button"], button, span');
                        for (let btn of buttons) {
                            if (btn.innerText) {
                                const text = btn.innerText.trim();
                                if (text === "Olası spam'i göster" || 
                                    text === "Show probable spam" || 
                                    text === "Daha fazla yanıt göster" || 
                                    text.includes("ek yanıtları göster") ||
                                    text.includes("Show additional replies")) {
                                    
                                    btn.click();
                                    printLog("Gizlenmiş/spam yorumları açma butonu tıklandı: " + text);
                                    await new Promise(r => setTimeout(r, 1500));
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        printLog("Spam yorum butonuna tıklanırken hata: " + e.message);
                    }
                    
                    if (commentsMap.size === previousCount) {
                        retries++;
                        if (retries >= 10) break; 
                    } else {
                        retries = 0;
                        previousCount = commentsMap.size;
                    }
                    
                    window.scrollTo(0, document.body.scrollHeight);
                    await new Promise(r => setTimeout(r, 2000));
                }
                
                gorev.gecerliVeri.yorumlar = Array.from(commentsMap.values());
            }
            
            if (iptalEdildi) {
                durdurVeTemizle(storageKey, sayacInterval);
                return;
            }
            
            // Dinamik Kontrol: Tivit sahibi ile giriş yapan kullanıcı farklı ise beğeni listesi taranmaz (Private Likes Koruması)
            chrome.storage.local.get({ auth_username: "" }, (storageRes) => {
                let loggedInUser = (storageRes.auth_username || "").trim().replace('@', '').toLowerCase();
                let tweetAuthor = (gorev.gecerliVeri.ozet?.yazar || "").trim().replace('@', '').toLowerCase();
                
                if (tweetAuthor && loggedInUser && tweetAuthor !== loggedInUser) {
                    printLog(`[GÜVENLİK] Tivit sahibi (@${tweetAuthor}) ile giriş yapan kullanıcı (@${loggedInUser}) farklı. Beğeni listesi kazıma adımı sayısal olarak geçiliyor.`);
                    gorev.ayarlar.sadeceSayisalBegeni = true;
                }

                // Determine next transition (skip likes page on server)
                if (gorev.ayarlar.rt) {
                    gorev.tivitAdimi = "retweets";
                } else if (gorev.ayarlar.alinti) {
                    gorev.tivitAdimi = "quotes";
                } else if (gorev.ayarlar.begeni && !gorev.ayarlar.sadeceSayisalBegeni && !gorev.is_server_job) {
                    gorev.tivitAdimi = "likes";
                } else {
                    gorev.tivitAdimi = "tamamla";
                }
                
                let updateObj = {}; updateObj[storageKey] = gorev;
                chrome.storage.local.set(updateObj, () => {
                    clearInterval(sayacInterval);
                    if (gorev.tivitAdimi === "tamamla") {
                        detayliTaramaYonetimi(gorev, storageKey);
                    } else {
                        window.location.href = aktifTivit + "/" + gorev.tivitAdimi;
                    }
                });
            });
        }
        
        // STEP 2: Retweets
        else if (gorev.tivitAdimi === "retweets") {
            let expectedUrl = aktifTivit + "/retweets";
            let expectedUrlAlt = aktifTivit + "/reposts";
            let normHam = normalizeUrl(hamUrl);
            if (normHam !== normalizeUrl(expectedUrl) && normHam !== normalizeUrl(expectedUrlAlt)) {
                durumText.innerHTML = `🔄 Yönlendiriliyorsunuz...`;
                window.location.href = expectedUrl;
                clearInterval(sayacInterval);
                return;
            }
            
            // Retweet listesinin yüklenmesini bekle
            let listLoaded = false;
            for (let i = 0; i < 30; i++) {
                if (iptalEdildi) break;

                // SPA URL Check: Check if user navigated away from the tweet
                let currentUrl = window.location.href;
                if (!normalizeUrl(currentUrl).startsWith(normalizeUrl(aktifTivit))) {
                    printLog("Tivitten ayrılma algılandı. Tarama durduruluyor.");
                    break;
                }

                // Storage task check: Check if task was aborted/deleted from storage
                let active = await isGorevActive(storageKey);
                if (!active) {
                    printLog("Görev iptal edildi, tarama durduruluyor.");
                    break;
                }
                
                if (document.querySelector('[data-testid="UserCell"]')) {
                    listLoaded = true;
                    break;
                }

                // Check for empty list state text
                let bodyText = document.body.innerText || "";
                if (bodyText.includes("Henüz Yeniden Gönderi yok") || 
                    bodyText.includes("Henüz yeniden gönderi yok") || 
                    bodyText.includes("No Reposts yet") || 
                    bodyText.includes("No reposts yet") ||
                    bodyText.includes("Henüz Repost yok")) {
                    printLog("Yeniden gönderi listesi boş.");
                    break;
                }

                let currentSureText = gecenSureyiBul(baslangicMs);
                durumText.innerHTML = `
                    🤖 <b>Retweetler Yükleniyor (${i+1}/30)</b><br>
                    Kalan Tweet: <b>${gorev.kuyruk.length}</b><br>
                    ${checklistHtml("retweets", "(Bekleniyor...)")}
                    Geçen Süre: <b id="w-tarama-sure">${currentSureText}</b>
                `;
                
                await new Promise(r => setTimeout(r, 500));
            }

            if (iptalEdildi) {
                durdurVeTemizle(storageKey, sayacInterval);
                return;
            }

            let rtMap = new Map();
            let retries = 0;
            let previousCount = 0;
            while (!iptalEdildi) {
                // SPA URL Check: Check if user navigated away from the tweet
                let currentUrl = window.location.href;
                if (!normalizeUrl(currentUrl).startsWith(normalizeUrl(aktifTivit))) {
                    printLog("Tivitten ayrılma algılandı. Tarama durduruluyor.");
                    break;
                }

                // Storage task check: Check if task was aborted/deleted from storage
                let active = await isGorevActive(storageKey);
                if (!active) {
                    printLog("Görev iptal edildi, tarama durduruluyor.");
                    break;
                }

                let currentSureText = gecenSureyiBul(baslangicMs);

                durumText.innerHTML = `
                    🤖 <b>Retweetler Toplanıyor</b><br>
                    Kalan Tweet: <b>${gorev.kuyruk.length}</b><br>
                    ${checklistHtml("retweets", `(${rtMap.size})`)}
                    Geçen Süre: <b id="w-tarama-sure">${currentSureText}</b>
                `;
                
                kullanıcılarıKazı(rtMap);
                
                if (rtMap.size === previousCount) {
                    retries++;
                    if (retries >= 10) break;
                } else {
                    retries = 0;
                    previousCount = rtMap.size;
                }
                
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise(r => setTimeout(r, 2000));
            }
            
            let rts = [];
            rtMap.forEach((name, handle) => { rts.push({ name, handle }); });
            gorev.gecerliVeri.retweets = rts;
            
            if (iptalEdildi) {
                durdurVeTemizle(storageKey, sayacInterval);
                return;
            }
            
            if (gorev.ayarlar.alinti) {
                gorev.tivitAdimi = "quotes";
            } else if (gorev.ayarlar.begeni && !gorev.ayarlar.sadeceSayisalBegeni && !gorev.is_server_job) {
                gorev.tivitAdimi = "likes";
            } else {
                gorev.tivitAdimi = "tamamla";
            }
            
            let updateObj = {}; updateObj[storageKey] = gorev;
            chrome.storage.local.set(updateObj, () => {
                clearInterval(sayacInterval);
                if (gorev.tivitAdimi === "tamamla") {
                    detayliTaramaYonetimi(gorev, storageKey);
                } else {
                    window.location.href = aktifTivit + "/" + gorev.tivitAdimi;
                }
            });
        }
        
        // STEP 3: Quotes
        else if (gorev.tivitAdimi === "quotes") {
            let expectedUrl = aktifTivit + "/quotes";
            if (normalizeUrl(hamUrl) !== normalizeUrl(expectedUrl)) {
                durumText.innerHTML = `🔄 Yönlendiriliyorsunuz...`;
                window.location.href = expectedUrl;
                clearInterval(sayacInterval);
                return;
            }
            
            // Alıntı listesinin yüklenmesini bekle
            let listLoaded = false;
            for (let i = 0; i < 30; i++) {
                if (iptalEdildi) break;

                // SPA URL Check: Check if user navigated away from the tweet
                let currentUrl = window.location.href;
                if (!normalizeUrl(currentUrl).startsWith(normalizeUrl(aktifTivit))) {
                    printLog("Tivitten ayrılma algılandı. Tarama durduruluyor.");
                    break;
                }

                // Storage task check: Check if task was aborted/deleted from storage
                let active = await isGorevActive(storageKey);
                if (!active) {
                    printLog("Görev iptal edildi, tarama durduruluyor.");
                    break;
                }
                
                if (document.querySelector('article[data-testid="tweet"]')) {
                    listLoaded = true;
                    break;
                }

                // Check for empty list state text
                let bodyText = document.body.innerText || "";
                if (bodyText.includes("Henüz Alıntılama yok") || 
                    bodyText.includes("Henüz alıntılama yok") || 
                    bodyText.includes("No Quotes yet") || 
                    bodyText.includes("No quotes yet") ||
                    bodyText.includes("Alıntı yok")) {
                    printLog("Alıntı listesi boş.");
                    break;
                }

                let currentSureText = gecenSureyiBul(baslangicMs);
                durumText.innerHTML = `
                    🤖 <b>Alıntılar Yükleniyor (${i+1}/30)</b><br>
                    Kalan Tweet: <b>${gorev.kuyruk.length}</b><br>
                    ${checklistHtml("quotes", "(Bekleniyor...)")}
                    Geçen Süre: <b id="w-tarama-sure">${currentSureText}</b>
                `;
                
                await new Promise(r => setTimeout(r, 500));
            }

            if (iptalEdildi) {
                durdurVeTemizle(storageKey, sayacInterval);
                return;
            }

            let quotesMap = new Map();
            let retries = 0;
            let previousCount = 0;
            while (!iptalEdildi) {
                // SPA URL Check: Check if user navigated away from the tweet
                let currentUrl = window.location.href;
                if (!normalizeUrl(currentUrl).startsWith(normalizeUrl(aktifTivit))) {
                    printLog("Tivitten ayrılma algılandı. Tarama durduruluyor.");
                    break;
                }

                // Storage task check: Check if task was aborted/deleted from storage
                let active = await isGorevActive(storageKey);
                if (!active) {
                    printLog("Görev iptal edildi, tarama durduruluyor.");
                    break;
                }

                let currentSureText = gecenSureyiBul(baslangicMs);

                durumText.innerHTML = `
                    🤖 <b>Alıntılar Toplanıyor</b><br>
                    Kalan Tweet: <b>${gorev.kuyruk.length}</b><br>
                    ${checklistHtml("quotes", `(${quotesMap.size})`)}
                    Geçen Süre: <b id="w-tarama-sure">${currentSureText}</b>
                `;
                
                alintilariKazı(quotesMap);
                
                if (quotesMap.size === previousCount) {
                    retries++;
                    if (retries >= 10) break;
                } else {
                    retries = 0;
                    previousCount = quotesMap.size;
                }
                
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise(r => setTimeout(r, 2000));
            }
            
            gorev.gecerliVeri.quotes = Array.from(quotesMap.values());
            
            if (iptalEdildi) {
                durdurVeTemizle(storageKey, sayacInterval);
                return;
            }
            
            if (gorev.ayarlar.begeni && !gorev.ayarlar.sadeceSayisalBegeni && !gorev.is_server_job) {
                gorev.tivitAdimi = "likes";
            } else {
                gorev.tivitAdimi = "tamamla";
            }
            
            let updateObj = {}; updateObj[storageKey] = gorev;
            chrome.storage.local.set(updateObj, () => {
                clearInterval(sayacInterval);
                if (gorev.tivitAdimi === "tamamla") {
                    detayliTaramaYonetimi(gorev, storageKey);
                } else {
                    window.location.href = aktifTivit + "/" + gorev.tivitAdimi;
                }
            });
        }
        
        // STEP 4: Likes
        else if (gorev.tivitAdimi === "likes") {
            if (gorev.is_server_job) {
                printLog("[GÜVENLİK] Sunucu modunda /likes aşaması atlanıyor.");
                gorev.tivitAdimi = "tamamla";
                let updateObj = {}; updateObj[storageKey] = gorev;
                chrome.storage.local.set(updateObj, () => {
                    clearInterval(sayacInterval);
                    detayliTaramaYonetimi(gorev, storageKey);
                });
                return;
            }
            
            let expectedUrl = aktifTivit + "/likes";
            if (normalizeUrl(hamUrl) !== normalizeUrl(expectedUrl)) {
                durumText.innerHTML = `🔄 Yönlendiriliyorsunuz...`;
                window.location.href = expectedUrl;
                clearInterval(sayacInterval);
                return;
            }
            
            // Beğeni listesinin yüklenmesini bekle
            let listLoaded = false;
            for (let i = 0; i < 30; i++) {
                if (iptalEdildi) break;

                // SPA URL Check: Check if user navigated away from the tweet
                let currentUrl = window.location.href;
                if (!normalizeUrl(currentUrl).startsWith(normalizeUrl(aktifTivit))) {
                    printLog("Tivitten ayrılma algılandı. Tarama durduruluyor.");
                    break;
                }

                // Storage task check: Check if task was aborted/deleted from storage
                let active = await isGorevActive(storageKey);
                if (!active) {
                    printLog("Görev iptal edildi, tarama durduruluyor.");
                    break;
                }
                
                if (document.querySelector('[data-testid="UserCell"]')) {
                    listLoaded = true;
                    break;
                }

                // Check for empty list state text
                let bodyText = document.body.innerText || "";
                if (bodyText.includes("Henüz Beğeni yok") || 
                    bodyText.includes("Henüz beğeni yok") || 
                    bodyText.includes("No Likes yet") || 
                    bodyText.includes("No likes yet") ||
                    bodyText.includes("Beğeni yok")) {
                    printLog("Beğeni listesi boş.");
                    break;
                }

                let currentSureText = gecenSureyiBul(baslangicMs);
                durumText.innerHTML = `
                    🤖 <b>Beğeniler Yükleniyor (${i+1}/30)</b><br>
                    Kalan Tweet: <b>${gorev.kuyruk.length}</b><br>
                    ${checklistHtml("likes", "(Bekleniyor...)")}
                    Geçen Süre: <b id="w-tarama-sure">${currentSureText}</b>
                `;
                
                await new Promise(r => setTimeout(r, 500));
            }

            if (iptalEdildi) {
                durdurVeTemizle(storageKey, sayacInterval);
                return;
            }

            let likesMap = new Map();
            let retries = 0;
            let previousCount = 0;
            while (!iptalEdildi) {
                // SPA URL Check: Check if user navigated away from the tweet
                let currentUrl = window.location.href;
                if (!normalizeUrl(currentUrl).startsWith(normalizeUrl(aktifTivit))) {
                    printLog("Tivitten ayrılma algılandı. Tarama durduruluyor.");
                    break;
                }

                // Storage task check: Check if task was aborted/deleted from storage
                let active = await isGorevActive(storageKey);
                if (!active) {
                    printLog("Görev iptal edildi, tarama durduruluyor.");
                    break;
                }

                let currentSureText = gecenSureyiBul(baslangicMs);

                durumText.innerHTML = `
                    🤖 <b>Beğeniler Toplanıyor</b><br>
                    Kalan Tweet: <b>${gorev.kuyruk.length}</b><br>
                    ${checklistHtml("likes", `(${likesMap.size})`)}
                    Geçen Süre: <b id="w-tarama-sure">${currentSureText}</b>
                `;
                
                kullanıcılarıKazı(likesMap);
                
                if (likesMap.size === previousCount) {
                    retries++;
                    if (retries >= 10) break;
                } else {
                    retries = 0;
                    previousCount = likesMap.size;
                }
                
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise(r => setTimeout(r, 2000));
            }
            
            let likes = [];
            likesMap.forEach((name, handle) => { likes.push({ name, handle }); });
            gorev.gecerliVeri.likes = likes;
            
            if (iptalEdildi) {
                durdurVeTemizle(storageKey, sayacInterval);
                return;
            }
            
            gorev.tivitAdimi = "tamamla";
            let updateObj = {}; updateObj[storageKey] = gorev;
            chrome.storage.local.set(updateObj, () => {
                clearInterval(sayacInterval);
                detayliTaramaYonetimi(gorev, storageKey);
            });
        }
        
        // STEP 5: Complete (Export + next)
        else if (gorev.tivitAdimi === "tamamla") {
            if (!gorev.is_server_job) {
                durumText.innerHTML = `💾 <b>Veriler Sunucuya Kaydediliyor...</b>`;
            } else {
                durumText.innerHTML = `💾 <b>Detaylı Veriler Kaydediliyor...</b>`;
            }
            etkilesimleriSunucuyaKaydet(gorev.gecerliVeri, gorev).then(() => {
                let stats = {
                    Link: gorev.aktifTivitUrl,
                    Date: gorev.gecerliVeri.ozet?.tarih || "",
                    Username: (gorev.gecerliVeri.ozet?.yazar || "").replace('@', ''),
                    Views: (gorev.collect_views == 1 || gorev.collect_views === undefined) ? (gorev.gecerliVeri.ozet?.views || "0") : null,
                    Likes: (gorev.collect_likes == 1 || (gorev.ayarlar && (gorev.ayarlar.begeni || gorev.ayarlar.sadeceSayisalBegeni))) ? (gorev.gecerliVeri.ozet?.likes || "0") : null,
                    Retweets: (gorev.collect_retweets == 1 || (gorev.ayarlar && gorev.ayarlar.rt)) ? (gorev.gecerliVeri.ozet?.retweets || "0") : null,
                    Quotes: (gorev.collect_quotes == 1 || (gorev.ayarlar && gorev.ayarlar.alinti)) ? (gorev.gecerliVeri.ozet?.quotes || "0") : null,
                    Replies: (gorev.collect_replies == 1 || (gorev.ayarlar && gorev.ayarlar.yorum)) ? (gorev.gecerliVeri.ozet?.replies || "0") : null,
                    Text: gorev.gecerliVeri.ozet?.metin || ""
                };
                if (!gorev.combinedData) {
                    gorev.combinedData = [];
                }
                gorev.combinedData.push(stats);

                gorev.kuyruk.shift();

                if (gorev.kuyruk.length > 0) {
                    gorev.tivitAdimi = "basla";
                    gorev.aktifTivitUrl = gorev.kuyruk[0];
                    gorev.gecerliVeri = { ozet: null, yorumlar: [], retweets: [], quotes: [], likes: [] };
                    let updateObj = {}; updateObj[storageKey] = gorev;
                    chrome.storage.local.set(updateObj, () => {
                        clearInterval(sayacInterval);
                        window.location.href = gorev.kuyruk[0];
                    });
                } else {
                    clearInterval(sayacInterval);
                    tivitBilgiKutusu.style.display = 'none';

                    if (gorev.is_server_job) {
                        durumText.innerHTML = `⏳ <b>Sonuçlar kaydediliyor...</b><br>Lütfen sekmeyi kapatmayın.`;
                        let submitData = {
                            action: "submitServerResult",
                            origin: gorev.server_origin,
                            job_id: gorev.job_id,
                            status: "completed",
                            data: gorev.combinedData,
                            duration_ms: Date.now() - (gorev.gorevBaslangicMs || Date.now())
                        };
                        chrome.runtime.sendMessage(submitData, (response) => {
                            chrome.storage.local.remove(storageKey, () => {
                                printLog("Tüm tweet listesi bitti. Keşfet sayfasına geri dönülüyor.");
                                location.href = "https://x.com/explore";
                            });
                        });
                    } else {
                        chrome.storage.local.get({ server_origin: "http://localhost:3012" }, (res) => {
                            const origin = gorev.server_origin || res.server_origin;

                            // Submit final detailed scan results to server
                            try {
                                chrome.runtime.sendMessage({
                                    action: "submitLocalResult",
                                    origin: origin,
                                    target_username: gorev.profilAdi || "",
                                    target_id: gorev.target_id || null,
                                    status: "completed",
                                    data: gorev.combinedData || [],
                                    settings: {
                                        collect_likes: (gorev.collect_likes == 1 || (gorev.ayarlar && (gorev.ayarlar.begeni || gorev.ayarlar.sadeceSayisalBegeni))) ? 1 : 0,
                                        collect_retweets: (gorev.collect_retweets == 1 || (gorev.ayarlar && gorev.ayarlar.rt)) ? 1 : 0,
                                        collect_quotes: (gorev.collect_quotes == 1 || (gorev.ayarlar && gorev.ayarlar.alinti)) ? 1 : 0,
                                        collect_replies: (gorev.collect_replies == 1 || (gorev.ayarlar && gorev.ayarlar.yorum)) ? 1 : 0
                                    }
                                });
                            } catch (submitErr) {
                                console.error("Failed to submit final local results to server:", submitErr);
                            }

                            durumText.innerHTML = `
                                🎉 <b>Tüm İşlemler Başarıyla Tamamlandı!</b><br><br>
                                Analiz sonuçları sisteme kaydedildi. Raporları Kullanıcı Paneli -> Son 24 Saat Taramaları altından Excel olarak indirebilirsiniz.<br>
                                <a href="${origin}/user/history#v-pills-extension" target="_blank" style="color:#1d9bf0;text-decoration:underline;font-weight:bold;margin-top:8px;display:inline-block;">📋 Geçmiş Taramalarıma Git</a>
                            `;
                        });

                        chrome.storage.local.remove(storageKey, () => {
                            console.log("Local gorev tamamlandi, storage temizlendi.");
                            if (gorev.is_stats_update) {
                                durumText.innerHTML = `🎉 <b>Güncelleme Başarıyla Tamamlandı!</b><br>Bu sekme kapatılıyor...`;
                                setTimeout(() => {
                                    chrome.runtime.sendMessage({ action: "closeActiveTab" });
                                }, 1500);
                            }
                        });

                        if (!gorev.is_stats_update) {
                            buton.innerText = "Kapat";
                            buton.style.backgroundColor = "#1d9bf0";
                            buton.disabled = false;

                            buton.onclick = () => {
                                location.reload();
                            };
                        }
                    }
                }
            }).catch(err => {
                console.error("Etkileşimleri sunucuya kaydetme hatası:", err);
            });
        }
    }

    // STATE MACHINE: Keyword / Hashtag search scraping (direct statistic collection)
    async function aramaTaramasiYonetimi(gorev, storageKey) {
        try {
            printLog("aramaTaramasiYonetimi başlatıldı...");
            if (!gorev.toplananTivitler) { gorev.toplananTivitler = []; }
            if (!gorev.tarananLinkler) { gorev.tarananLinkler = {}; }
            if (gorev.aktifAsama === undefined) {
                gorev.aktifAsama = (gorev.populerSayisi > 0) ? "populer" : "enson";
            }

            // Make widget visible
            widget.style.display = 'block';
            
            let query = gorev.searchQuery;
            let normalizedQuery = query.toLowerCase().trim().replace(/\s+/g, ' ');
            let targetType = gorev.targetType;

            let targetCount = (gorev.aktifAsama === "populer") ? gorev.populerSayisi : gorev.enSonSayisi;
            let currentTabScrapedCount = 0;

            function isExactPhraseMatch(tweetText, searchQuery) {
                if (!searchQuery) return true;
                const normalizedTweet = tweetText.toLowerCase().replace(/\s+/g, ' ');
                return normalizedTweet.includes(normalizedQuery);
            }

            function escapeHtml(str) {
                if (!str) return '';
                return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            }

            async function scanPageForTweets() {
                let articles = document.querySelectorAll('article[data-testid="tweet"]');
                let foundNew = false;

                for (let article of articles) {
                    let textEl = article.querySelector('[data-testid="tweetText"]');
                    let text = textEl ? textEl.innerText : "";
                    
                    if (!isExactPhraseMatch(text, query)) {
                        continue;
                    }

                    let linkEl = article.querySelector('a[href*="/status/"]');
                    if (!linkEl) continue;
                    let link = linkEl.getAttribute('href');
                    let fullLink = link.startsWith('http') ? link : "https://x.com" + link;
                    let cleanLink = fullLink.split('?')[0];

                    if (gorev.tarananLinkler[cleanLink]) {
                        continue;
                    }

                    let options = {
                        extractAll: false,
                        extractViews: !!gorev.ayarlar.views,
                        extractLikes: !!gorev.ayarlar.begeni,
                        extractRetweets: !!gorev.ayarlar.rt,
                        extractReplies: !!gorev.ayarlar.yorum
                    };
                    let rawStats = tivitIstatistikleriniBul(article, options);

                    let tweetData = {
                        Link: cleanLink,
                        Text: text,
                        Username: cleanLink.split('/')[3],
                        Views: rawStats.views,
                        Likes: rawStats.likes,
                        Retweets: rawStats.retweets,
                        Replies: rawStats.replies,
                        Date: new Date().toISOString()
                    };

                    let timeEl = article.querySelector('time');
                    if (timeEl) {
                        let dt = timeEl.getAttribute('datetime');
                        if (dt) tweetData.Date = dt;
                    }

                    gorev.toplananTivitler.push(tweetData);
                    gorev.tarananLinkler[cleanLink] = true;
                    currentTabScrapedCount++;
                    foundNew = true;

                    let currentSureText = gecenSureyiBul(gorev.baslangicMs);
                    durumText.innerHTML = `
                        🤖 <b>Arama Taraması Yapılıyor</b><br>
                        Hedef: <b>${escapeHtml(query)}</b> (${targetType === 'hashtag' ? 'Hashtag' : 'Anahtar Kelime'})<br>
                        Sekme: <b>${gorev.aktifAsama === 'populer' ? 'Popüler' : 'En Son'}</b><br>
                        Toplam Toplanan: <b>${gorev.toplananTivitler.length}</b> / ${gorev.populerSayisi + gorev.enSonSayisi}<br>
                        Süre: <b>${currentSureText}</b>
                    `;

                    if (gorev.toplananTivitler.length >= (gorev.populerSayisi + gorev.enSonSayisi) || currentTabScrapedCount >= targetCount) {
                        break;
                    }
                }

                return foundNew;
            }

            let scrollRetries = 0;
            let maxScrollRetries = 15;

            while (gorev.aktif) {
                let active = await isGorevActive(storageKey);
                if (!active) {
                    printLog("Görev iptal edildi, arama durduruluyor.");
                    break;
                }

                let foundNew = await scanPageForTweets();

                let totalNeeded = (gorev.aktifAsama === "populer") ? gorev.populerSayisi : gorev.enSonSayisi;
                if (currentTabScrapedCount >= totalNeeded || gorev.toplananTivitler.length >= (gorev.populerSayisi + gorev.enSonSayisi)) {
                    break;
                }

                if (!foundNew) {
                    scrollRetries++;
                    if (scrollRetries >= maxScrollRetries) {
                        printLog("Yeni tweet bulunamadı, sonlandırılıyor.");
                        break;
                    }
                } else {
                    scrollRetries = 0;
                }

                window.scrollBy(0, 800);
                await new Promise(r => setTimeout(r, 1200));
            }

            if (gorev.aktif && gorev.aktifAsama === "populer" && gorev.enSonSayisi > 0 && gorev.toplananTivitler.length < (gorev.populerSayisi + gorev.enSonSayisi)) {
                printLog("Popüler sekmesi tamamlandı, En Son sekmesine geçiliyor...");
                gorev.aktifAsama = "enson";
                
                chrome.storage.local.set({ [storageKey]: gorev }, () => {
                    const q = encodeURIComponent(query);
                    window.location.href = `https://x.com/search?q=${q}&f=live`;
                });
                return;
            }

            if (gorev.aktif) {
                printLog("Arama taraması tamamlandı, sonuçlar sunucuya gönderiliyor...");
                durumText.innerHTML = `🤖 <b>Sonuçlar Yükleniyor...</b><br>Lütfen bekleyin.`;

                chrome.storage.local.get({ server_origin: "http://localhost:3012" }, (res) => {
                    let origin = res.server_origin;
                    chrome.runtime.sendMessage({
                        action: "submitLocalResult",
                        origin: origin,
                        status: 'success',
                        target_username: query,
                        target_type: targetType,
                        data: gorev.toplananTivitler
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error("Yükleme hatası (runtime):", chrome.runtime.lastError.message);
                            durumText.innerHTML = `❌ <b>Yükleme Hatası!</b><br>Arka plan servisine bağlanılamadı.`;
                            return;
                        }
                        if (response && response.status === "success") {
                            printLog("Arama taraması yükleme yanıtı:", response);
                            durumText.innerHTML = `✅ <b>Tamamlandı!</b><br>Sonuçlar başarıyla kaydedildi.`;
                            
                            chrome.storage.local.remove(storageKey, () => {
                                setTimeout(() => {
                                    location.reload();
                                }, 1500);
                            });
                        } else {
                            let errMsg = (response && response.message) || "Sunucu hatası oluştu.";
                            console.error("Yükleme hatası:", errMsg);
                            durumText.innerHTML = `❌ <b>Yükleme Hatası!</b><br>${errMsg}`;
                        }
                    });
                });
            }

        } catch (err) {
            showError(err);
        }
    }

    // STATE MACHINE: Profile scanning management (Stage 1 of Bulk Scan)
    async function topluProfilYonetimi(gorev, storageKey) {
        try {
            printLog("topluProfilYonetimi başlatıldı...");
            if (!gorev.metinDeposu) { gorev.metinDeposu = {}; } 
            if (!gorev.statsDeposu) { gorev.statsDeposu = {}; } 
            if (!gorev.geciciKuyruk) { gorev.geciciKuyruk = []; } 
            if (!gorev.combinedData) { gorev.combinedData = []; }

            if (!gorev.gorevBaslangicMs) {
                gorev.gorevBaslangicMs = Date.now();
                let updateObj = {}; updateObj[storageKey] = gorev;
                chrome.storage.local.set(updateObj);
            }

            const startTimePerf = gorev.gorevBaslangicMs;

            tivitBilgiKutusu.style.display = 'none'; 
            
            // Check if this is a server job to update status text
            if (gorev.is_server_job) {
                let displayTarget = gorev.is_list_scrape ? `Liste: ${gorev.profilAdi.split('/lists/').pop()}` : `@${gorev.profilAdi}`;
                durumText.innerHTML = `
                    ⏳ <b>Sunucu Görevi Çalışıyor...</b><br>
                    Hedef: <b>${displayTarget}</b> (${gorev.targetIndex + 1}/${gorev.targetList.length})<br>
                    Tip: <i>${gorev.content_filter || 'Normal'}</i><br><br>
                    Geçen Süre: <b id="w-tarama-sure" style="color:#f7ba14; font-size:14px;">00:00</b>
                `;
            } else {
                let displayTarget = gorev.is_list_scrape ? `Liste: ${gorev.profilAdi.split('/lists/').pop()}` : `@${gorev.profilAdi}`;
                durumText.innerHTML = `
                    ⏳ <b>Profil/Liste Yükleniyor...</b><br>
                    ${displayTarget} tivitleri bekleniyor.<br><br>
                    Geçen Süre: <b id="w-tarama-sure" style="color:#f7ba14; font-size:14px;">00:00</b>
                `;
            }
            
            buton.innerText = "Taramayı İptal Et"; 
            buton.style.backgroundColor = "#e0245e"; 
            buton.disabled = false;
            
            let manuelDurduruldu = false; 
            buton.onclick = () => { manuelDurduruldu = true; }; 

            let sayacInterval = kronometreyiBaslat(gorev.gorevBaslangicMs);

            // Tarih kriterine uyan tweetlerin toplanması için ilk tweetlerin yüklenmesini bekle
            let profilYuklendi = false;
            printLog("Tivitlerin DOM'a yüklenmesi bekleniyor...");
            for (let i = 0; i < 30; i++) {
                if (manuelDurduruldu) break;

                // SPA URL Check: Check if user navigated away from profile/list
                let currentPath = window.location.pathname.toLowerCase();
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
                if (currentPath !== expectedPath) {
                    printLog("Profil/Liste sayfasından ayrılma algılandı. Tarama durduruluyor.");
                    break;
                }

                // Storage task check: Check if task was aborted/deleted from storage
                let active = await isGorevActive(storageKey);
                if (!active) {
                    printLog("Görev iptal edildi, tarama durduruluyor.");
                    break;
                }

                let tivitKutilari = document.querySelectorAll('article[data-testid="tweet"]');
                printLog(`Bekleme döngüsü ${i+1}/30. Bulunan tivit kutusu: ${tivitKutilari.length}`);
                if (tivitKutilari.length > 0) {
                    profilYuklendi = true;
                    break;
                }
                await new Promise(r => setTimeout(r, 500));
            }

            if (manuelDurduruldu) {
                printLog("İşlem kullanıcı tarafından durduruldu.");
                if (gorev.is_server_job) {
                    // Report failure to server
                    chrome.runtime.sendMessage({
                        action: "submitServerResult",
                        origin: gorev.server_origin,
                        job_id: gorev.job_id,
                        status: "failed",
                        error: "İşlem sunucu veya kullanıcı tarafından iptal edildi."
                    });
                }
                durdurVeTemizle(storageKey, sayacInterval, gorev.server_origin);
                return;
            }

            if (!profilYuklendi) {
                printLog("Hata: Tivitler süre aşımı nedeniyle yüklenemedi.");
                clearInterval(sayacInterval);
                if (gorev.is_server_job) {
                    chrome.runtime.sendMessage({
                        action: "submitServerResult",
                        origin: gorev.server_origin,
                        job_id: gorev.job_id,
                        status: "failed",
                        error: "Profil tivitleri yüklenemedi veya X.com oturumu kapalı."
                    });
                } else {
                    alert("Profil tivitleri yüklenemedi. Görev iptal ediliyor.");
                }
                chrome.storage.local.remove(storageKey, () => {
                    location.href = "https://x.com/explore";
                });
                return;
            }

            // Tivitler yüklendi, şimdi tarama durumunu güncelle ve başla
            printLog("Tivitler yüklendi. Tarama başlatılıyor...");
            if (gorev.is_server_job) {
                let displayTarget = gorev.is_list_scrape ? `Liste: ${gorev.profilAdi.split('/lists/').pop()}` : `@${gorev.profilAdi}`;
                durumText.innerHTML = `
                    ⏳ <b>Sunucu Görevi Taraması...</b><br>
                    Hedef: <b>${displayTarget}</b> (${gorev.targetIndex + 1}/${gorev.targetList.length})<br><br>
                    Uyan Tweet: <b id="w-tarama-adet" style="color:#1d9bf0; font-size:14px;">${gorev.geciciKuyruk.length}</b> adet.<br>
                    Geçen Süre: <b id="w-tarama-sure" style="color:#f7ba14; font-size:14px;">00:00</b><br><br>
                    <span style="font-size:11px;color:#8899a6;">Aşağı doğru taranıyor...</span>
                `;
            } else {
                let displayTarget = gorev.is_list_scrape ? `Liste: ${gorev.profilAdi.split('/lists/').pop()}` : `@${gorev.profilAdi}`;
                durumText.innerHTML = `
                    ⏳ <b>Profil/Liste Ön Taraması...</b><br>
                    ${displayTarget} tivitleri doğruluk moduyla taranıyor.<br><br>
                    Uyan Tweet: <b id="w-tarama-adet" style="color:#1d9bf0; font-size:14px;">${gorev.geciciKuyruk.length}</b> adet.<br>
                    Geçen Süre: <b id="w-tarama-sure" style="color:#f7ba14; font-size:14px;">00:00</b><br><br>
                    <span style="font-size:11px;color:#8899a6;">Aşağı doğru taranıyor...</span>
                `;
                buton.innerText = "Taramayı Bitir ve Onayla"; 
                buton.style.backgroundColor = "#1d9bf0"; 
                buton.onclick = () => { manuelDurduruldu = true; }; 
            }

            let bulunanLinkler = new Set(gorev.geciciKuyruk); 
            let consecutiveOldTweets = 0; 
            let consecutiveOldRetweets = 0; 
            let sonScrollY = window.scrollY; 
            let hareketsizAdimSayaci = 0; 

            // Spoof hidden window / active state to prevent throttling
            try {
                Object.defineProperty(document, 'hidden', {get: function() { return false; }, configurable: true});
                Object.defineProperty(document, 'visibilityState', {get: function() { return 'visible'; }, configurable: true});
                window.dispatchEvent(new Event('focus'));
            } catch(e){}

            const tivitGozlemci = new MutationObserver(() => {
                let tivitKutilari = document.querySelectorAll('article[data-testid="tweet"]'); 
                tivitKutilari.forEach(kutu => {
                    if (kutu.getAttribute('data-react-tagged') !== 'true') return;

                    let linkElement = kutu.querySelector('a[href*="/status/"]'); 
                    if (!linkElement) return;

                    let href = linkElement.getAttribute('href'); 
                    let match = href.match(/\/([^\/]+)\/status\/(\d+)/); 
                    
                    if (match) {
                        let tivitSahibi = kutu.getAttribute('data-author-username') || match[1].toLowerCase(); 
                        let tivitId = kutu.getAttribute('data-tweet-id') || match[2]; 
                        let tivitUrl = `${window.location.origin}/${match[1]}/status/${tivitId}`; 

                        let isRt = kutu.getAttribute('data-is-retweet') === 'true';
                        let isSelfRt = kutu.getAttribute('data-is-self-retweet') === 'true';
                        let isReply = kutu.getAttribute('data-is-reply') === 'true';
                        let replyTo = kutu.getAttribute('data-reply-to') || "";
                        let isPinned = false;

                        // Pinned check via socialContext text
                        let socialCtxEl = kutu.querySelector('[data-testid="socialContext"]');
                        if (socialCtxEl) {
                            let text = socialCtxEl.innerText.toLowerCase();
                            if (text.includes("socialContext") || text.includes("sabit") || text.includes("pinned") || text.includes("épinglé")) {
                                isPinned = true;
                            }
                        }

                        let tivitMs = tivitIdZamaniBul(tivitId); 
                        if (tivitMs) {
                            if (tivitMs >= gorev.baslangicMs && tivitMs <= gorev.bitisMs) { 
                                if (!isPinned) {
                                    consecutiveOldTweets = 0;
                                    consecutiveOldRetweets = 0;
                                }

                                // Apply filters
                                let keep = true;

                                // 1. Self Retweet check: always skip
                                if (isRt && isSelfRt) {
                                    keep = false;
                                }

                                // 2. Content Filters
                                let filter = gorev.content_filter || 'none';
                                if (gorev.is_list_scrape) {
                                    if (filter === 'none') {
                                        if (isRt || isReply) keep = false;
                                    } else if (filter === 'only_replies') {
                                        if (isRt || !isReply) keep = false;
                                    } else if (filter === 'only_retweets') {
                                        if (!isRt) keep = false;
                                    } else if (filter === 'include_retweets') {
                                        if (isReply) keep = false;
                                    }
                                } else {
                                    if (filter === 'none') {
                                        if (isRt || isReply) keep = false;
                                    } else if (filter === 'only_replies') {
                                        if (isRt) keep = false;
                                        if (!isReply) keep = false;
                                        // Exclude self-replies / thread continuations
                                        if (isReply && replyTo === gorev.profilAdi.toLowerCase()) {
                                            keep = false;
                                        }
                                    } else if (filter === 'only_retweets') {
                                        if (!isRt) keep = false;
                                    } else if (filter === 'include_retweets') {
                                        if (isReply) keep = false;
                                    }
                                }

                                // 3. Keyword filter
                                if (keep && gorev.search_keyword) {
                                    let textContent = (kutu.querySelector('[data-testid="tweetText"]')?.innerText || "").toLowerCase();
                                    let keyword = gorev.search_keyword.toLowerCase();
                                    let orGroups = keyword.split(';');
                                    let isMatch = false;
                                    for (let group of orGroups) {
                                        group = group.trim();
                                        if (!group) continue;
                                        let andParts = group.split(',');
                                        let groupMatch = true;
                                        for (let part of andParts) {
                                            part = part.trim();
                                            if (part && !textContent.includes(part)) {
                                                groupMatch = false;
                                                break;
                                            }
                                        }
                                        if (groupMatch) {
                                            isMatch = true;
                                            break;
                                        }
                                    }
                                    if (!isMatch) keep = false;
                                }

                                if (keep) {
                                    if (!gorev.metinDeposu[tivitUrl]) { 
                                        let metinAlani = kutu.querySelector('[data-testid="tweetText"]'); 
                                        let yaziMetni = metinAlani ? (metinAlani.innerText || metinAlani.textContent || "") : "Metin Yok/Medya."; 
                                        gorev.metinDeposu[tivitUrl] = yaziMetni.trim(); 
                                    }

                                    if (!gorev.statsDeposu[tivitUrl]) {
                                        let stats = tivitIstatistikleriniBul(kutu, {
                                            extractAll: false,
                                            extractViews: (gorev.collect_views == 1 || gorev.collect_views === undefined),
                                            extractLikes: (gorev.collect_likes == 1 || (gorev.ayarlar && (gorev.ayarlar.begeni || gorev.ayarlar.sadeceSayisalBegeni))),
                                            extractRetweets: (gorev.collect_retweets == 1 || (gorev.ayarlar && gorev.ayarlar.rt)),
                                            extractQuotes: (gorev.collect_quotes == 1 || (gorev.ayarlar && gorev.ayarlar.alinti)),
                                            extractReplies: (gorev.collect_replies == 1 || (gorev.ayarlar && gorev.ayarlar.yorum))
                                        });
                                        gorev.statsDeposu[tivitUrl] = {
                                            Views: (gorev.collect_views == 1 || gorev.collect_views === undefined) ? (stats.views || "0") : null,
                                            Likes: (gorev.collect_likes == 1 || (gorev.ayarlar && (gorev.ayarlar.begeni || gorev.ayarlar.sadeceSayisalBegeni))) ? (stats.likes || "0") : null,
                                            Retweets: (gorev.collect_retweets == 1 || (gorev.ayarlar && gorev.ayarlar.rt)) ? (stats.retweets || "0") : null,
                                            Quotes: (gorev.collect_quotes == 1 || (gorev.ayarlar && gorev.ayarlar.alinti)) ? (stats.quotes || "0") : null,
                                            Replies: (gorev.collect_replies == 1 || (gorev.ayarlar && gorev.ayarlar.yorum)) ? (stats.replies || "0") : null,
                                            Text: stats.metin || ""
                                        };
                                    }

                                    if (!bulunanLinkler.has(tivitUrl)) { 
                                        bulunanLinkler.add(tivitUrl); 
                                        gorev.geciciKuyruk = Array.from(bulunanLinkler); 
                                        
                                        let adetEl = document.getElementById('w-tarama-adet');
                                        if (adetEl) { adetEl.innerText = gorev.geciciKuyruk.length; }
                                        
                                        let updateObj = {}; updateObj[storageKey] = gorev;
                                        chrome.storage.local.set(updateObj);

                                        // Server job status updates
                                        if (gorev.is_server_job) {
                                            chrome.runtime.sendMessage({
                                                action: "updateServerStatus",
                                                origin: gorev.server_origin,
                                                job_id: gorev.job_id,
                                                current: gorev.targetIndex + 1,
                                                total: gorev.targetList.length,
                                                last_url: gorev.profilAdi
                                            });
                                        }
                                    }
                                }
                            }
                            else if (tivitMs < gorev.baslangicMs) { 
                                if (!isPinned) {
                                    if (isRt) {
                                        consecutiveOldRetweets++;
                                    } else {
                                        consecutiveOldTweets++;
                                    }
                                } 
                            }
                        }
                    }
                });
            });

            tivitGozlemci.observe(document.body, { childList: true, subtree: true }); 

            while (!manuelDurduruldu) {
                // SPA URL Check: Check if user navigated away from profile/list
                let currentPath = window.location.pathname.toLowerCase();
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
                if (currentPath !== expectedPath) {
                    printLog("Profil/Liste sayfasından ayrılma algılandı. Tarama durduruluyor.");
                    break;
                }

                // Storage task check: Check if task was aborted/deleted from storage
                let active = await isGorevActive(storageKey);
                if (!active) {
                    printLog("Görev iptal edildi, tarama durduruluyor.");
                    break;
                }

                window.scrollBy(0, 350); 
                await new Promise(r => setTimeout(r, 500)); 

                if (window.scrollY === sonScrollY) { 
                    hareketsizAdimSayaci++; 
                    if (hareketsizAdimSayaci % 5 === 0 && hareketsizAdimSayaci < 20) { 
                        window.scrollBy(0, -200); 
                        await new Promise(r => setTimeout(r, 400)); 
                    }
                    if (hareketsizAdimSayaci >= 20) { break; } 
                } else {
                    hareketsizAdimSayaci = 0; 
                    sonScrollY = window.scrollY; 
                }

                // Chronological stopping safety boundaries
                if (consecutiveOldTweets >= 10 || consecutiveOldRetweets >= 40) {
                    printLog(`Başlangıç tarihinden eski içeriklere ulaşıldı (Kendi: ${consecutiveOldTweets}, RT: ${consecutiveOldRetweets}). Durduruluyor.`);
                    break;
                }
            }

            clearInterval(sayacInterval);
            tivitGozlemci.disconnect(); 

            // --- SERVER JOB TRANSITION ---
            if (gorev.is_server_job) {
                printLog(`Profil bitti: @${gorev.profilAdi}. Toplanan: ${gorev.geciciKuyruk.length}`);
                
                // Format results for the current target
                let currentResults = gorev.geciciKuyruk.map(link => {
                    let id = link.split('/status/')[1];
                    let stats = (gorev.statsDeposu && gorev.statsDeposu[link]) ? gorev.statsDeposu[link] : {
                        Views: (gorev.collect_views == 1 || gorev.collect_views === undefined) ? "0" : null,
                        Likes: (gorev.collect_likes == 1 || (gorev.ayarlar && (gorev.ayarlar.begeni || gorev.ayarlar.sadeceSayisalBegeni))) ? "0" : null,
                        Retweets: (gorev.collect_retweets == 1 || (gorev.ayarlar && gorev.ayarlar.rt)) ? "0" : null,
                        Quotes: (gorev.collect_quotes == 1 || (gorev.ayarlar && gorev.ayarlar.alinti)) ? "0" : null,
                        Replies: (gorev.collect_replies == 1 || (gorev.ayarlar && gorev.ayarlar.yorum)) ? "0" : null,
                        Text: ""
                    };
                    return {
                        Link: link,
                        DateMs: tivitIdZamaniBul(id),
                        Username: link.split('/status/')[0].split('/').pop(),
                        Views: stats.Views,
                        Likes: stats.Likes,
                        Retweets: stats.Retweets,
                        Quotes: stats.Quotes,
                        Replies: stats.Replies,
                        Text: stats.Text
                    };
                });

                // Append to combined list
                gorev.combinedData = gorev.combinedData.concat(currentResults);

                if (gorev.targetIndex + 1 < gorev.targetList.length) {
                    // Proceed to next target profile
                    gorev.targetIndex++;
                    gorev.profilAdi = gorev.targetList[gorev.targetIndex];
                    gorev.geciciKuyruk = []; // Reset queue for next target

                    let updateObj = {}; updateObj[storageKey] = gorev;
                    chrome.storage.local.set(updateObj, () => {
                        let nextUrl = "";
                        if (gorev.is_list_scrape) {
                            nextUrl = gorev.profilAdi;
                            printLog(`Sıradaki listeye yönlendiriliyor: ${gorev.profilAdi}...`);
                        } else {
                            nextUrl = `https://x.com/${gorev.profilAdi}`;
                            if (gorev.content_filter === "only_replies") {
                                nextUrl = `https://x.com/${gorev.profilAdi}/with_replies`;
                            }
                            printLog(`Sıradaki profile yönlendiriliyor: @${gorev.profilAdi}...`);
                        }
                        location.href = nextUrl;
                    });
                    return;
                }

                // All targets completed, submit combined results to Flask
                durumText.innerHTML = `⏳ <b>Sonuçlar kaydediliyor...</b><br>Lütfen sekmeyi kapatmayın.`;
                let submitData = {
                    action: "submitServerResult",
                    origin: gorev.server_origin,
                    job_id: gorev.job_id,
                    status: "completed",
                    data: gorev.combinedData,
                    duration_ms: Date.now() - startTimePerf
                };
                chrome.runtime.sendMessage(submitData, (response) => {
                    chrome.storage.local.remove(storageKey, () => {
                        printLog("Tüm hedefler bitti. Keşfet sayfasına geri dönülüyor.");
                        location.href = "https://x.com/explore";
                    });
                });
                return;
            }

            // Submit profile scan results to server immediately so they register in user history
            chrome.storage.local.get({ server_origin: "http://localhost:3012" }, (res) => {
                const origin = gorev.server_origin || res.server_origin;
                try {
                    let localData = (gorev.geciciKuyruk || []).map(link => {
                        let id = link.split('/status/')[1];
                        let stats = (gorev.statsDeposu && gorev.statsDeposu[link]) ? gorev.statsDeposu[link] : {
                            Views: (gorev.collect_views == 1 || gorev.collect_views === undefined) ? "0" : null,
                            Likes: (gorev.collect_likes == 1 || (gorev.ayarlar && (gorev.ayarlar.begeni || gorev.ayarlar.sadeceSayisalBegeni))) ? "0" : null,
                            Retweets: (gorev.collect_retweets == 1 || (gorev.ayarlar && gorev.ayarlar.rt)) ? "0" : null,
                            Quotes: (gorev.collect_quotes == 1 || (gorev.ayarlar && gorev.ayarlar.alinti)) ? "0" : null,
                            Replies: (gorev.collect_replies == 1 || (gorev.ayarlar && gorev.ayarlar.yorum)) ? "0" : null,
                            Text: ""
                        };
                        return {
                            Link: link,
                            DateMs: tivitIdZamaniBul(id),
                            Username: link.split('/status/')[0].split('/').pop(),
                            Views: stats.Views,
                            Likes: stats.Likes,
                            Retweets: stats.Retweets,
                            Quotes: stats.Quotes,
                            Replies: stats.Replies,
                            Text: stats.Text
                        };
                    });

                    chrome.runtime.sendMessage({
                        action: "submitLocalResult",
                        origin: origin,
                        target_username: gorev.profilAdi,
                        status: "completed",
                        data: localData,
                        settings: {
                            collect_likes: (gorev.collect_likes == 1 || (gorev.ayarlar && (gorev.ayarlar.begeni || gorev.ayarlar.sadeceSayisalBegeni))) ? 1 : 0,
                            collect_retweets: (gorev.collect_retweets == 1 || (gorev.ayarlar && gorev.ayarlar.rt)) ? 1 : 0,
                            collect_quotes: (gorev.collect_quotes == 1 || (gorev.ayarlar && gorev.ayarlar.alinti)) ? 1 : 0,
                            collect_replies: (gorev.collect_replies == 1 || (gorev.ayarlar && gorev.ayarlar.yorum)) ? 1 : 0
                        }
                    });
                } catch (submitErr) {
                    console.error("Failed to submit profile scan results to server:", submitErr);
                }
            });

            // --- NORMAL LOCAL SCAN COMPLETION (SHOW CONFIRMATION POPUP) ---
            durumText.innerHTML = `
                ✅ <b>Profil Taraması Tamamlandı!</b><br><br>
                Tarih kriterlerine uyan toplam tweet: <b style="color:#1d9bf0; font-size:14px;">${gorev.geciciKuyruk.length}</b> adet.<br><br>
                Detaylı kazıma ve rapor oluşturma aşamasına geçmek istiyor musunuz?
            `;

            // Hide main button
            buton.style.display = 'none';

            // Create horizontal split buttons container
            const onayKutusu = document.createElement('div');
            onayKutusu.id = 'w-onay-kutusu';
            onayKutusu.style.cssText = `display: flex; gap: 8px; margin-top: 10px; width: 100%; box-sizing: border-box;`;

            const evetButon = document.createElement('button');
            evetButon.innerText = "Evet, Başla";
            evetButon.style.cssText = `
                flex: 1; color: #fff; border: none; padding: 11px; font-weight: bold; 
                font-size: 12px; border-radius: 99px; cursor: pointer; background-color: #00ba7c;
                transition: background 0.2s; text-align: center;
            `;

            const hayirButon = document.createElement('button');
            hayirButon.innerText = "İptal Et";
            hayirButon.style.cssText = `
                flex: 1; color: #fff; border: none; padding: 11px; font-weight: bold; 
                font-size: 12px; border-radius: 99px; cursor: pointer; background-color: #e0245e;
                transition: background 0.2s; text-align: center;
            `;

            onayKutusu.appendChild(evetButon);
            onayKutusu.appendChild(hayirButon);
            widget.appendChild(onayKutusu);

            evetButon.onclick = () => {
                onayKutusu.remove();
                buton.style.display = 'block';

                if (gorev.geciciKuyruk.length === 0) { 
                    alert("Kuyruk boş."); 
                    chrome.storage.local.remove(storageKey);
                    location.reload(); 
                    return;
                }
                gorev.kuyruk = gorev.geciciKuyruk; 
                gorev.asama = "detayli_tarama"; 
                gorev.tivitAdimi = "basla";
                gorev.aktifTivitUrl = gorev.kuyruk[0];
                gorev.gecerliVeri = { ozet: null, yorumlar: [], retweets: [], quotes: [], likes: [] };
                
                let updateObj = {}; updateObj[storageKey] = gorev;
                chrome.storage.local.set(updateObj, () => {
                    window.location.href = gorev.kuyruk[0]; 
                });
            };

            hayirButon.onclick = () => {
                onayKutusu.remove();
                buton.style.display = 'block';
                chrome.storage.local.remove(storageKey, () => {
                    location.reload(); 
                });
            };
        } catch (e) {
            showError(e);
        }
    }

    // UI State 0: Locked widget renderer
    function renderLockedWidget() {
        try {
            printLog("renderLockedWidget çağrıldı...");
            
            const oldCb = document.getElementById('w-cb-container');
            if (oldCb) oldCb.remove();
            
            durumText.style.color = "#ff4d4f";
            durumText.innerHTML = `
                <div style="text-align: center; padding: 10px 0;">
                    <div style="font-size: 24px; margin-bottom: 8px;">🔒</div>
                    <div style="font-weight: bold; margin-bottom: 6px; font-size: 13px; color: var(--w-text);">Eklenti Kilitli</div>
                    <div style="font-size: 11px; line-height: 1.4; color: var(--w-text-muted);">
                        Eklentiyi kullanabilmek için geçerli bir kullanıcı girişi gerekmektedir. Lütfen önce panele giriş yapın.
                    </div>
                </div>
            `;
            
            buton.innerText = "🔑 Giriş Paneline Git";
            buton.style.backgroundColor = '#1d9bf0';
            buton.disabled = false;
            
            buton.onclick = () => {
                chrome.storage.local.get({ server_origin: "http://localhost:3012" }, (res) => {
                    window.open(`${res.server_origin}/user/login`, "_blank");
                });
            };
        } catch (e) {
            showError(e);
        }
    }

    // UI State 1: Idle widget renderer
    function renderIdleWidget(storageKey) {
        try {
            printLog("renderIdleWidget çağrıldı...");
            
            const oldCb = document.getElementById('w-cb-container');
            if (oldCb) oldCb.remove();
            
            chrome.storage.local.get({
                server_origin: "http://localhost:3012"
            }, (res) => {
                let hostIP = "localhost";
                try {
                    hostIP = new URL(res.server_origin).hostname;
                } catch(e){}
                
                durumText.innerHTML = `🛡️ <b>GörüntüX</b><br>
                                       Durum: <b>Bağlantı Hazır ✔️</b><br>
                                       Sunucu: <b>${hostIP}</b>`;
                
                buton.innerText = "Tekil Word Raporu Üret";
                buton.style.backgroundColor = '#1d9bf0'; // X Blue color
                buton.disabled = false;
                
                buton.onclick = async () => {
                    buton.disabled = true;
                    buton.innerText = "⏳ Hazırlanıyor...";
                    
                    const urlMatch = window.location.href.split('?')[0].match(/status\/(\d+)/);
                    const tweetId = urlMatch ? urlMatch[1] : null;
                    let article = null;
                    const articles = document.querySelectorAll('article[data-testid="tweet"]');
                    if (tweetId) {
                        for (const art of articles) {
                            if (art.querySelector(`a[href*="/status/${tweetId}"]`)) {
                                article = art;
                                break;
                            }
                        }
                        if (!article) {
                            for (const art of articles) {
                                const timeEl = art.querySelector('time');
                                if (timeEl && !timeEl.closest('a')) {
                                    article = art;
                                    break;
                                }
                            }
                        }
                    }
                    if (!article && articles.length > 0) {
                        article = articles[0];
                    }
                    
                    if (!article) {
                        alert("Tweet içeriği sayfada bulunamadı!");
                        buton.disabled = false;
                        buton.innerText = "Tekil Word Raporu Üret";
                        return;
                    }
                    
                    let accountName = article.getAttribute('data-author-name') || "";
                    let username = article.getAttribute('data-author-username') || "";
                    
                    if (!accountName || !username) {
                        const userNameEl = article.querySelector('[data-testid="User-Name"]');
                        if (userNameEl) {
                            const spans = userNameEl.querySelectorAll('span');
                            if (spans.length > 0) {
                                accountName = spans[0].innerText;
                            }
                            for (let span of spans) {
                                if (span.innerText.startsWith('@')) {
                                    username = span.innerText;
                                    break;
                                }
                            }
                        }
                    }
                    
                    if (username && !username.startsWith('@')) {
                        username = '@' + username;
                    }
                    
                    // Tweeti viewport tepesine hizala (zoom YOK — yapı bozulmaz)
                    // html2canvas ile tüm tiviti yakala (viewport bağımsız)
                    article.scrollIntoView({ block: 'start', behavior: 'instant' });
                    await new Promise(r => setTimeout(r, 600));

                    const screenshotData = await captureArticle(article) || "";

                    chrome.runtime.sendMessage({
                        action: "generateSingleWord",
                        origin: res.server_origin,
                        tweet_url: window.location.href.split('?')[0],
                        account_name: accountName,
                        username: username,
                        screenshot: screenshotData
                    }, (genRes) => {
                        buton.disabled = false;
                        buton.innerText = "Tekil Word Raporu Üret";
                        if (genRes && genRes.status === "success" && genRes.download_url) {
                            window.open(genRes.download_url, '_blank');
                        } else {
                            alert("Rapor üretilirken hata oluştu: " + (genRes ? genRes.message : "yanıt yok"));
                        }
                    });
                };
            });
        } catch (e) {
            showError(e);
        }
    }

    function isVersionOlder(local, latest) {
        const localParts = (local || '').split('.').map(Number);
        const latestParts = (latest || '').split('.').map(Number);
        for (let i = 0; i < Math.max(localParts.length, latestParts.length); i++) {
            const localVal = localParts[i] || 0;
            const latestVal = latestParts[i] || 0;
            if (localVal < latestVal) return true;
            if (localVal > latestVal) return false;
        }
        return false;
    }

    function renderVersionLockedWidget(localVersion, latestVersion) {
        try {
            printLog("renderVersionLockedWidget çağrıldı...");
            
            const oldCb = document.getElementById('w-cb-container');
            if (oldCb) oldCb.remove();
            
            durumText.style.color = "#ff4d4f";
            durumText.innerHTML = `
                <div style="text-align: center; padding: 10px 0;">
                    <div style="font-size: 24px; margin-bottom: 8px;">❌</div>
                    <div style="font-weight: bold; margin-bottom: 6px; font-size: 13px; color: var(--w-text);">Güncelleme Gerekli</div>
                    <div style="font-size: 11px; line-height: 1.4; color: var(--w-text-muted);">
                        Eklenti sürümünüz güncel değil! <br>
                        Sizdeki: <b>v${localVersion}</b>, Güncel: <b>v${latestVersion}</b> <br><br>
                        Taramaya devam edebilmek için lütfen güncel eklentiyi indirin ve tarayıcınızda yenileyin.
                    </div>
                </div>
            `;
            
            buton.innerText = "📥 Eklentiyi İndir";
            buton.style.backgroundColor = '#e0245e';
            buton.disabled = false;
            
            buton.onclick = () => {
                chrome.storage.local.get({ server_origin: "http://localhost:3012" }, (res) => {
                    window.open(`${res.server_origin}/x-rapor-arti`, "_blank");
                });
            };
        } catch (e) {
            showError(e);
        }
    }

    // STATE MACHINE: Word Report scraping management
    async function wordTaramaYonetimi(gorev, storageKey) {
        try {
            let hamUrl = window.location.href.split('?')[0];
            let activeTask = gorev.kuyruk[0];
            
            if (!activeTask) {
                durumText.innerHTML = `🎉 <b>Tüm Linkler Tarandı!</b><br>Word Raporunu panel üzerinden indirebilirsiniz.`;
                buton.innerText = "Kapat";
                buton.disabled = false;
                buton.style.backgroundColor = '#1d9bf0';
                buton.onclick = () => {
                    chrome.storage.local.remove(storageKey, () => {
                        location.reload();
                    });
                };
                return;
            }
            
            let activeUrl = activeTask.url || activeTask;
            let isProfileTask = activeTask && activeTask.type === "profile_header" && !activeUrl.includes('/p/') && !activeUrl.includes('/reel/');
            
            if (normalizeUrl(hamUrl) !== normalizeUrl(activeUrl)) {
                durumText.innerHTML = `🔄 Yönlendiriliyorsunuz...`;
                // Instagram dahil tüm gönderiler doğrudan (embed olmadan) normal sayfada açılır.
                setTimeout(() => { window.location.href = activeUrl; }, 100);
                return;
            }
            
            buton.innerText = "🛑 Taramayı Durdur";
            buton.style.backgroundColor = "#e0245e";
            buton.onclick = () => {
                durdurVeTemizle(storageKey, null, gorev.server_origin);
            };

            // CASE 1: Profile Header Capture Task
            if (isProfileTask) {
                const isInstagram = window.location.hostname.includes('instagram.com');
                let profileLoaded = false;
                for (let i = 0; i < 60; i++) {
                    if (isInstagram) {
                        const hasIgHeader = document.querySelector('header');
                        const hasIgMain = document.querySelector('main[role="main"]') || document.querySelector('main');
                        if (hasIgHeader && hasIgMain) {
                            profileLoaded = true;
                            break;
                        }
                    } else {
                        if (document.querySelector('[data-testid="primaryColumn"]')) {
                            profileLoaded = true;
                            break;
                        }
                    }
                    await new Promise(r => setTimeout(r, 500));
                }
                
                if (!profileLoaded) {
                    printLog("Hata: Profil yüklenemedi! Bir sonrakine geçiliyor...");
                    gorev.kuyruk.shift();
                    let updateObj = {}; updateObj[storageKey] = gorev;
                    chrome.storage.local.set(updateObj, () => {
                        if (gorev.kuyruk.length > 0) {
                            const nextUrl = gorev.kuyruk[0].url || gorev.kuyruk[0];
                            let isNextUrlInstagram = nextUrl.includes('instagram.com');
                            if (isNextUrlInstagram) {
                                // Instagram dahil tüm gönderiler doğrudan (embed olmadan) normal sayfada açılır.
                                setTimeout(() => { window.location.href = nextUrl; }, 100);
                            } else {
                                setTimeout(() => { window.location.href = nextUrl; }, 100);
                            }
                        } else {
                            location.reload();
                        }
                    });
                    return;
                }
                
                let primaryCol = null;
                if (isInstagram) {
                    primaryCol = document.querySelector('.Embed') || document.querySelector('article') || document.querySelector('main[role="main"]') || document.querySelector('main') || document.body;
                } else {
                    primaryCol = document.querySelector('[data-testid="primaryColumn"]');
                }

                await new Promise(r => setTimeout(r, 800));
                
                durumText.innerHTML = `🤖 <b>Görsel Alınıyor...</b><br>Kalan: <b>${gorev.kuyruk.length}</b>`;
                
                let screenshotData = "";
                try {
                    screenshotData = await captureArticle(primaryCol) || "";
                } catch(e) {}

                if (!screenshotData) {
                    await new Promise(r => setTimeout(r, 1500));
                    try {
                        screenshotData = await captureArticle(primaryCol) || "";
                    } catch(e) {}
                }
                
                if (!gorev.combinedData) {
                    gorev.combinedData = [];
                }
                let extractedUser = "";
                if (activeTask && activeTask.username) {
                    extractedUser = activeTask.username;
                } else if (isInstagram) {
                    const match = document.title.match(/^([^ ]+) on Instagram/);
                    if (match) {
                        extractedUser = "@" + match[1];
                    } else {
                        extractedUser = "@instagram_user";
                    }
                }
                let resItem = {
                    link: activeUrl,
                    account_name: extractedUser,
                    username: extractedUser,
                    screenshot: screenshotData,
                    is_profile: true
                };
                gorev.combinedData.push(resItem);
                
                gorev.kuyruk.shift();
                
                if (gorev.kuyruk.length > 0) {
                    const totalCount = (gorev.total_count) || (gorev.combinedData.length + gorev.kuyruk.length);
                    const progress = gorev.combinedData.length;
                    const nextUrl = gorev.kuyruk[0].url || gorev.kuyruk[0];
                    
                    swSendReliable({
                        action: "submitWordResult",
                        origin: gorev.server_origin || "http://localhost:3012",
                        job_id: gorev.job_id,
                        results: [xStripForServer(resItem, gorev)],
                        final: false
                    }, (response) => {
                        swSendReliable({
                            action: "updateWordProgress",
                            origin: gorev.server_origin || "http://localhost:3012",
                            job_id: gorev.job_id,
                            current: progress,
                            total: totalCount
                        }, () => {
                            let nextUpdate = {}; nextUpdate[storageKey] = gorev;
                            chrome.storage.local.set(nextUpdate, () => {
                                window.location.href = nextUrl;
                            });
                        });
                    });
                } else {
                    const progress = gorev.combinedData.length;
                    durumText.innerHTML = `⏳ <b>Sonuçlar kaydediliyor...</b><br>Lütfen sekmeyi kapatmayın.`;
                    
                    swSendReliable({
                        action: "submitWordResult",
                        origin: gorev.server_origin || "http://localhost:3012",
                        job_id: gorev.job_id,
                        results: [xStripForServer(resItem, gorev)],
                        final: true
                    }, () => {
                        swSendReliable({
                            action: "updateWordProgress",
                            origin: gorev.server_origin || "http://localhost:3012",
                            job_id: gorev.job_id,
                            current: progress,
                            total: progress
                        }, () => {
                            chrome.storage.local.remove(storageKey, () => {
                                chrome.runtime.sendMessage({
                                    action: "completeJobAndFocusPanel",
                                    origin: gorev.server_origin
                                });
                            });
                        });
                    });
                }
                return;
            }

            // CASE 2: Tweet Article Capture Task
            const isInstagram = window.location.hostname.includes('instagram.com');

            // --- Faz FB-1 GUVENLIK KAPISI: Facebook YAKALAMA HENUZ YOK (Faz 2'de gelecek) ---
            // Faz 1'de FB linkleri kuyruga girebiliyor (havuz/gruplama/Baslik 1 icin calisir),
            // ama widget'ta FB yolu olmadigindan asagidaki dongu X seciciyi
            // (article[data-testid="tweet"]) arar, FB'de ASLA bulamaz -> "Tweet yuklenemedi"
            // -> 120sn'de bir location.reload() ile SONSUZ dongu (retry_count'un ust siniri YOK).
            // FB'de tekrarlanan sayfa yenileme dogrudan otomasyon imzasidir (checkpoint /
            // hesap kisitlama riski). Bu yuzden FB gonderisi retry dongusune HIC sokulmadan
            // TEMIZ atlanir. Faz 2 geldiginde bu kapi yerini gercek FB yakalama yoluna birakacak.
            const isFacebook = /(^|\.)facebook\.com$/i.test(window.location.hostname);
            if (isFacebook) {
                printLog("[Facebook] Yakalama henuz eklenmedi (Faz 2) — gonderi atlaniyor: " + activeUrl);
                durumText.innerHTML = `
                    <div style="text-align:center;">
                        <span style="color:#f7ba14; font-size:13px; font-weight:bold;">⏭️ Facebook gönderisi atlandı</span><br>
                        <span style="font-size:11px; color:var(--w-text-muted);">Facebook ekran görüntüsü henüz desteklenmiyor.<br>Link havuza eklenebilir, yakalama sonraki aşamada gelecek.</span>
                    </div>`;
                gorev.retry_count = 0;
                gorev.kuyruk.shift();
                let fbUpd = {}; fbUpd[storageKey] = gorev;
                chrome.storage.local.set(fbUpd, () => {
                    if (gorev.kuyruk.length > 0) {
                        const nextUrl = gorev.kuyruk[0].url || gorev.kuyruk[0];
                        setTimeout(() => { window.location.href = nextUrl; }, 600);
                    } else {
                        // Kuyruk bitti -> taramayi DUZGUN kapat (reload dongusu YOK).
                        swSendReliable({
                            action: "submitWordResult",
                            origin: gorev.server_origin || "http://localhost:3012",
                            job_id: gorev.job_id,
                            results: [],
                            final: true
                        }, () => {
                            chrome.storage.local.remove(storageKey, () => {
                                chrome.runtime.sendMessage({
                                    action: "completeJobAndFocusPanel",
                                    origin: gorev.server_origin
                                });
                            });
                        });
                    }
                });
                return;
            }

            let articleLoaded = false;
            for (let i = 0; i < 60; i++) {
                if (isInstagram) {
                    try {
                        const closeBtn = document.querySelector('svg[aria-label="Close"], svg[aria-label="Kapat"], svg[aria-label*="close" i], svg[aria-label*="kapat" i]');
                        if (closeBtn) {
                            const btnEl = closeBtn.closest('[role="button"]') || closeBtn.parentElement;
                            if (btnEl && typeof btnEl.click === 'function') {
                                btnEl.click();
                            }
                        }
                        const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                        if (modal && (modal.textContent.includes("Sign up") || modal.textContent.includes("Log in") || modal.textContent.includes("Giriş yap") || modal.textContent.includes("Kaydol") || modal.textContent.includes("Never miss"))) {
                            modal.style.display = 'none';
                            const parent = modal.parentNode;
                            if (parent && parent !== document.body) {
                                const style = window.getComputedStyle(parent);
                                if (style.position === 'fixed' || style.position === 'absolute') {
                                    parent.style.display = 'none';
                                }
                            }
                        }
                    } catch(e){}

                    if (document.querySelector('.Embed') || 
                        document.querySelector('article') || 
                        document.querySelector('[role="dialog"]') || 
                        document.querySelector('[aria-modal="true"]') || 
                        document.querySelector('main[role="main"]') || 
                        document.querySelector('main') || 
                        document.querySelector('video') || 
                        document.querySelector('img[style*="object-fit"]')) {
                        articleLoaded = true;
                        break;
                    }
                } else {
                    if (document.querySelector('article[data-testid="tweet"]')) {
                        articleLoaded = true;
                        break;
                    }
                }
                await new Promise(r => setTimeout(r, 500));
            }
            
            if (!articleLoaded) {
                gorev.retry_count = (gorev.retry_count || 0) + 1;
                printLog(`Hata: Tweet yüklenemedi! Yeniden deneme adımı: ${gorev.retry_count}`);

                let saniyeKalan = 120;
                
                durumText.innerHTML = `
                    <div style="text-align:center;">
                        <span style="color:#e0245e; font-size:14px; font-weight:bold;">⚠️ Limit / Yükleme Engeli!</span><br>
                        <span style="font-size:12px; color:var(--w-text-muted);">Tivit yüklenemedi. (Deneme ${gorev.retry_count})</span><br>
                        <span id="limit-countdown" style="font-size:13px; font-weight:bold; color:#f7ba14; display:block; margin:8px 0;">120 saniye sonra tekrar denenecek...</span>
                        <div style="display:flex; gap:8px; justify-content:center; margin-top:8px;">
                            <button id="btn-limit-retry" style="background:#1d9bf0; color:#fff; border:none; border-radius:12px; padding:6px 12px; font-size:11px; cursor:pointer; font-weight:bold;">🔄 Şimdi Yenile</button>
                            <button id="btn-limit-skip" style="background:#38444d; color:#fff; border:none; border-radius:12px; padding:6px 12px; font-size:11px; cursor:pointer; font-weight:bold;">Atla ⏭️</button>
                        </div>
                    </div>
                `;

                let limitInterval = setInterval(() => {
                    saniyeKalan--;
                    const countdownEl = document.getElementById('limit-countdown');
                    if (countdownEl) {
                        countdownEl.innerText = `${saniyeKalan} saniye sonra tekrar denenecek...`;
                    }
                    if (saniyeKalan <= 0) {
                        clearInterval(limitInterval);
                        let updateObj = {}; updateObj[storageKey] = gorev;
                        chrome.storage.local.set(updateObj, () => {
                            location.reload();
                        });
                    }
                }, 1000);

                const btnRetry = document.getElementById('btn-limit-retry');
                if (btnRetry) {
                    btnRetry.onclick = () => {
                        clearInterval(limitInterval);
                        let updateObj = {}; updateObj[storageKey] = gorev;
                        chrome.storage.local.set(updateObj, () => {
                            location.reload();
                        });
                    };
                }

                const btnSkip = document.getElementById('btn-limit-skip');
                if (btnSkip) {
                    btnSkip.onclick = () => {
                        clearInterval(limitInterval);
                        gorev.retry_count = 0;
                        gorev.kuyruk.shift();
                        let updateObj = {}; updateObj[storageKey] = gorev;
                        chrome.storage.local.set(updateObj, () => {
                            if (gorev.kuyruk.length > 0) {
                                const nextUrl = gorev.kuyruk[0].url || gorev.kuyruk[0];
                                let isNextUrlInstagram = nextUrl.includes('instagram.com');
                            if (isNextUrlInstagram) {
                                // Instagram dahil tüm gönderiler doğrudan (embed olmadan) normal sayfada açılır.
                                setTimeout(() => { window.location.href = nextUrl; }, 100);
                            } else {
                                setTimeout(() => { window.location.href = nextUrl; }, 100);
                            }
                            } else {
                                location.reload();
                            }
                        });
                    };
                }
                return;
            }

            if (gorev.retry_count) {
                gorev.retry_count = 0;
                let updateObj = {}; updateObj[storageKey] = gorev;
                await new Promise(resolve => {
                    chrome.storage.local.set(updateObj, () => resolve());
                });
            }
            
            const urlMatch = activeUrl.match(/status\/(\d+)/);
            const tweetId = urlMatch ? urlMatch[1] : null;
            
            let article = null;
            if (isInstagram) {
                let igCard = document.querySelector('.Embed') || 
                             document.querySelector('[role="dialog"]') || 
                             document.querySelector('[aria-modal="true"]') || 
                             document.querySelector('article');
                if (!igCard) {
                    const mediaEl = document.querySelector('img[style*="object-fit"], img[class*="media"], div[class*="media"] img, video');
                    if (mediaEl) {
                        let parent = mediaEl.parentNode;
                        while (parent && parent !== document.body) {
                            const rect = parent.getBoundingClientRect();
                            if (rect.width > 200) {
                                igCard = parent;
                                break;
                            }
                            parent = parent.parentNode;
                        }
                    }
                }
                article = igCard || document.body;
            } else {
                const articles = document.querySelectorAll('article[data-testid="tweet"]');
                if (tweetId) {
                    for (const art of articles) {
                        if (art.querySelector(`a[href*="/status/${tweetId}"]`)) {
                            article = art;
                            break;
                        }
                    }
                    if (!article) {
                        for (const art of articles) {
                            const timeEl = art.querySelector('time');
                            if (timeEl && !timeEl.closest('a')) {
                                article = art;
                                break;
                            }
                        }
                    }
                }
                if (!article && articles.length > 0) {
                    article = articles[0];
                }
            }
            
            if (!article) {
                printLog("Hata: Hedef tivit/gönderi element olarak bulunamadı! Sıradaki sayfaya geçiliyor...");
                gorev.kuyruk.shift();
                let updateObj2 = {}; updateObj2[storageKey] = gorev;
                chrome.storage.local.set(updateObj2, () => {
                    if (gorev.kuyruk.length > 0) {
                        const nextUrl = gorev.kuyruk[0].url || gorev.kuyruk[0];
                        let isNextUrlInstagram = nextUrl.includes('instagram.com');
                            if (isNextUrlInstagram) {
                                // Instagram dahil tüm gönderiler doğrudan (embed olmadan) normal sayfada açılır.
                                setTimeout(() => { window.location.href = nextUrl; }, 100);
                            } else {
                                setTimeout(() => { window.location.href = nextUrl; }, 100);
                            }
                    } else {
                        location.reload();
                    }
                });
                return;
            }
            
            let accountName = "";
            let username = "";
            
            if (isInstagram) {
                // Bir Instagram linkinden (mutlak veya göreli) yazar kullanıcı adını güvenli şekilde çıkaran yardımcı.
                const IG_RESERVED = ["explore", "reels", "reel", "direct", "stories", "emails", "p", "accounts",
                                     "about", "developer", "legal", "privacy", "tv", "igtv", "challenge", "web", "ajax"];
                const usernameFromHref = (rawHref) => {
                    if (!rawHref) return "";
                    let h = rawHref.split('?')[0].split('#')[0].trim();
                    // Mutlak URL ise (embed sayfasındaki yazar linki böyledir) host'tan sonrasını al
                    const m = h.match(/instagram\.com\/([^/]+)/i);
                    let seg = m ? m[1] : h.replace(/^\//, '').split('/')[0];
                    seg = (seg || "").toLowerCase();
                    if (!seg || IG_RESERVED.includes(seg)) return "";
                    // Geçerli Instagram kullanıcı adı biçimi
                    if (!/^[a-z0-9._]{1,30}$/.test(seg)) return "";
                    return seg;
                };

                const scanAnchorsForUsername = (scope) => {
                    if (!scope) return "";
                    const anchors = scope.querySelectorAll('a[href*="instagram.com/"], a[href^="/"]');
                    for (let a of anchors) {
                        const cand = usernameFromHref(a.getAttribute('href') || "");
                        if (cand) return cand;
                    }
                    return "";
                };

                // Bir profil-yolu href'inin İLK segmentinden yazar adı: /mahajansitr/reel/CODE/ -> mahajansitr
                const usernameFromFirstSeg = (rawHref) => {
                    if (!rawHref) return "";
                    let h = rawHref.split('?')[0].split('#')[0].trim();
                    h = h.replace(/^https?:\/\/[^/]+/i, ''); // host'u at (varsa)
                    let seg = (h.replace(/^\//, '').split('/')[0] || "").toLowerCase();
                    if (!seg || IG_RESERVED.includes(seg)) return "";
                    if (!/^[a-z0-9._]{1,30}$/.test(seg)) return "";
                    return seg;
                };

                // 0a. EN GÜVENİLİR: Belge genelinde gönderi KALICI-LİNKİNİ ara: /{yazar}/(p|reel|tv)/{kod}/.
                // Bu link (header'daki zaman damgası dahil) daima YAZARIN adını içerir ve postCode benzersizdir;
                // article seçimi (iki-sütunda yalnız medya sütunu olabilir) ne olursa olsun sayfada bulunur,
                // böylece sol menü/yorum kutusundaki GİRİŞ YAPAN kullanıcının linki asla yazar sanılmaz.
                // NOT: repost/öneri gönderilerinde bu link DOM'a GEÇ gelebiliyor; hazır olana kadar kısa süre bekle
                // (yoksa erken çalışıp yanlış yedeğe -> giriş yapan kullanıcıya düşüyordu).
                if (!username) {
                    const postCode = (activeUrl.match(/\/(?:p|reel|tv)\/([^/?#]+)/) || [])[1] || "";
                    if (postCode) {
                        const codeEsc = postCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const permRe = new RegExp('/([a-z0-9._]{1,30})/(?:p|reel|tv)/' + codeEsc, 'i');
                        const findInAnchors = () => {
                            for (let a of document.querySelectorAll('a[href]')) {
                                const m = (a.getAttribute('href') || "").match(permRe);
                                if (m && m[1] && !IG_RESERVED.includes(m[1].toLowerCase())) return m[1].toLowerCase();
                            }
                            return "";
                        };
                        let found = findInAnchors();
                        for (let w = 0; w < 15 && !found; w++) {   // en fazla ~3sn bekle
                            await new Promise(r => setTimeout(r, 200));
                            found = findInAnchors();
                        }
                        // Anchorlarda hâlâ yoksa ham HTML/JSON içinde de ara (permalink script verisinde olabilir).
                        if (!found) {
                            const hm = (document.documentElement.innerHTML || "").match(permRe);
                            if (hm && hm[1] && !IG_RESERVED.includes(hm[1].toLowerCase())) found = hm[1].toLowerCase();
                        }
                        if (found) { username = found; accountName = found; }
                    }
                }

                // 0b. Yedek: gönderi zaman damgasının (<time>) linkinden ilk segment (kod eşleşmese bile).
                if (!username) {
                    const timeEls = document.querySelectorAll('time');
                    for (let t of timeEls) {
                        const a = t.closest('a'); if (!a) continue;
                        const u = usernameFromFirstSeg(a.getAttribute('href') || "");
                        if (u) { username = u; accountName = u; break; }
                    }
                }

                // 1. Gönderi kartı KAPSAMINDA yazarın profil linki (embed dahil, header <time> yoksa yedek).
                // Kapsamı kartla sınırlı tuttuğumuz için tam sayfada gezinme/öneri linklerini yanlışlıkla seçmeyiz.
                if (!username && article && article !== document.body) {
                    const cand = scanAnchorsForUsername(article);
                    if (cand) {
                        username = cand;
                        accountName = cand;
                    }
                }

                // 2. .Header içindeki .UsernameText / .Username sınıfları
                if (!username) {
                    let headerUsernameEl = (article ? (article.querySelector('.Header .UsernameText') || article.querySelector('.Header .Username')) : null) ||
                                           document.querySelector('.Header .UsernameText') ||
                                           document.querySelector('.Header .Username') ||
                                           document.querySelector('.HoverCardUserName .Username') ||
                                           document.querySelector('.UsernameText') ||
                                           document.querySelector('.Username');
                    if (headerUsernameEl) {
                        username = (headerUsernameEl.textContent || "").trim().replace(/^@+/, '');
                        accountName = username;
                    }
                }

                // 3. JSON "owner" bloğu (embed script'leri genelde içerir)
                if (!username) {
                    const scripts = document.querySelectorAll('script');
                    for (let script of scripts) {
                        if (script.textContent && script.textContent.includes('"owner":{')) {
                            const match = script.textContent.match(/"owner":\{[^}]*"username":"([^"]+)"/);
                            if (match && match[1]) {
                                username = match[1];
                                accountName = username;
                                break;
                            }
                        }
                    }
                }

                // 4. og:title / document.title -> "kullanici on Instagram"
                if (!username) {
                    const metaTitle = document.querySelector('meta[property="og:title"]');
                    const content = ((metaTitle && metaTitle.getAttribute('content')) || document.title || "");
                    const match = content.match(/^([^ ]+)\s+on Instagram/i);
                    if (match) {
                        username = match[1].replace(/^@+/, '');
                        accountName = username;
                    }
                }

                // 5. Son çare öncesi: tüm dokümanda profil linki tara (yanlış kullanıcı riski olduğu için en sonda)
                if (!username) {
                    const cand = scanAnchorsForUsername(document);
                    if (cand) {
                        username = cand;
                        accountName = cand;
                    }
                }

                // 6. Son çare
                if (!username) {
                    username = "instagram_user";
                    accountName = "Instagram Gönderisi";
                }

                username = username.replace(/^@+/, '');
                username = '@' + username;
                accountName = username;
            } else {
                accountName = article.getAttribute('data-author-name') || "";
                username = article.getAttribute('data-author-username') || "";
                if (!accountName || !username) {
                    const userNameEl = article.querySelector('[data-testid="User-Name"]');
                    if (userNameEl) {
                        const spans = userNameEl.querySelectorAll('span');
                        if (spans.length > 0) {
                            accountName = spans[0].innerText;
                        }
                        for (let span of spans) {
                            if (span.innerText.startsWith('@')) {
                                username = span.innerText;
                                break;
                            }
                        }
                    }
                }
            }
            
            if (username && !username.startsWith('@')) {
                username = '@' + username;
            }
            
            article.style.zoom = '';
            article.scrollIntoView({ block: 'start', behavior: 'instant' });
            await new Promise(r => setTimeout(r, 600));

            durumText.innerHTML = `🤖 <b>Ekran Görüntüsü Alınıyor...</b><br>Kalan: <b>${gorev.kuyruk.length}</b>`;

            let screenshotData = "";
            try {
                screenshotData = await captureArticle(article) || "";
            } catch (captureErr) {
                printLog("Yakalama hatası oluştu: " + captureErr.message);
                await new Promise(r => setTimeout(r, 1000));
                try {
                    screenshotData = await captureArticle(article) || "";
                } catch (secondErr) {
                    printLog("Kritik yakalama hatası: " + secondErr.message);
                }
            }

            // Ensure screenshot is explicitly captured and checked before queue push
            if (!screenshotData || screenshotData.length < 100) {
                printLog("Hata: Instagram gönderisinden ekran görüntüsü çekilemedi veya veriler geçersiz, yeniden deneniyor...");
                await new Promise(r => setTimeout(r, 2000));
                try {
                    // Instagram'da bazen article referansı kaybediliyor olabilir.
                    let freshArticle = document.querySelector('article') || article;
                    screenshotData = await captureArticle(freshArticle) || "";
                } catch(e) {}
            }

            // BOŞ-KARE GÜVENLİK AĞI (Instagram): Yakalama "geçerli ama boş/tekdüze" olabilir
            // (yanlış bölge -> açıklama/yorum/beyaz alan kırpılmış). Uzunluk yeterli olduğundan
            // eski kontrole takılmaz. Pikselleri örnekleyip tekdüzelik ölçer; boşsa gönderiyi
            // bir kez yeniden yükleyip tekrar deneriz (en fazla 2 kez), atlamadan.
            const captureLooksBlank = (dataUrl) => new Promise((resolve) => {
                if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.length < 1000) { resolve(true); return; }
                const im = new Image();
                im.onload = () => {
                    try {
                        if (im.width < 120 || im.height < 120) { resolve(true); return; }
                        const cw = 60, ch = 60, n = cw * ch;
                        const cnv = document.createElement('canvas'); cnv.width = cw; cnv.height = ch;
                        const cx = cnv.getContext('2d'); cx.drawImage(im, 0, 0, cw, ch);
                        const dd = cx.getImageData(0, 0, cw, ch).data;
                        let s = 0, s2 = 0;
                        for (let i = 0; i < dd.length; i += 4) {
                            const l = 0.299 * dd[i] + 0.587 * dd[i + 1] + 0.114 * dd[i + 2];
                            s += l; s2 += l * l;
                        }
                        const mean = s / n;
                        const std = Math.sqrt(Math.max(0, (s2 / n) - mean * mean));
                        resolve(std < 6); // neredeyse tekdüze (düz beyaz/koyu) => boş
                    } catch (e) { resolve(false); }
                };
                im.onerror = () => resolve(true);
                im.src = dataUrl;
            });

            if (isInstagram) {
                const IG_CAPTURE_MAX_RELOADS = 2;
                const bosMu = await captureLooksBlank(screenshotData);
                if (bosMu) {
                    gorev.ig_capture_retry = (gorev.ig_capture_retry || 0) + 1;
                    if (gorev.ig_capture_retry <= IG_CAPTURE_MAX_RELOADS) {
                        printLog(`[Instagram] Ekran görüntüsü boş/tekdüze. Gönderi yeniden yükleniyor (deneme ${gorev.ig_capture_retry}/${IG_CAPTURE_MAX_RELOADS}): ${activeUrl}`);
                        durumText.innerHTML = `⚠️ <b>Boş görüntü — gönderi yenileniyor...</b><br>Deneme: <b>${gorev.ig_capture_retry}/${IG_CAPTURE_MAX_RELOADS}</b>`;
                        let reloadObj = {}; reloadObj[storageKey] = gorev; // sayaç yeniden yüklemede korunur
                        await new Promise(res => chrome.storage.local.set(reloadObj, res));
                        setTimeout(() => { location.reload(); }, 400); // CASE 2 baştan çalışır; kuyruk[0] değişmedi
                        return; // resItem push / kuyruk shift / submit ATLANIR
                    }
                    printLog(`[Instagram] ${IG_CAPTURE_MAX_RELOADS} yeniden yüklemeye rağmen boş, mevcut görüntüyle devam ediliyor: ${activeUrl}`);
                }
                gorev.ig_capture_retry = 0; // başarı VEYA tükenme -> sıfırla (navigasyondaki storage.set ile kalıcılaşır)
            }

            if (!gorev.combinedData) {
                gorev.combinedData = [];
            }
            if (!username && isInstagram) {
                const match = document.title.match(/^([^ ]+) on Instagram/);
                if (match) {
                    username = "@" + match[1];
                    accountName = username;
                } else {
                    username = "@instagram_user";
                    accountName = "Instagram Gönderisi";
                }
            }
            let resItem = {
                link: activeUrl,
                account_name: accountName,
                username: username,
                screenshot: screenshotData,
                is_profile: false
            };
            gorev.combinedData.push(resItem);
            
            gorev.kuyruk.shift();
            
            if (gorev.kuyruk.length > 0) {
                const totalCount = (gorev.total_count) || (gorev.combinedData.length + gorev.kuyruk.length);
                const progress = gorev.combinedData.length;
                const nextUrl = gorev.kuyruk[0].url || gorev.kuyruk[0];

                durumText.innerHTML = `⏳ <b>Sonuç kaydediliyor...</b><br>Lütfen sekmeyi kapatmayın.`;

                swSendReliable({
                    action: "submitWordResult",
                    origin: gorev.server_origin || "http://localhost:3012",
                    job_id: gorev.job_id,
                    results: [xStripForServer(resItem, gorev)],
                    final: false
                }, (response) => {
                    if (response && response.status === 'cancelled') {
                        chrome.storage.local.remove(storageKey, () => {
                            chrome.runtime.sendMessage({ action: "completeJobAndFocusPanel", origin: gorev.server_origin });
                        });
                        return;
                    }
                    swSendReliable({
                        action: "updateWordProgress",
                        origin: gorev.server_origin || "http://localhost:3012",
                        job_id: gorev.job_id,
                        current: progress,
                        total: totalCount
                    }, (progResponse) => {
                        if (progResponse && progResponse.status === 'cancelled') {
                            chrome.storage.local.remove(storageKey, () => {
                                chrome.runtime.sendMessage({ action: "completeJobAndFocusPanel", origin: gorev.server_origin });
                            });
                            return;
                        }
                        let nextUpdate = {}; nextUpdate[storageKey] = gorev;
                        chrome.storage.local.set(nextUpdate, () => {
                            // Tüm gönderiler doğrudan (embed olmadan) normal sayfada açılır.
                            setTimeout(() => { window.location.href = nextUrl; }, 100);
                        });
                    });
                });
            } else {
                const progress = gorev.combinedData.length;
                
                durumText.innerHTML = `⏳ <b>Sonuçlar kaydediliyor...</b><br>Lütfen sekmeyi kapatmayın.`;
                
                swSendReliable({
                    action: "submitWordResult",
                    origin: gorev.server_origin || "http://localhost:3012",
                    job_id: gorev.job_id,
                    results: [xStripForServer(resItem, gorev)],
                    final: true
                }, () => {
                    swSendReliable({
                        action: "updateWordProgress",
                        origin: gorev.server_origin || "http://localhost:3012",
                        job_id: gorev.job_id,
                        current: progress,
                        total: progress
                    }, () => {
                        chrome.storage.local.remove(storageKey, () => {
                            // Background worker'a bu sekmenin kapatılıp panelin odaklanması talimatını veriyoruz.
                            chrome.runtime.sendMessage({
                                action: "completeJobAndFocusPanel",
                                origin: gorev.server_origin
                            });
                        });
                    });
                });
            }
        } catch (e) {
            showError(e);
        }
    }

    function devamEt(allStorage, directKey) {
        try {
            let temizUrl = window.location.href.split('?')[0];
            let storageKey = null;
            let gorev = null;

            // 1. First, check direct tab key
            if (directKey && allStorage[directKey] && allStorage[directKey].aktif) {
                storageKey = directKey;
                gorev = allStorage[storageKey];
            }
            
            // 2. Fallback to scanning all keys if direct key is not found/active
            if (!gorev) {
                for (let key in allStorage) {
                    if (key.startsWith('x_profil_gorevi_') && allStorage[key] && allStorage[key].aktif) {
                        storageKey = key;
                        gorev = allStorage[key];
                        break;
                    }
                }
            }

            printLog(`Görev sorgulama sonucu: Anahtar=${storageKey || 'Bulunamadı'}, Aktif=${gorev?.aktif || false}, Asama=${gorev?.asama || 'Yok'}`);

            if (gorev && gorev.aktif) {
                initWidgetTimer(gorev, storageKey);
                updateWidgetProgress(gorev);
                if (gorev.asama === "profil_taramasi") {
                    topluProfilYonetimi(gorev, storageKey);
                } else if (gorev.asama === "detayli_tarama") {
                    detayliTaramaYonetimi(gorev, storageKey);
                } else if (gorev.asama === "arama_taramasi") {
                    aramaTaramasiYonetimi(gorev, storageKey);
                } else if (gorev.asama === "word_taramasi") {
                    wordTaramaYonetimi(gorev, storageKey);
                } else {
                    printLog(`Bilinmeyen veya eski görev aşaması (${gorev.asama}) algılandı. Temizleniyor...`);
                    chrome.storage.local.remove(storageKey, () => {
                        location.reload();
                    });
                }
            } else {
                printLog("Aktif görev yok. Tekil tivit kontrolü yapılıyor...");
                // Idle Mod: Check if we are on a detailed Tweet status page
                let tivitMi = /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(temizUrl);
                let rtSayfasiMi = temizUrl.endsWith('/retweets') || temizUrl.endsWith('/reposts') || temizUrl.endsWith('/quotes') || temizUrl.endsWith('/likes');
                
                printLog(`Sayfa Analizi: tivitMi=${tivitMi}, rtSayfasiMi=${rtSayfasiMi}`);

                if (tivitMi && !rtSayfasiMi) {
                    printLog("Tekil tivit sayfası algılandı. Idle widget yükleniyor.");
                    renderIdleWidget(directKey || "x_profil_gorevi_tekil");
                } else {
                    printLog("Alakasız sayfa. Widget gizleniyor.");
                    widget.style.display = 'none';
                }
            }
        } catch (innerErr) {
            showError(innerErr);
        }
    }

    // MAIN START: Retrieve Storage Key using Tab ID if possible
    try {
        let tabId = window.xRaporTabId;
        let directKey = tabId ? `x_profil_gorevi_${tabId}` : null;
        
        printLog(`Görev sorgulanıyor... TabID: ${tabId || 'Bilinmiyor'}, Direkt Anahtar: ${directKey || 'Yok'}`);

        chrome.storage.local.get(null, (allStorage) => {
            try {
                devamEt(allStorage, directKey);
            } catch (innerErr) {
                showError(innerErr);
            }
        });
    } catch (outerErr) {
        showError(outerErr);
    }

        } catch (err) {
            console.error("X Rapor Kritik Hata:", err);
            alert("X Rapor Başlatma Hatası:\n" + err.stack);
        }
    }

    // Send raw views and likes counts to server immediately during crawl
    function izlenmeleriSunucuyaKaydet(stats, gorev, tweetUrl) {
        if (!stats || !tweetUrl) return;
        chrome.storage.local.get({ server_origin: "http://localhost:3012" }, (res) => {
            const origin = (gorev && gorev.server_origin) || res.server_origin;
            const payload = {
                action: "updateTweetViews",
                origin: origin,
                tweet_url: tweetUrl,
                target_id: (gorev && gorev.target_id) || null,
                views_count: stats.views || null,
                likes_count: stats.likes || null,
                tweet_text: stats.metin || "",
                is_extension: (gorev && gorev.is_server_job) ? 0 : 1
            };
            chrome.runtime.sendMessage(payload, (response) => {
                printLog("İzlenme/Beğeni sayısı sunucuya anlık gönderildi: " + (stats.views || "0"));
            });
        });
    }

    // Send interactions to server, returns a Promise that resolves when all requests complete
    function etkilesimleriSunucuyaKaydet(gecerliVeri, gorev) {
        return new Promise((resolve) => {
            if (!gecerliVeri || !gecerliVeri.ozet || !gecerliVeri.ozet.url) {
                resolve();
                return;
            }
            
            const tweetUrl = gecerliVeri.ozet.url;
            const tweetText = gecerliVeri.ozet.metin || "";
            
            const categories = [
                { 
                    key: 'retweets', 
                    data: gecerliVeri.retweets, 
                    enabled: !!(gorev && (gorev.collect_retweets == 1 || (gorev.ayarlar && gorev.ayarlar.rt)))
                },
                { 
                    key: 'likes', 
                    data: gecerliVeri.likes, 
                    enabled: !!(gorev && (gorev.collect_likes == 1 || (gorev.ayarlar && (gorev.ayarlar.begeni || gorev.ayarlar.sadeceSayisalBegeni))))
                },
                { 
                    key: 'quotes', 
                    data: gecerliVeri.quotes, 
                    enabled: !!(gorev && (gorev.collect_quotes == 1 || (gorev.ayarlar && gorev.ayarlar.alinti)))
                },
                { 
                    key: 'yorumlar', 
                    data: gecerliVeri.yorumlar, 
                    enabled: !!(gorev && (gorev.collect_replies == 1 || (gorev.ayarlar && gorev.ayarlar.yorum)))
                }
            ];
            
            chrome.storage.local.get({ server_origin: "http://localhost:3012" }, (res) => {
                const origin = res.server_origin;
                const activeCategories = categories.filter(cat => cat.enabled);
                if (activeCategories.length === 0) {
                    resolve();
                    return;
                }
                
                let completedCount = 0;
                activeCategories.forEach(cat => {
                    const payload = {
                        action: "saveInteractionsToServer",
                        origin: origin,
                        tweet_url: tweetUrl,
                        target_id: (gorev && gorev.target_id) || null,
                        tweet_text: tweetText,
                        tweet_date: gecerliVeri.ozet.tarih || "",
                        interaction_type: cat.key,
                        users: cat.data || [],
                        is_extension: (gorev && gorev.is_server_job) ? 0 : 1,
                        views_count: gecerliVeri.ozet.views || null,
                        likes_count: gecerliVeri.ozet.likes || null
                    };
                    chrome.runtime.sendMessage(payload, (response) => {
                        completedCount++;
                        if (completedCount === activeCategories.length) {
                            resolve();
                        }
                    });
                });
            });
        });
    }

    baslat();
})();