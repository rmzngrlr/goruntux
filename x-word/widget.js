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

    // ----------------- PLATFORM (Faz FB-2 / TT-1) -----------------
    // 'x' | 'ig' | 'fb' | 'tt'. isInstagram BUGUNKU degerini AYNEN korur (3 yerde ayri ayri
    // tanimli: :568/:3878/:4022) — bu helper yalnizca yaninda isFacebook/isTiktok tanimlamak icin.
    function xPlatform() {
        var h = window.location.hostname;
        if (h.indexOf('instagram.com') !== -1) return 'ig';
        if (/(^|\.)facebook\.com$/i.test(h)) return 'fb';
        if (/(^|\.)tiktok\.com$/i.test(h)) return 'tt';   // Faz TT-1
        if (/(^|\.)youtube\.com$/i.test(h) || /(^|\.)youtu\.be$/i.test(h)) return 'yt';   // Faz YT-1
        return 'x';
    }

    // Kullaniciya/loga gorunen platform adi. Log satirlari ve widget durum yazisi
    // BUTUN platformlarda ayni kalibi kullansin diye tek kaynak.
    function xPlatformAdi() {
        var p = xPlatform();
        return p === 'ig' ? 'Instagram'
             : (p === 'fb' ? 'Facebook'
             : (p === 'tt' ? 'TikTok'
             : (p === 'yt' ? 'YouTube' : 'X')));
    }

    // Idle "Rapora Ekle" yakalaması GERÇEKTEN yapılmış non-X platformlar. Buton yalnız bunlarda
    // görünür (yarım/bozuk buton olmasın). FB/TT/YT eklendikçe buraya eklenecek.
    function xIdleDestekli(p) {
        return p === 'ig' || p === 'fb' || p === 'tt' || p === 'yt';
    }

    // Instagram gönderi yazarı -> "@kullanici". Idle "Rapora Ekle" başlığı için.
    // Taramanın çok-yedekli türetmesinin (wordTaramaYonetimi) hafif ikizi.
    // SAĞLAM ÇOK-KAYNAK (2026-11-04, "Instagram Gönderisi" fallback hatası): eski kod yalnız
    // İngilizce "X on Instagram" og:title'ına + document.querySelector ilk link'e bakıyordu.
    // Türkçe/yeni IG og:title "Ad, Instagram:" biçiminde + document.title "(5) Instagram"
    // (bildirim öneki) + oturum-açık SPA'da gönderi <article> yerine modal'da -> üçü de çöküp
    // fallback'e düşüyordu. Yeni sıra güvenilirlik düzeni: (1) og:description "- handle,"
    // GERÇEK handle, (2) YAKALANAN kartın (igFindPost) kapsamında ilk geçerli profil linki,
    // (3) og:title "(@handle)" | "Ad on Instagram" | "Ad, Instagram:".
    function xIgYazar() {
        try {
            var _rez = ['p', 'reel', 'reels', 'explore', 'stories', 'direct', 'accounts', 'about', 'emails', 'tv', 'igtv', 'challenge', 'web', 'ajax', 'developer', 'legal', 'privacy', 'tags', 'locations', 's'];
            var _gecerli = function (seg) { return seg && _rez.indexOf(seg) === -1 && /^[a-z0-9._]{1,30}$/.test(seg); };
            var _segOf = function (href) {
                var h = (href || '').split('?')[0].split('#')[0].replace(/^https?:\/\/[^/]+/i, '');
                return (h.replace(/^\//, '').split('/')[0] || '').toLowerCase();
            };
            // 0) GÖNDERİ PERMALINK'inden yazar (OPERATÖR TUZAĞINA DÜŞMEZ): sayfadaki /{handle}/(p|reel|tv)/{CODE}
            //    linkinde CODE aktif gönderinin kodu (benzersiz). Giriş yapan kullanıcının profil linki post code
            //    İÇERMEZ -> asla operatör seçilmez. Profilden açılan modalda grid küçük-resim linki (yazar-önekli)
            //    DOM'da durur -> yazarı buradan al. (Tarama yolu wordTaramaYonetimi aynı tekniği kullanır, kanıtlı.)
            var _cm = (location.pathname || '').match(/\/(?:p|reel|reels|tv)\/([^/?#]+)/i);
            if (_cm && _cm[1]) {
                var _code = _cm[1].replace(/[^A-Za-z0-9_-]/g, '');
                if (_code) {
                    var _re = new RegExp('/([a-z0-9._]{1,30})/(?:p|reel|reels|tv)/' + _code + '(?:[/?#]|$)', 'i');
                    var _pa = document.querySelectorAll('a[href]');
                    for (var _pi = 0; _pi < _pa.length; _pi++) {
                        var _pm = (_pa[_pi].getAttribute('href') || '').match(_re);
                        if (_pm && _gecerli(_pm[1].toLowerCase())) { return '@' + _pm[1]; }
                    }
                }
            }
            // 1) og:description "N likes, M comments - handle, Date: ..." -> GERÇEK handle (en güvenilir)
            var ogd = document.querySelector('meta[property="og:description"]');
            var dc = (ogd && ogd.getAttribute('content')) || '';
            var md = dc.match(/[-–]\s*([A-Za-z0-9._]+)\s*,/);
            if (md && _gecerli(md[1].toLowerCase())) { return '@' + md[1]; }
            // 2) Yakalanan gönderi kartı (igFindPost) kapsamında ilk GEÇERLİ profil linki (modal/iki-sütun dahil)
            var post = (typeof igFindPost === 'function' ? igFindPost() : null) || document.querySelector('article') || document;
            var as = post.querySelectorAll('a[href*="instagram.com/"], a[href^="/"]');
            for (var i = 0; i < as.length; i++) {
                var seg = _segOf(as[i].getAttribute('href') || '');
                if (_gecerli(seg)) { return '@' + seg; }
            }
            // 3) og:title kalıpları: "(@handle)" | "Ad on Instagram" | "Ad, Instagram:" (TR/yeni)
            var metaT = document.querySelector('meta[property="og:title"]');
            var content = (metaT && metaT.getAttribute('content')) || document.title || "";
            var mh = content.match(/\(@([A-Za-z0-9._]+)\)/);
            if (mh && mh[1]) { return '@' + mh[1]; }
            var mo = content.match(/^\s*([^\s(:,]+)\s+on Instagram/i);
            if (mo && mo[1]) { return '@' + mo[1].replace(/^@+/, ''); }
            var mv = content.match(/^\s*([^\s(:,]+)\s*,\s*Instagram\s*:/i);
            if (mv && mv[1]) { return '@' + mv[1].replace(/^@+/, ''); }
        } catch (e) {}
        return 'Instagram Gönderisi';
    }

    // FB gonderi formundaki bir URL mi? (background.js xIsFbPostUrl ikizi)
    function fbGonderiFormuMu(href) {
        try {
            var u = new URL(href);
            if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return false;
            var p = String(u.pathname || '').replace(/\/+$/, '');
            var low = p.toLowerCase();
            if (/^\/groups\/[^/]+\/(?:posts|permalink)\/[^/]+$/i.test(p)) return true;
            if (/^\/[^/]+\/posts\/[^/]+$/i.test(p)) return true;
            if (/^\/reel\/[^/]+$/i.test(p)) return true;
            if ((low === '/watch' || low === '/video.php') && u.searchParams.get('v')) return true;
            if ((low === '/photo.php' || low === '/photo') && u.searchParams.get('fbid')) return true;
            if ((low === '/permalink.php' || low === '/story.php') && u.searchParams.get('story_fbid')) return true;
            return false;
        } catch (e) { return false; }
    }

    // FB'de hedefe ULASTIK MI? URL string esitligi YETMEZ.
    // SAHA (2026-07-16): kullanici /share/v/14jeAjQz7ZP ekledi; FB bunu
    //   /reel/2052772415581354/?rdid=...&share_url=https%3A%2F%2F...%2Fshare%2Fv%2F14jeAjQz7ZP
    // adresine YONLENDIRDI. Duz karsilastirma "eslesmedi" der; widget da activeUrl'e
    // geri gitmeye calisir, FB tekrar yonlendirir -> SONSUZ DONGU.
    // FB neyse ki orijinal linki ?share_url= parametresinde TASIYOR -> onu kullan.
    function fbHedefeUlastikMi(gercekHref, hedefUrl) {
        try {
            if (normalizeUrl(gercekHref) === normalizeUrl(hedefUrl)) return true;
            // 1) FB'nin kendi verdigi kanit: share_url == bizim hedefimiz.
            //    share_url VARSA BELIRLEYICIDIR: eslesmiyorsa BASKA bir gonderidesin ->
            //    asagidaki yedege DUSME (yoksa yanlis gonderiyi "ulastik" sayip YANLIS
            //    gorseli dogru link altinda rapora koyariz — sessiz ariza).
            var su = new URL(gercekHref).searchParams.get('share_url');
            if (su) return normalizeUrl(su) === normalizeUrl(hedefUrl);
            // 2) share_url YOKSA: hedef /share/... idi ve simdi bir FB GONDERI
            //    sayfasindayiz -> FB yonlendirmis kabul et.
            if (/\/share\/[pvr]\//i.test(String(hedefUrl).toLowerCase()) && fbGonderiFormuMu(gercekHref)) return true;
            return false;
        } catch (e) { return false; }
    }

    // Etkilesim satiri secicisi — TEK KAYNAK (fbFindPost, fbBitisY ve bekleme poll'u
    // AYNI seciciyi kullansin diye; fbFindPost'tan ONCE tanimli olmali).
    //
    // GEVSEK (iceren) eslesme — BILEREK. Kisa suren bir TAM-ESLESME denemesi (v3.32)
    // REGRESYON yaratti: FB'nin gercek etiketi listedekinden azicik farkli olunca
    // (bosluk/yazim/guncelleme) secici HICBIR SEY bulamiyor; ustelik fbFindPost da ayni
    // seciciyi kullandigi icin KART bulma da bozuluyor -> onceden calisan gonderiler
    // bozuldu. FB'nin etiketlerini tam olarak bilemeyiz, o yuzden GENIS tutuyoruz.
    //
    // Gevsek eslesmenin TEK gercek sorunu (saha 2026-07-16): YORUM YAZMA KUTUSUNUN
    // placeholder'i "Ramazan Gürler adıyla yorum yap" da eslesiyordu -> fbBitisY onu
    // "bitis" sanip kadraji tam da yorum kutusunu ICINE ALACAK sekilde kesiyordu.
    // Bu YAPISAL olarak cozuldu (fbBitisY icinde textbox/contenteditable/form ATLANIR) —
    // seciciyi daraltarak DEGIL. Cozum orada, burada degil.
    var FB_ENG_SEL = '[aria-label="Beğen"],[aria-label="Like"],[aria-label*="Yorum" i],' +
                     '[aria-label*="Comment" i],[aria-label*="Paylaş" i],[aria-label*="Share" i]';

    // BITIS icin AYRI ve DAR secici — "kart sinirini bul"dan farkli bir is.
    // SAHA (2026-07-16, log kaniti):
    //   Futbol Gazetesi: bitis=700+8 <- İfade bırak[button/DIV]  -> DOGRU (gonderi reaksiyonu)
    //   NTV Spor       : bitis=601+8 <- İfade bırak[button/DIV]  -> YANLIS (YORUM KUTUSUNDAKI
    //                    emoji dugmesi; kesilen=25px = kadraj kutunun ortasinda kesiyor)
    // Yani FB "İfade bırak" etiketini IKI AYRI yerde kullaniyor ve ayirt edilemiyor.
    // Yorum-kutusu savunmasi da tutmuyor: emoji dugmesi [role=textbox]'in ICINDE degil,
    // YANINDA. Bu yuzden bitis hesabinda "İfade bırak" KULLANILMAZ; "Beğen"/"Yorum"
    // gonderiye ozel ve ikisi de etkilesim satirinda (teshis ciktisi: "Beğen",
    // "İfade bırak", "Yorum bırak" — ucu de mevcut).
    // NOT: FB_ENG_SEL (kart bulma + bekleme) GENIS kalir; yalnizca BITIS dar.
    var FB_BITIS_SEL = '[aria-label="Beğen"],[aria-label="Like"],[aria-label*="Yorum" i],' +
                       '[aria-label*="Comment" i]';

    // Facebook gonderi KARTINI bul. SAHA VERISIYLE tasarlandi (2026-07-16):
    //
    // /posts -> gonderi MODAL icinde acilir (adres cubugundan acilsa bile) ve ARKA PLANDA
    //   ana sayfa feed'i durur. Feed'in gorseli modaldakinden BUYUK olabilir:
    //     feed  IMG 500x500 = 250000  <- global "en buyuk medya" BUNU secer (YANLIS)
    //     modal IMG 367x641 = 235023  <- gercek gonderi
    //   Bu yuzden ONCE KAP (en icteki dialog) bulunur, arama YALNIZCA onun icinde yapilir.
    // /reel -> dialog YOK, [role="article"] de YOK; kapsam belge geneli olur.
    // outEng verilirse GORUNUR etkilesim butonlari outEng.list'e yazilir — kadraj
    // hesabi bunlari da kapsayabilsin diye (reel'de stats sutunu position:absolute
    // oldugu icin kartin rect'ini GENISLETMIYOR; ata dogru olsa bile kadraj kesiyor).
    function fbFindPost(outEng) {
        try {
            var kap = null, scope, _btnKart = null;
            // [FB BUTON — HEDEF KART] Tiklanan gönderi ⋯ butonu bir kart set ettiyse ONU KAPSAM yap:
            // icinde normal medya+etkilesim ortak-ata hesabi (adim 2-4) kosar -> buton yolu, dock
            // yoluyla AYNI DAR karti verir. Boylece fbBitisY etkilesim satirinda biter ve YORUM YAZMA
            // KUTUSU ("... adıyla yorum yap") kadraja GIRMEZ (kullanici: cikti sistemimize uymuyordu).
            // Dar hesap tutmazsa (adim 5) en kotu tiklanan kartin kendisine duser.
            if (window.__xFbHedefPost && document.contains(window.__xFbHedefPost) &&
                window.__xFbHedefPost.getBoundingClientRect().height > 100) {
                _btnKart = window.__xFbHedefPost;
                scope = _btnKart;
            } else {
                // 1) KAP: en icteki GORUNUR dialog (varsa) — /posts. Yoksa belge geneli — /reel.
                //
                // SAHA HATASI (2026-07-20, kullanici teshis ciktisi): Facebook BILDIRIMLER
                // panelini de role="dialog" olarak DOM'a ONCEDEN basiyor ve o panel GIZLI (0x0).
                // Eski kod "baska dialog icermeyen ilk dialog"u DOM SIRASINA gore seciyordu:
                //   [0] 0x0     role=dialog  "Bildirimler..."   <- yaprak, DOM'da BIRINCI -> SECILIYORDU
                //   [1] 900x718 role=dialog  "Sabah'in Gönderisi"
                //   [2] 700x654 aria-modal   "Sabah'in Gönderisi"  <- GERCEK modal
                // Sonuc zinciri: kap = 0x0 panel -> kapsam bos -> medya YOK, etkilesim YOK ->
                // kart 0x0 -> kirpma dikdortgeni gecersiz -> captureAndCrop kirpamayip TUM
                // GORUNUR SEKMEYI dondurdu -> rapora sol menu/reklamlar/arkadaki akis girdi.
                // Cozum: (a) once GORUNUR dialoglar, (b) aria-modal="true" varsa O gercek modaldir.
                var Dham = Array.prototype.slice.call(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'));
                var D = Dham.filter(function (d) {
                    var r = d.getBoundingClientRect();
                    return r.width > 100 && r.height > 100;
                });
                if (D.length) {
                    var am = D.filter(function (d) { return d.getAttribute('aria-modal') === 'true'; });
                    var aday = am.length ? am : D;
                    var inner = aday.filter(function (d) { return !aday.some(function (x) { return x !== d && d.contains(x); }); });
                    kap = inner[0] || aday[aday.length - 1];
                }
                scope = kap || document.body;
            }

            // 2) Kapsam icinde GORUNUR en buyuk medya (viewport disindakiler baska kart olabilir:
            //    reel'de kart karuseli var, feed'de sonraki gonderiler).
            var media = null, best = 0;
            scope.querySelectorAll('video, img').forEach(function (m) {
                var r = m.getBoundingClientRect();
                if (r.width > 150 && r.height > 150 && r.bottom > 0 && r.top < window.innerHeight) {
                    var a = r.width * r.height;
                    if (a > best) { best = a; media = m; }
                }
            });

            // 3) Etkilesim butonu (kapsam icinde). FB aria-label'i div[role=button]'a koyuyor,
            //    IG'deki gibi svg'ye DEGIL.
            //    DIKKAT: querySelector DOM'daki ILK'i alir. Reel bir KART KARUSELI ve her
            //    kartin kendi "Begen"i var -> ilk buton GORUNMEYEN bir karta ait olabilir,
            //    o zaman ortak ata iki karti birden kapsayip kart cok GENIS cikar
            //    (saha: kart=1156 genislik, viewport 895). Bu yuzden GORUNUR olani sec.
            //    Secici TEK KAYNAK (FB_ENG_SEL) — burada da TAM ESLESME sart: gevsek
            //    *="Yorum" YORUM YAZMA KUTUSUNU ("... adıyla yorum yap") yakaliyordu ve
            //    ortak ata hesabini bozuyordu (fbBitisY'de ayni tuzak sahada patladi).
            //    TEK degil, GORUNUR OLANLARIN HEPSI toplanir (asagida hepsini kapsayan ata
            //    aranacak). SAHA HATASI (2026-07-16): tek dugmeyle ortak ata hesaplaniyordu;
            //    reel'de dugmeler SAGDA DIKEY duruyor ve hangisinin secildigine gore ata
            //    degisiyor -> sutunun tamami kapsanmiyor. Secici listesini degistirdigimde
            //    ("İfade bırak" cikip "Paylaş" girdi) secilen dugme de degisti ve kart
            //    1156x610 -> 1120x630 DARALDI, sagdaki begen/yorum/paylas sutunu kadraj
            //    disinda kaldi. Cozum: hepsini kapsa.
            var eng = null, engGorunur = [];
            var engList = scope.querySelectorAll(FB_ENG_SEL);
            for (var ei = 0; ei < engList.length; ei++) {
                var er = engList[ei].getBoundingClientRect();
                if (er.width > 0 && er.height > 0 && er.bottom > 0 && er.top < window.innerHeight) {
                    engGorunur.push(engList[ei]);
                    if (!eng) eng = engList[ei];
                }
            }
            if (!eng && engList.length) eng = engList[0];   // hicbiri gorunur degilse eskisi gibi
            if (outEng) outEng.list = engGorunur;

            // 4) medya + etkilesim ORTAK ATASI = gonderi karti (IG'deki mantik, kapsam sinirli)
            //    HEPSINI kapsayan ata: medyadan yukari cikip GORUNUR etkilesim dugmelerinin
            //    TAMAMINI iceren ilk atayi al. Tek dugmeyle hesaplarsak reel'de sagdaki
            //    dikey sutun disarida kalabiliyor (saha: kart 1120 genislik, stats yok).
            if (media && engGorunur.length) {
                var n2 = media;
                while (n2 && n2 !== document.body) {
                    var hepsiIcinde = true;
                    for (var gi = 0; gi < engGorunur.length; gi++) {
                        if (!n2.contains(engGorunur[gi])) { hepsiIcinde = false; break; }
                    }
                    if (hepsiIcinde) return n2;
                    n2 = n2.parentElement;
                }
            }
            //    Yedek: hepsini kapsayan ata bulunamadi (or. baska kartin dugmesi de
            //    gorunuyor) -> TEK dugmeyle eski davranis.
            if (media && eng) {
                var chain = new Set(); var n = media;
                while (n) { chain.add(n); n = n.parentElement; }
                var c = eng;
                while (c) { if (chain.has(c)) return c; c = c.parentElement; }
            }
            // 5) Yedekler
            if (_btnKart) return _btnKart;   // buton yolu: dar hesap tutmadi -> tiklanan kartin kendisi
            if (kap) return kap;
            if (media) return media.closest('[role="article"]') || media.parentElement;
            return document.querySelector('[role="main"]');
        } catch (e) { return null; }
    }

    // Yorumlari GIZLE (kullanici karari: yorumlar rapora girmeyecek).
    // Iki fayda: (1) rapor gonderi kartiyla sinirli kalir, (2) yorumlar TEMBEL yuklendigi
    // icin kart yuksekligi yakalama sirasinda BUYUR; gizlemek onu yapisal olarak STABIL yapar
    // (saha: /posts kart=1688 yukseklik, modal ise 634 -> aradaki fark buyuk olcude yorumlar).
    // visibility:hidden DEGIL display:none: yerleşimi de daraltmasi gerekiyor.
    // Geri alma sorumlulugu cagirana ait (finally'de restore edilir).
    function fbYorumlariGizle(kart) {
        var gizlenen = [];
        try {
            if (!kart) return gizlenen;
            // FB'de yorumlar da [role="article"]; gonderi kartinin ICINDEKI article'lar = yorumlar.
            kart.querySelectorAll('[role="article"]').forEach(function (a) {
                if (a === kart) return;
                gizlenen.push([a, a.style.display]);
                a.style.display = 'none';
            });
            // "N yanıtı gör" / "Daha fazla yorum göster" gibi yorum kontrolleri
            kart.querySelectorAll('div[role="button"],span[role="button"]').forEach(function (b) {
                var t = (b.innerText || '').replace(/\s+/g, ' ').trim();
                if (t && t.length < 40 && /yanıtı gör|yanit gor|daha fazla yorum|önceki yorumlar|view .* replies|more comments/i.test(t)) {
                    gizlenen.push([b, b.style.display]);
                    b.style.display = 'none';
                }
            });
        } catch (e) {}
        return gizlenen;
    }

    // "Daha fazlasını gör" — FB uzun metinleri VARSAYILAN olarak kisaltiyor; tiklanmazsa
    // rapor KESIK metinle cikar. SAHA: gercek metin "Daha fazlasını gör" ("göster" DEGIL).
    // YALNIZCA gonderi karti kapsaminda ve YORUM yanitlarina DOKUNMADAN
    // (saha: ayni listede "23 yanıtı gör" / "12 yanıtı gör" de vardi — onlar TIKLANMAMALI).
    async function fbMetniAc(kart) {
        var n = 0;
        try {
            if (!kart) return 0;
            // AYNI elemana tekrar tiklama: buton tiklamadan sonra kaybolmazsa dongude
            // tekrar secilir. Zararsiz ama gereksiz; ayrica ileride toggle'a donerse
            // ("Daha azını gör") actigimizi KAPATMA riski dogar.
            var clicked = new Set();
            for (var pass = 0; pass < 3; pass++) {
                var hit = null;
                var els = kart.querySelectorAll('div[role="button"],span[role="button"]');
                for (var i = 0; i < els.length; i++) {
                    if (clicked.has(els[i])) continue;
                    var t = (els[i].innerText || '').replace(/\s+/g, ' ').trim();
                    // TAM esleşme: "23 yanıtı gör" gibi YORUM kontrolleri KACMASIN.
                    // "Daha azını gör" de eslesmez -> actigimizi kapatmayiz.
                    if (/^(daha fazlasını gör|daha fazla göster|see more|devamını gör)$/i.test(t)) {
                        var r = els[i].getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) { hit = els[i]; break; }
                    }
                }
                if (!hit) break;
                clicked.add(hit);
                hit.click(); n++;
                await new Promise(r => setTimeout(r, 350));
            }
        } catch (e) {}
        return n;
    }

    // X UZUN TWEET "Daha fazla göster" — X uzun tweet metnini VARSAYILAN kısaltır; yanıt/konuşmada
    // gösterilen ANA (parent) tweet kesik kalır ("Daha fazla göster" linkiyle). Tıklanmazsa rapora KESIK
    // metin girer. fbMetniAc deseni: article içinde X'in INLINE genişletme butonunu (tweet-text-show-more-link)
    // tıkla — gezinme YAPMAZ, metni yerinde açar. Yalnız bu tweetin metni; "N yanıtı gör"/"daha fazla yorum"
    // (yorum kontrolleri) ve alıntı tweet ETKİLENMEZ (tam-metin eşleşmesi + <a href> hariç). Bayrak
    // x_tweet_metin_ac='0' -> kapalı (eski davranış). Yakalamadan ÖNCE çağrılır (scroll/ölçüm öncesi -> tam yükseklik).
    async function xTweetMetniAc(article) {
        var n = 0;
        try {
            if (!article) return 0;
            if (localStorage.getItem('x_tweet_metin_ac') === '0') return 0;
        } catch (e) {}
        try {
            var clicked = new Set();
            for (var pass = 0; pass < 2; pass++) {
                var hit = null;
                // Birincil: X'in inline tweet-metni genişletme butonu (gezinmez, metni yerinde açar).
                var byTestid = article.querySelectorAll('[data-testid="tweet-text-show-more-link"]');
                for (var i = 0; i < byTestid.length; i++) {
                    if (clicked.has(byTestid[i])) continue;
                    var r0 = byTestid[i].getBoundingClientRect();
                    if (r0.width > 0 && r0.height > 0) { hit = byTestid[i]; break; }
                }
                // Yedek (testid değişirse): TAM metin eşleşmesi; <a href> HARIC (gezinme riski -> dokunma).
                if (!hit) {
                    var els = article.querySelectorAll('button,[role="button"]');
                    for (var j = 0; j < els.length; j++) {
                        if (clicked.has(els[j])) continue;
                        if (els[j].closest('a[href]')) continue;
                        var t = (els[j].innerText || '').replace(/\s+/g, ' ').trim();
                        if (/^(daha fazla göster|daha fazlasını göster|devamını göster|show more)$/i.test(t)) {
                            var r1 = els[j].getBoundingClientRect();
                            if (r1.width > 0 && r1.height > 0) { hit = els[j]; break; }
                        }
                    }
                }
                if (!hit) break;
                clicked.add(hit);
                var _href0 = location.href;
                hit.click(); n++;
                await new Promise(r => setTimeout(r, 350));
                if (location.href !== _href0) break;   // beklenmedik gezinme (inline beklenirdi) -> dur
            }
        } catch (e) {}
        return n;
    }

    // Yakalama NEREDE BITMELI? Kullanici karari: goruntu BEGENI/YORUM/PAYLAS satirinin
    // HEMEN ALTINDA bitsin. Altta kalanlar ("En alakalı" siralama menusu, "bazı yorumlar
    // filtrelenmiş olabilir" uyarisi, yorum yazma kutusu) gonderiye ait DEGIL ve yorum
    // gizlemeye de takilmiyorlar ([role="article"] degiller).
    // Etkilesim satirinin ALT kenarini icerik koordinatinda (kaydirici scrollTop dahil)
    // dondurur; bulunamazsa null -> cagiran eski davranisa (tam kart) duser.
    // Etkilesim satiri secicisi — TEK KAYNAK (hem bekleme hem bitis hesabi kullanir).
    //
    // TAM ESLESME kullaniyoruz. SAHA HATASI (2026-07-16): once *="Yorum" i gibi ICEREN
    // eslesme vardi ve YORUM YAZMA KUTUSUNUN placeholder'i ("... adıyla yorum yap")
    // ESLESIYORDU -> fbBitisY etkilesim satiri yerine YORUM KUTUSUNU "bitis" saniyor,
    // kadraj tam da yorum kutusunu ICINE ALACAK sekilde kesiliyordu.
    // Kanit: log bitis=581 diyordu; kullanicinin duzeninde etkilesim ~650'de olmali,
    // 581 ise gorselin bittigi yer = yorum kutusunun basi.
    // Gercek etiketler teshis ciktisindan: "Beğen", "İfade bırak", "Yorum bırak"
    // (/posts), "Yorum Yap", "Paylaş" (reel).
    function fbBitisY(kart, sc, scIc, taniOut) {
        try {
            if (!kart) return null;
            var sel = FB_BITIS_SEL;   // DAR secici — "İfade bırak" HARIC (bkz. yukaridaki not)
            var list = kart.querySelectorAll(sel);
            if (!list.length) {
                // TANI: seciciyle bulunamadi -> karttaki GERCEK aria-label'lari disari ver.
                // (Saha: gonderide "35 begeni 1 yorum" VARDI ama secici bulamadi. Bir daha
                //  tahmin yurutmeyelim diye label'lari loglayacagiz.)
                if (taniOut) {
                    var labs = [];
                    kart.querySelectorAll('[aria-label]').forEach(function (e) {
                        var l = e.getAttribute('aria-label');
                        if (l && l.length < 40 && labs.indexOf(l) === -1) labs.push(l);
                    });
                    taniOut.labels = labs.slice(0, 25);
                    taniOut.sebep = 'secici-eslesmedi';
                }
                return null;
            }
            // Etkilesim satirindaki EN ALT kenar (Begen/Yorum/Paylas ayni satirda).
            var enAlt = -1, _kompTopVp = -1;
            for (var i = 0; i < list.length; i++) {
                var el = list[i];
                var r = el.getBoundingClientRect();
                if (r.height <= 0 || r.width <= 0) continue;   // gizlenmis/gorunmez -> atla
                // [YORUM YAZMA KUTUSU PLACEHOLDER — ANASAYFA FEED, role=button] Feed'de yorum kutusu
                // bir role=textbox DEGIL, aria="<SEN> adıyla yorum yap" (EN: "Comment as <you>") olan bir
                // role=button; *="Yorum" ile FB_BITIS_SEL'e ESLESIR ama ETKILESIM satiri DEGIL, ALTINDADIR.
                // Textbox/FORM sarmali OLMADIGI icin asagidaki ata-kontrolu YAKALAMAZ -> bitis kutunun
                // ALTINA kayip kutu kadraja giriyordu (kullanici: cikti sistemimize uymuyordu). Eylem-cubugu
                // "Yorum" butonu "<POST SAHIBI>'in gönderisine yorum yap" ("adıyla" DEGIL) -> o KALIR.
                // enAlt'e KATMA; ama baska hic etkilesim eslesmesi cikmazsa kutunun USTUNDE bitirebilmek
                // icin en UST kutu-topunu sakla (asagidaki enAlt<0 yedegi).
                var _elAl = (el.getAttribute('aria-label') || '');
                if (/adıyla yorum|adiyla yorum|comment as /i.test(_elAl)) {
                    if (r.top > 0 && (_kompTopVp < 0 || r.top < _kompTopVp)) _kompTopVp = r.top;
                    continue;
                }
                // Yorumlarin ICINDEKI "Beğen" linkleri bitisi ASAGI CEKMESIN.
                // fbYorumlariGizle onlari zaten display:none yapiyor (rect 0 -> yukarida elenir),
                // ama buna BEL BAGLAMA: gizleme herhangi bir sebeple tutmazsa yorumlar kadraja
                // girerdi. Yapisal filtre: kartin ICINDEKI bir [role="article"] (= yorum)
                // altinda kalan etkilesim butonlarini say-ma.
                // DIKKAT: el'in KENDISI de kutu olabilir (placeholder'in kendisi
                // role="textbox" tasiyor: "... adıyla yorum yap"). Once ATALARA bakip
                // kendisini atliyordum -> savunma calismiyordu (test yakaladi: bitis=619,
                // kutu 579'da basliyordu). Bu yuzden zincire EL'DEN basla.
                var p = el, yorumIcinde = false;
                while (p && p !== kart) {
                    if (p.getAttribute && p.getAttribute('role') === 'article') { yorumIcinde = true; break; }
                    // YORUM YAZMA KUTUSU icindeki hicbir dugme "etkilesim satiri" DEGILDIR
                    // (Emoji/GIF/Etiket ve "... adıyla yorum yap"). Secici tam-eslesme'ye
                    // cekildi ama buna BEL BAGLAMA: ileride gevserse kadraj yine yorum
                    // kutusunu icine alirdi (saha hatasi tam olarak buydu).
                    if (p.getAttribute && (p.getAttribute('role') === 'textbox' ||
                        p.getAttribute('contenteditable') === 'true' ||
                        p.tagName === 'FORM')) { yorumIcinde = true; break; }
                    p = p.parentElement;
                }
                if (yorumIcinde) continue;
                if (r.bottom > enAlt) {
                    enAlt = r.bottom;
                    // TANI: bitisi HANGI oge belirledi? Saha hatasi bunsuz cozulemiyor —
                    // "bitis=581" tek basina yanlis ogeyi gostermiyor.
                    if (taniOut) {
                        taniOut.el = (el.getAttribute('aria-label') || '?').slice(0, 30) +
                                     '[' + (el.getAttribute('role') || '-') + '/' + el.tagName + ']';
                    }
                }
            }
            if (enAlt < 0) {
                // Gercek etkilesim butonu cikmadi. Eslesen TEK sey yorum YAZMA kutusu placeholder'i
                // ise (feed'de olur) onun USTUNDE bitir -> kutu kadraja GIRMEZ (null donup tum karti
                // almaktansa). Yoksa eskisi gibi null (gorunmez/yorum-ici adaylar).
                if (_kompTopVp > 0) { enAlt = _kompTopVp - 6; }
                else {
                    if (taniOut) { taniOut.sebep = 'eslesti-ama-gorunmez(' + list.length + ' aday)'; }
                    return null;
                }
            }
            // Viewport koordinatindan ICERIK koordinatina cevir.
            if (scIc && sc) {
                var scr = sc.getBoundingClientRect();
                return Math.round(enAlt - scr.top + sc.scrollTop);
            }
            var kr = kart.getBoundingClientRect();
            return Math.round(enAlt - kr.top);
        } catch (e) { return null; }
    }

    // Karti gercekten kaydiran elemani bul. FB'de window scroll YOK (saha: sh==ch==698);
    // icerik bir kapsayici icinde kayiyor. YANLIS kaydiriciyi secmek SESSIZ ariza:
    // /posts'ta arka plan feed kaydiricisi (sh:1851) ile modal kaydiricisi (sh:2278) YAN YANA;
    // feed'inkini kaydirirsak gonderi KIMILDAMAZ, her dilim ayni cikar, birlestirici ayni
    // goruntuyu ust uste yapistirir ve sonuc BOS OLMADIGI icin bos-yakalama korumasi FARK ETMEZ.
    function fbScroller(el) {
        try {
            if (!el) return null;
            // 1) ATALARDA ara (reel: kart bir kaydiricinin icinde — saha sh=1926/ch=642)
            var n = el;
            while (n && n !== document.body && n !== document.documentElement) {
                var cs = getComputedStyle(n);
                if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 20) return n;
                n = n.parentElement;
            }
            // 2) ICERIDE ara. /posts'ta kart MODAL'in kendisi olur (FB gonderi modali IKI
            //    SUTUNLU: gorsel bir yanda, metin/etkilesim diger yanda -> ortak ata = modal)
            //    ve modal overflow:hidden; GERCEK kaydirici modalin ICINDE (saha sh=2278/ch=507).
            //    Bu dal olmadan kaydirici=YOK cikiyor ve yakalama modalin yalnizca GORUNEN
            //    634px'ini alip altini SESSIZCE kaciriyordu.
            var best = null, bestAlan = 0;
            el.querySelectorAll('*').forEach(function (e) {
                try {
                    var cs2 = getComputedStyle(e);
                    if (!/(auto|scroll)/.test(cs2.overflowY)) return;
                    if (e.scrollHeight <= e.clientHeight + 20) return;
                    var r = e.getBoundingClientRect();
                    if (r.width < 200 || r.height < 200) return;
                    var a = r.width * r.height;
                    if (a > bestAlan) { bestAlan = a; best = e; }
                } catch (x) {}
            });
            return best;   // null => kaydirma gerekmiyor / window
        } catch (e) { return null; }
    }

    // Yazar tespiti — KIRLENMEYE BAGISIK katmanlar ONCE.
    // IG'yi yakan tuzak: belge-geneli anchor taramasi GIRIS YAPAN kullanicinin profilini
    // donduruyordu. FB'de kirlenme yuzeyi cok daha genis (ust nav, sol menu, kisayollar,
    // "Sen ve 42 kisi", grup uyeleri) -> belge-geneli tarama HIC YAPILMIYOR.
    function fbAuthor() {
        try {
            // 0A) GRUP gönderisi: /groups/{gid}/posts|permalink/{id}. Eski kod bunu HİÇ ele almıyordu
            //     (step 0 regex /^\/([^/]+)\/posts\// grupta null -> "Facebook Gönderisi" fallback). og tag YOK.
            //     Kullanıcı kararı (2026-11-04): "Kişi (Grup)" -> "Mert Özsoy (ESKİ MANİSA FOTOĞRAFLARI)";
            //     kişi bulunamazsa yalnız grup adı. Grup adı document.title'dan ("(N+) GRUP | metin | Facebook");
            //     kişi, gönderi sahibinin /groups/{gid}/user/{uid}/ linkinden (ilk ADLI link = sahip, yorumcular sonra).
            var gm = location.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\//);
            if (gm) {
                var gid = gm[1];
                var tt = (document.title || '').replace(/^\(\d+\+?\)\s*/, '');   // bildirim öneki "(20+) " at
                var grupAd = (tt.split(' | ')[0] || '').trim();
                if (/^facebook$/i.test(grupAd)) grupAd = '';
                var kisi = '', allA = document.querySelectorAll('a[href]');
                for (var gi = 0; gi < allA.length; gi++) {
                    var gyol = (allA[gi].getAttribute('href') || '').replace(/^https?:\/\/[^/]+/i, '').split('?')[0].split('#')[0];
                    if (gyol.indexOf('/groups/' + gid + '/user/') !== 0) continue;   // bu grubun üye profili
                    var kt = (allA[gi].innerText || '').replace(/\s+/g, ' ').trim();
                    if (!kt || kt.length > 60) continue;
                    if (/^\d+\s*[a-zçğıöşü]{1,3}$/i.test(kt)) continue;              // zaman damgası ("3s") değil
                    kisi = kt; break;
                }
                var gad = (kisi && grupAd) ? (kisi + ' (' + grupAd + ')') : (kisi || grupAd);
                if (gad) return { ad: gad, id: '', slug: '', kaynak: 'grup' };
            }
            // 0) /{ad}/posts/{id} -> SLUG URL'DE. Kirlenme IMKANSIZ (operatorun hesabi
            //    URL'e karisamaz). GORUNEN AD icin DOM'a bakariz: kullanici karari
            //    "Ad (@slug)" -> slug tek basina yetmez.
            var m = location.pathname.match(/^\/([^/]+)\/posts\//);
            if (m && m[1] && m[1].toLowerCase() !== 'profile.php') {
                var slug = m[1];
                // Ayni slug'a giden IKI link vardir:
                //   profil   : /{slug}/            -> metni GORUNEN AD ("Futbol Gazetesi")
                //   permalink: /{slug}/posts/{id}  -> metni ZAMAN DAMGASI ("3s")
                // SAHA HATASI (2026-07-16): ilk bulunani aliyorduk ve permalink once gelince
                // baslik "3s (@futbolgazetesi)" cikti. Zaman damgasi regex'i de kacirmisti:
                // listede sa/dk/sn vardi ama FB TR "3s" (saniye) kullaniyor.
                // Bu yuzden IKI katman: (1) permalink'i YAPISAL olarak ele, (2) kalin
                // (strong/h2/h3) yazilmis adi TERCIH et.
                // SAHA HATASI 2 (2026-07-16): baslik "futbolgazetesi" (slug) cikti, "Futbol
                // Gazetesi" olmaliydi -> DOM'dan ad HIC bulunamiyordu. Sebep: secici
                // a[href^="/{slug}"] GORELI yol varsayiyordu ama FB linkleri MUTLAK geliyor
                // (teshis: "https://www.facebook.com/haberduytr/posts/..."). Ayni sebeple
                // teshisteki profileLike da BOS donmustu — ipucu oradaydi.
                // Cozum: butun a[href]'leri gez, host'u SOY, YOL uzerinden esleştir.
                var ad = '', adKalin = '';
                var slugEsc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                var slugRe = new RegExp('^/' + slugEsc + '(/|$)', 'i');
                var as = document.querySelectorAll('a[href]');
                for (var i = 0; i < as.length; i++) {
                    var href = (as[i].getAttribute('href') || '').split('?')[0].split('#')[0];
                    if (!href) continue;
                    var yol = href.replace(/^https?:\/\/[^/]+/i, '');   // MUTLAK -> yol
                    if (!slugRe.test(yol)) continue;                    // bu sayfaya ait degil
                    // Gonderi/medya permalink'i -> metni zaman damgasidir, AD DEGIL.
                    if (/\/(posts|videos|photos|reel|permalink)\//i.test(yol)) continue;
                    var t = (as[i].innerText || '').replace(/\s+/g, ' ').trim();
                    if (!t || t.length > 60) continue;
                    // Yedek: "3s", "5dk", "2sa", "4h", "1w" gibi zaman damgalari.
                    if (/^\d+\s*[a-zçğıöşü]{1,3}$/i.test(t)) continue;
                    if (!adKalin && as[i].querySelector('strong,h2,h3,h4,span[dir]')) adKalin = t;
                    if (!ad) ad = t;
                }
                ad = adKalin || ad;
                return { ad: ad || slug, id: '', slug: slug, kaynak: ad ? 'url+dom' : 'url' };
            }
            // 1) reel: a[aria-label="Sahibin Profilini Gör"] -> SPESIFIK olarak gonderi sahibi.
            //    Saha: iki anchor ayni href'le gelir; biri avatar (bos metin), biri ADLI.
            //    href: /profile.php?id=100044386777681&sk=reels_tab&__cft__[0]=...
            var owns = document.querySelectorAll('a[aria-label*="Sahibin" i], a[aria-label*="owner profile" i]');
            if (owns.length) {
                var ad = '', href = '';
                for (var i = 0; i < owns.length; i++) {
                    var t = (owns[i].innerText || '').replace(/\s+/g, ' ').trim();
                    if (!href) href = owns[i].getAttribute('href') || '';
                    if (t && !ad) ad = t;              // ADLI anchor'i tercih et
                }
                var idm = href.match(/[?&]id=(\d+)/);
                var slugm = href.match(/^\/([a-zA-Z0-9._-]{3,40})\/?(?:\?|$)/);
                if (ad || idm) {
                    return { ad: ad || '', id: idm ? idm[1] : '',
                             slug: (slugm && slugm[1] !== 'profile.php') ? slugm[1] : '',
                             kaynak: 'sahibin-profili' };
                }
            }
            // 2) "X'i takip et" -> aria-label icinde gorunen ad
            var fol = document.querySelector('[aria-label*="takip et" i], [aria-label*="follow" i]');
            if (fol) {
                var al = fol.getAttribute('aria-label') || '';
                var nm = al.replace(/['’]?[iı]?\s*takip et$/i, '').replace(/^follow\s+/i, '').trim();
                if (nm) return { ad: nm, id: '', slug: '', kaynak: 'takip-et' };
            }
            return { ad: '', id: '', slug: '', kaynak: 'BULUNAMADI' };
        } catch (e) { return { ad: '', id: '', slug: '', kaynak: 'HATA' }; }
    }

    function logToServer(message) {
        chrome.runtime.sendMessage({ action: "logToServer", message: `[WIDGET] ${message}` }).catch(err => {});
    }

    // ============================================================================
    // DOCK MODU BAYRAĞI — varsayılan KAPALI (false) = yeni tasarım:
    //   • Eski alt-sağ sürüklenebilir dock (#x-downloader-widget) DOM'da kalır ama GİZLENİR
    //     (yedek: tüm tarama/uyarı/güncelleme fonksiyonları null-ref kırılmadan çalışır).
    //   • Görünür arayüz = X'in sol navigasyonuna, logonun hemen altına enjekte edilen
    //     yerli GörüntüX butonu (xNavButon*). Tık=Panele Git; dock durumu buraya yansır.
    // OLAĞANÜSTÜ durumda ESKİ dock'u geri getirmek için bunu `true` yap (nav butonu kapanır).
    // ============================================================================
    var X_GX_DOCK_ESKI = (typeof window !== 'undefined' && window.__X_GX_DOCK_ESKI === true);

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
                        --w-accent: #1d9bf0;
                        position: fixed; z-index: 999999;
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                        user-select: none; box-sizing: border-box;
                        transition: transform .18s ease;
                    }
                    #x-downloader-widget.light-theme {
                        --w-bg: #ffffff;
                        --w-text: #0f1419;
                        --w-text-muted: #536471;
                        --w-border: #eff3f4;
                        --w-card-bg: #f7f9fa;
                        --w-shadow: rgba(0, 0, 0, 0.1);
                    }
                    #x-downloader-widget * { box-sizing: border-box; }

                    /* Kenara yapisik dikey ray */
                    #x-downloader-widget .xdock-rail {
                        display: flex; flex-direction: column; align-items: center; gap: 10px;
                        width: 52px; padding: 10px 0;
                        background: var(--w-bg); color: var(--w-text);
                        border: 1px solid var(--w-border); box-shadow: 0 4px 24px var(--w-shadow);
                    }
                    #x-downloader-widget[data-side="right"] { right: 0; }
                    #x-downloader-widget[data-side="right"] .xdock-rail { border-radius: 14px 0 0 14px; border-right: none; }
                    #x-downloader-widget[data-side="left"]  { left: 0; }
                    #x-downloader-widget[data-side="left"]  .xdock-rail { border-radius: 0 14px 14px 0; border-left: none; }

                    /* Gizli: kenardan ~8px dilim gorunur. Hover/surukleme ile acilir. */
                    #x-downloader-widget[data-side="right"] { transform: translateX(44px); }
                    #x-downloader-widget[data-side="left"]  { transform: translateX(-44px); }
                    #x-downloader-widget:hover,
                    #x-downloader-widget.xdock-open,
                    #x-downloader-widget.dragging { transform: translateX(0) !important; }
                    #x-downloader-widget.dragging { transition: none; }

                    /* Logo (baslik yerine) + surukleme tutamagi */
                    #x-downloader-widget .xdock-logo { position: relative; width: 34px; height: 34px; cursor: grab;
                        display: flex; align-items: center; justify-content: center; }
                    #x-downloader-widget.dragging .xdock-logo { cursor: grabbing; }

                    /* Taranıyor: dairesel ilerleme HALKASI (dis cember, ici bos), ortada asama (ör. 1/2).
                       Tarama sirasinda dock ACIK kalir, yalnız halka gorunur (Rapora Ekle gizli). Ilerleme panelde. */
                    #x-downloader-widget .xdock-scan { display: none; position: relative; width: 40px; height: 40px; }
                    #x-downloader-widget.scanning .xdock-scan { display: block; }
                    #x-downloader-widget.scanning { transform: translateX(0) !important; }
                    #x-downloader-widget.scanning #w-buton { display: none; }
                    #x-downloader-widget .xdock-ring-track { fill: none; stroke: var(--w-border); stroke-width: 4; }
                    #x-downloader-widget .xdock-ring-fill { fill: none; stroke: #00ba7c; stroke-width: 4; stroke-linecap: round;
                        transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset .2s linear; }
                    #x-downloader-widget .xdock-scan-txt { position: absolute; inset: 0; display: flex; align-items: center;
                        justify-content: center; font-size: 11px; font-weight: 700; color: var(--w-text); }
                    /* Halka hover fly-out'u: SEFFAF konteyner; icinde AYRI [durum karti] + [✕ iptal].
                       Ikisi de metne gore boyutlanir (width:max-content -> 40px kapsayicida cokme yok). */
                    #x-downloader-widget .xdock-scan-pop { display: none; position: absolute; top: 50%; transform: translateY(-50%);
                        width: max-content; z-index: 6; }
                    #x-downloader-widget .xdock-scan.xdock-scan-open .xdock-scan-pop { display: flex; align-items: center; gap: 8px; }
                    /* Dock sag -> fly-out sola acilir, ✕ EN SOLDA (row-reverse). Dock sol -> tersi. */
                    #x-downloader-widget[data-side="right"] .xdock-scan-pop { right: 46px; flex-direction: row-reverse; }
                    #x-downloader-widget[data-side="left"]  .xdock-scan-pop { left: 46px; flex-direction: row; }
                    /* Durum karti: metne gore boyut (uzun metin ~190px'te sarar). */
                    #x-downloader-widget .xdock-scan-msg { flex: 0 0 auto; width: max-content; max-width: 200px;
                        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                        padding: 8px 11px; font-size: 12px; line-height: 1.3;
                        background: var(--w-bg); color: var(--w-text); border: 1px solid var(--w-border);
                        border-radius: 10px; box-shadow: 0 6px 24px var(--w-shadow); }
                    /* IPTAL: bilgi balonunun DISINDA, ayri kirmizi yuvarlak ikon (SADECE ✕). */
                    #x-downloader-widget .xdock-scan-cancel { position: relative; flex: none; width: 34px; height: 34px; padding: 0;
                        border: none; border-radius: 50%; background: #e0245e; color: #fff; font-size: 15px; cursor: pointer;
                        display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px var(--w-shadow); }
                    #x-downloader-widget .xdock-scan-cancel:hover { background: #c81e4f; }
                    /* Uyari: metne gore boyut (max-content, cok uzunsa 220px'te sarar). ✕ altinda. */
                    #x-downloader-widget .xdock-cancel-warn { display: none; }
                    #x-downloader-widget .xdock-scan-cancel:hover .xdock-cancel-warn { display: block; position: absolute;
                        top: calc(100% + 8px); left: 50%; transform: translateX(-50%);
                        width: max-content; max-width: 220px; padding: 7px 9px; font-size: 11px; font-weight: 600; line-height: 1.3;
                        background: var(--w-card-bg); color: #ff5c81; border: 1px solid #e0245e; border-radius: 8px;
                        box-shadow: 0 4px 16px var(--w-shadow); z-index: 7; }

                    /* Ikon butonlar */
                    /* Buton favicon (logo) ile ayni boyutta: 34x34, ikon ~16px. */
                    #x-downloader-widget .xdock-btn { position: relative; width: 34px; height: 34px; border-radius: 50%;
                        border: 1px solid var(--w-border); background: var(--w-card-bg); color: var(--w-text);
                        font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center;
                        transition: background .15s, transform .1s, box-shadow .2s; padding: 0; }
                    /* BAGLANTI VAR: yesil + isik sacar (glow). Islev artik butonda (ayri nokta yok). */
                    #x-downloader-widget .xdock-btn.connected { background: #00ba7c; color: #fff; border-color: #00ba7c;
                        animation: xdockGlow 2.2s ease-in-out infinite; }
                    @keyframes xdockGlow {
                        0%,100% { box-shadow: 0 0 7px 0 rgba(0,186,124,.55); }
                        50%     { box-shadow: 0 0 16px 3px rgba(0,186,124,.9); }
                    }
                    /* GUNCELLEME VAR: sari + uyari. */
                    #x-downloader-widget .xdock-btn.outdated { background: #f5a623; color: #3b2a00; border-color: #f5a623;
                        box-shadow: 0 0 10px 1px rgba(245,166,35,.6); animation: none; }
                    /* Sarı butonda yalnız BEYAZ ünlem (düz "!" metni; emoji degil, filter gereksiz). */
                    #x-downloader-widget .xdock-btn.outdated .xdock-ico { color: #fff; font-weight: 800; font-size: 19px; }
                    #x-downloader-widget .xdock-btn:hover { transform: scale(1.06); }
                    #x-downloader-widget .xdock-btn:disabled { cursor: default; transform: none; }
                    #x-downloader-widget .xdock-ico { pointer-events: none; line-height: 1; }
                    /* Yesil (connected) butonda ikon BEYAZ olsun: renkli emoji'yi (➕ / ⏳ / ✔️ / ⚠️)
                       beyaz siluete cevir. color emoji'yi etkilemedigi icin brightness(0)+invert(1). */
                    #x-downloader-widget .xdock-btn.connected .xdock-ico { filter: brightness(0) invert(1); }
                    /* Hover'da acik yone dogru etiket balonu (+ gecici durumlarda .xdock-show-lbl ile) */
                    #x-downloader-widget .xdock-lbl { position: absolute; top: 50%;
                        transform: translateY(-50%) scale(.9); white-space: nowrap;
                        padding: 6px 10px; border-radius: 8px; font-size: 12px; font-weight: 600;
                        background: var(--w-bg); color: var(--w-text); border: 1px solid var(--w-border);
                        box-shadow: 0 4px 16px var(--w-shadow); opacity: 0; pointer-events: none;
                        transition: opacity .12s, transform .12s; }
                    #x-downloader-widget[data-side="right"] .xdock-lbl { right: 48px; }
                    #x-downloader-widget[data-side="left"]  .xdock-lbl { left: 48px; }
                    #x-downloader-widget .xdock-btn:hover .xdock-lbl,
                    #x-downloader-widget .xdock-logo:hover .xdock-lbl,
                    #x-downloader-widget .xdock-btn.xdock-show-lbl .xdock-lbl { opacity: 1; transform: translateY(-50%) scale(1); }

                    /* Guncelleme uyari balonu (Rapora Ekle butonunda; .outdated ile acilir/genisler) */
                    #x-downloader-widget .xdock-warn { display: none; }
                    #x-downloader-widget .xdock-btn.outdated .xdock-warn { display: block; position: absolute; top: -6px;
                        width: 200px; padding: 9px 11px; font-size: 11px; line-height: 1.4; font-weight: 500;
                        background: var(--w-card-bg); color: var(--w-text); border: 1px solid var(--w-border);
                        border-radius: 10px; box-shadow: 0 4px 16px var(--w-shadow); z-index: 3; cursor: pointer; }
                    #x-downloader-widget[data-side="right"] .xdock-warn { right: 50px; }
                    #x-downloader-widget[data-side="left"]  .xdock-warn { left: 50px; }
                    #x-downloader-widget .xdock-warn b { color: var(--w-text); }
                    #x-downloader-widget .xdock-warn .xdock-warn-link { color: #1d9bf0; font-weight: 700; }

                    /* Tarama/idle kodunun bekledigi ama artik gizli dugumler */
                    #x-downloader-widget .xdock-hidden { display: none !important; }
                    /* Tam ekran (video fullscreen) -> tum dock gizli (window.xRaporFsListener). */
                    #x-downloader-widget.xdock-fs-gizli { display: none !important; }
                    /* YENI MOD (X_GX_DOCK_ESKI=false): eski dock gorunmez yedek; arayuz nav butonunda. */
                    #x-downloader-widget.x-gx-dock-yedek { display: none !important; }

                    /* Etkilesimli tarama diyalogu (limit/atla): dock KENARDA kalir, durum metni
                       acik yone BITISIK bir kart olarak ANLIK acilir; kapaninca dar hale doner. */
                    #x-downloader-widget .xdock-status { display: none; }
                    #x-downloader-widget.xdock-dialog { transform: translateX(0) !important; }
                    #x-downloader-widget.xdock-dialog #w-buton,
                    #x-downloader-widget.xdock-dialog .xdock-scan { display: none; }
                    #x-downloader-widget.xdock-dialog .xdock-status {
                        display: block; position: absolute; top: 50%; transform: translateY(-50%);
                        width: 212px; padding: 12px 14px; box-sizing: border-box; font-size: 12px; line-height: 1.45;
                        background: var(--w-bg); color: var(--w-text); border: 1px solid var(--w-border);
                        border-radius: 12px; box-shadow: 0 6px 24px var(--w-shadow); z-index: 5; }
                    #x-downloader-widget[data-side="right"].xdock-dialog .xdock-status { right: 52px; }
                    #x-downloader-widget[data-side="left"].xdock-dialog  .xdock-status { left: 52px; }
                `;
                document.head.appendChild(styleEl);
            }

            // 2. Create new widget element
            const widget = document.createElement('div'); 
            widget.id = 'x-downloader-widget'; 
            // Konumlandirma artik CSS'te (#x-downloader-widget). Varsayilan: sag kenar, top=100.
            // Kalici deger (dock_side/dock_top) asagida chrome.storage'dan yuklenir.
            widget.setAttribute('data-side', 'right');
            widget.style.top = '100px';

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

            // TAM EKRAN (fullscreen) -> dock GIZLE (tum platformlar, kullanici istegi). Video tam
            // ekranken dock ustte gorunmesin; cikinca geri gelsin. Yalniz GERCEK fullscreen (F/tam
            // ekran dugmesi); tiyatro modu haric. Tema dinleyicisi gibi TEKIL kalici window handler
            // (yeniden enjeksiyonda mukerrer olmasin).
            if (window.xRaporFsListener) {
                document.removeEventListener('fullscreenchange', window.xRaporFsListener);
                document.removeEventListener('webkitfullscreenchange', window.xRaporFsListener);
            }
            window.xRaporFsListener = () => {
                const widgetEl = document.getElementById('x-downloader-widget');
                if (!widgetEl) return;
                const tamEkran = !!(document.fullscreenElement || document.webkitFullscreenElement);
                widgetEl.classList.toggle('xdock-fs-gizli', tamEkran);
            };
            document.addEventListener('fullscreenchange', window.xRaporFsListener);
            document.addEventListener('webkitfullscreenchange', window.xRaporFsListener);
            window.xRaporFsListener();   // ilk durum (widget tam ekranken enjekte olduysa hemen gizle)

            // === Kalici konum: kaydedilmis taraf + dikey konum ===
            chrome.storage.local.get({ dock_side: 'right', dock_top: 100 }, (r) => {
                widget.setAttribute('data-side', r.dock_side === 'left' ? 'left' : 'right');
                widget.style.top = (parseInt(r.dock_top, 10) || 100) + 'px';
            });

            // === Ray (rail): logo (Panele Git) + taranıyor isigi + Rapora Ekle butonu ===
            const rail = document.createElement('div');
            rail.className = 'xdock-rail';

            // Logo (baslik metni YOK) = FAVICON. Ayni zamanda "Panele Git" (tikla) + surukleme
            // tutamagi. Tikla vs surukle: initDockDrag esikle ayirir (kimildamadiysa -> panele git).
            const logo = document.createElement('div');
            logo.className = 'xdock-logo';
            logo.id = 'w-panel-buton';
            logo.title = 'GörüntüX\'e Git · sürükleyerek taşı';
            logo.innerHTML = `<svg width="30" height="30" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="7" fill="#1d9bf0"/><g fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12V9h3"/><path d="M20 9h3v3"/><path d="M23 20v3h-3"/><path d="M12 23H9v-3"/><path d="M13 13l6 6M19 13l-6 6"/></g></svg><span class="xdock-lbl">GörüntüX'e Git</span>`;
            rail.appendChild(logo);

            // Taranıyor halkasi (.scanning ile acilir): dis cember ilerlemeye gore dolar,
            // ortasinda asama (tamamlanan/toplam). Cember cevresi = 2*pi*16 ≈ 100.53.
            const scanDot = document.createElement('div');
            scanDot.className = 'xdock-scan';
            scanDot.innerHTML = `<svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><circle class="xdock-ring-track" cx="20" cy="20" r="16"></circle><circle class="xdock-ring-fill" id="w-scan-ring" cx="20" cy="20" r="16" stroke-dasharray="100.53" stroke-dashoffset="100.53"></circle></svg><span class="xdock-scan-txt" id="w-scan-txt">0/0</span><div class="xdock-scan-pop"><div class="xdock-scan-msg" id="w-scan-msg">Taranıyor…</div><button class="xdock-scan-cancel" id="w-scan-cancel" type="button" aria-label="Taramayı iptal et">✕<span class="xdock-cancel-warn">Bu tarama işlemini durdurur ve panele döner.</span></button></div>`;
            // Halkaya gelince fly-out acilir: AYRI [durum karti] + [✕ iptal]. ✕, bilgi balonunun DISINDA
            // ve acik tarafta EN DISTA (dock sag -> en solda; dock sol -> en sagda; CSS flex yonu ile).
            // Ikisi de metne gore boyutlanir. Grace-timer (250ms) ile halka<->fly-out gecisinde kapanmaz.
            (function initScanPop() {
                let _t = null;
                const _ac = () => {
                    if (_t) { clearTimeout(_t); _t = null; }
                    const _msg = document.getElementById('w-scan-msg');
                    // Platforma gore temiz cumle (ör. "Instagram görseli alınıyor."). Sayac halkada.
                    if (_msg) { _msg.textContent = xPlatformAdi() + ' görseli alınıyor.'; }
                    scanDot.classList.add('xdock-scan-open');
                };
                const _kapatYakinda = () => { if (_t) clearTimeout(_t); _t = setTimeout(() => scanDot.classList.remove('xdock-scan-open'), 250); };
                scanDot.addEventListener('mouseenter', _ac);
                scanDot.addEventListener('mouseleave', _kapatYakinda);
                const _iptal = scanDot.querySelector('#w-scan-cancel');
                if (_iptal) _iptal.addEventListener('click', (e) => { e.stopPropagation(); xTaramaIptal(); });
            })();
            rail.appendChild(scanDot);

            // Ana buton: "Rapora Ekle" (ikon; hover'da etiket). ID korunur (#w-buton).
            // BAGLANTI DURUMUNU DA TASIR (kullanici istegi): .connected -> yesil + isik sacar (glow);
            // .outdated -> sari + uyari balonu (#w-conn-warn) + kilit. Ayri yesil nokta YOK.
            const buton = document.createElement('button');
            buton.id = 'w-buton';
            buton.className = 'xdock-btn connected';
            buton.innerHTML = `<span class="xdock-ico">➕</span><span class="xdock-lbl">Rapora Ekle</span><div class="xdock-warn" id="w-conn-warn"></div>`;
            rail.appendChild(buton);

            widget.appendChild(rail);

            // === Tarama/idle kodunun bekledigi ama artik GIZLI dugumler (uyumluluk) ===
            // durumText (#w-durum): showStatus/showError/renderIdleWidget yazar; dock'ta gorunmez.
            const durumText = document.createElement('div');
            durumText.id = 'w-durum';
            durumText.className = 'xdock-status';   // normalde gizli; YALNIZ .xdock-dialog'da kart olur
            widget.appendChild(durumText);
            // progressBox (#w-progress-*): initWidgetTimer/scan gunceller; ilerleme panelde.
            const progressBox = document.createElement('div');
            progressBox.id = 'w-progress-box';
            progressBox.className = 'xdock-hidden';
            progressBox.innerHTML = `
                <span id="w-progress-counter">0 / 0</span>
                <span id="w-progress-timer">⏱ 00:00</span>
                <div id="w-progress-bar-fill"></div>
            `;
            widget.appendChild(progressBox);

            document.body.appendChild(widget);

            // YENI MOD: eski dock'u GIZLE (gorunmez yedek) + sol-nav GoruntuX butonunu baslat.
            // Durum (tarama/guncelleme) gizli dock'tan nav butonuna MutationObserver ile yansir.
            if (!X_GX_DOCK_ESKI) {
                try { widget.classList.add('x-gx-dock-yedek'); } catch (e) {}
                try { xNavButonPollerBaslat(); } catch (e) {}
            }
            // [TIK SECIM / Step 2] Tweet tik ikonlari + alttan kayan secim menusu (her enjekte X sayfasinda).
            try { xTikInit(); } catch (e) {}
            // [YOUTUBE SS] YouTube /watch'ta Begeni'nin soluna yesil "+" GoruntuX butonu (yalniz yt'de aktif).
            try { xYtButonInit(); } catch (e) {}
            // [INSTAGRAM SS] Her gönderinin Kaydet butonunun soluna yesil "+" GoruntuX butonu (yalniz ig'de aktif).
            try { xIgButonInit(); } catch (e) {}
            // [FACEBOOK SS] Her gönderi kartinin basligindaki ⋯/X butonlarinin SOLUNA yesil "+" GoruntuX butonu
            // (yalniz fb'de aktif) -> anasayfa feed'inde de kart SS'i alinabilir.
            try { xFbButonInit(); } catch (e) {}
            // [TIKTOK SS] Her video gönderisinin sağ aksiyon kolonuna (beğeni/yorum/paylaş; FB Reels deseni)
            // yeşil "+" GoruntuX butonu (yalniz tt'de aktif).
            try { xTtButonInit(); } catch (e) {}
            // [RT LİSTE VİDEOSU] X RT/beğeni/alıntı listesinde orta bloğu VİDEO kaydet (Region yerine canvas-kırp;
            // getDisplayMedia preferCurrentTab -> sekme akışı -> liste rect'ine kırp -> MediaRecorder -> .webm indir).
            try { xVideoInit(); } catch (e) {}
            // [GÜNCELLEME F5] Eklenti ↻ yenilenince bu sayfadaki içerik-script KOPAR -> chrome çağrıları patlar,
            // butonlar "Hata" verir. Kopukluğu sez -> sayfaya "Yenile (F5)" toast'ı koy (X + tüm sosyal medya).
            try { xGxGuncellemeKontrolBaslat(); } catch (e) {}

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

            // [BEYAZ KENAR KIRP 2026-11-04] Yakalanan görselin SAĞ+SOL kenarındaki ~beyaz (içeriksiz) sütunları kırpar.
            // IG profilden açılan modalda carousel medya+yorum bloğu geniş kapta ORTALANIP yanlara beyaz bırakıyordu;
            // viewport'a göre değişken + bazen tam-genişlik şeffaf sarmalayıcı DOM-tabanlı kırpmayı atlatıyordu ->
            // PİKSEL tabanlı her durumda çalışır. Bir sütun "beyaz" = örneklenen satırların HEPSİ ~beyaz (RGB>=TH).
            // Yorum paneli metin/ikon içerir -> beyaz değil, KORUNUR. Sol cap küçük (foto; cropLeft zaten foto soluna
            // hizalı), sağ cap büyük (asıl beyaz orada). Kırpacak kenar beyazı yoksa (standalone) ORİJİNAL döner.
            function igTrimBeyazKenar(dataUrl) {
                return new Promise(function (resolve) {
                    try {
                        var img = new Image();
                        img.onload = function () {
                            try {
                                var w = img.naturalWidth, h = img.naturalHeight;
                                if (!w || !h || w < 60) { resolve(dataUrl); return; }
                                var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
                                var cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
                                var d = cx.getImageData(0, 0, w, h).data;
                                var TH = 248, STEP = 3;
                                function colBeyaz(x) {
                                    for (var y = 0; y < h; y += STEP) { var i = (y * w + x) * 4; if (d[i] < TH || d[i + 1] < TH || d[i + 2] < TH) return false; }
                                    return true;
                                }
                                var solCap = Math.floor(w * 0.15), sagCap = Math.floor(w * 0.45);
                                var left = 0; while (left < solCap && colBeyaz(left)) left++;
                                var right = w - 1; while ((w - 1 - right) < sagCap && right > left + 60 && colBeyaz(right)) right--;
                                if (left <= 1 && right >= w - 2) { resolve(dataUrl); return; }   // kenar beyazı yok -> dokunma
                                var nw = right - left + 1;
                                var cv2 = document.createElement('canvas'); cv2.width = nw; cv2.height = h;
                                cv2.getContext('2d').drawImage(cv, left, 0, nw, h, 0, 0, nw, h);
                                resolve(cv2.toDataURL('image/png'));
                            } catch (e) { resolve(dataUrl); }
                        };
                        img.onerror = function () { resolve(dataUrl); };
                        img.src = dataUrl;
                    } catch (e) { resolve(dataUrl); }
                });
            }

            // Faz IG-1: Instagram gonderi kartini (media iceren article) guvenilir sec.
            // 'main article' bazen yanlis/tam-genislik element donduruyordu; medyayi iceren article'i tercih et.
            function igFindPost() {
                try {
                    // [YT/IG BUTON — HEDEF GÖNDERİ] Tıklanan Kaydet butonunun gönderisi set edilmişse onu döndür
                    // (çoklu-feed'de en-büyük-medya yerine TIKLANAN gönderi yakalansın; tüm iç igFindPost çağrıları tutarlı).
                    if (window.__xIgHedefPost && document.contains(window.__xIgHedefPost)) return window.__xIgHedefPost;
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

            // v4.3 (kullanıcı isteği): Yanıt/yorum tweeti ise, DOĞRUDAN yanıt verilen (bir üstteki)
            // tweeti de görüntüye dahil et. Link/başlık YANIT tweetine ait kalır (çağıran ayarlar).
            // İki görseli dikey birleştir: 1 ÜSTTE (parent), 2 ALTTA (yanıt). Beyaz zemin.
            function xDikeyBirlestir(dataUrl1, dataUrl2) {
                return new Promise(function (resolve, reject) {
                    var img1 = new Image(), img2 = new Image(), yuklenen = 0;
                    function tamam() {
                        try {
                            var w = Math.max(img1.naturalWidth || img1.width, img2.naturalWidth || img2.width);
                            var h = (img1.naturalHeight || img1.height) + (img2.naturalHeight || img2.height);
                            var c = document.createElement('canvas'); c.width = w; c.height = h;
                            var ctx = c.getContext('2d');
                            ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
                            ctx.drawImage(img1, 0, 0);
                            ctx.drawImage(img2, 0, (img1.naturalHeight || img1.height));
                            resolve(c.toDataURL('image/png'));
                        } catch (e) { reject(e); }
                    }
                    img1.onload = function () { if (++yuklenen === 2) tamam(); };
                    img2.onload = function () { if (++yuklenen === 2) tamam(); };
                    img1.onerror = img2.onerror = function () { reject(new Error('resim yuklenemedi')); };
                    img1.src = dataUrl1; img2.src = dataUrl2;
                });
            }
            // Odak (yanıt) tweeti + varsa DOĞRUDAN parent'ı yakala. Parent = odak article'ın DOM'da
            // HEMEN ÖNCESİndeki article (X detay sayfasında atalar üstte, yanıtlar altta). Odak ilk
            // article ise -> yanıt değil (standalone) -> tek yakala (ESKİ davranış, sıfır regresyon).
            async function xYakalaTweetVeYanit(focusedArticle, articles) {
                async function _yakala(el, opts) {
                    el.scrollIntoView({ block: 'start', behavior: 'instant' });
                    await new Promise(r => setTimeout(r, 600));
                    return await captureArticle(el, opts) || "";
                }
                var parentArticle = null;
                try {
                    var arr = Array.prototype.slice.call(articles || []);
                    var idx = arr.indexOf(focusedArticle);
                    if (idx > 0) { parentArticle = arr[idx - 1]; }
                } catch (e) {}
                // X UZUN TWEET: ana (parent) + odak tweetteki "Daha fazla göster" otomatik aç -> kesik metin yakalanmasın.
                // Scroll/ölçümden ÖNCE: açılan metin yüksekliği doğru ölçülür (hem tek-geçiş hem parça-parça yolu).
                try { if (parentArticle) await xTweetMetniAc(parentArticle); } catch (e) {}
                try { await xTweetMetniAc(focusedArticle); } catch (e) {}
                if (!parentArticle) { return await _yakala(focusedArticle); }
                // v4.39 TEK-GEÇİŞ: parent + odak BİTİŞİK -> bir kerede yakala (ayrı SS + birleştirme yerine). Çıktı
                // aynı: atalar tam, odak footer'sız; ama atalar arası X thread DOĞAL görünür (parça-birleştirme yok).
                // Bayrak x_coklu_tekgecis='0' -> eski parça-parça. Başarısız/kısa dönerse de parça-parça'ya düşer.
                if (xTekGecisAcik()) {
                    try {
                        parentArticle.scrollIntoView({ block: 'start', behavior: 'instant' });
                        await new Promise(r => setTimeout(r, 600));
                        var _tek = await captureArticle(focusedArticle, { rangeTop: parentArticle }) || "";
                        if (_tek && _tek.length > 100) return _tek;
                    } catch (e) { printLog("Tek-geçiş (2'li) hata, parça-parça: " + ((e && e.message) || e)); }
                }
                // Parça-parça (eski): parent TAM yükseklikte + footer-gizlemesiz (saat başlıkta), odak normal.
                var parentImg = await _yakala(parentArticle, { tamYukseklik: true });
                var focusedImg = await _yakala(focusedArticle);
                if (parentImg && parentImg.length > 100 && focusedImg && focusedImg.length > 100) {
                    try { return await xDikeyBirlestir(parentImg, focusedImg); }
                    catch (e) { printLog("Dikey birleştirme hatası: " + ((e && e.message) || e)); return focusedImg; }
                }
                return focusedImg || parentImg;
            }
            // v4.39 TEK-GEÇİŞ bayrağı: bitişik seçili tweetler tek scroll+stitch ile yakalanır (hız). '0' -> parça-parça.
            function xTekGecisAcik() { try { return localStorage.getItem('x_coklu_tekgecis') !== '0'; } catch (e) { return true; } }

            // === ÇOKLU TWEET SEÇ + YAKALA (v4.33, kullanıcı isteği) ===
            // Derin zincir (A←B←C) / flood: eklenen tweetin ≥2 atası varsa, kullanıcıya atalar + eklenen tweet
            // ONAY KUTULARIYLA sunulur; seçilenler yukarıdan aşağıya dikey birleştirilir. 1 ata (ana+yorum) ve
            // tekil tweet -> ESKİ otomatik davranış (xYakalaTweetVeYanit) dokunulmaz. Bayrak x_coklu_sec='0' -> kapalı.
            // N görseli dikey birleştir (beyaz zemin, en geniş genişlik). xDikeyBirlestir'in N-genellemesi.
            function xDikeyBirlestirN(dataUrls) {
                return new Promise(function (resolve, reject) {
                    if (!dataUrls || !dataUrls.length) { reject(new Error('resim yok')); return; }
                    if (dataUrls.length === 1) { resolve(dataUrls[0]); return; }
                    var imgs = dataUrls.map(function () { return new Image(); });
                    var yuklenen = 0, hata = false;
                    function tamam() {
                        try {
                            var w = 0, h = 0;
                            imgs.forEach(function (im) { w = Math.max(w, im.naturalWidth || im.width); h += (im.naturalHeight || im.height); });
                            var c = document.createElement('canvas'); c.width = w; c.height = h;
                            var ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
                            var y = 0;
                            imgs.forEach(function (im) { ctx.drawImage(im, 0, y); y += (im.naturalHeight || im.height); });
                            resolve(c.toDataURL('image/png'));
                        } catch (e) { reject(e); }
                    }
                    imgs.forEach(function (im, i) {
                        im.onload = function () { if (++yuklenen === imgs.length && !hata) tamam(); };
                        im.onerror = function () { if (!hata) { hata = true; reject(new Error('resim yuklenemedi')); } };
                        im.src = dataUrls[i];
                    });
                });
            }
            // Seçilen article'ları (yukarıdan aşağıya) yakala: atalar TAM yükseklikte (bağlam), en alttaki (eklenen
            // tweet) NORMAL (footer gizli, saat-kırpması). Hepsini xDikeyBirlestirN ile birleştir.
            async function xYakalaCoklu(secilenler, adaylar) {
                async function _yakala(el, opts) {
                    el.scrollIntoView({ block: 'start', behavior: 'instant' });
                    await new Promise(r => setTimeout(r, 600));
                    return await captureArticle(el, opts) || "";
                }
                if (!secilenler || !secilenler.length) return "";
                // X UZUN TWEET: seçili tüm article'larda "Daha fazla göster" otomatik aç (tek öğe dahil; ölçümden önce).
                for (var _si = 0; _si < secilenler.length; _si++) { try { await xTweetMetniAc(secilenler[_si]); } catch (e) {} }
                if (secilenler.length === 1) return await _yakala(secilenler[0]);
                // v4.39 TEK-GEÇİŞ: seçim BİTİŞİK (en alt=odak, aralıkta boşluk YOK) ise bir kerede yakala. Boşluklu
                // (üstten atlanmış ata) ise parça-parça (bölgeye istenmeyen ata girmesin). Bayrak x_coklu_tekgecis.
                if (xTekGecisAcik() && adaylar && adaylar.length) {
                    var _ilk = adaylar.indexOf(secilenler[0]);
                    var _bitisik = (_ilk >= 0 && secilenler.length === adaylar.length - _ilk);   // secilenler == adaylar.slice(_ilk)
                    if (_bitisik) {
                        try {
                            var _ust = secilenler[0], _odak = secilenler[secilenler.length - 1];
                            _ust.scrollIntoView({ block: 'start', behavior: 'instant' });
                            await new Promise(r => setTimeout(r, 600));
                            var _tek = await captureArticle(_odak, { rangeTop: _ust }) || "";
                            if (_tek && _tek.length > 100) return _tek;
                        } catch (e) { printLog("Tek-geçiş (çoklu) hata, parça-parça: " + ((e && e.message) || e)); }
                    }
                }
                var imgs = [];
                for (var i = 0; i < secilenler.length; i++) {
                    var sonMu = (i === secilenler.length - 1);   // en alt = eklenen tweet -> normal; üsttekiler tam-yükseklik
                    var img = await _yakala(secilenler[i], sonMu ? {} : { tamYukseklik: true });
                    if (!img || img.length < 100) return "";   // bir parça alınamadı -> başarısız (çağıran uyarır)
                    imgs.push(img);
                }
                try { return await xDikeyBirlestirN(imgs); }
                catch (e) { printLog("Çoklu birleştirme hatası: " + ((e && e.message) || e)); return imgs[imgs.length - 1] || ""; }
            }
            // Seçim ekranı: her aday article'a onay-kutusu overlay + altta onay çubuğu. Promise -> seçilen article'lar
            // (adaylar sırasında) veya null (iptal). focusedArticle KİLİTLİ (hep seçili). Varsayılan: focused + direkt üstü.
            function xCokluTweetSec(adaylar, focusedArticle) {
                return new Promise(function (resolve) {
                    var temizle = [];
                    var secili = new Set();
                    secili.add(focusedArticle);
                    var fIdx = adaylar.indexOf(focusedArticle);
                    if (fIdx > 0) secili.add(adaylar[fIdx - 1]);   // direkt üstü de varsayılan
                    var sayiGuncelle = function () {};
                    adaylar.forEach(function (art) {
                        var oPos = art.style.position;
                        if (getComputedStyle(art).position === 'static') art.style.position = 'relative';
                        var kilitli = (art === focusedArticle);
                        var ov = document.createElement('div');
                        ov.className = 'w-tsec-ov';
                        ov.style.cssText = 'position:absolute;inset:0;z-index:2147483000;cursor:pointer;box-sizing:border-box;border:3px solid transparent;border-radius:12px;transition:border-color .1s,background .1s;';
                        // Etiket: gönderinin SAĞ-ALTINDA, OPAK zemin (seçili tweetler zaten mavi çerçeyle belli -> tik yok).
                        var etiket = document.createElement('div');
                        etiket.style.cssText = 'position:absolute;bottom:10px;right:10px;padding:5px 11px;border-radius:8px;font-size:12px;font-weight:700;color:#fff;background:' + (kilitli ? '#1d9bf0' : '#15202b') + ';border:1px solid rgba(255,255,255,.18);box-shadow:0 2px 8px rgba(0,0,0,.5);font-family:system-ui,-apple-system,sans-serif;';
                        etiket.textContent = kilitli ? 'Eklenen gönderi' : 'Üst gönderi';
                        ov.appendChild(etiket);
                        function yansit() {
                            var on = secili.has(art);
                            ov.style.borderColor = on ? '#1d9bf0' : 'rgba(29,155,240,.35)';
                            ov.style.background = on ? 'rgba(29,155,240,.10)' : 'transparent';
                        }
                        ov.addEventListener('click', function (e) {
                            e.preventDefault(); e.stopPropagation();
                            if (kilitli) return;
                            if (secili.has(art)) secili.delete(art); else secili.add(art);
                            yansit(); sayiGuncelle();
                        }, true);
                        yansit();
                        art.appendChild(ov);
                        temizle.push(function () { try { ov.remove(); art.style.position = oPos; } catch (_) {} });
                    });
                    // Alt çubuk: panelin çoklu-rapor seçim çubuğu gibi -> ORTALI yüzen pill (bg/kenar/radius/gölge),
                    // outline butonlar, aşağıdan slide-up. (Panel .x-secim-bar / .x-secim-btn ile aynı dil.)
                    var bar = document.createElement('div');
                    bar.id = 'w-tsec-bar';
                    bar.style.cssText = 'position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));transform:translateX(-50%) translateY(130%);z-index:2147483600;max-width:calc(100vw - 20px);width:max-content;background:#15202b;color:#e7e9ea;border:1px solid rgba(136,153,166,0.3);border-radius:14px;padding:12px 14px;box-shadow:0 10px 30px rgba(0,0,0,0.45);display:flex;flex-direction:column;gap:10px;font-family:system-ui,-apple-system,sans-serif;transition:transform .24s cubic-bezier(.2,.8,.2,1);';
                    var bilgi = document.createElement('div'); bilgi.style.cssText = 'font-size:13px;line-height:1.4;max-width:440px;';
                    bilgi.innerHTML = '<b style="color:#fff">Rapora eklenecek gönderileri seçin</b><br><span style="opacity:.78">Eklediğiniz gönderi bağlı. Diziye katmak istediğiniz üst gönderileri seçin.</span>';
                    var btnWrap = document.createElement('div'); btnWrap.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
                    var bstil = 'display:inline-flex;align-items:center;gap:6px;padding:7px 14px;font-size:13px;font-weight:600;border-radius:9px;border:1px solid rgba(136,153,166,0.3);background:transparent;color:#e7e9ea;cursor:pointer;white-space:nowrap;';
                    var iptal = document.createElement('button'); iptal.textContent = 'İptal'; iptal.style.cssText = bstil;
                    var ekle = document.createElement('button'); ekle.style.cssText = bstil + 'border-color:#1d9bf0;color:#1d9bf0;font-weight:700;';
                    btnWrap.appendChild(iptal); btnWrap.appendChild(ekle);
                    bar.appendChild(bilgi); bar.appendChild(btnWrap);
                    document.body.appendChild(bar);
                    requestAnimationFrame(function () { bar.style.transform = 'translateX(-50%) translateY(0)'; });   // slide-up
                    temizle.push(function () { try { bar.remove(); } catch (_) {} });
                    sayiGuncelle = function () { ekle.textContent = 'Seçilenleri Ekle (' + secili.size + ')'; };
                    sayiGuncelle();
                    var _bitti = false;
                    function bitir(sonuc) { if (_bitti) return; _bitti = true; temizle.forEach(function (f) { f(); }); resolve(sonuc); }
                    ekle.addEventListener('click', function () { var s = adaylar.filter(function (a) { return secili.has(a); }); bitir(s.length ? s : null); });
                    iptal.addEventListener('click', function () { bitir(null); });
                    // [OTO-KAPAT] İlgili gönderiden BAŞKA sayfaya gidilirse (X SPA = pushState; URL yolu değişir) seçim
                    // ekranını İPTAL et -> çubuk/overlay body'de asılı kalmasın (kullanıcı isteği). Yol değişimini yokla.
                    var _acilisPath = location.pathname;
                    var _urlTimer = setInterval(function () { if (location.pathname !== _acilisPath) bitir(null); }, 300);
                    temizle.push(function () { clearInterval(_urlTimer); });
                    // [SCROLL] Varsayılan seçili ÇİFT (eklenen gönderi C + direkt üstü B) çubuğun üstündeki görünür
                    // alanın MERKEZİNE gelsin (kullanıcı: "A-B-C'de scroll B-C merkezde olsun"). En üstteki ataya
                    // kaydırmak ÇOK yukarı gidiyordu.
                    try {
                        var _dUst = (fIdx > 0) ? adaylar[fIdx - 1] : focusedArticle;   // B (direkt üst)
                        var _ciftUst = _dUst.getBoundingClientRect().top;
                        var _ciftAlt = focusedArticle.getBoundingClientRect().bottom;
                        var _barH = bar.offsetHeight || 92;   // transform offsetHeight'ı etkilemez
                        var _gorunurAlt = window.innerHeight - _barH - 28;   // çubuğun üstündeki görünür alanın altı
                        var _delta = ((_ciftUst + _ciftAlt) / 2) - (_gorunurAlt / 2);   // B-C merkezini görünür alan merkezine taşı
                        window.scrollBy({ top: Math.round(_delta), behavior: 'smooth' });
                    } catch (_) {}
                });
            }

            // Tweet elementini yakala (Yerel captureVisibleTab, Scroll Spacer ve Scroll-and-Stitch entegrasyonuyla)
            // 1) Sayfadaki tüm resimlerin yüklenmesini bekle
            // 2) Tweetin tarih/saat satırından sonrasını (beğeni/rt sayıları, butonlar) gizle
            // 3) Sayfa altına geçici büyük boşluk (spacer) ekle ki tweet en üste kayabilsin
            // 4) Yapışkan (sticky/fixed) barları ve eklenti widget'ını gizle
            // 5) Tweeti en üste kaydır, Screenshot 1'i al
            // 6) Eğer tweet viewport'a sığıyorsa tek ekran görüntüsü kırp, sığmıyorsa aşağı kaydırıp Screenshot 2'yi al ve birleştir (Stitch)
            async function captureArticle(element, opts) {
                opts = opts || {};   // v4.5: opts.tamYukseklik -> parent (saat başlıkta) için footer-gizleme + saat-kırpması ATLA
                // [SCROLL GERİ-YÜKLE] Yakalama BAŞLAMADAN önceki scroll'u sakla; finally'de BURAYA dön (eski
                // kod top:0'a ZIPLIYORDU -> /status/ tweet detaydan profile dönüşte gereksiz kayma hissi).
                const _origScrollY = window.scrollY || document.documentElement.scrollTop || 0;
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
                let igMsgHidden = []; // Faz IG-1: no-zoom modunda gizlenen Instagram "Mesajlar" (DM) balonu
                let dateTimeRow = null;
                const isInstagram = window.location.hostname.includes('instagram.com');

                // Faz IG-1 (sade no-zoom): kırpma hedefi = TÜM post kartı (article) — solda medya + sağda
                // kullanıcı adı/açıklama/hashtag/yorum/etkileşim sütunu. Böylece açıklama da görüntüye girer.
                // (Sadece medya elementini ölçünce sağ sütun/açıklama kırpma dışında kalıyordu.)
                if (isInstagram) {
                    const igPost = igFindPost();
                    if (igPost) element = igPost;
                }

                try {
                    xGxButonlariGizle();   // [GÖRÜNTÜX İLE RAPORLA] profil/tweet SS'inde butonumuz görünmesin (finally'de geri açılır)
                    if (isInstagram) {
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
                        // [BEĞENENLER GİZLE] "busgur ve 78 diğer kişi beğendi" satırı -> beğenen KİŞİLER raporda
                        // görünmesin (kullanıcı isteği 2026-11-04). Çapa: "/liked_by/" linki (IG'de "N diğer kişi"/
                        // "others" HEP oraya gider) -> satır kabına çık (yükseklik<70px) -> display:none (temiz, boşluk yok).
                        // Yedek (liked_by yoksa, tek-beğenen "X beğendi"): metni "...beğendi/liked by/others" ile biten,
                        // profil linki içeren kısa satır. Beğenme SAYISI isimsizse (liked_by yok + eşleşme yok) DOKUNULMAZ.
                        try {
                            const igpL = igFindPost();
                            if (igpL) {
                                let likeRow = null;
                                const lb = igpL.querySelector('a[href*="/liked_by/"]');
                                if (lb) {
                                    let n = lb;
                                    for (let i = 0; i < 6 && n && n !== igpL; i++) {
                                        const h = n.getBoundingClientRect().height;
                                        if (h > 0 && h < 70) likeRow = n; else if (h >= 70) break;
                                        n = n.parentElement;
                                    }
                                    likeRow = likeRow || lb;
                                }
                                if (!likeRow) {
                                    const cands = igpL.querySelectorAll('span, div');
                                    for (const c of cands) {
                                        const t = (c.textContent || '').replace(/\s+/g, ' ').trim();
                                        if (t.length > 0 && t.length < 80 && /(beğendi|beğenenler|liked by|others)\s*$/i.test(t)) {
                                            const r = c.getBoundingClientRect();
                                            if (r.height > 0 && r.height < 70 && c.querySelector('a[href^="/"]')) { likeRow = c; break; }
                                        }
                                    }
                                }
                                if (likeRow) {
                                    igMsgHidden.push({ el: likeRow, d: likeRow.style.display });
                                    likeRow.style.setProperty('display', 'none', 'important');
                                    printLog("[Instagram] Beğenenler satırı gizlendi.");
                                }
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
                    //
                    // ALINTI TWEET DUZELTMESI (2026-07-17, kullanici ciktisi):
                    // querySelector('time') DOM'daki ILK <time>'i verir. Alinti tweette bu,
                    // ALINTILANAN (nested) tweetin zaman damgasidir ("· 2s"), disaridaki tweetin
                    // TARIH satiri DEGIL. Sonuc: dateTimeRow alintilanan tweet KUTUSUNA oturuyor,
                    // kirpma orada bitiyor ve disaridaki "5:03 ÖÖ · 15 Tem 2026" satiri kadraj
                    // DISINDA kaliyordu -- ustelik asagidaki nextElementSibling dongusu onu
                    // GIZLIYORDU da. Disaridaki tarih satiri DOM'da alintidan SONRA gelir, yani
                    // SON <time> her zaman odur (alinti tek seviye gomulur -> en fazla 2 <time>).
                    // Normal (alintisiz) tweette tek <time> vardir -> son == ilk, davranis AYNI.
                    const _tumTimes = element.querySelectorAll('time');
                    const timeEl = _tumTimes.length ? _tumTimes[_tumTimes.length - 1] : null;
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
                            
                            // v4.5: tamYukseklik (parent tweet) -> footer-gizlemeyi ATLA. Parent'ta saat
                            // BAŞLIKTA; "saatten sonrasını gizle" TÜM içeriği silerdi (v4.3 absürt çıktı).
                            if (dateTimeRow && !opts.tamYukseklik) {
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
                    if (isInstagram) {
                        try {
                            const post = igFindPost() || element;
                            // Tepeye çık ve article'ın MUTLAK sayfa konumunu al (video/yerleşme payı için kısa bekle).
                            window.scrollTo(0, 0);
                            await new Promise(r => setTimeout(r, 250));
                            const pRect0 = post.getBoundingClientRect();
                            const startY = (window.scrollY || document.documentElement.scrollTop || 0) + pRect0.top;
                            // [BEYAZ KENAR FİX] Profilden açılan MODALDA carousel medya+yorum bloğu geniş article içinde
                            // ORTALANIP yanlara beyaz bırakıyor (viewport'a göre değişken; link/standalone'da yok).
                            // İKİ KATMAN: (1) cropLeft = foto SOL kenarı -> sol article margin'ini GÜVENLİ kırpar (DOM;
                            // fotoyu yemez), crop fotonun solundan article sağına; (2) yakalama SONRASI PİKSEL-tabanlı
                            // beyaz-kenar kırpma (igTrimBeyazKenar) sağdaki+kalan beyazı DOM'dan BAĞIMSIZ temizler ->
                            // tam-genişlik şeffaf sarmalayıcıların DOM-kırpmayı atlatması sorunu biter.
                            let _tL = pRect0.left;
                            try {
                                let _mEl = null, _mB = 0;
                                post.querySelectorAll('video, img').forEach(m => { const r = m.getBoundingClientRect(); const a = r.width * r.height; if (a > _mB && r.width > 200 && r.height > 200) { _mB = a; _mEl = m; } });
                                if (_mEl) { _tL = _mEl.getBoundingClientRect().left; }
                            } catch (e) {}
                            const cropLeft = Math.max(0, Math.round(_tL));
                            const cropWidth = Math.round(Math.min(vW - cropLeft, Math.max(40, (pRect0.left + pRect0.width) - _tL)));
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
                                    swSendReliable({ action: "captureAndCrop", vw: window.innerWidth, rect: { top: 0, left: cropLeft, width: cropWidth, height: sliceH }, dpr: dpr }, resolve);
                                });
                                if (!segRes || segRes.status !== "success" || !segRes.dataUrl) break;
                                segs.push(segRes.dataUrl);
                                y += sliceH;
                            }
                            // TEKDUZE: butun platformlar "Yakalama: N parça (WxH)" kalibi.
                            printLog(`Yakalama: ${segs.length} parça (${Math.round(cropWidth)}x${fullH}), yol=no-zoom`);
                            if (segs.length > 0) {
                                let igRaw = (segs.length === 1) ? segs[0] : await igVerticalStitch(segs);
                                igRaw = await igTrimBeyazKenar(igRaw);   // [BEYAZ KENAR] piksel-tabanlı kenar beyaz kırpma (modal sağ/sol beyazı)
                                return await compressScreenshot(igRaw);
                            }
                            printLog("Yakalama BAŞARISIZ: parça alınamadı, genel yola dönülüyor.");
                        } catch (e) {
                            printLog("[Instagram] Sade no-zoom hata: " + (e.message || e));
                        }
                    }

                    // E. Tweeti viewport tepesine hizala (spacer sayesinde bu işlem her zaman başarılı olur)
                    // v4.39 TEK-GEÇİŞ: opts.rangeTop varsa en ÜSTTEKİ seçili atayı tepeye al (bölge ondan başlar);
                    // footer-crop yine element=ODAK üzerinden hesaplanır.
                    (opts.rangeTop || element).scrollIntoView({ block: 'start', behavior: 'instant' });
                    
                    if (isInstagram) {
                        // Instagram KÜÇÜLTME (zoom-out) YAPMAZ: X gibi kaydır+birleştir yapılır.
                        // (Buradaki zoom-to-fit dali xWidgetIgNoZoom=true oldugundan hic calismiyordu -> kaldirildi.)

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
                        // Faz IG-1 (sade no-zoom): tam yüksekliği ölç; X yolu kaydırıp birleştirerek tamamını alır.
                        articleHeight = r.height;
                    }
                    // v4.5: parent (yanıt verilen) tweet -> saat BAŞLIKTA olduğundan saat-satırı kırpması
                    // header'a keserdi; TAM article yüksekliğini kullan (footer-gizleme de yukarıda atlandı).
                    if (opts.tamYukseklik) { articleHeight = r.height; }

                    const measuredRect = {
                        top: r.top,
                        left: r.left,
                        width: r.width,
                        height: articleHeight,
                        right: r.right,
                        bottom: r.top + articleHeight
                    };

                    // v4.39 TEK-GEÇİŞ: bölge = [rangeTop.top .. odağın KIRPILMIŞ altı (saat satırı)]. Atalar arada
                    // DOĞAL X thread haliyle girer -> tek scroll+stitch (parça-parça SS yok). Odağın footer'ı yukarıda
                    // zaten gizlendi (element=odak). left/width ODAK'ın (aynı sütun). Çıktı: atalar tam + odak footer'sız.
                    if (opts.rangeTop) {
                        try {
                            var _rtTop = opts.rangeTop.getBoundingClientRect().top;
                            var _altY = r.top + articleHeight;   // odağın kırpılmış alt sınırı
                            if (_altY > _rtTop + 5) {
                                measuredRect.top = _rtTop;
                                measuredRect.height = _altY - _rtTop;
                                measuredRect.bottom = _altY;
                            }
                        } catch (e) {}
                    }

                    // Spacer'ı (bölge) yüksekliğine göre dinamik olarak büyüt — çok uzun aralıkta bile kaydırma durmaz.
                    const requiredSpacer = Math.max(1800, Math.ceil(measuredRect.height) + 500);
                    spacer.style.height = requiredSpacer + 'px';

                    // F. Ekran görüntüsünü al ve kırp
                    printLog("Ekran görüntüsü alınıyor...");
                    const snapshots = [];
                    let rawResult = "";

                    // Instagram artik X ile AYNI yolu kullanir: kaydir + birlestir.
                    // Burada "zoom-to-fit" adli 313 satirlik ikinci bir yakalama yolu vardi;
                    // xWidgetIgNoZoom sabit true oldugundan HIC calismiyordu (2026-07-17 kaldirildi).
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
                        // TEKDUZE: butun platformlar "Yakalama: N parça (WxH)" kalibi.
                        // (X'te sonuc logu HIC yoktu -> taramada ne oldugu logdan anlasilmiyordu.)
                        printLog(`Yakalama: 1 parça (${Math.round(crop.width)}x${Math.round(crop.height)}), yol=tek-kare`);
                    } else {
                        // H. Uzun tweet: viewport yüksekliği kadar kaydırarak çoklu çekim yap
                        printLog(`Uzun gönderi algılandı, tam boy çekim yapılıyor...`);
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
                        // TEKDUZE: butun platformlar "Yakalama: N parça (WxH)" kalibi.
                        printLog(`Yakalama: ${snapshots.length} parça (${Math.round(measuredRect.width)}x${Math.round(measuredRect.height)}), yol=kaydir-birlestir`);
                        rawResult = await stitchMultipleScreenshots(snapshots, measuredRect, vH, dpr);
                    }

                    // Compress the final image on the client side
                    return await compressScreenshot(rawResult);

                } finally {
                    // Geri yüklemeleri her durumda yap
                    spacer.remove();
                    disableSmoothScrollStyles.remove();
                    xGxButonlariGoster();   // [GÖRÜNTÜX İLE RAPORLA] SS bitti -> butonu geri aç

                    // Faz IG-1: gizlenen Instagram "Mesajlar" balonu / beğenenler satırı geri aç.
                    for (const h of igMsgHidden) {
                        try {
                            if (h.d !== undefined) { if (h.d) h.el.style.setProperty('display', h.d); else h.el.style.removeProperty('display'); }   // [BEĞENENLER] display ile gizlendi
                            else { if (h.v) h.el.style.setProperty('visibility', h.v); else h.el.style.removeProperty('visibility'); }
                        } catch (e) {}
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
                    // Eski scroll konumuna geri kaydır (top:0 DEĞİL -> kullanicinin oldugu yere)
                    try { window.scrollTo({ top: _origScrollY, behavior: 'instant' }); } catch (e) { window.scrollTo(0, 0); }
                }
            }

            // [GÖRÜNTÜX İLE RAPORLA #2] Profil YERİNDE-yakalama (top-level xProfilYerindeYakala)
            // bu iç yakalayıcılara erişsin diye window'a aç (baslat çalışınca, buton görünmeden önce set edilir).
            try { window.__xGxCap = captureArticle; window.__xGxCapYanit = xYakalaTweetVeYanit; window.__xGxCokluSec = xCokluTweetSec; window.__xGxYakalaCoklu = xYakalaCoklu; } catch (e) {}

            // Global timer and progress helper states
            let timerIntervalId = null;
            // Aktif tarama gorevinin storage anahtari — dock'taki IPTAL dugmesi bunu kullanir.
            let aktifStorageKey = null;

            // Facebook idle "Rapora Ekle" yakalayıcısı — taramanın (wordTaramaYonetimi isFacebook
            // bloğu) gorev-BAĞIMSIZ İKİZİ. captureArticle'ın YANINDA (aynı scope) tanımlı olmalı:
            // swSendReliable/compressScreenshot/igVerticalStitch bu scope'ta; TOP-LEVEL'a konunca
            // "swSendReliable is not defined" veriyordu (v4.18 sahada). TARAMAYA DOKUNULMADI.
            // Mevcut FB yardımcılarını yeniden kullanır. Döner: {shot, author} | hata fırlatır.
            // Geçici DOM (yorum gizle/sticky->static/scrollbar gizle/widget gizle) finally'de geri alınır.
            async function xFbIdleYakala() {
                var _fbGizli = [], _fbGorunur = [], _fbStil = [], _fbSbStyle = null, _sbEls = [];
                try {
                    var _isReel = location.pathname.indexOf('/reel/') === 0;
                    var card = null, _engOut = {};
                    var _maxBekle = _isReel ? 40 : 15;
                    for (var w = 0; w < _maxBekle; w++) {
                        card = fbFindPost(_engOut);
                        if (card && card.getBoundingClientRect().height > 100) {
                            if (_isReel) {
                                // Reel: listeye ILK giren genelde KIRLETICI ("...ile paylasiliyor" ~12x12);
                                // tek basina break etme (video+kirletici ortak atasi TUM SAYFA kadar genis
                                // kart verir) -> MAKUL BOYUTLU (>=20px) EN AZ 2 gercek ray dugmesi bekle.
                                var _ray = (_engOut.list || []).filter(function (e) { var r = e.getBoundingClientRect(); return r.width >= 20 && r.height >= 20; }).length;
                                if (_ray >= 2) break;
                            }
                            else if (card.querySelector(FB_ENG_SEL)) { break; }
                        }
                        await new Promise(function (r) { setTimeout(r, 200); });
                    }
                    if (!card) throw new Error("gonderi karti bulunamadi");
                    var _cr = card.getBoundingClientRect();
                    if (_cr.width < 120 || _cr.height < 120) throw new Error("kart olcusu gecersiz");
                    if (_cr.width > window.innerWidth * 0.95 && _cr.height > window.innerHeight * 0.95) throw new Error("kart TUM SAYFA");
                    _fbGizli = fbYorumlariGizle(card);
                    await fbMetniAc(card);
                    await new Promise(function (r) { setTimeout(r, 300); });
                    [document.getElementById('x-downloader-widget'), document.getElementById('w-cb-container')]
                        .forEach(function (el) { if (el) { _fbGorunur.push([el, el.style.visibility]); el.style.visibility = 'hidden'; } });
                    // [FB PER-POST BUTON] Kart basligindaki yesil GoruntuX butonumuz (kart icinde) SS'e GIRMESIN.
                    try { document.querySelectorAll('.x-gx-fb-btn').forEach(function (b) { _fbGorunur.push([b, b.style.visibility]); b.style.setProperty('visibility', 'hidden', 'important'); }); } catch (e) {}
                    await new Promise(function (r) { setTimeout(r, 120); });
                    var _mode = _isReel ? 'reel' : 'posts';
                    var sc = fbScroller(card);
                    var scIc = !!(sc && card.contains(sc));
                    var kadrajEl = scIc ? sc : card;
                    var dpr = window.devicePixelRatio || 1;
                    if (!document.getElementById('x-fb-sb-hide')) {
                        var _sb = document.createElement('style'); _sb.id = 'x-fb-sb-hide';
                        _sb.textContent = '*::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}'
                            + '*{scrollbar-width:none!important;-ms-overflow-style:none!important}';
                        (document.head || document.documentElement).appendChild(_sb); _fbSbStyle = _sb;
                        await new Promise(function (r) { setTimeout(r, 120); });
                    }
                    // [KAYDIRMA ÇUBUĞU GİZLE — KURŞUN-GEÇİRMEZ]: scroll kaplarına overflow:hidden ver. scrollTop ile JS
                    // kaydırma YİNE çalışır (stitch bozulmaz; doğrulandı) ama HİÇBİR Chrome'da/sürümde çubuk çizilmez,
                    // CSS özgüllüğünden bağımsız. (Eski scrollbar-width:none YETMİYORDU: eski Chrome onu yok sayıyor ->
                    // FB'nin gizlemesi de çalışmayıp çubuk kalıyordu; kullanıcı canlıda hâlâ görüyordu.) Kart subtree +
                    // scroll kabı (sc). finally'de geri alınır.
                    try {
                        var _sbAdaylar = [card]; if (sc) _sbAdaylar.push(sc);
                        card.querySelectorAll('*').forEach(function (e) { _sbAdaylar.push(e); });
                        _sbAdaylar.forEach(function (e) {
                            try {
                                if (!e || e.__xSbDone) return;   // dedup
                                var _cs = getComputedStyle(e);
                                if (!(e === sc || /(auto|scroll)/.test(_cs.overflowY + ' ' + _cs.overflowX))) return;
                                e.__xSbDone = true;
                                _sbEls.push([e, e.style.getPropertyValue('overflow'), e.style.getPropertyPriority('overflow')]);
                                e.style.setProperty('overflow', 'hidden', 'important');   // çubuk YOK; scrollTop ile kaydırma yine çalışır
                            } catch (x) {}
                        });
                    } catch (x) {}
                    if (scIc && sc) {
                        _fbStil.push([sc, 'scrollBehavior', sc.style.scrollBehavior]); sc.style.scrollBehavior = 'auto';
                        kadrajEl.querySelectorAll('*').forEach(function (e) {
                            try { if (getComputedStyle(e).position === 'sticky') { _fbStil.push([e, 'position', e.style.position]); e.style.position = 'static'; } } catch (x) {}
                        });
                        await new Promise(function (r) { setTimeout(r, 200); });
                    }
                    var kr = kadrajEl.getBoundingClientRect();
                    if (!scIc && _engOut.list && _engOut.list.length) {
                        var L = kr.left, T = kr.top, R = kr.right, B = kr.bottom;
                        _engOut.list.forEach(function (e) {
                            var r = e.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return;
                            if (r.left < kr.left - 300 || r.right > kr.right + 400) return;
                            if (r.bottom < kr.top - 200 || r.top > kr.bottom + 200) return;
                            L = Math.min(L, r.left - 8); T = Math.min(T, r.top - 8); R = Math.max(R, r.right + 8); B = Math.max(B, r.bottom + 8);
                        });
                        if (R > kr.right || B > kr.bottom || L < kr.left || T < kr.top) { kr = { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T }; }
                    }
                    var cropLeft = Math.max(0, Math.round(kr.left));
                    var cropWidth = Math.round(Math.min(window.innerWidth - cropLeft, kr.width));
                    var fullH = scIc ? sc.scrollHeight : Math.round(kr.height);
                    var pencere = scIc ? sc.clientHeight : Math.round(kr.height);
                    var _bitis = (_mode !== 'reel') ? fbBitisY(card, sc, scIc, {}) : null;
                    var _bitisPay = 8;
                    if (_bitis && _bitis + _bitisPay < fullH) { fullH = _bitis + _bitisPay; }
                    // [YORUM KUTUSU — KART DISI GORSEL ORTUSME, !scIc] Post sayfasinda/feed'de yorum YAZMA
                    // kutusu ("<SEN> adıyla yorum yap", role=textbox) kartin DOM cocugu DEGIL (SIBLING) ama
                    // kart bbox'inin ALT kenariyla GORSEL ortusuyor (olcum: eylem-cubugu 665-697, kutu
                    // 691-711, kart alt 703 -> kutu kadraja giriyordu). fbBitisY KART-SINIRLI oldugu icin bu
                    // kart-disi kutuyu GORMEZ. Cozum: SAYFA genelinde kutuyu bul; bu kartin alt bolgesine
                    // denk geliyorsa kadraji kutunun TAM TOPUNDA bitir (eylem-cubugu gorsel olarak ustte
                    // kalir). Modal/scIc yolu: kutu kart ICINDE -> fbBitisY textbox/"adıyla yorum" ile zaten
                    // eler; orada bu KAPALI (koordinat farkli + gereksiz).
                    if (!scIc && _mode !== 'reel') { try {
                        var _kompTopVp = null;
                        document.querySelectorAll('[role="textbox"],[contenteditable="true"],[aria-label*="adıyla yorum" i],[aria-label*="comment as" i]').forEach(function (tb) {
                            var _tr = tb.getBoundingClientRect();
                            if (_tr.height <= 0 || _tr.width <= 0) return;
                            // yalniz BU kartin alt bolgesine denk gelen kutu (status kutusu/baska gönderi HARIC)
                            if (_tr.top < kr.top + 60 || _tr.top > kr.bottom + 80) return;
                            _kompTopVp = (_kompTopVp == null) ? _tr.top : Math.min(_kompTopVp, _tr.top);
                        });
                        if (_kompTopVp != null) {
                            var _kompH = Math.round(_kompTopVp - kr.top) - 2;   // 2px pay: kutu topu kesirli olabilir
                            if (_kompH > 80 && _kompH < fullH) fullH = _kompH;
                        }
                    } catch (e) {} }
                    var segs = [];
                    if (!scIc) {
                        var _vpH = window.innerHeight;
                        if (kr.top >= 0 && kr.top + fullH <= _vpH + 1) {
                            // Kart TAMAMEN viewport'ta -> TEK KARE (mevcut davranis; sigan kartlarda regresyon yok).
                            var top = Math.max(0, Math.round(kr.top));
                            var h = Math.round(Math.min(_vpH - top, fullH));
                            var res = await new Promise(function (resolve) { swSendReliable({ action: "captureAndCrop", vw: window.innerWidth, rect: { top: top, left: cropLeft, width: cropWidth, height: h }, dpr: dpr }, resolve); });
                            if (res && res.status === "success" && res.dataUrl) { segs.push(res.dataUrl); }
                        } else {
                            // [FEED/UZUN KART — PENCERE-SCROLL-STITCH] Kart viewport'a SIGMIYOR (feed'de ic-scroller
                            // YOK -> scIc=false). Eski tek-kare uzun karti KESIYOR / viewport sonraki posta tasiyordu
                            // (kullanici: "kartin tamamini gormek icin scroll olmuyor"). captureArticle'in IG yolu gibi
                            // PENCERE'yi kaydirip kartin dilimlerini viewport TEPESINE getirip yakala + dikey birlestir.
                            // (1) Ust-bar (role=banner) viewport 0'da kartla ortusur -> gecici visibility:hidden.
                            // (2) Spacer: son dilime scroll icin yer. (3) FB feed VIRTUALIZE -> her dilimde karti
                            // YENIDEN OLC (scrollBy ile dilimi 0'a getir); kart DOM'dan kalkarsa dur. Sonda scroll+banner geri.
                            // Ust/alt SABIT bar(lar)i gizle (FB ust-bari [role=banner] DEGIL, fixed/sticky div).
                            // elementsFromPoint ile ucuz tespit: viewport orta-ust ve orta-alt'taki fixed/sticky,
                            // yeterince genis (>%40) ve bar-boyutlu (20-200px) ogeler.
                            var _bannerEls = [];
                            try {
                                var _barAday = [];
                                [[Math.round(window.innerWidth / 2), 3], [Math.round(window.innerWidth / 2), _vpH - 3]].forEach(function (pt) {
                                    try {
                                        (document.elementsFromPoint(pt[0], pt[1]) || []).forEach(function (el) {
                                            try { var cs = getComputedStyle(el); if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
                                                var r = el.getBoundingClientRect();
                                                if (r.width > window.innerWidth * 0.4 && r.height >= 20 && r.height <= 200 && _barAday.indexOf(el) < 0) _barAday.push(el);
                                            } catch (x) {}
                                        });
                                    } catch (x) {}
                                });
                                _barAday.forEach(function (el) { _bannerEls.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]); el.style.setProperty('visibility', 'hidden', 'important'); });
                            } catch (e) {}
                            var _spacer = null; try { _spacer = document.createElement('div'); _spacer.setAttribute('aria-hidden', 'true'); _spacer.style.cssText = 'height:' + (Math.ceil(fullH) + _vpH + 400) + 'px;width:1px;pointer-events:none;'; document.body.appendChild(_spacer); } catch (e) {}
                            var _oncekiWY = window.scrollY || document.documentElement.scrollTop || 0;
                            var _captured = 0, _wg = 0;
                            while (_captured < fullH && _wg < 32) {
                                _wg++;
                                if (!document.contains(card)) break;
                                var _cVpTop = card.getBoundingClientRect().top;
                                var _segVp = _cVpTop + _captured;   // kart-ofset _captured'in su anki viewport-y'si
                                if (_segVp < -1 || _segVp > 1) {     // dilimi viewport TEPESINE getir (re-ground -> virtualization kaymasina bagisik)
                                    window.scrollBy(0, Math.round(_segVp));
                                    await new Promise(function (r) { setTimeout(r, 260); });
                                    if (!document.contains(card)) break;
                                    _cVpTop = card.getBoundingClientRect().top;
                                }
                                var _capTop = Math.max(0, Math.round(_cVpTop + _captured));   // ~0
                                var _sliceH = Math.round(Math.min(_vpH - _capTop, fullH - _captured));
                                if (_sliceH <= 2) break;
                                var _sr = await new Promise(function (resolve) { swSendReliable({ action: "captureAndCrop", vw: window.innerWidth, rect: { top: _capTop, left: cropLeft, width: cropWidth, height: _sliceH }, dpr: dpr }, resolve); });
                                if (!_sr || _sr.status !== "success" || !_sr.dataUrl) break;
                                if (segs.length && segs[segs.length - 1] === _sr.dataUrl) break;   // ayni kare -> scroll takildi
                                segs.push(_sr.dataUrl); _captured += _sliceH;
                            }
                            try { if (_spacer) _spacer.remove(); } catch (e) {}
                            try { _bannerEls.forEach(function (p) { try { if (p[1]) p[0].style.setProperty('visibility', p[1], p[2] || ''); else p[0].style.removeProperty('visibility'); } catch (x) {} }); } catch (e) {}
                            try { window.scrollTo(0, _oncekiWY); } catch (e) {}
                        }
                    } else {
                        var oncekiTop = sc.scrollTop, maxScroll = Math.max(0, fullH - pencere);
                        var y = 0, guard = 0;
                        while (y < fullH && guard < 20) {
                            guard++;
                            var hedef = Math.min(y, maxScroll); sc.scrollTop = hedef;
                            await new Promise(function (r) { setTimeout(r, 320); });
                            if (Math.abs(sc.scrollTop - hedef) > 4) { segs.length = 0; break; }
                            kr = kadrajEl.getBoundingClientRect();
                            var ofset = Math.max(0, y - sc.scrollTop);
                            var sliceH = Math.round(Math.min(pencere - ofset, fullH - y));
                            if (sliceH <= 2) break;
                            var res2 = await new Promise(function (resolve) { swSendReliable({ action: "captureAndCrop", vw: window.innerWidth, rect: { top: Math.max(0, Math.round(kr.top + ofset)), left: cropLeft, width: cropWidth, height: sliceH }, dpr: dpr }, resolve); });
                            if (!res2 || res2.status !== "success" || !res2.dataUrl) break;
                            if (segs.length && segs[segs.length - 1] === res2.dataUrl) { segs.length = 0; break; }
                            segs.push(res2.dataUrl); y += sliceH;
                        }
                        try { sc.scrollTop = oncekiTop; } catch (e) {}
                    }
                    if (!segs.length) throw new Error("parca alinamadi");
                    var raw = (segs.length === 1) ? segs[0] : await igVerticalStitch(segs);
                    var shot = await compressScreenshot(raw);
                    var a = fbAuthor();
                    return { shot: shot, author: (a && a.ad) || '' };
                } finally {
                    try { _fbGizli.forEach(function (p) { try { p[0].style.display = p[1] || ''; } catch (e) {} }); } catch (e) {}
                    try { _fbGorunur.forEach(function (p) { try { p[0].style.visibility = p[1] || ''; } catch (e) {} }); } catch (e) {}
                    try { _fbStil.forEach(function (p) { try { p[0].style[p[1]] = p[2] || ''; } catch (e) {} }); } catch (e) {}
                    try { if (_fbSbStyle) { _fbSbStyle.remove(); } } catch (e) {}
                    try { _sbEls.forEach(function (p) { try { var e = p[0]; if (p[1]) e.style.setProperty('overflow', p[1], p[2] || ''); else e.style.removeProperty('overflow'); try { delete e.__xSbDone; } catch (_) { e.__xSbDone = undefined; } } catch (x) {} }); } catch (e) {}
                }
            }

            // TikTok idle "Rapora Ekle" yakalayıcısı — taramanın TT bloğu (~3495-3752) gorev-BAĞIMSIZ
            // İKİZİ (captureArticle scope'unda: swSendReliable/compressScreenshot/igVerticalStitch burada).
            // TARAMAYA DOKUNULMADI. TikTok tek-kare (desc açılıp taşarsa 2 dilim). Captcha çıkarsa idle'da
            // durdurulacak tarama YOK -> hata fırlatır (onclick "sebep"i gösterir). Yazar URL'den (/@user).
            // Döner: {shot, author} | hata. Çerez bandı + widget geçici gizlenir, finally'de geri alınır.
            async function xTtIdleYakala() {
                var _ttGorunur = [], _ttGizli = [];
                try {
                    var kart = null, video = null;
                    for (var w = 0; w < 15; w++) {
                        // 0) PER-POST BUTON: tıklanan container HEDEFLE (varsa). Geçerli + video+like içerene kadar bekle.
                        if (window.__xTtHedefKart && document.contains(window.__xTtHedefKart)) {
                            kart = window.__xTtHedefKart; video = kart.querySelector('video');
                            if (video && kart.querySelector('[data-e2e="like-count"], [data-e2e="like-icon"]')) break;
                            await new Promise(function (r) { setTimeout(r, 200); }); continue;
                        }
                        // 1) Besleme/paylaşım düzeni (taramanın kullandığı; genelde oturum-KAPALI).
                        kart = document.querySelector('[data-e2e="recommend-list-item-container"]');
                        video = kart ? kart.querySelector('video') : null;
                        if (kart && video && kart.querySelector('[data-e2e="like-count"]')) break;
                        // 2) YEDEK — GİRİŞ-YAPILMIŞ video-detay düzeni: recommend-list-item-container YOK.
                        //    En büyük <video>'nun, etkileşim (like-count) + tercihen açıklama (video-desc)
                        //    içeren EN YAKIN atasını kart say. data-e2e'ler her iki düzende de mevcut.
                        if (!kart || !video || !kart.querySelector('[data-e2e="like-count"]')) {
                            var _v = null, _best = 0;
                            document.querySelectorAll('video').forEach(function (m) {
                                var r = m.getBoundingClientRect(); var a = r.width * r.height;
                                if (a > _best && r.width > 150 && r.height > 150) { _best = a; _v = m; }
                            });
                            if (_v) {
                                var _p = _v.parentElement, _bulunan = null;
                                for (var d = 0; d < 15 && _p && _p !== document.body; d++) {
                                    if (_p.querySelector('[data-e2e="like-count"]')) {
                                        _bulunan = _p;
                                        if (_p.querySelector('[data-e2e="video-desc"]')) break;   // ideal: desc de içersin
                                    }
                                    _p = _p.parentElement;
                                }
                                if (_bulunan) { kart = _bulunan; video = _v; break; }
                            }
                        }
                        await new Promise(function (r) { setTimeout(r, 200); });
                    }
                    if (!kart) throw new Error("gonderi karti bulunamadi");
                    if (document.querySelector('#captcha-verify-container-main-page, .captcha-verify-container')) {
                        throw new Error("dogrulama bulmacasi (captcha) cikti — once tiktok.com'da cozun");
                    }
                    document.querySelectorAll('tiktok-cookie-banner').forEach(function (b) { _ttGizli.push([b, b.style.display]); b.style.setProperty('display', 'none', 'important'); });
                    // [PER-POST BUTON] Aksiyon kolonundaki yeşil GörüntüX butonumuz SS'e GIRMESIN (kadraja biniyor).
                    try { document.querySelectorAll('.x-gx-tt-btn').forEach(function (b) { _ttGorunur.push([b, b.style.visibility]); b.style.setProperty('visibility', 'hidden', 'important'); }); } catch (e) {}
                    if (video) {
                        try { video.pause(); } catch (e) {}
                        await new Promise(function (res) {
                            var bitti = false; var fin = function () { if (!bitti) { bitti = true; res(); } };
                            if (Math.abs(video.currentTime || 0) < 0.05) { fin(); return; }
                            try { video.addEventListener('seeked', fin, { once: true }); } catch (e) {}
                            try { video.currentTime = 0; } catch (e) { fin(); }
                            setTimeout(fin, 1200);
                        });
                    }
                    try {
                        var btn = Array.from(kart.querySelectorAll('button,span,div')).find(function (e) {
                            var t = (e.textContent || '').trim().toLowerCase();
                            return (t === 'daha fazlası' || t === 'more' || t === 'daha fazla') && e.getBoundingClientRect().width > 10;
                        });
                        if (btn) { ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (tip) { btn.dispatchEvent(new MouseEvent(tip, { bubbles: true, cancelable: true, view: window })); }); }
                    } catch (e) {}
                    await new Promise(function (r) { setTimeout(r, 350); });
                    // KADRAJ = VİDEO ÖĞESİNİN rect'i = videonun TAM GÖRÜNÜR SINIRI (kullanıcı: "tam sınırdan al,
                    // sağ/solunu kesme"; yorum-paneli/landscape ekranda sağ panel + yan siyah bantlar ÖĞE DIŞINDA
                    // kalır -> kadraja girmez). Parça-BİRLEŞİMİ KULLANMIYORUZ (desc/sayaç yan panelde olunca kadraj
                    // panele taşıyordu); object-fit KIRPMASI YOK (videonun kendi kenarını kesiyordu). TikTok video
                    // öğesi object-fit:cover + öğe-AR = video-AR -> öğe rect'i görünen videoyu TAM kaplar, içinde
                    // pillarbox yok (canlı ölçüldü: kenar parlaklıkları 120+). Feed/immersive'de ray+caption video
                    // ÜSTÜNE bindiği için öğe içinde -> dahil olur. (Dock/tarama bloğu ~7413 feed için parça-birleşimi
                    // KALIR; bu ikiz yalnız per-post butonda, çünkü yorum-paneli layout'unu O karşılıyor.)
                    if (!video) throw new Error("video yok");
                    var _vr = video.getBoundingClientRect();
                    var L = _vr.left, T = _vr.top, R = _vr.right, B = _vr.bottom;
                    L = Math.max(0, Math.round(L)); T = Math.max(0, Math.round(T));
                    R = Math.min(window.innerWidth, Math.round(R)); B = Math.min(window.innerHeight, Math.round(B));
                    var cw = R - L, ch2 = B - T;
                    if (cw < 40 || ch2 < 40) throw new Error("kadraj cok kucuk: " + cw + "x" + ch2);
                    var _binerMi = function (el) { if (!el) return false; var r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; return !(r.right <= L || r.left >= R || r.bottom <= T || r.top >= B); };
                    [document.getElementById('x-downloader-widget'), document.getElementById('w-cb-container')].forEach(function (w) { if (_binerMi(w)) { _ttGorunur.push([w, w.style.visibility]); w.style.setProperty('visibility', 'hidden', 'important'); } });
                    var dpr = window.devicePixelRatio || 1;
                    var _capture = async function (top, h) {
                        var rr = await new Promise(function (resolve) { swSendReliable({ action: "captureAndCrop", vw: window.innerWidth, rect: { top: top, left: L, width: cw, height: h }, dpr: dpr }, resolve); });
                        if (!rr || rr.status !== "success" || !rr.dataUrl) throw new Error("captureAndCrop basarisiz");
                        return rr.dataUrl;
                    };
                    var B_tam = B;   // video-rect viewport'a sığar -> _delta=0, stitch gerekmez (video öğesi tek karede görünür)
                    var _delta = Math.max(0, B_tam - window.innerHeight);
                    var _ham = null;
                    if (_delta > 0 && _delta <= 300) {
                        var sc = null, el = kart;
                        while (el && el !== document.body) { var cs = getComputedStyle(el); if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20) { sc = el; break; } el = el.parentElement; }
                        if (sc) {
                            var _oncekiTop = sc.scrollTop, _snap = sc.style.scrollSnapType, _dav = sc.style.scrollBehavior;
                            try {
                                sc.style.setProperty('scroll-snap-type', 'none', 'important');
                                sc.style.setProperty('scroll-behavior', 'auto', 'important');
                                var ust = await _capture(T, window.innerHeight - T);
                                sc.scrollTop = _oncekiTop + _delta;
                                await new Promise(function (r) { setTimeout(r, 250); });
                                var _gercek = sc.scrollTop - _oncekiTop;
                                if (_gercek >= 4 && _gercek <= _delta + 20) {
                                    var alt = await _capture(window.innerHeight - _gercek, _gercek);
                                    if (ust !== alt) { _ham = await igVerticalStitch([ust, alt]); }
                                }
                            } catch (e) {} finally {
                                sc.scrollTop = _oncekiTop; sc.style.scrollSnapType = _snap || ''; sc.style.scrollBehavior = _dav || '';
                            }
                        }
                    }
                    if (!_ham) _ham = await _capture(T, ch2);
                    var shot = await compressScreenshot(_ham);
                    if (!shot) throw new Error("sikistirma basarisiz");
                    var _ttAd = (location.pathname.match(/^\/@([^/]+)\//) || [])[1] || '';
                    return { shot: shot, author: _ttAd ? ('@' + _ttAd) : '' };
                } finally {
                    try { _ttGizli.forEach(function (p) { try { p[0].style.display = p[1] || ''; } catch (e) {} }); } catch (e) {}
                    try { _ttGorunur.forEach(function (p) { try { p[0].style.visibility = p[1] || ''; } catch (e) {} }); } catch (e) {}
                }
            }

            // YouTube idle "Rapora Ekle" yakalayıcısı — taramanın YT bloğu (~3266-3547) gorev-BAĞIMSIZ
            // İKİZİ (captureArticle scope'unda). TARAMAYA DOKUNULMADI. YALNIZ /watch (Shorts/topluluk
            // tarama gibi kapsam dışı -> net hata). Oynatıcı+başlık bekle, reklam bekle, kareyi sabitle,
            // örtü katmanlarını gizle, kadraj=oynatıcı+başlık+kanal+istatistik (yorumlara taşmaz, sağ=oynatıcı
            // kenarı), widget çakışıyorsa gizle, tek-kare (+ taşarsa 2 dilim). Yazar=kanal adı (DOM). {shot,author}|hata.
            async function xYtIdleYakala() {
                var _ytGorunur = [], _ytGizli = [], _ytBtnGizli = [];
                try {
                    if (location.pathname.toLowerCase() !== '/watch') {
                        throw new Error("yalniz normal video (/watch) destekleniyor — Shorts/topluluk henuz yok");
                    }
                    var ply = null, bas = null;
                    for (var w = 0; w < 20; w++) {
                        ply = document.querySelector('#movie_player');
                        bas = document.querySelector('h1.ytd-watch-metadata, #title h1');
                        if (ply && bas && ply.getBoundingClientRect().height > 100) break;
                        await new Promise(function (r) { setTimeout(r, 300); });
                    }
                    if (!ply || !bas) throw new Error("oynatici/baslik bulunamadi");
                    for (var w2 = 0; w2 < 40; w2++) {
                        if (!/(^|\s)ad-showing(\s|$)/.test(ply.className)) break;
                        var atla = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button');
                        if (atla) { try { atla.click(); } catch (e) {} }
                        await new Promise(function (r) { setTimeout(r, 300); });
                    }
                    var vid = document.querySelector('#movie_player video');
                    if (vid) {
                        await new Promise(function (res) {
                            var bitti = false; var fin = function () { if (!bitti) { bitti = true; res(); } };
                            try { vid.pause(); } catch (e) {}
                            if (Math.abs(vid.currentTime || 0) < 0.05) { fin(); return; }
                            try { vid.addEventListener('seeked', fin, { once: true }); } catch (e) {}
                            try { vid.currentTime = 0; } catch (e) { fin(); }
                            setTimeout(fin, 1500);
                        });
                    }
                    ['ytd-consent-bump-v2-lightbox', 'ytd-popup-container tp-yt-paper-dialog', 'tp-yt-iron-overlay-backdrop',
                     'ytd-mealbar-promo-renderer', '#masthead-container', '.ytp-chrome-top', '.ytp-chrome-bottom',
                     '.ytp-gradient-top', '.ytp-gradient-bottom', '.ytp-large-play-button', '.ytp-play-button-overlay'].forEach(function (sel) {
                        document.querySelectorAll(sel).forEach(function (el) { var r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return; _ytGizli.push([el, el.style.display]); el.style.setProperty('display', 'none', 'important'); });
                    });
                    // [YT BUTONUMUZ SS'E GIRMESIN] Kadraj OLCUMUNDEN ONCE yesil "+" butonunu display:none yap
                    // (satir reflow -> kadrajda bosluk birakmaz; poller display:none'i yine querySelector'la bulup
                    // yeniden enjekte etmez). finally'de geri alinir.
                    try { document.querySelectorAll('.x-gx-yt-btn').forEach(function (b) { _ytBtnGizli.push([b, b.style.display]); b.style.setProperty('display', 'none', 'important'); }); } catch (e) {}
                    await new Promise(function (r) { setTimeout(r, 250); });
                    var parcalar = [];
                    var ekle = function (sel) { var hepsi = document.querySelectorAll(sel); for (var qi = 0; qi < hepsi.length; qi++) { var r = hepsi[qi].getBoundingClientRect(); if (r.width > 1 && r.height > 1) { parcalar.push(r); return; } } };
                    ekle('#movie_player'); ekle('h1.ytd-watch-metadata'); ekle('#owner'); ekle('#top-level-buttons-computed'); ekle('#bottom-row');
                    if (!parcalar.length) throw new Error("kadraj ogesi bulunamadi");
                    var PAY = 8;
                    var L = Math.min.apply(null, parcalar.map(function (r) { return r.left; })) - PAY;
                    var T = Math.min.apply(null, parcalar.map(function (r) { return r.top; })) - PAY;
                    var R2 = Math.max.apply(null, parcalar.map(function (r) { return r.right; })) + PAY;
                    var B_tam = Math.max.apply(null, parcalar.map(function (r) { return r.bottom; })) + PAY;
                    try { var _ym = document.querySelector('#comments'); if (_ym) { var _yr = _ym.getBoundingClientRect(); if (_yr.height > 0) B_tam = Math.min(B_tam, _yr.top); } } catch (e) {}
                    var _ilkGorunur = function (sel) { var hepsi = document.querySelectorAll(sel); for (var qi = 0; qi < hepsi.length; qi++) { var r = hepsi[qi].getBoundingClientRect(); if (r.width > 1 && r.height > 1) return r; } return null; };
                    try { var _ply = _ilkGorunur('#movie_player'); if (_ply) R2 = Math.min(R2, _ply.right + PAY); var _pr = _ilkGorunur('#primary'); if (_pr) R2 = Math.min(R2, _pr.right); var _sr = _ilkGorunur('#secondary'); if (_sr) R2 = Math.min(R2, _sr.left); } catch (e) {}
                    L = Math.max(0, Math.round(L)); T = Math.max(0, Math.round(T));
                    R2 = Math.min(window.innerWidth, Math.round(R2)); B_tam = Math.round(B_tam);
                    var B = Math.min(window.innerHeight, B_tam);
                    var cw = R2 - L, ch2 = B - T;
                    if (cw < 120 || ch2 < 120) throw new Error("kadraj gecersiz (" + cw + "x" + ch2 + ")");
                    if (cw > window.innerWidth * 0.98 && ch2 > window.innerHeight * 0.98) throw new Error("kadraj TUM SAYFA");
                    var _biner = function (el) { if (!el) return false; var r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; return !(r.right <= L || r.left >= R2 || r.bottom <= T || r.top >= B); };
                    [document.getElementById('x-downloader-widget'), document.getElementById('w-cb-container')].forEach(function (w) { if (_biner(w)) { _ytGorunur.push([w, w.style.visibility]); w.style.setProperty('visibility', 'hidden', 'important'); } });
                    var dpr = window.devicePixelRatio || 1;
                    var _capture = async function (top, h) { var rr = await new Promise(function (resolve) { swSendReliable({ action: "captureAndCrop", vw: window.innerWidth, rect: { top: top, left: L, width: cw, height: h }, dpr: dpr }, resolve); }); if (!rr || rr.status !== "success" || !rr.dataUrl) throw new Error("captureAndCrop basarisiz"); return rr.dataUrl; };
                    var _delta = Math.max(0, B_tam - window.innerHeight);
                    var _ham = null;
                    if (_delta > 0 && _delta <= 700) {
                        var _oncekiY = window.scrollY, _dav = document.documentElement.style.scrollBehavior;
                        try {
                            document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
                            var ust = await _capture(T, window.innerHeight - T);
                            window.scrollBy(0, _delta);
                            await new Promise(function (r) { setTimeout(r, 350); });
                            var _gercek = window.scrollY - _oncekiY;
                            if (_gercek >= 4 && _gercek <= _delta + 20) {
                                var _yenidenOlc = function () {
                                    var p2 = [];
                                    ['#movie_player', 'h1.ytd-watch-metadata', '#owner', '#top-level-buttons-computed', '#bottom-row'].forEach(function (sel) { var e2 = document.querySelector(sel); if (!e2) return; var r2 = e2.getBoundingClientRect(); if (r2.width > 1 && r2.height > 1) p2.push(r2); });
                                    if (!p2.length) return 0;
                                    var b2 = Math.max.apply(null, p2.map(function (r) { return r.bottom; })) + PAY;
                                    var ym2 = document.querySelector('#comments'); if (ym2) { var yr2 = ym2.getBoundingClientRect(); if (yr2.height > 0) b2 = Math.min(b2, yr2.top); }
                                    return Math.min(window.innerHeight, Math.round(b2));
                                };
                                var _B2 = _yenidenOlc();
                                var _altUst = Math.max(0, window.innerHeight - _gercek);
                                var _altYuk = Math.round(_B2 - _altUst);
                                if (_altYuk >= 4) {
                                    var alt = await _capture(_altUst, _altYuk);
                                    if (ust !== alt) { _ham = await igVerticalStitch([ust, alt]); }
                                }
                            }
                        } catch (e) {} finally {
                            window.scrollTo(0, _oncekiY); document.documentElement.style.scrollBehavior = _dav || '';
                        }
                    }
                    if (!_ham) _ham = await _capture(T, ch2);
                    var shot = await compressScreenshot(_ham);
                    if (!shot) throw new Error("sikistirma basarisiz");
                    var _kanal = '';
                    try { var k = document.querySelector('#owner ytd-channel-name a, #owner ytd-channel-name yt-formatted-string'); _kanal = k ? String(k.textContent || '').replace(/\s+/g, ' ').trim() : ''; } catch (e) {}
                    return { shot: shot, author: _kanal };
                } finally {
                    try { _ytGizli.forEach(function (p) { try { p[0].style.display = p[1] || ''; } catch (e) {} }); } catch (e) {}
                    try { _ytBtnGizli.forEach(function (p) { try { p[0].style.display = p[1] || ''; } catch (e) {} }); } catch (e) {}
                    try { _ytGorunur.forEach(function (p) { try { p[0].style.visibility = p[1] || ''; } catch (e) {} }); } catch (e) {}
                }
            }

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
                const widgetEl = document.getElementById('x-downloader-widget');

                if (!box || !gorev || !gorev.aktif) {
                    if (box) box.style.display = 'none';
                    // Tarama bitti/yok: dock'taki "taranıyor" isigini kapat. ⚠ PROFİL TARAMASINDA DEĞİL: profil
                    // taraması addToPool kullanır (sunucu-işi yok) -> burası 'scanning'i kaldırıp halkayı/creep'i
                    // bozuyordu. __xGxTaramaAktif açıkken DOKUNMA (profil göstergesini xGxTaramaGostergeKapat kapatır).
                    if (widgetEl && !window.__xGxTaramaAktif) widgetEl.classList.remove('scanning');
                    return;
                }

                box.style.display = 'flex';
                // Tarama aktif: dock'ta yalnız "taranıyor" isigi (ilerleme panelde).
                if (widgetEl) widgetEl.classList.add('scanning');
                
                const completed = (gorev.combinedData) ? gorev.combinedData.length : 0;
                let total = 0;
                if (gorev.total_count) {
                    total = gorev.total_count;
                } else if (gorev.kuyruk) {
                    total = completed + gorev.kuyruk.length;
                }
                
                const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
                if (counter) { counter.innerText = `${completed} / ${total}`; }
                if (fill) { fill.style.width = `${pct}%`; }

                // Dock tarama HALKASI (dis cember) + ortadaki asama (tamamlanan/toplam).
                const ring = document.getElementById('w-scan-ring');
                if (ring) { const C = 100.53; ring.setAttribute('stroke-dashoffset', String(C * (1 - pct / 100))); }
                const scanTxt = document.getElementById('w-scan-txt');
                if (scanTxt) { scanTxt.textContent = `${completed}/${total}`; }
            }

            // Live DOM logging helper
            function printLog(msg) {
                console.log("X Rapor Log:", msg);
                // TEKDUZE LOG: her satir "[X] / [Instagram] / [Facebook]" onekiyle sunucuya
                // gider. Once X'te onek HIC yoktu, IG/FB kendi oneklerini elle yaziyordu.
                // Zaten onekli olan mesajlara TEKRAR eklenmez (cift onek olmasin).
                // Onek YALNIZCA sunucu loguna: widget'ta kullanici zaten hangi platformda
                // oldugunu biliyor, orada gurultu olurdu (asagida cleanMsg onek almaz).
                var _srvMsg = String(msg == null ? '' : msg);
                if (!/^\[(X|Instagram|Facebook)\]/.test(_srvMsg)) {
                    _srvMsg = '[' + xPlatformAdi() + '] ' + _srvMsg;
                }
                logToServer(_srvMsg);

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
        // İPTAL FLAŞI FIX: tarama iptal edildiyse (son ~12 sn) YAKALAMA isteklerini GÖNDERME ve cb'yi
        // ÇAĞIRMA -> background X sekmesini öne getirmez (flaş yok), retry/throw/showError tetiklenmez,
        // await askıda kalır ve tarama o noktada sessizce durur (worker sekmesi reload'da bayrak sıfırlanır).
        try {
            var _ipt = window.__xWordIptal;
            if (_ipt && (Date.now() - _ipt < 12000) && msg && (msg.action === "captureTab" || msg.action === "captureAndCrop")) {
                try { logToServer("[swSend] iptal: capture atlandi (X one getirilmez)"); } catch (e) {}
                return;
            }
        } catch (e) {}
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

    // Instagram X ile AYNI yolu kullanir: kaydir + birlestir. Eskiden bunu bir "zoom-to-fit"
    // yolundan ayiran xWidgetIgNoZoom bayragi vardi; toggle kaldirilinca bayrak sabit true
    // kaldi ve ikinci yol OLU koda dondu. Bayrak da, o yol da 2026-07-17'de kaldirildi.

    function xStripForServer(resItem, gorev) {
        try {
            // [GÖRSEL KAYBI KÖK-NEDEN FIX] ESKİDEN koşul `xWidgetLocalImages && ...`'ydı. AMA xWidgetLocalImages
            // ASENKRON yükleniyor (başta false, chrome.storage.local.get ile dolar). Tarama o yüklenmeden capture
            // ederse flag FALSE kalır -> görsel YEREL İLETİLMEZ -> SUNUCUYA gider -> kaydet-commit'te silinir ->
            // snapshot 0 -> KAYIP (aralıklı, ilk kurulum/hızlı tarama). Sunucu görsel yolu zaten KALDIRILDI (hep
            // yerel). Flag yarışını kaldır: görsel + link varsa DAİMA panele ilet (deliverLocalImage -> queueLocalImage
            // -> pending + retry ile kesin teslim). [[client-docx-migration]]: görsel daima yerel.
            if (resItem && resItem.screenshot && resItem.link) {
                // Faz #1-D (tam kaldırma): görüntü SADECE panele iletilir, sunucuya ASLA gitmez; kurtarma-fallback YOK.
                // swSendReliable teslimi retry eder; teslim background queueLocalImage'a yönlenir (pending + retry).
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
        xSetButon("Yenile");
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

    // Dock surukleme: logodan tut-surukle -> DIKEY tasi. Isaretci ekranin obur yarisina
    // gecince TARAF degisir (sag<->sol). Birakinca {dock_side, dock_top} kalici olarak yazilir.
    // Surukleme boyunca .dragging: acik kalir + gecis kapali (titremesin).
    // Logo hem "Panele Git" (tikla) hem surukleme tutamagi. Isaretci 5px'ten az kaydiysa
    // TIKLAMA sayilir -> panele git; aksi halde surukleme (tasi/taraf degistir + kalici yaz).
    (function initDockDrag() {
        let dragging = false, moved = false, startX = 0, startY = 0, startTop = 0;
        function goToPanel() {
            chrome.storage.local.get({ server_origin: "https://goruntux.rgmedya.tr" }, (res) => {
                chrome.runtime.sendMessage({ action: "goToPanel", origin: res.server_origin });
            });
        }
        logo.addEventListener('mousedown', (e) => {
            e.preventDefault();
            dragging = true; moved = false;
            startX = e.clientX; startY = e.clientY;
            startTop = widget.offsetTop;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        function onMove(ev) {
            if (!dragging) return;
            ev.preventDefault();
            if (!moved && (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5)) {
                moved = true;
                widget.classList.add('dragging');   // gercek suruklemede: acik kal + gecis kapali
            }
            if (!moved) return;
            let nt = startTop + (ev.clientY - startY);
            nt = Math.max(4, Math.min(window.innerHeight - 80, nt));
            widget.style.top = nt + 'px';
            widget.setAttribute('data-side', (ev.clientX < window.innerWidth / 2) ? 'left' : 'right');
        }
        function onUp() {
            dragging = false;
            widget.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (!moved) { goToPanel(); return; }   // tiklama -> panele git
            const side = widget.getAttribute('data-side') || 'right';
            const top = parseInt(widget.style.top, 10) || 100;
            chrome.storage.local.set({ dock_side: side, dock_top: top });
        }
    })();

    // SILINDI (v3.65): olu kazima motorunun 11 yardimcisi — tivitIdZamaniBul,
    // zamanFormatla, tivitBilgisiniYazdir, gecenSureyiBul, kronometreyiBaslat,
    // isGorevActive, sayiCozumle, tivitIstatistikleriniBul, yorumlariKazi,
    // alintilariKazi, kullanicilariKazi. Hepsinin TUM cagri yerleri silinen motorun
    // icindeydi. DIKKAT: hemen asagidaki durdurVeTemizle PAYLASILAN ve CANLI —
    // Word taramasi onu kullaniyor (renderIdleWidget + wordTaramaYonetimi), kaba bir
    // aralikla silinmesin.

    // Stop and clear helper
    // 'sebep' (v3.66, istege bagli): tarama NEDEN durdu. Bos birakilirsa NORMAL bitis /
    // kullanicinin elle durdurmasi demektir ve panel her zamanki gibi davranir.
    // Doldurulursa panelde uyari gosterilir. Buna ihtiyac vardi cunku bu fonksiyon HEM
    // normal bitiste HEM de captcha/checkpoint iptalinde cagriliyor ve ikisi de panele
    // ayni "completeJobAndFocusPanel" mesajini gonderiyordu -> panel acisindan AYIRT
    // EDILEMEZ oluyordu. Sebep yalnizca Docker loguna yaziliyordu, kullanici gormuyordu.
    // (Sahada goruldu: TikTok captcha cikti, tarama durdu, panel "bitti" gibi davrandi.)
    // Dock'taki halka pop'undaki IPTAL: panelden baslayan uzun taramayi durdurur ve panele doner.
    // durdurVeTemizle: sunucu job'unu resetler + storage'i temizler + paneli 'sebep' ile bilgilendirir.
    function xTaramaIptal() {
        if (!aktifStorageKey) { printLog("İptal: aktif tarama görevi yok."); return; }
        printLog("Kullanıcı taramayı dock'tan iptal etti.");
        durdurVeTemizle(aktifStorageKey, timerIntervalId, null, "Kullanıcı taramayı iptal etti.");
    }

    function durdurVeTemizle(storageKey, interval, serverOrigin, sebep) {
        if (interval) clearInterval(interval);
        // İPTAL FLAŞI FIX: iptalden sonra uçuştaki/yeni YAKALAMALAR worker (X) sekmesini ekran görüntüsü
        // için öne getirip "anlık X" flaşı yapıyordu. Bu bayrak (worker sekmesinin window'unda, reload'da
        // kendiliğinden sıfırlanır) swSendReliable'da capture isteklerini DURDURUR (göndermez). Zaman damgalı:
        // ~12 sn sonra kendiliğinden kalkar (tarama zaten bitmiş olur; idle yakalamayı kalıcı bozma).
        try { window.__xWordIptal = Date.now(); } catch (e) {}
        // Tarama sonlandi: dock'taki "taranıyor" isigini kapat (savunmaci).
        try { const _w = document.getElementById('x-downloader-widget'); if (_w) _w.classList.remove('scanning'); } catch (e) {}
        chrome.storage.local.get({ server_origin: "https://goruntux.rgmedya.tr", client_id: "" }, (res) => {
            const origin = serverOrigin || res.server_origin;
            const clientId = res.client_id || "";
            
            // Storage'ı temizle ve panele geç - sunucu yanıtından BAĞIMSIZ çalışır
            function doCleanup() {
                chrome.storage.local.remove(storageKey, () => {
                    chrome.runtime.sendMessage({
                        action: "completeJobAndFocusPanel",
                        origin: origin,
                        sebep: sebep || ""
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

    // SILINDI (v3.64): excelDosyasiOlustur + ic ice s2ab. Sayfalari 'Ozet / Retweetler /
    // Alintilar / Begeniler / Yorumlar' olan bir Excel dosyasi uretiyordu — yani bir X
    // ETKILESIM KAZIMA ciktisi. Bu urunun isi ekran goruntusu -> Word raporu; Excel yok.
    // Onceki programdan kalma. Cagirani YOKTU (grep: tek eslesme tanimin kendisiydi) ve
    // besledigi xlsx.full.min.js (881 KB) bu commit'te paketten cikarildi.

    // SILINDI (v3.65): olu kazima motoru — detayliTaramaYonetimi + aramaTaramasiYonetimi
    // + topluProfilYonetimi ve ic yardimcilari. Onceki X otomasyon programindan kalma:
    // bir gonderinin RT/alinti/begeni/yorum listelerini kaziyip Excel'e doken uc asamali
    // durum makinesi. Sunucu (app.py) YALNIZCA "word_taramasi" asamasini gonderiyor;
    // diger uc asama hicbir zaman tetiklenmiyordu. Dagitici da bu commit'te tek dala indi.

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
            
            xSetButon("🔑 Giriş Paneline Git");
            buton.style.backgroundColor = '#1d9bf0';
            buton.disabled = false;
            
            buton.onclick = () => {
                chrome.storage.local.get({ server_origin: "https://goruntux.rgmedya.tr" }, (res) => {
                    window.open(`${res.server_origin}/user/login`, "_blank");
                });
            };
        } catch (e) {
            showError(e);
        }
    }

    // UI State 1: Idle widget renderer
    // Ikon+etiket yapisini KORUYARAK buton "metnini" ayarlar (eski buton.innerText'in yerini tutar).
    // Bastaki emoji -> ikon (.xdock-ico); kalan -> etiket (.xdock-lbl). Idle "Rapora Ekle" disindaki
    // (gecici) durumlarda etiketi otomatik gosterir (.xdock-show-lbl) ki kullanici sonucu okusun.
    function xSetButon(text) {
        text = String(text == null ? '' : text);
        const ico = buton.querySelector('.xdock-ico');
        const lbl = buton.querySelector('.xdock-lbl');
        if (!ico || !lbl) { buton.textContent = text; return; }
        const m = text.match(/^\s*(\p{Extended_Pictographic}️?)\s*([\s\S]*)$/u);
        if (m) { ico.textContent = m[1]; lbl.textContent = m[2].trim(); }
        else   { ico.textContent = '➕'; lbl.textContent = text.trim(); }
        buton.classList.toggle('xdock-show-lbl', text.trim() !== 'Rapora Ekle');
    }

    // ============================================================================
    // [GÖRÜNTÜX İLE RAPORLA] (Faz 2) — X profil başlığında, "Takip et" butonları
    // satırına silik bir GörüntüX ikonu enjekte eder; hover'da opaklaşıp
    // "GörüntüX ile Raporla!" etiketi açılır. Tıklanınca (sonraki fazlar) profilin
    // tüm /all akışını otomatik raporlar. Bayrak: localStorage x_gx_profil_rapor
    // !== '0'. Mevcut dock / "Rapora Ekle" / tarama motoru DEĞİŞMEZ (yalnız ek buton).
    // ============================================================================
    function xGxProfilRaporAcik() {
        try { return localStorage.getItem('x_gx_profil_rapor') !== '0'; } catch (e) { return true; }
    }
    function xGxProfilHandle() {
        try {
            // Profil KÖKÜ (x.com/handle) VEYA profil alt-sekmeleri (all/with_replies/reposts/
            // media/highlights/superfollows/affiliates). /status, /followers, /photo vb. DEĞİL.
            const m = location.href.match(/^https?:\/\/(?:x|twitter)\.com\/([^/?#]+)(?:\/(all|with_replies|reposts|media|highlights|superfollows|affiliates))?\/?(?:[?#]|$)/i);
            const rez = ["home","explore","notifications","messages","search","i","settings",
                         "compose","hashtag","login","logout","signup","share","intent",
                         "tos","privacy","about","download","jobs","developer"];
            if (m && m[1] && rez.indexOf(m[1].toLowerCase()) === -1) return m[1];
        } catch (e) {}
        return null;
    }
    // /all (Tümü) akışında mıyız? (tarama hasatı burada çalışır)
    function xGxAllSayfasiMi() { return /^https?:\/\/(?:x|twitter)\.com\/[^/?#]+\/all\b/i.test(location.href); }
    function xGxProfilStilEkle() {
        if (document.getElementById('x-gx-profil-rapor-style')) return;
        const s = document.createElement('style');
        s.id = 'x-gx-profil-rapor-style';
        s.textContent = `
            .x-gx-rapor-btn{ box-sizing:border-box; position:relative; display:inline-flex; align-items:center; justify-content:center;
                width:36px; height:36px; padding:0; margin:0 8px 12px 0; border-radius:9999px;
                background:transparent; border:none; color:#1d9bf0;
                cursor:pointer; opacity:1; transition:transform .12s ease, filter .12s ease;
                flex:0 0 auto; }
            .x-gx-rapor-btn:hover{ filter:brightness(1.08); transform:scale(1.06); }
            .x-gx-rapor-btn.x-gx-gizli{ display:none !important; }   /* profil kartı SS'i alınırken butonu gizle */
            .x-gx-rapor-btn .x-gx-ico{ display:inline-flex; flex:0 0 auto; }
            .x-gx-rapor-btn .x-gx-tip{ position:absolute; top:calc(100% + 8px); left:50%;
                transform:translateX(-50%) translateY(-4px); background:rgba(15,20,25,.96); color:#fff;
                font-weight:600; font-size:12px; line-height:1; white-space:nowrap; padding:6px 9px; border-radius:6px;
                opacity:0; pointer-events:none; z-index:99999; box-shadow:0 2px 10px rgba(0,0,0,.3);
                transition:opacity .12s ease, transform .12s ease; }
            .x-gx-rapor-btn .x-gx-tip::before{ content:""; position:absolute; bottom:100%; left:50%;
                transform:translateX(-50%); border:5px solid transparent; border-bottom-color:rgba(15,20,25,.96); }
            .x-gx-rapor-btn:hover .x-gx-tip{ opacity:1; transform:translateX(-50%) translateY(0); }
        `;
        (document.head || document.documentElement).appendChild(s);
    }
    function xProfilRaporButonuEkle() {
        try {
            if (xGxProfilModAcik()) return;   // YENİ: profil işi sol-nav yeşil butona taşındı; bu header butonu GİZLİ YEDEK (x_profil_yesil='0' ile geri gelir)
            if (!xGxProfilRaporAcik()) return;
            if (window.__xGxCaptureAktif) return;   // yakalama sırasında taze buton enjekte etme (SS'e girmesin)
            const handle = xGxProfilHandle();
            if (!handle) return;
            // "Takip et" satırı: placementTracking (takip butonu) sarmalayıcısının ebeveyni
            // (•••, bildirim, mesaj, Takip aynı flex satırında). Butonu satırın BAŞINA koyuyoruz.
            const pt = document.querySelector('[data-testid="placementTracking"]');
            if (!pt || !pt.parentElement) return;
            const satir = pt.parentElement;
            if (satir.querySelector('.x-gx-rapor-btn')) return;   // zaten eklenmiş
            xGxProfilStilEkle();
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'x-gx-rapor-btn';
            btn.setAttribute('aria-label', "Bu X profilinin GörüntüX Raporu'nu oluştur.");   // title YOK -> yerel tooltip çift görünmesin; metin özel .x-gx-tip tooltip'inde
            btn.innerHTML = `<span class="x-gx-ico"><svg width="26" height="26" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="7" fill="#1d9bf0"/><g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12V9h3"/><path d="M20 9h3v3"/><path d="M23 20v3h-3"/><path d="M12 23H9v-3"/><path d="M13 13l6 6M19 13l-6 6"/></g></svg></span><span class="x-gx-tip">Bu X profilinin GörüntüX Raporu'nu oluştur.</span>`;
            btn.addEventListener('click', (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                // Handle'ı TIK ANINDA taze oku: buton bir profilde oluşup SPA ile başka profile geçilince
                // closure'daki eski handle (ör. @mahajansi) bayat kalıyordu -> hep güncel URL'den al.
                try { xProfilRaporBaslat(xGxProfilHandle() || handle); } catch (e) { printLog('[GX Profil Rapor] hata: ' + (e && e.message)); }
            });
            satir.insertBefore(btn, satir.firstChild);
            printLog('[GX Profil Rapor] buton eklendi: @' + handle);
        } catch (e) {}
    }
    // ====================== FAZ 3: MOD KARARI + POPUP ======================
    // Butona basınca: paneldeki açık rapor durumunu sorgula → DOLU ise "Devam"
    // (bıraktığı yerden bugüne), DEĞİLSE "Takvim" (tarih aralığı). Panel yanıt
    // vermezse güvenli şekilde takvime düşer. Tarama başlatma Faz 4.
    function xProfilRaporBaslat(handle) {
        printLog('[GX Profil Rapor] başlat istendi: @' + handle);
        xProfilPopupAc(handle, { mod: 'yukleniyor' });
        xPanelRaporDurumSorgula(handle, function (durum) {
            xProfilPopupGuncelle(handle, durum);
        });
    }
    // Panel durumu sorgusu: background → bridge → panel → geri. 2.5sn içinde yanıt
    // gelmezse (panel kapalı / henüz desteklemiyor) takvim moduna düş.
    function xPanelRaporDurumSorgula(handle, cb) {
        var bitti = false;
        var tmr = setTimeout(function () { if (!bitti) { bitti = true; cb({ mod: 'takvim', sebep: 'panel-yanit-yok' }); } }, 2500);
        try {
            chrome.runtime.sendMessage({ action: 'gxPanelRaporDurum', handle: handle }, function (resp) {
                if (bitti) return; bitti = true; clearTimeout(tmr);
                if (chrome.runtime.lastError || !resp) { cb({ mod: 'takvim', sebep: 'kanal-hatasi' }); return; }
                // resp: { panelAcik, dolu, ad, sonTarihISO }
                if (resp.panelAcik && resp.dolu) cb({ mod: 'devam', ad: resp.ad || '', sonTarihISO: resp.sonTarihISO || '' });
                else cb({ mod: 'takvim', panelAcik: !!resp.panelAcik });
            });
        } catch (e) { if (!bitti) { bitti = true; clearTimeout(tmr); cb({ mod: 'takvim', sebep: 'exception' }); } }
    }
    function xGxPopupStilEkle() {
        if (document.getElementById('x-gx-popup-style')) return;
        var s = document.createElement('style'); s.id = 'x-gx-popup-style';
        s.textContent = `
            /* EKRANI KAPLAMAYAN popover: backdrop YOK; konum JS ile sol-menüdeki GörüntüX nav butonuna yaslanır. */
            #x-gx-ov{ position:fixed; top:60px; left:72px; z-index:2147483600; font-family:-apple-system,Segoe UI,Roboto,sans-serif;
                animation:xgxpop .14s ease; }
            @keyframes xgxpop{ from{ opacity:0; transform:translateX(-6px); } to{ opacity:1; transform:none; } }
            /* [SS'TE POPUP OLMASIN] yakalama sürerken (<html>.x-gx-capturing) popup KESİN gizli (geç oluşsa da). */
            html.x-gx-capturing #x-gx-ov{ display:none !important; }
            /* PANEL TEMASI (koyu): --bg-modal #0e141f, text #e7e9ea, secondary #8b98a5, input #111622, accent #1d9bf0. */
            #x-gx-card{ width:min(360px,calc(100vw - 24px)); max-height:85vh; overflow:auto; background:#0e141f; color:#e7e9ea;
                border-radius:16px; box-shadow:0 12px 40px rgba(0,0,0,.5); border:1px solid rgba(255,255,255,.08); padding:16px 18px; box-sizing:border-box;
                scrollbar-width:none; }
            /* ⚠ X sayfası STANDART scrollbar modelini kullanıyor (X CSS'inde scrollbar-width:none kuralları var) ->
               Chrome ::-webkit-scrollbar'ı tüm sayfada YOK SAYAR; scrollbar-width native 11px'ten inceltilemez.
               ÇÖZÜM: native'i gizle (scrollbar-width:none + ::-webkit display:none) + ÖZEL ince overlay thumb (xAramaScrollbar). */
            #x-gx-card::-webkit-scrollbar{ display:none; width:0; height:0; }
            .x-gx-sb-thumb{ position:absolute; right:3px; width:4px; border-radius:4px; background:rgba(255,255,255,.28);
                z-index:6; cursor:pointer; opacity:0; transition:opacity .2s ease, background .15s ease, width .12s ease; }
            .x-gx-sb-thumb:hover, .x-gx-sb-thumb.surukle{ background:rgba(255,255,255,.5); width:6px; right:2px; }
            #x-gx-card h3{ margin:0 0 2px; font-size:19px; font-weight:800; color:#e7e9ea; display:flex; align-items:center; gap:9px; }
            #x-gx-card .x-gx-sub{ color:#8b98a5; font-size:13px; margin:8px 0 16px; }
            #x-gx-card .x-gx-row{ display:flex; flex-direction:column; gap:12px; margin:12px 0; }
            #x-gx-card label{ display:block; font-size:12.5px; font-weight:700; color:#8b98a5; margin:0 0 5px; }
            /* TÜM input türleri + select KOYU (yalnız date değil; X'in beyaz varsayılanını !important ezer).
               color-scheme:dark native select açılır-listesini + date seçiciyi de koyu yapar (macOS uyumsuzluğu). */
            #x-gx-card input, #x-gx-card select, #x-gx-card textarea{ width:100%; box-sizing:border-box; padding:9px 11px;
                border:1px solid rgba(255,255,255,.14) !important; border-radius:9px; font-size:14px;
                color:#e7e9ea !important; background:#111622 !important; color-scheme:dark; }
            #x-gx-card input::placeholder{ color:#5b6b7d; opacity:1; }
            #x-gx-card input:focus, #x-gx-card select:focus{ outline:none; border-color:#1d9bf0 !important; box-shadow:0 0 0 3px rgba(29,155,240,.15); }
            #x-gx-card .x-gx-info{ background:rgba(29,155,240,.12); border:1px solid rgba(29,155,240,.3); color:#e7e9ea; border-radius:11px;
                padding:12px 14px; font-size:13.5px; line-height:1.5; margin:4px 0 16px; }
            #x-gx-card .x-gx-info b{ color:#5bb3f5; }
            #x-gx-card .x-gx-tiplbl{ font-size:12.5px; font-weight:700; color:#8b98a5; margin:2px 0 6px; }
            #x-gx-card .x-gx-tipsecler{ display:flex; flex-direction:column; gap:2px; margin-bottom:4px; }
            #x-gx-card .x-gx-tipsec{ display:flex; align-items:center; gap:9px; font-size:14px; color:#e7e9ea; padding:7px 9px; border-radius:9px; cursor:pointer; user-select:none; }
            #x-gx-card .x-gx-tipsec:hover{ background:rgba(255,255,255,.06); }
            #x-gx-card .x-gx-tipsec input{ width:17px; height:17px; accent-color:#1d9bf0; cursor:pointer; flex:0 0 auto; }
            #x-gx-card .x-gx-tipsec b{ margin-left:auto; color:#5bb3f5; font-weight:800; }
            #x-gx-card .x-gx-tipwarn{ color:#f4212e; font-size:12.5px; font-weight:700; margin-top:4px; }
            #x-gx-card .x-gx-act{ display:flex; flex-direction:column-reverse; gap:9px; margin-top:18px; }
            #x-gx-card .x-gx-act button{ width:100%; }
            #x-gx-card button{ font-weight:800; font-size:14px; border-radius:9999px; padding:10px 20px; cursor:pointer; border:1px solid transparent; }
            #x-gx-card .x-gx-primary{ background:#1d9bf0; color:#fff; }
            #x-gx-card .x-gx-primary:hover{ background:#1a8cd8; }
            #x-gx-card .x-gx-primary:disabled{ opacity:.5; cursor:default; }
            #x-gx-card .x-gx-ghost{ background:rgba(255,255,255,.05); color:#e7e9ea; border-color:rgba(255,255,255,.15); }
            #x-gx-card .x-gx-ghost:hover{ background:rgba(255,255,255,.1); }
            #x-gx-card .x-gx-note{ color:#8b98a5; font-size:12px; margin-top:12px; line-height:1.45; }
            #x-gx-card .x-gx-spin{ display:flex; align-items:center; gap:10px; color:#8b98a5; font-size:14px; padding:14px 0; }
            #x-gx-card .x-gx-spin .d{ width:16px;height:16px;border:2px solid rgba(255,255,255,.2);border-top-color:#1d9bf0;border-radius:50%;animation:xgxsp .8s linear infinite; }
            @keyframes xgxsp{ to{ transform:rotate(360deg); } }
            /* ===== KEŞFET GELİŞMİŞ ARAMA (akordiyon; profil popup temasıyla aynı kart) ===== */
            .x-gx-ara-logo{ width:28px; height:28px; border-radius:50%; background:#00ba7c; color:#fff; display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; }
            #x-gx-card .x-gx-akor{ border-top:1px solid rgba(255,255,255,.07); }
            #x-gx-card .x-gx-akor:first-of-type{ border-top:none; margin-top:4px; }
            #x-gx-card .x-gx-akor-h{ width:100%; display:flex; align-items:center; justify-content:space-between; background:transparent; border:none; color:#e7e9ea; font-weight:800; font-size:14px; padding:12px 2px; cursor:pointer; }
            #x-gx-card .x-gx-akor-ch{ color:#8b98a5; font-size:12px; transition:transform .18s ease; }
            #x-gx-card .x-gx-akor.acik .x-gx-akor-ch{ transform:rotate(180deg); }
            #x-gx-card .x-gx-akor-b{ display:none; padding:0 2px 12px; }
            #x-gx-card .x-gx-akor.acik .x-gx-akor-b{ display:block; animation:xgxgecis .18s ease; }
            /* Akordiyon gövdesinin DOĞRUDAN-çocuğu başlıklar (Dil, Bahseden) bir önceki input/satıra yapışmasın. */
            #x-gx-card .x-gx-akor-b > label{ margin-top:12px; }
            /* [DAHA FAZLA] az kullanılan alanlar (Hiçbiri/Etiketler) gizli; toggle ile aç/kapa, son durum hatırlanır. */
            #x-gx-card .x-gx-dahafazla{ display:block; width:100%; text-align:left; background:transparent; border:none; color:#1d9bf0; font-size:13px; font-weight:700; cursor:pointer; padding:9px 2px 2px; }
            #x-gx-card .x-gx-dahafazla:hover .t{ text-decoration:underline; }
            #x-gx-card .x-gx-ekstra{ display:none; }
            #x-gx-card .x-gx-ekstra.acik{ display:block; animation:xgxgecis .2s ease; }
            #x-gx-card .x-gx-ekstra input{ margin-top:7px; }
            #x-gx-card .x-gx-ekstra label{ margin-top:12px; }   /* ekstra içine taşınan Dil etiketi (akor-b doğrudan-çocuk kuralı artık uygulanmaz) */
            #x-gx-card .x-gx-ikili{ display:flex; gap:8px; align-items:flex-start; } #x-gx-card .x-gx-ikili>div{ flex:1; min-width:0; }
            #x-gx-card .x-gx-uclu{ display:flex; gap:7px; margin-top:6px; align-items:flex-start; } #x-gx-card .x-gx-uclu>div{ flex:1; min-width:0; }
            /* Min satırı etiketleri TEK SATIR (2 satıra kayıp inputları yamultmasın) + label alt boşluğu eşit. */
            #x-gx-card .x-gx-uclu label{ white-space:nowrap; font-size:11.5px; }
            #x-gx-card .x-gx-ikili label, #x-gx-card .x-gx-uclu label{ margin-top:0; }
            /* Tarih inputu dar sütunda "yyyy"yi kessemesin: kompakt padding + font. */
            #x-gx-card input[type=date]{ padding:9px 6px; font-size:13px; }
            #x-gx-card .x-gx-prev-h{ font-size:11px; color:#8b98a5; margin:14px 0 5px; }
            #x-gx-card .x-gx-prev{ background:rgba(29,155,240,.1); border:1px solid rgba(29,155,240,.28); border-radius:10px; padding:9px 11px;
                font-size:12.5px; color:#cfe3f5; word-break:break-all; font-family:ui-monospace,Menlo,Consolas,monospace; min-height:18px; line-height:1.45; }
            /* Temizle+Ara butonları popup altına SABİT (scroll'dan bağımsız). Kart scroll konteyneri
               (#x-gx-card overflow:auto) -> footer position:sticky bottom:0 ile scroll'da hep altta durur.
               Kartın alt padding'i footer'a devredildi (alt-padding:0) -> doğal/pinned konum aynı, kayma yok;
               full-bleed (margin yanları -18 = kart yatay padding'i iptal) + solid zemin + üst çizgi. */
            #x-gx-card.x-gx-ara-card{ padding-bottom:0; }
            #x-gx-card .x-gx-ara-act{ position:sticky; bottom:0; z-index:5; display:flex; gap:9px;
                margin:14px -18px 0; padding:12px 18px 16px; background:#0e141f; border-top:1px solid rgba(255,255,255,.09); }
            #x-gx-card .x-gx-ara-act button{ flex:1; font-weight:800; font-size:14px; border-radius:9999px; padding:10px 20px; cursor:pointer; border:1px solid transparent; }
            /* ÖZEL KOYU DROPDOWN (native <select> açılır-listesi macOS'ta AÇIK render; color-scheme:dark native
               menüyü koyartmıyor -> panel gibi xcs). Kapalı kutu = .x-gx-xcs, açık liste = .x-gx-xcs-list (<html>'de). */
            #x-gx-card .x-gx-xcs{ width:100%; box-sizing:border-box; display:flex; align-items:center; justify-content:space-between; gap:8px;
                padding:9px 11px; border:1px solid rgba(255,255,255,.14); border-radius:9px; font-size:14px; color:#e7e9ea; background:#111622; cursor:pointer; text-align:left; font-family:inherit; }
            #x-gx-card .x-gx-xcs:hover{ border-color:rgba(255,255,255,.25); }
            #x-gx-card .x-gx-xcs.acik{ border-color:#1d9bf0; box-shadow:0 0 0 3px rgba(29,155,240,.15); }
            #x-gx-card .x-gx-xcs-lbl{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            #x-gx-card .x-gx-xcs-chev{ color:#8b98a5; flex:0 0 auto; font-size:12px; transition:transform .15s ease; }
            #x-gx-card .x-gx-xcs.acik .x-gx-xcs-chev{ transform:rotate(180deg); }
            .x-gx-xcs-list{ position:fixed; z-index:2147483601; background:#15202b; border:1px solid rgba(255,255,255,.12); border-radius:10px;
                box-shadow:0 12px 32px rgba(0,0,0,.6); max-height:260px; overflow:auto; padding:4px; box-sizing:border-box; font-family:"TwitterChirp",-apple-system,"system-ui",Segoe UI,Roboto,sans-serif; }
            .x-gx-xcs-list::-webkit-scrollbar{ width:2px; } .x-gx-xcs-list::-webkit-scrollbar-thumb{ background:rgba(255,255,255,.22); border-radius:8px; }
            .x-gx-xcs-it{ padding:8px 10px; border-radius:7px; font-size:14px; color:#e7e9ea; cursor:pointer; white-space:nowrap; }
            .x-gx-xcs-it:hover{ background:rgba(255,255,255,.08); }
            .x-gx-xcs-it.sec{ background:rgba(29,155,240,.2); color:#fff; }
        `;
        (document.head || document.documentElement).appendChild(s);
    }
    // Popover'ı sol-menüdeki GörüntüX nav butonunun SAĞINA yasla (üstü hizalı), viewport içinde tut.
    function xGxPopoverKonumla() {
        var ov = document.getElementById('x-gx-ov'); if (!ov) return;
        var card = ov.querySelector('#x-gx-card');
        var nav = document.getElementById('x-gx-nav-btn');
        // [NAV SÜTUNU ALANI — kullanıcı isteği] Popup, X sol nav sütununun alanını doldurur:
        //   üst = GörüntüX butonunun altı · alt = "Gönderi yayınla" (SideNav_NewTweet_Button) butonunun ALT sınırı
        //   sol = nav sütunu solu (header[role=banner]) · sağ = içerik sütunu (primaryColumn) solu.
        // 85vh YERİNE max-height = bu alanın yüksekliği -> kısa içerik (profil) kadar uzar, uzun içerik
        // (arama) scroll eder + sticky footer altta (post butonu hizasında) kalır. İki popup da bu fn'i kullanır.
        var postBtn = document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
        var prim = document.querySelector('[data-testid="primaryColumn"]');
        var banner = document.querySelector('header[role="banner"]');
        if (nav && card && postBtn && prim) {
            try {
                var nr = nav.getBoundingClientRect();
                var pbr = postBtn.getBoundingClientRect();
                var contentLeft = prim.getBoundingClientRect().left;
                var navLeft = banner ? Math.max(4, Math.round(banner.getBoundingClientRect().left)) : Math.round(nr.left);
                var top = Math.round(nr.bottom + 6);
                var altSinir = Math.round(pbr.bottom);                 // "Gönderi yayınla" alt sınırı
                var width = Math.max(240, Math.round(contentLeft - navLeft - 12));
                var maxH = Math.max(160, altSinir - top);              // nav sütunu yüksekliği (85vh değil)
                if (width > 200 && maxH > 120 && contentLeft > navLeft + 60) {   // makul: sütun daralmamış
                    card.style.width = width + 'px';
                    card.style.maxHeight = maxH + 'px';
                    ov.style.left = navLeft + 'px';
                    ov.style.top = top + 'px';
                    return;
                }
            } catch (e) {}
        }
        // --- FALLBACK (nav/post butonu yok ya da sütun fazla dar): eski yüzen-kart davranışı ---
        var left, top2;
        if (nav) {
            var r = nav.getBoundingClientRect(); left = r.left; top2 = r.bottom + 6;
            if (card) {
                var solSinir = prim ? prim.getBoundingClientRect().left : window.innerWidth;
                card.style.width = Math.max(230, Math.min(360, solSinir - left - 12)) + 'px';
                card.style.maxHeight = '';   // CSS 85vh'e dön
            }
        } else { left = 12; top2 = 60; if (card) { card.style.width = ''; card.style.maxHeight = ''; } }
        var ow = (card && card.offsetWidth) || 360, oh = (card && card.offsetHeight) || 300;
        if (left + ow > window.innerWidth - 10) left = Math.max(10, window.innerWidth - ow - 10);
        if (top2 + oh > window.innerHeight - 10) top2 = Math.max(10, window.innerHeight - oh - 10);
        if (top2 < 10) top2 = 10;
        ov.style.left = Math.round(left) + 'px'; ov.style.top = Math.round(top2) + 'px';
    }
    function xProfilPopupKapat() {
        try { if (window.__xGxPopoverTemizle) window.__xGxPopoverTemizle(); } catch (e) {}
        try { var _c = document.getElementById('x-gx-card'); if (_c && _c.__sbTemizle) _c.__sbTemizle(); } catch (e) {}   // özel scrollbar belge-dinleyicileri
        var o = document.getElementById('x-gx-ov'); if (o) o.remove();
        try { document.querySelectorAll('.x-gx-xcs-list').forEach(function (l) { l.remove(); }); } catch (e) {}   // açık özel-dropdown listesi varsa temizle
    }
    // Native <select>'i KOYU özel dropdown'a çevir (macOS native açılır-listesi açık render; color-scheme yetmiyor).
    function xAramaSelectKur(sel) {
        try {
            if (!sel || sel.__xcs) return; sel.__xcs = true;
            sel.style.display = 'none';
            var box = document.createElement('button'); box.type = 'button'; box.className = 'x-gx-xcs';
            box.innerHTML = '<span class="x-gx-xcs-lbl"></span><span class="x-gx-xcs-chev">▾</span>';
            var lbl = box.querySelector('.x-gx-xcs-lbl');
            var sync = function () { var o = sel.options[sel.selectedIndex]; lbl.textContent = o ? o.textContent : ''; };
            sync(); sel.__xcsSync = sync;
            sel.parentNode.insertBefore(box, sel.nextSibling);
            var liste = null;
            var disKapat = function (e) { if (!liste) return; if (liste.contains(e.target) || box.contains(e.target)) return; kapat(); };
            var kapat = function () { if (liste) { try { liste.remove(); } catch (e) {} liste = null; } box.classList.remove('acik'); try { document.removeEventListener('mousedown', disKapat, true); } catch (e) {} };
            box.addEventListener('click', function (e) {
                e.preventDefault(); e.stopPropagation();
                if (liste) { kapat(); return; }
                liste = document.createElement('div'); liste.className = 'x-gx-xcs-list';
                Array.prototype.forEach.call(sel.options, function (o, i) {
                    var it = document.createElement('div'); it.className = 'x-gx-xcs-it' + (i === sel.selectedIndex ? ' sec' : ''); it.textContent = o.textContent;
                    it.addEventListener('click', function (ev) { ev.stopPropagation(); sel.selectedIndex = i; sync(); try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (x) {} kapat(); });
                    liste.appendChild(it);
                });
                document.documentElement.appendChild(liste);
                var r = box.getBoundingClientRect();
                liste.style.left = Math.round(r.left) + 'px'; liste.style.minWidth = Math.round(r.width) + 'px';
                liste.style.top = Math.round(r.bottom + 4) + 'px';
                var lh = liste.offsetHeight;
                if (r.bottom + 4 + lh > window.innerHeight - 8) liste.style.top = Math.round(Math.max(8, r.top - 4 - lh)) + 'px';
                box.classList.add('acik');
                setTimeout(function () { try { document.addEventListener('mousedown', disKapat, true); } catch (e) {} }, 0);
            });
        } catch (e) {}
    }
    // ÖZEL İNCE OVERLAY SCROLLBAR (#x-gx-ov'a eklenen thumb; native gizli — X standart-model webkit'i yok sayar).
    function xAramaScrollbar(card) {
        try {
            var ov = card.parentNode; if (!ov) return;
            var thumb = document.createElement('div'); thumb.className = 'x-gx-sb-thumb';
            ov.appendChild(thumb);
            var guncelle = function () {
                try {
                    var ch = card.clientHeight, sh = card.scrollHeight;
                    if (sh <= ch + 2) { thumb.style.opacity = '0'; return; }
                    var inset = 6, trackH = ch - inset * 2;
                    var th = Math.max(24, Math.round(ch / sh * trackH));
                    var top = inset + Math.round((card.scrollTop / (sh - ch)) * (trackH - th));
                    thumb.style.height = th + 'px'; thumb.style.top = top + 'px'; thumb.style.opacity = '1';
                } catch (e) {}
            };
            card.__sbGuncelle = guncelle;
            card.addEventListener('scroll', guncelle, { passive: true });
            try { new ResizeObserver(guncelle).observe(card); } catch (e) {}
            var sur = null;
            thumb.addEventListener('mousedown', function (e) {
                e.preventDefault(); e.stopPropagation();
                var ch = card.clientHeight, sh = card.scrollHeight, inset = 6, trackH = ch - inset * 2;
                var th = parseFloat(thumb.style.height) || 24;
                sur = { y: e.clientY, st: card.scrollTop, trackH: trackH, th: th, sh: sh, ch: ch };
                thumb.classList.add('surukle'); document.body.style.userSelect = 'none';
            });
            var mm = function (e) { if (!sur) return; var dy = e.clientY - sur.y; var oran = (sur.trackH - sur.th) > 0 ? dy / (sur.trackH - sur.th) : 0; card.scrollTop = sur.st + oran * (sur.sh - sur.ch); };
            var mu = function () { if (sur) { sur = null; thumb.classList.remove('surukle'); document.body.style.userSelect = ''; } };
            document.addEventListener('mousemove', mm, true);
            document.addEventListener('mouseup', mu, true);
            card.__sbTemizle = function () { try { document.removeEventListener('mousemove', mm, true); document.removeEventListener('mouseup', mu, true); } catch (e) {} };
            setTimeout(guncelle, 0); setTimeout(guncelle, 150);
        } catch (e) {}
    }
    function xProfilPopupAc(handle, durum) {
        if (window.__xGxCaptureAktif) return;   // [SS'TE POPUP OLMASIN] yakalama sürerken popup OLUŞTURMA
        xGxPopupStilEkle();
        xProfilPopupKapat();
        var ov = document.createElement('div'); ov.id = 'x-gx-ov';
        var card = document.createElement('div'); card.id = 'x-gx-card';
        ov.appendChild(card); document.body.appendChild(ov);
        xProfilPopupGuncelle(handle, durum);
        xGxPopoverKonumla();
        // Backdrop YOK (ekranı kaplamaz): dışarı tık / Esc ile kapat; resize/scroll'da yeniden konumla.
        var disTik = function (e) {
            var o = document.getElementById('x-gx-ov'); if (!o || o.contains(e.target)) return;
            var nb = document.getElementById('x-gx-nav-btn'); if (nb && nb.contains(e.target)) return;
            var pb = e.target.closest ? e.target.closest('.x-gx-rapor-btn') : null; if (pb) return;   // profil butonu -> kapatma
            xProfilPopupKapat();
        };
        var esc = function (e) { if (e.key === 'Escape') xProfilPopupKapat(); };
        var yeniden = function () { try { xGxPopoverKonumla(); } catch (e) {} };
        setTimeout(function () { try { document.addEventListener('click', disTik, true); } catch (e) {} }, 0);   // açılış tıklaması kapatmasın
        document.addEventListener('keydown', esc, true);
        window.addEventListener('resize', yeniden); window.addEventListener('scroll', yeniden, true);
        // [OTO-KAPAT] Sayfa (SPA) değişince popup asılı kalmasın (kalıntı popup sonraki yakalamalara girmesin).
        var _acPath = location.pathname;
        var _navT = setInterval(function () {
            if (!document.getElementById('x-gx-ov')) { clearInterval(_navT); return; }
            if (location.pathname !== _acPath) { clearInterval(_navT); try { xProfilPopupKapat(); } catch (e) {} }
        }, 400);
        window.__xGxPopoverTemizle = function () {
            try { document.removeEventListener('click', disTik, true); } catch (e) {}
            try { document.removeEventListener('keydown', esc, true); } catch (e) {}
            try { window.removeEventListener('resize', yeniden); window.removeEventListener('scroll', yeniden, true); } catch (e) {}
            try { clearInterval(_navT); } catch (e) {}
            window.__xGxPopoverTemizle = null;
        };
    }
    // [#5] Popup içinde mesaj göster (yerli alert yerine). Popup kapalıysa açar.
    // ilerleme=true -> 'ilerleme' modu (Tamam butonu YOK; süren işlem göstergesi).
    function xProfilMesajGoster(handle, html, otoKapat, ilerleme) {
        try {
            var h = handle || xGxProfilHandle() || '';
            var durum = { mod: ilerleme ? 'ilerleme' : 'mesaj', html: html };
            if (!document.getElementById('x-gx-card')) xProfilPopupAc(h, durum);
            else xProfilPopupGuncelle(h, durum);
            if (otoKapat) { setTimeout(function () { try { xProfilPopupKapat(); } catch (e) {} }, 3800); }
        } catch (e) {}
    }
    // [İLERLEME DOCK'TA] Profil tarama ilerlemesini SAĞDAKİ DOCK halkasında göster (popup değil).
    function xProfilDockIlerleme(yapilan, toplam, msg) {
        try {
            // Nav halkası tüm tarama boyunca KALICI (SPA dock-rebuild'de kaybolmasın): window-var'lara yaz.
            window.__xGxTaramaAktif = true;
            window.__xGxTaraYapilan = yapilan || 0; window.__xGxTaraToplam = toplam || 0; if (msg) window.__xGxTaraMsg = msg;
            var w = document.getElementById('x-downloader-widget'); if (w) { w.classList.add('scanning'); w.classList.remove('xdock-dialog'); }
            // [İLERLEMELİ HALKA] Halka BİR ANDA değil, YUMUŞAK creep ile dolar. Hedef kesri monoton (geri gitmez);
            // creep interval hedefe + sonraki adım payına doğru sürekli ilerler -> adımlar ARASI bile dolum sürer.
            if (toplam) {
                var hedef = Math.max(0, Math.min(1, (yapilan || 0) / toplam));
                if (window.__xGxRingHedef == null || hedef > window.__xGxRingHedef) window.__xGxRingHedef = hedef;
                window.__xGxRingAdim = 1 / toplam;
                xGxRingCreepBaslat();
            }
            var txt = document.getElementById('w-scan-txt'); if (txt) txt.textContent = (yapilan || 0) + '/' + (toplam || 0);
            var m = document.getElementById('w-scan-msg'); if (m && msg) m.textContent = msg;
            try { xNavYansit(); } catch (e) {}   // nav'ı anında güncelle (observer'a güvenme)
        } catch (e) {}
    }
    // Halkayı hedefe doğru yumuşak+sürekli ilerleten döngü (profil taraması). Tarama bitince (scanning yok) durur+sıfırlar.
    function xGxRingCreepBaslat() {
        if (window.__xGxRingTick) return;
        if (window.__xGxRingGoster == null) window.__xGxRingGoster = 0;
        window.__xGxRingTick = setInterval(function () {
            try {
                var w = document.getElementById('x-downloader-widget');
                // ⚠ GATE = __xGxTaramaAktif (scanning DEĞİL): Rapor'matik poll'ü (2474) sunucu-işi yoksa 'scanning'i
                // kaldırıyor; profil taraması addToPool kullandığından sunucu-işi YOK -> 'scanning' sayaç-sayaç
                // kalkıp geliyordu, creep durup sıfırlanıyor (ring dolmaz). __xGxTaramaAktif profil boyunca stabil.
                if (!w || !window.__xGxTaramaAktif) { clearInterval(window.__xGxRingTick); window.__xGxRingTick = null; window.__xGxRingHedef = null; window.__xGxRingGoster = null; return; }
                var hedef = window.__xGxRingHedef || 0, adim = window.__xGxRingAdim || 0.05;
                var ust = Math.min(0.985, hedef + adim * 0.9);   // sonraki adımın %90'ına kadar creep; gerçek ilerleme gelince ileri çekilir
                var g = window.__xGxRingGoster || 0;
                // YAVAŞ, SÜREKLİ dolum: bir adımı ~birkaç saniyede doldurur (hızlı değil) -> adım adım İZLENEBİLİR.
                g += (ust - g) * 0.03 + Math.max(0.0006, adim * 0.004);
                if (g > ust) g = ust;
                if (g < (window.__xGxRingGoster || 0)) g = window.__xGxRingGoster || 0;   // monoton (geri gitmez)
                window.__xGxRingGoster = g;
                var ring = document.getElementById('w-scan-ring');
                if (ring) { var C = 100.53; ring.setAttribute('stroke-dashoffset', (C * (1 - g)).toFixed(2)); }
            } catch (e) { try { clearInterval(window.__xGxRingTick); } catch (_) {} window.__xGxRingTick = null; }
        }, 110);
    }
    // Tarama BİTİNCE dock göstergesini kapat + nav halkasını temizle (profil VE Rapor'matik ortak).
    function xGxTaramaGostergeKapat() {
        try { window.__xGxTaramaAktif = false; } catch (e) {}
        try { var w = document.getElementById('x-downloader-widget'); if (w) w.classList.remove('scanning'); } catch (e) {}
        try { var ring = document.getElementById('w-scan-ring'); if (ring) ring.setAttribute('stroke-dashoffset', '100.53'); } catch (e) {}
        try { if (typeof xNavYansit === 'function') xNavYansit(); } catch (e) {}
    }
    function xProfilDockBitir() { xGxTaramaGostergeKapat(); }
    // [GÜNCELLEME F5] Eklenti ↻ (reload/update) olunca AÇIK sekmelerdeki içerik-script KOPAR: chrome.runtime.id
    // undefined olur, chrome.* çağrıları "Extension context invalidated" atar -> SS/Rapora Ekle butonları "Hata"
    // verir. Kullanıcı F5 yapana dek bozuk. Çözüm: kopukluğu periyodik sez -> sayfaya (X + tüm sosyal medya)
    // "GörüntüX güncellendi — Yenile (F5)" toast'ı koy. Tık/F5 -> taze script yüklenir.
    function xGxBaglantiKopuk() {
        try { return !(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id); } catch (e) { return true; }
    }
    function xGxF5ToastGoster() {
        try {
            if (!document.body || document.getElementById('x-gx-f5-toast')) return;
            var t = document.createElement('div');
            t.id = 'x-gx-f5-toast';
            t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483600;background:#15202b;border:1px solid #1d9bf0;border-radius:12px;padding:10px 14px;color:#e7e9ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-size:14px;line-height:1.3;box-shadow:0 8px 26px rgba(0,0,0,.45);display:flex;align-items:center;gap:12px;max-width:92vw;';
            var s = document.createElement('span'); s.textContent = 'GörüntüX güncellendi — bu sayfayı yenileyin';
            var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Yenile (F5)';
            b.style.cssText = 'background:#1d9bf0;border:0;color:#fff;border-radius:9999px;padding:7px 15px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap;';
            b.addEventListener('click', function () { try { location.reload(); } catch (e) {} });
            t.appendChild(s); t.appendChild(b);
            document.body.appendChild(t);
        } catch (e) {}
    }
    function xGxGuncellemeKontrolBaslat() {
        if (window.__xGxF5Kontrol) return;
        window.__xGxF5Kontrol = true;
        setInterval(function () { try { if (xGxBaglantiKopuk()) xGxF5ToastGoster(); } catch (e) {} }, 2500);
    }
    // ====================== TWEET DETAY "Rapora Ekle" BUTONU ======================
    // Tweet detay sayfasında (/status/) HER tweet'in (ana + yanıtlar) Grok/… kümesinin
    // SOLUNA GörüntüX butonu; tooltip "Bu paylaşımı GörüntüX Raporu'na ekle!". Tıklayınca
    // O tweet'i yakalar + havuza ekler (dock "Rapora Ekle" ile aynı: yorum ise parent
    // bağlamıyla xYakalaTweetVeYanit, RT ise group_override). Bayrak x_gx_tweet_btn!='0'.
    var _X_GX_ICO = '<svg width="22" height="22" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="7" fill="#1d9bf0"/><g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12V9h3"/><path d="M20 9h3v3"/><path d="M23 20v3h-3"/><path d="M12 23H9v-3"/><path d="M13 13l6 6M19 13l-6 6"/></g></svg>';
    // Yeşil "Rapora Ekle" işareti (daire zemin BUTONDA): çerçeve + ortada ARTI, stroke=currentColor.
    var _X_GX_ICO_EKLE = '<svg width="25" height="25" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12V9h3"/><path d="M20 9h3v3"/><path d="M23 20v3h-3"/><path d="M12 23H9v-3"/><path d="M16 11.5v9M11.5 16h9"/></g></svg>';
    // Yeşil PROFİL işareti: çerçeve köşeleri + ortada KİŞİ (baş + omuz), stroke=currentColor.
    var _X_GX_ICO_KISI = '<svg width="25" height="25" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12V9h3"/><path d="M20 9h3v3"/><path d="M23 20v3h-3"/><path d="M12 23H9v-3"/><circle cx="16" cy="14" r="2.6"/><path d="M11.8 22.6c0-2.7 1.9-4.3 4.2-4.3s4.2 1.6 4.2 4.3"/></g></svg>';
    // Yeşil ARAMA işareti (Keşfet): çerçeve köşeleri + ortada BÜYÜTEÇ, stroke=currentColor.
    var _X_GX_ICO_ARA = '<svg width="25" height="25" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12V9h3"/><path d="M20 9h3v3"/><path d="M23 20v3h-3"/><path d="M12 23H9v-3"/><circle cx="15" cy="15" r="3.2"/><path d="M17.3 17.3l2.3 2.3"/></g></svg>';
    function xGxTweetBtnAcik() { try { return localStorage.getItem('x_gx_tweet_btn') !== '0'; } catch (e) { return true; } }
    // Keşfet gelişmiş-arama modu (varsayılan AÇIK): Keşfet'te yeşil buton = arama ikonu + gelişmiş arama popup'ı.
    function xGxKesfetAcik() { try { return localStorage.getItem('x_kesfet_ara') !== '0'; } catch (e) { return true; } }
    function xGxKesfetMi() { try { return /^https?:\/\/(?:x|twitter)\.com\/(?:explore|search)(?:\/|\?|#|$)/i.test(location.href); } catch (e) { return false; } }
    // Profil YEŞİL-NAV modu (varsayılan AÇIK): profil işi sol-nav yeşil butona taşındı (kişi ikonu + popup);
    // '0' -> eski mavi profil-başlığı butonu geri döner (xProfilRaporButonuEkle), yeşil profil modu kapanır.
    function xGxProfilModAcik() { try { return localStorage.getItem('x_profil_yesil') !== '0'; } catch (e) { return true; } }
    function xGxTweetStilEkle() {
        if (document.getElementById('x-gx-tw-style')) return;
        var s = document.createElement('style'); s.id = 'x-gx-tw-style';
        s.textContent = `
            .x-gx-tw-btn{ box-sizing:border-box; position:relative; display:inline-flex; align-items:center; justify-content:center;
                width:30px; height:30px; margin:0 0 0 6px; border-radius:9999px; background:transparent; border:none;
                color:#1d9bf0; cursor:pointer; opacity:1; transition:transform .12s ease, filter .12s ease; flex:0 0 auto; vertical-align:middle; }
            .x-gx-tw-btn:hover{ filter:brightness(1.08); transform:scale(1.08); }
            .x-gx-tw-btn.x-gx-gizli{ display:none !important; }
            .x-gx-tw-btn.x-gx-ok{ color:#00ba7c; opacity:1; }
            .x-gx-tw-btn.x-gx-warn{ color:#f5a623; opacity:1; }
            .x-gx-tw-btn .x-gx-tw-ic{ display:inline-flex; align-items:center; justify-content:center; line-height:0; }
            .x-gx-tw-btn .x-gx-tw-ic svg{ display:block; }
            .x-gx-tw-btn .x-gx-tw-tip{ position:absolute; top:calc(100% + 8px); left:0;
                transform:translateY(-4px); background:rgba(15,20,25,.96); color:#fff; font-weight:600; font-size:12px;
                line-height:1; white-space:nowrap; padding:6px 9px; border-radius:6px; opacity:0; pointer-events:none;
                z-index:99999; box-shadow:0 2px 10px rgba(0,0,0,.3); transition:opacity .12s ease, transform .12s ease; }
            .x-gx-tw-btn:hover .x-gx-tw-tip{ opacity:1; transform:translateY(0); }
        `;
        (document.head || document.documentElement).appendChild(s);
    }

    // ============================================================================
    // [YOUTUBE SS BUTONU] YouTube /watch sayfasinda Begeni'nin SOLUNA yesil "+" GoruntuX
    // butonu. Dock sol-nav'a tasininca YouTube'da gorunur tetikleyici kalmamisti (nav X-ozel).
    // Buton bu videoyu xYtIdleYakala ile yakalar -> panelin havuzuna ekler (+ panoya kopya).
    // ⚠ YouTube Trusted Types CSP uygular -> innerHTML YASAK; DOM createElement/NS ile kurulur.
    // (Icerik-script izole-dunya CSP'den muaf olsa da TrustedHTML icin DOM-API garanti-guvenli.)
    // Begeni segmenti = segmented-like-dislike-button-view-model; GORUNUR ebeveyni asil
    // #top-level-buttons-computed (0x0 gizli ikizi degil) -> butonu onun basina (seg'den once) koy.
    // ============================================================================
    function xGxYtStilEkle() {
        xGxSsStilEkle();   // ortak ic-ice daire+kare+arti ikon + hover/durum
        if (document.getElementById('x-gx-yt-style')) return;
        var s = document.createElement('style'); s.id = 'x-gx-yt-style';
        // NOT: backtick template-literal yerine dizi+join -> backtick-tuzagi riski yok.
        // Arka plan SEFFAF: daire artik ikonun parcasi (nested tasarim). Ikon 30px (YouTube satiri kalin).
        s.textContent = [
            '.x-gx-yt-btn{ box-sizing:border-box; position:relative; display:inline-flex; align-items:center;',
            '   justify-content:center; width:40px; height:40px; margin:0 8px 0 0; padding:0; border:none;',
            '   border-radius:9999px; background:transparent; cursor:pointer; opacity:1; flex:0 0 auto;',
            '   vertical-align:middle; -webkit-appearance:none; appearance:none;',
            '   transition:transform .12s ease; }',
            '.x-gx-yt-btn:hover{ transform:scale(1.06); }',
            '.x-gx-yt-btn:disabled{ cursor:default; opacity:.92; }',
            '.x-gx-yt-btn.x-gx-gizli{ display:none !important; }',
            '.x-gx-yt-btn .x-gx-ssico{ width:44px; height:44px; }',   /* .c dairesi 40px = YouTube Paylas butonu (40x40) ile AYNI boyut */
            '.x-gx-yt-btn .x-gx-yt-ic{ display:inline-flex; align-items:center; justify-content:center; line-height:0; }',
            '.x-gx-yt-btn .x-gx-yt-ic svg{ display:block; }',
            // ⚠ Tooltip KOKE tasindi (ytd-menu-renderer overflow:hidden KIRPIYORDU) -> standalone
            // .x-gx-yt-tip + position:FIXED; konum+opacity JS-hover ile (xYtButonKur mouseenter).
            '.x-gx-yt-tip{ position:fixed; background:rgba(15,20,25,.96); color:#fff; font-weight:600;',
            '   font-size:12px; line-height:1; white-space:nowrap; padding:6px 9px; border-radius:6px; opacity:0;',
            '   pointer-events:none; z-index:2147483600; box-shadow:0 2px 10px rgba(0,0,0,.3);',
            '   transition:opacity .12s ease; }',
            'html.x-gx-capturing .x-gx-yt-tip{ opacity:0 !important; }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(s);
    }
    // Ikon SVG'si DOM-API ile (Trusted Types guvenli). tur: 'ekle' = cerceve+arti, 'ok' = onay tiki.
    function _xYtIkonSvg(tur) {
        var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('width', '24'); svg.setAttribute('height', '24'); svg.setAttribute('viewBox', '0 0 32 32');
        var g = document.createElementNS(NS, 'g');
        g.setAttribute('fill', 'none'); g.setAttribute('stroke', 'currentColor'); g.setAttribute('stroke-width', '2.4');
        g.setAttribute('stroke-linecap', 'round'); g.setAttribute('stroke-linejoin', 'round');
        var paths = (tur === 'ok')
            ? ['M9 16.5l5 5 9-10']
            : ['M9 12V9h3', 'M20 9h3v3', 'M23 20v3h-3', 'M12 23H9v-3', 'M16 11.5v9M11.5 16h9'];
        paths.forEach(function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); g.appendChild(p); });
        svg.appendChild(g); return svg;
    }

    // ============================================================================
    // [TEKLI SS BUTON IKONU — ORTAK] Kullanici tasarimi (2026-11-21): ic ice 3 kat —
    // (1) yesil konturlu DAIRE, (2) SS anlamli tarama-KARESI (logomuz), (3) kucuk ARTI.
    // Normal: hepsi yesil outline (daire ici seffaf). Hover: daire YESIL DOLAR (kontur
    // yesil kalir), kare+arti BEYAZ olur. 'ok' durumunda ic = beyaz onay tiki (dolu daire).
    // Tum TEKLI-SS butonlarinda ortak (.x-gx-ssbtn): IG + YouTube. (X tekli-SS = sol-nav
    // butonu, kullanici haric tuttu; X'te ayri per-tweet buton zaten olusturulmuyor.)
    // Renkler CSS'te (.c=daire, .in=ic) -> currentColor degil; hover/durum CSS ile.
    // ============================================================================
    function xGxSsStilEkle() {
        if (document.getElementById('x-gx-ss-style')) return;
        var s = document.createElement('style'); s.id = 'x-gx-ss-style';
        s.textContent = [
            '.x-gx-ssbtn .x-gx-ssico{ display:block; width:24px; height:24px; overflow:visible; }',
            '.x-gx-ssbtn .x-gx-ssico .c{ fill:none; stroke:#00ba7c; stroke-width:1.6; transition:fill .12s ease, stroke .12s ease; }',
            '.x-gx-ssbtn .x-gx-ssico .in{ fill:none; stroke:#00ba7c; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; transition:stroke .12s ease; }',
            '.x-gx-ssbtn:hover .x-gx-ssico .c{ fill:#00ba7c; stroke:#00ba7c; }',   /* daire dolar, KONTUR yesil kalir */
            '.x-gx-ssbtn:hover .x-gx-ssico .in{ stroke:#fff; }',                   /* kare+arti beyaz */
            '.x-gx-ssbtn.x-gx-ok .x-gx-ssico .c{ fill:#00ba7c; stroke:#00ba7c; }',
            '.x-gx-ssbtn.x-gx-ok .x-gx-ssico .in{ stroke:#fff; }',
            '.x-gx-ssbtn.x-gx-warn .x-gx-ssico .c{ fill:none; stroke:#f5a623; }',
            '.x-gx-ssbtn.x-gx-warn .x-gx-ssico .in{ stroke:#f5a623; }',
            '.x-gx-ssbtn.x-gx-warn:hover .x-gx-ssico .c{ fill:#f5a623; stroke:#f5a623; }',
            '.x-gx-ssbtn.x-gx-warn:hover .x-gx-ssico .in{ stroke:#fff; }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(s);
    }
    // Ortak ikon (DOM-API, Trusted Types guvenli). tur 'ok' = ic onay tiki, aksi = kare+arti.
    function _xGxSsIkon(tur) {
        var NS = 'http://www.w3.org/2000/svg';
        var s = document.createElementNS(NS, 'svg');
        s.setAttribute('class', 'x-gx-ssico'); s.setAttribute('viewBox', '0 0 24 24');
        var c = document.createElementNS(NS, 'circle');
        c.setAttribute('class', 'c'); c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '11');
        // INLINE FALLBACK: paylasilan CSS (x-gx-ss-style) gec/eksik olsa bile SVG varsayilani fill:black
        // -> SIYAH DAIRE/"bos" olurdu. Inline fill/stroke ile base DAIMA yesil outline render olur;
        // CSS (varsa) presentation-attribute'u ezer -> hover/durum yine calisir.
        c.setAttribute('fill', 'none'); c.setAttribute('stroke', '#00ba7c'); c.setAttribute('stroke-width', '1.6');
        s.appendChild(c);
        var g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'in');
        g.setAttribute('fill', 'none'); g.setAttribute('stroke', '#00ba7c'); g.setAttribute('stroke-width', '1.7');
        g.setAttribute('stroke-linecap', 'round'); g.setAttribute('stroke-linejoin', 'round');
        function P(d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); g.appendChild(p); }
        function CI(cx, cy, r) { var e = document.createElementNS(NS, 'circle'); e.setAttribute('cx', cx); e.setAttribute('cy', cy); e.setAttribute('r', r); g.appendChild(e); }
        // Daire ORTAK kap (.c). Ic (.in) moda gore: ekle=cerceve+arti (IG/YT ile AYNI),
        // profil=kisi, ara=arama, ok=onay tiki. (X sol-nav butonu tum modlarda bu tasarim.)
        // CERCEVE (kare) = GoruntuX/SS logosu, TUM capture modlarinda (kullanici: profil+ara'da da kare olsun).
        var CERCEVE = ['M7.5 10.5V7.5h3', 'M13.5 7.5h3v3', 'M16.5 13.5v3h-3', 'M10.5 16.5H7.5v-3'];
        if (tur === 'ok') {
            P('M7.5 12.4l2.8 2.8 6-6.4');
        } else if (tur === 'profil') {
            CERCEVE.forEach(P); CI('12', '10.6', '1.25'); P('M9.6 15c0-1.5 1.1-2.4 2.4-2.4s2.4 .9 2.4 2.4');   // cerceve + kisi
        } else if (tur === 'ara') {
            CERCEVE.forEach(P); CI('11.3', '11.3', '1.7'); P('M12.7 12.7l1.7 1.7');   // cerceve + arama
        } else if (tur === 'kayit') {
            // RT VIDEO kayit modu: yesil SS butonuyla AYNI kare cerceve + ic DOLU nokta (record). Renk CSS'te (kirmizi).
            CERCEVE.forEach(P);
            var _dot = document.createElementNS(NS, 'circle'); _dot.setAttribute('cx', '12'); _dot.setAttribute('cy', '12'); _dot.setAttribute('r', '2.6');
            _dot.setAttribute('stroke', 'none'); _dot.setAttribute('fill', '#f4212e'); g.appendChild(_dot);
        } else if (tur === 'durdur') {
            // RT VIDEO durdur: ic DOLU kare (stop) -> diger ikonlar boyutunda (ikonu doldurur). Renk CSS'te.
            var _sq = document.createElementNS(NS, 'rect'); _sq.setAttribute('x', '6'); _sq.setAttribute('y', '6'); _sq.setAttribute('width', '12'); _sq.setAttribute('height', '12'); _sq.setAttribute('rx', '2');
            _sq.setAttribute('stroke', 'none'); _sq.setAttribute('fill', '#f4212e'); g.appendChild(_sq);
        } else if (tur === 'indir') {
            P('M12 7.4v6.2'); P('M9.2 10.8L12 13.6l2.8-2.8'); P('M8.2 16.2h7.6');   // daire + asagi ok (indir)
        } else if (tur === 'kapat') {
            P('M9 9l6 6'); P('M15 9l-6 6');   // daire + X (kapat)
        } else {
            CERCEVE.forEach(P); P('M12 10v4'); P('M10 12h4');   // cerceve + arti (ekle)
        }
        s.appendChild(g); return s;
    }
    // Begeni segmentinin GORUNUR ebeveyni (asil #top-level-buttons-computed). Butonu bunun basina koyariz.
    function _xYtLikeHedef() {
        try {
            var seg = document.querySelector('segmented-like-dislike-button-view-model')
                   || document.querySelector('like-button-view-model');
            if (seg && seg.parentElement) {
                var pr = seg.parentElement.getBoundingClientRect();
                if (pr.width > 1 && pr.height > 1) return { host: seg.parentElement, once: seg };
            }
            var all = document.querySelectorAll('#top-level-buttons-computed');
            for (var i = 0; i < all.length; i++) {
                var r = all[i].getBoundingClientRect();
                if (r.width > 10 && r.height > 10) return { host: all[i], once: all[i].firstElementChild };
            }
        } catch (e) {}
        return null;
    }
    // Buton gorsel durumu: sinif ('x-gx-ok'|'x-gx-warn'|null), tooltip metni, ikon turu.
    function _xYtDurum(btn, sinif, mesaj, ikonTur) {
        try {
            btn.classList.remove('x-gx-ok', 'x-gx-warn');
            if (sinif) btn.classList.add(sinif);
            var ic = btn.querySelector('.x-gx-yt-ic');
            if (ic) { while (ic.firstChild) ic.removeChild(ic.firstChild); ic.appendChild(_xGxSsIkon(ikonTur || 'ekle')); }
            if (btn.__tip && typeof mesaj === 'string') btn.__tip.textContent = mesaj;
        } catch (e) {}
    }
    var _X_YT_TIP = 'Bu videoyu GörüntüX Raporu\'na ekle';
    // Butonu /watch'ta Begeni'nin soluna kur (yoksa). /watch disinda kaldir.
    function xYtButonKur() {
        try {
            if (xPlatform() !== 'yt') return;
            if (location.pathname.toLowerCase() !== '/watch') {
                var esk = document.querySelectorAll('.x-gx-yt-btn'); for (var k = 0; k < esk.length; k++) { try { esk[k].remove(); } catch (e) {} }
                document.querySelectorAll('.x-gx-yt-tip').forEach(function (t) { try { t.remove(); } catch (e) {} });   // koke tasinan tooltip'leri de temizle
                return;
            }
            if (document.querySelector('.x-gx-yt-btn')) return;   // zaten var (display:none olsa bile -> capture sirasinda yeniden enjekte etme)
            var hedef = _xYtLikeHedef(); if (!hedef || !hedef.host) return;
            xGxYtStilEkle();
            var btn = document.createElement('button');
            btn.className = 'x-gx-yt-btn x-gx-ssbtn';
            btn.type = 'button';
            btn.setAttribute('aria-label', 'GörüntüX Raporu\'na ekle');
            var ikonSar = document.createElement('span'); ikonSar.className = 'x-gx-yt-ic'; ikonSar.appendChild(_xGxSsIkon('ekle'));
            btn.appendChild(ikonSar);
            // ⚠ Tooltip KOKE (documentElement): YouTube'da ytd-menu-renderer overflow-y:hidden ->
            // buton-ici absolute tooltip KIRPILIYOR (gorunmez). Koke tasinip position:fixed + JS-hover
            // ile konumlanir (X-nav tooltip deseni). INLINE literal (var timing -> bos tooltip).
            var tip = document.createElement('span'); tip.className = 'x-gx-yt-tip'; tip.textContent = "Bu videoyu GörüntüX Raporu'na ekle";
            document.documentElement.appendChild(tip); btn.__tip = tip;
            btn.addEventListener('mouseenter', function () { try { var r = btn.getBoundingClientRect(); tip.style.left = Math.round(r.left) + 'px'; tip.style.top = Math.round(r.bottom + 8) + 'px'; tip.style.opacity = '1'; var tr = tip.getBoundingClientRect(); if (tr.right > window.innerWidth - 8) tip.style.left = Math.max(8, Math.round(window.innerWidth - 8 - tr.width)) + 'px'; } catch (e) {} });
            btn.addEventListener('mouseleave', function () { try { tip.style.opacity = '0'; } catch (e) {} });
            btn.addEventListener('click', function (ev) { try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {} xYtButonTikla(btn); });
            if (hedef.once && hedef.once.parentElement === hedef.host) hedef.host.insertBefore(btn, hedef.once);
            else hedef.host.insertBefore(btn, hedef.host.firstChild);
        } catch (e) {}
    }
    // Buton tiklama: yakala (xYtIdleYakala) -> pano -> addToPool -> geri bildirim.
    async function xYtButonTikla(btn) {
        if (!btn || btn.__busy) return;
        if (location.pathname.toLowerCase() !== '/watch') {
            _xYtDurum(btn, 'x-gx-warn', 'Yalnız video (/watch)', 'ekle');
            setTimeout(function () { _xYtDurum(btn, null, "Bu videoyu GörüntüX Raporu'na ekle", 'ekle'); }, 2200); return;
        }
        btn.__busy = true; btn.disabled = true;
        _xYtDurum(btn, null, 'Yakalanıyor…', 'ekle');
        var _ytLink = window.location.href;
        var pano = null; try { pano = xPanoHazirla(_ytLink); } catch (e) {}
        var origin = 'https://goruntux.rgmedya.tr';
        try { origin = await new Promise(function (r) { chrome.storage.local.get({ server_origin: 'https://goruntux.rgmedya.tr' }, function (x) { r((x && x.server_origin) || 'https://goruntux.rgmedya.tr'); }); }); } catch (e) {}
        var _bitir = function (sinif, mesaj, ikonTur, sure) {
            _xYtDurum(btn, sinif, mesaj, ikonTur);
            setTimeout(function () { btn.__busy = false; btn.disabled = false; _xYtDurum(btn, null, "Bu videoyu GörüntüX Raporu'na ekle", 'ekle'); }, sure || 1800);
        };
        var _ytRes = null;
        try { _ytRes = await xYtIdleYakala(); }
        catch (e) { printLog('YT buton yakalama hatasi: ' + ((e && e.message) || e)); }
        if (!_ytRes || !_ytRes.shot || _ytRes.shot.length < 100) {
            if (pano) { try { pano.iptal(); } catch (e) {} }
            _bitir('x-gx-warn', 'Yakalanamadı — tekrar deneyin', 'ekle', 2600); return;
        }
        var _panoOk = false; if (pano) { try { _panoOk = await pano.gorseliVer(_ytRes.shot); } catch (e) {} }
        try {
            chrome.runtime.sendMessage({
                action: 'addToPool',
                origin: origin,
                title: _ytRes.author || 'YouTube Videosu',
                link: _ytLink,
                image: _ytRes.shot,
                is_profile: false,
                group_override: ''
            }, function (addRes) {
                if (addRes && addRes.status === 'success') { _bitir('x-gx-ok', _panoOk ? 'Eklendi · Panoda' : 'Rapora eklendi', 'ok', 1800); }
                else if (addRes && addRes.status === 'duplicate') { _bitir('x-gx-warn', 'Zaten havuzda', 'ekle', 2000); }
                else { _bitir('x-gx-warn', 'Eklenemedi' + (addRes && addRes.message ? (': ' + addRes.message) : ''), 'ekle', 3000); }
            });
        } catch (e) {
            if (pano) { try { pano.iptal(); } catch (x) {} }
            _bitir('x-gx-warn', 'Bağlantı koptu — F5 yapın', 'ekle', 3200);
        }
    }
    // Baslangic: yalniz YouTube'da; stil kur + hemen dene + SPA/yeniden-render icin poller.
    function xYtButonInit() {
        if (xPlatform() !== 'yt') return;
        try { xGxYtStilEkle(); } catch (e) {}
        try { xYtButonKur(); } catch (e) {}
        setInterval(function () { try { xYtButonKur(); } catch (e) {} }, 700);
    }

    // ============================================================================
    // [INSTAGRAM SS BUTONU] Her gönderinin Kaydet (bookmark) butonunun SOLUNA yesil "+"
    // GoruntuX butonu — feed + post-sayfasi + profil-modali (hepsi ayni <section grid> aksiyon
    // cubugu). Tik = O gönderiyi captureArticle ile yakalar -> panelin havuzuna ekler (+ pano).
    // Anchor: save.closest('section') + save'i iceren hucre (yalniz-Kaydet). Hucre flex yapilir,
    // buton Kaydet'in soluna (4px) girer. Capture dogru gönderiyi alsin diye __xIgHedefPost set
    // edilir (igFindPost guard'i onu doner). SS kosulu: captureArticle xGxButonlariGizle ile
    // .x-gx-ig-btn'i (listede) + DM balonu/yorum-avatari/begenenler'i gizler -> butonumuz SS'e girmez.
    // Ikon DOM-API ile (_xYtIkonSvg yeniden kullanildi); IG light-tema -> yesil OUTLINE (IG ikon stili).
    // ============================================================================
    function xGxIgStilEkle() {
        xGxSsStilEkle();   // ortak ic-ice daire+kare+arti ikon + hover/durum
        if (document.getElementById('x-gx-ig-style')) return;
        var s = document.createElement('style'); s.id = 'x-gx-ig-style';
        // Buton Kaydet (bookmark) ile AYNI boyut: 24x24; arka plan seffaf (daire ikonun parcasi).
        s.textContent = [
            '.x-gx-ig-btn{ box-sizing:border-box; position:relative; display:inline-flex; align-items:center;',
            '   justify-content:center; width:24px; height:24px; padding:0; margin:0; border:none; background:transparent;',
            '   cursor:pointer; opacity:1; flex:0 0 auto; vertical-align:middle;',
            '   -webkit-appearance:none; appearance:none; transition:transform .12s ease; }',
            '.x-gx-ig-btn:hover{ transform:scale(1.06); }',
            '.x-gx-ig-btn.x-gx-gizli{ display:none !important; }',
            '.x-gx-ig-btn .x-gx-ssico{ width:24px; height:24px; }',
            '.x-gx-ig-btn .x-gx-ig-ic{ display:inline-flex; align-items:center; justify-content:center; line-height:0; }',
            '.x-gx-ig-btn .x-gx-ig-ic svg{ display:block; }',
            // Buton Kaydet'in solunda = post SAG kenarina yakin. Ortali tooltip sagdan TASIP kesiliyordu.
            // Cozum: SAGA yasla (right:0) -> tooltip SOLA acilir, viewport sagindan tasmaz.
            '.x-gx-ig-btn .x-gx-ig-tip{ position:absolute; bottom:calc(100% + 8px); right:0; left:auto;',
            '   transform:translateY(4px); background:rgba(15,20,25,.96); color:#fff; font-weight:600;',
            '   font-size:12px; line-height:1; white-space:nowrap; padding:6px 9px; border-radius:6px; opacity:0;',
            '   pointer-events:none; z-index:99999; box-shadow:0 2px 10px rgba(0,0,0,.3);',
            '   transition:opacity .12s ease, transform .12s ease; }',
            '.x-gx-ig-btn:hover .x-gx-ig-tip{ opacity:1; transform:translateY(0); }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(s);
    }
    // IG ikonu (kullanici secimi C): RAFINE cerceve+arti — GoruntuX kimligi, IG cizgi kalinligine
    // uyarlanmis (viewBox 24, stroke 2.1, yuvarlak uc). tur 'ok' = onay tiki.
    function _xIgIkonSvg(tur) {
        var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('width', '24'); svg.setAttribute('height', '24'); svg.setAttribute('viewBox', '0 0 24 24');
        var g = document.createElementNS(NS, 'g');
        g.setAttribute('fill', 'none'); g.setAttribute('stroke', 'currentColor'); g.setAttribute('stroke-width', '2.1');
        g.setAttribute('stroke-linecap', 'round'); g.setAttribute('stroke-linejoin', 'round');
        var paths = (tur === 'ok')
            ? ['M6 12.5l3.8 3.8 8.2-9']
            : ['M8 10V8h2', 'M16 8h2v2', 'M18 16v2h-2', 'M10 18H8v-2', 'M12 9v6', 'M9 12h6'];
        paths.forEach(function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); g.appendChild(p); });
        svg.appendChild(g); return svg;
    }
    // Kaydet svg'sinin aksiyon-cubugu hucresi (section'in dogrudan cocugu, yalniz-Kaydet).
    function _xIgSaveCell(saveSvg) {
        try {
            var sec = saveSvg.closest('section'); if (!sec) return null;
            var cell = saveSvg, guard = 0;
            while (cell && cell.parentElement !== sec && guard < 12) { cell = cell.parentElement; guard++; }
            if (!cell || cell.parentElement !== sec) return null;
            if (cell.querySelector('svg[aria-label="Beğen"], svg[aria-label="Like"]')) return null;   // yalniz-Kaydet hucresi olmali
            return cell;
        } catch (e) { return null; }
    }
    function _xIgDurum(btn, renk, mesaj, ikonTur) {
        try {
            btn.classList.remove('x-gx-ok', 'x-gx-warn');
            if (renk === 'ok') btn.classList.add('x-gx-ok');
            else if (renk === 'warn') btn.classList.add('x-gx-warn');
            var ic = btn.querySelector('.x-gx-ig-ic');
            if (ic) { while (ic.firstChild) ic.removeChild(ic.firstChild); ic.appendChild(_xGxSsIkon(ikonTur || 'ekle')); }
            if (btn.__tip && typeof mesaj === 'string') btn.__tip.textContent = mesaj;
        } catch (e) {}
    }
    var _X_IG_TIP = "GörüntüX Raporu'na ekle";   // ⚠ ÇİFT TIRNAK + DÜZ apostrof: tek-tırnak+\' bir yerde BOŞ string veriyor ([[html-template-escape-tuzagi]])
    // Tum gorunur Kaydet butonlari icin (coklu-post): hucreyi flex yap + butonu Kaydet'in soluna koy.
    function xIgButonKur() {
        try {
            if (xPlatform() !== 'ig') return;
            if (window.__xGxCaptureAktif) return;   // yakalama sirasinda DOM'a dokunma
            xGxIgStilEkle();
            var saves = document.querySelectorAll('svg[aria-label="Kaydet"], svg[aria-label="Save"]');
            for (var i = 0; i < saves.length; i++) {
                var save = saves[i];
                // [ANASAYFA FEED'DE GOSTERME — kullanici istegi 2026-11-21, "simdilik"] Butonu YALNIZ
                // capture'in TEMIZ oldugu yuzeylerde goster: modal ([role=dialog]) VEYA gönderinin KENDI
                // sayfasi (/p/,/reel/ -> <article> YOK). Home feed inline <article> gönderileri HARIC —
                // feed yakalamasi "usulune uygun" degildi + flassiz yeni-sekme yakalamasi Chrome'da mumkun
                // degil (captureVisibleTab yalniz on sekme; debugger=banner). Temiz cozum gelene dek feed kapali.
                if (!(save.closest('[role="dialog"]') || !save.closest('article'))) continue;
                var cell = _xIgSaveCell(save);
                if (!cell || cell.querySelector('.x-gx-ig-btn')) continue;
                try { cell.style.setProperty('display', 'flex'); cell.style.setProperty('align-items', 'center'); cell.style.setProperty('gap', '4px'); } catch (e) {}
                var btn = document.createElement('div');
                btn.className = 'x-gx-ig-btn x-gx-ssbtn'; btn.setAttribute('role', 'button'); btn.setAttribute('tabindex', '0');
                btn.setAttribute('aria-label', 'GörüntüX Raporu\'na ekle');
                var ic = document.createElement('span'); ic.className = 'x-gx-ig-ic'; ic.appendChild(_xGxSsIkon('ekle'));
                var tip = document.createElement('span'); tip.className = 'x-gx-ig-tip'; tip.textContent = "GörüntüX Raporu'na ekle";   // ⚠ INLINE literal: _X_IG_TIP var'i xIgButonKur ANINDA henuz undefined olabiliyordu (timing) -> tooltip bos geliyordu
                btn.appendChild(ic); btn.appendChild(tip); btn.__tip = tip;
                (function (b) { b.addEventListener('click', function (ev) { try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {} xIgButonTikla(b); }); })(btn);
                cell.insertBefore(btn, cell.firstChild);
            }
        } catch (e) {}
    }
    // IG gönderi KANONIK permalinki = sunucunun x_temizle_link'i ile BIREBIR AYNI uretir:
    // 'https://www.instagram.com/p/<shortcode>'. ⚠KRITIK: querySelector('a[href*="/p/"]') bir
    // YORUM linki ('.../p/CODE/c/<id>/') cekebiliyor -> sunucu meta'yi /p/CODE'a indirir ama
    // GORSEL anahtari (normalize_link_key, IG'de yalniz kucuk-harf) /c/...'li kalir -> ANAHTAR
    // ESLESMEZ -> rapor dogru link+baslik ama GORSELSIZ cikar. Shortcode'u regex'le cek (yorum
    // linki de dogru code verir), reel/tv de /p/'ye indir (sunucu da oyle) -> anahtarlar esit.
    function _xIgPostLink(post) {
        function kanon(u) {
            try { var m = String(u || '').match(/\/(?:p|reel|reels|tv)\/([^/?#]+)/i); if (m) return 'https://www.instagram.com/p/' + m[1]; } catch (e) {}
            return null;
        }
        var fromLoc = kanon(location.pathname) || kanon(location.href);
        if (fromLoc) return fromLoc;
        try {
            var as = (post || document).querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
            for (var i = 0; i < as.length; i++) { var k = kanon(as[i].getAttribute('href') || as[i].href); if (k) return k; }
        } catch (e) {}
        try { return location.href.split('?')[0].split('#')[0]; } catch (e) { return location.href; }
    }
    // Tik: tiklanan butonun gönderisini coz -> __xIgHedefPost -> captureArticle -> pano -> addToPool.
    async function xIgButonTikla(btn) {
        if (!btn || btn.__busy) return;
        btn.__busy = true;
        _xIgDurum(btn, null, 'Yakalanıyor…', 'ekle');
        var post = null; try { post = btn.closest('article'); } catch (e) {}
        if (!post) { try { post = igFindPost(); } catch (e) {} }
        // Link = gönderinin KANONIK permalinki (sunucu x_temizle_link ile AYNI -> gorsel anahtari eslesir).
        var link = _xIgPostLink(post);
        var pano = null; try { pano = xPanoHazirla(link); } catch (e) {}
        var origin = 'https://goruntux.rgmedya.tr';
        try { origin = await new Promise(function (r) { chrome.storage.local.get({ server_origin: 'https://goruntux.rgmedya.tr' }, function (x) { r((x && x.server_origin) || 'https://goruntux.rgmedya.tr'); }); }); } catch (e) {}
        var _bitir = function (renk, mesaj, ikonTur, sure) {
            _xIgDurum(btn, renk, mesaj, ikonTur);
            setTimeout(function () { btn.__busy = false; _xIgDurum(btn, null, "GörüntüX Raporu'na ekle", 'ekle'); }, sure || 1800);
        };
        var ss = '', baslik = 'Instagram Gönderisi';
        try {
            window.__xIgHedefPost = post || null;   // igFindPost guard'i -> tum ic kadraj/gizleme hedef gönderiye kilitlenir
            try {
                ss = (await captureArticle(post || document.querySelector('article') || document.body)) || '';
                baslik = xIgYazar() || baslik;       // xIgYazar da igFindPost kullanir -> hedef gönderi yazari
            } finally { window.__xIgHedefPost = null; }
        } catch (e) { printLog('IG buton yakalama hatasi: ' + ((e && e.message) || e)); }
        if (!ss || ss.length < 100) {
            if (pano) { try { pano.iptal(); } catch (e) {} }
            _bitir('warn', 'Yakalanamadı — tekrar deneyin', 'ekle', 2600); return;
        }
        var _panoOk = false; if (pano) { try { _panoOk = await pano.gorseliVer(ss); } catch (e) {} }
        try {
            chrome.runtime.sendMessage({
                action: 'addToPool', origin: origin, title: baslik, link: link, image: ss, is_profile: false, group_override: ''
            }, function (addRes) {
                if (addRes && addRes.status === 'success') { _bitir('ok', _panoOk ? 'Eklendi · Panoda' : 'Rapora eklendi', 'ok', 1800); }
                else if (addRes && addRes.status === 'duplicate') { _bitir('warn', 'Zaten havuzda', 'ekle', 2000); }
                else { _bitir('warn', 'Eklenemedi' + (addRes && addRes.message ? (': ' + addRes.message) : ''), 'ekle', 3000); }
            });
        } catch (e) {
            if (pano) { try { pano.iptal(); } catch (x) {} }
            _bitir('warn', 'Bağlantı koptu — F5 yapın', 'ekle', 3200);
        }
    }
    // Baslangic: yalniz Instagram'da; stil + hemen dene + poller (SPA + akista yeni gönderiler kaydikca).
    function xIgButonInit() {
        if (xPlatform() !== 'ig') return;
        try { xGxIgStilEkle(); } catch (e) {}
        try { xIgButonKur(); } catch (e) {}
        setInterval(function () { try { xIgButonKur(); } catch (e) {} }, 700);
    }

    // ============================================================================
    // [FACEBOOK SS] Her gönderi kartinin basliginda, sagdaki ⋯ (ve varsa X kapat) butonlarinin
    // SOLUNA yesil "+" GoruntuX butonu -> anasayfa feed'inde de kart SS'i alinabilir. Tiklayinca
    // __xFbHedefPost = tiklanan kart -> fbFindPost guard'i onu doner -> xFbIdleYakala DOGRU karti
    // yakalar (en-buyuk-medya degil). LINK: FB header'inda temiz permalink <a> YOK (zaman-damgasi
    // JS-gezinme) -> icerik-hash SENTETIK link (xmanual://fb-<hash>) -> dedup + gorsel anahtari eslesir
    // (sunucu normalize_link_key default dali, kirpma yok). SS'te butonumuz xFbIdleYakala'da
    // .x-gx-fb-btn visibility:hidden ile gizlenir (kart icinde oldugundan).
    // ============================================================================
    function xGxFbStilEkle() {
        xGxSsStilEkle();   // ortak ic-ice daire+kare+arti ikon + hover/durum
        if (document.getElementById('x-gx-fb-style')) return;
        var s = document.createElement('style'); s.id = 'x-gx-fb-style';
        // ⋯/X butonlari ile AYNI 36x36 kutu; arka plan seffaf (yesil daire ikonun parcasi).
        s.textContent = [
            '.x-gx-fb-btn{ box-sizing:border-box; position:relative; display:inline-flex; align-items:center;',
            '   justify-content:center; width:36px; height:36px; padding:0; margin:0; border:none; background:transparent;',
            '   cursor:pointer; opacity:1; flex:0 0 auto; vertical-align:middle;',
            '   -webkit-appearance:none; appearance:none; transition:transform .12s ease; }',
            '.x-gx-fb-btn:hover{ transform:scale(1.06); }',
            '.x-gx-fb-btn.x-gx-gizli{ display:none !important; }',
            '.x-gx-fb-btn .x-gx-ssico{ width:38px !important; height:38px !important; }',   // daire ~34px = ⋯/X hover dairesine yakin
            '.x-gx-fb-btn .x-gx-fb-ic{ display:inline-flex; align-items:center; justify-content:center; line-height:0; }',
            '.x-gx-fb-btn .x-gx-fb-ic svg{ display:block; overflow:visible; }',
            // Sagdaki buton grubunun solunda -> tooltip SAGA yaslanirsa viewport sagindan tasabilir; SOLA ac.
            // ALTA dogru ac (kullanici istegi): buton baslik ustunde -> yukari acilinca ustteki sayfaya tasiyordu.
            '.x-gx-fb-btn .x-gx-fb-tip{ position:absolute; top:calc(100% + 8px); right:0; left:auto;',
            '   transform:translateY(-4px); background:rgba(15,20,25,.96); color:#fff; font-weight:600;',
            '   font-size:12px; line-height:1; white-space:nowrap; padding:6px 9px; border-radius:6px; opacity:0;',
            '   pointer-events:none; z-index:99999; box-shadow:0 2px 10px rgba(0,0,0,.3);',
            '   transition:opacity .12s ease, transform .12s ease; }',
            '.x-gx-fb-btn:hover .x-gx-fb-tip{ opacity:1; transform:translateY(0); }',
            // REEL: sag dikey aksiyon kolonundaki (Begen/Yorum/Paylas/⋯) 48px native butonlara uy.
            // Buton Begen'in USTUNE (kolon ilk cocuk) eklenir; tooltip SOLA acilir (sag kenarda, altta Begen'i orter).
            '.x-gx-fb-btn.x-gx-fb-reel{ width:48px; height:48px; margin:0 0 2px 0; }',
            '.x-gx-fb-btn.x-gx-fb-reel .x-gx-ssico{ width:42px !important; height:42px !important; }',
            '.x-gx-fb-btn.x-gx-fb-reel .x-gx-fb-tip{ top:50%; bottom:auto; right:calc(100% + 10px); left:auto; transform:translate(4px,-50%); }',
            '.x-gx-fb-btn.x-gx-fb-reel:hover .x-gx-fb-tip{ transform:translate(0,-50%); }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(s);
    }
    // Icerik-hash (djb2) -> SENTETIK link (FB header'inda temiz permalink <a> yok).
    function _xFbHash(str) {
        var h = 5381; str = String(str || '');
        for (var i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) | 0; }
        return (h >>> 0).toString(36);
    }
    // YAZAR (ANASAYFA FEED): ⋯ aria-label'inda yazar adi GOMULU — "<AD>'in bu gönderisi için eylemler"
    // / "<AD> adlı kişinin ... gönderisi için eylemler". Anasayfada URL "/" oldugundan fbAuthor() BOS
    // doner ("Facebook Gönderisi" fallback'a duser); bu her yuzeyde (feed+post sayfasi) yazari verir.
    function _xFbYazarAria(eylemBtn) {
        try {
            var al = (eylemBtn && eylemBtn.getAttribute('aria-label')) || '';
            var m = al.match(/^(.*?)(?:['’’][a-zçğıöşü]{1,3})?\s*(?:adlı kişinin\s*)?(?:bu\s+)?gönderisi için eylemler/i);
            if (m && m[1] && m[1].trim()) return m[1].trim();
            var me = al.match(/(?:post by|post from)\s+(.+?)(?:'s)?$/i); if (me && me[1]) return me[1].trim();
        } catch (e) {}
        return '';
    }
    // POST LINKI (katmanli): (1) post SAYFASINDAYSA location permalink; (2) kartta GERCEK post permalink
    // <a> (yol: /{x}/posts|videos/, /reel/, /permalink/, /groups/{g}/posts|permalink/); (3) FEED yedegi:
    // yazar adiyla eslesen profil/grup-uye linki (gercek https kaynak); (4) sentetik (dedup icin).
    // ⚠Feed'de temiz permalink <a> YOK (FB JS-nav + __cft__ query-token) -> cogu feed gönderide (3) girer.
    function _xFbPostLink(card, eylemBtn, yazar) {
        function temiz(h) {
            try {
                if (!h) return ''; var abs = String(h).replace(/^https?:\/\/[^/]+/i, '');
                var yol = abs.split('?')[0].split('#')[0]; if (!yol || yol === '/') return '';
                if (/^\/profile\.php$/i.test(yol)) { var mi = abs.match(/[?&](id=\d+)/i); return 'https://www.facebook.com/profile.php' + (mi ? '?' + mi[1] : ''); }   // profil ?id= KORU
                return 'https://www.facebook.com' + yol;
            } catch (e) { return ''; }
        }
        try {   // 1) Post sayfasi (permalink URL'de)
            var lp = location.pathname || '';
            if (/\/(?:posts|permalink|videos|reel)\/[^/]/i.test(lp) || /\/groups\/[^/]+\/(?:posts|permalink)\//i.test(lp) || /\/watch\//i.test(lp)) {
                return location.href.split('#')[0];
            }
        } catch (e) {}
        try {   // 2) Kartta GERCEK post permalink <a> (coklu format). ⚠FEED'de temiz /posts/ permalinki her
            //    zaman YOK; ama cogu feed postu (foto/link-share/video) icin /photo/?fbid veya /watch?v GERCEK
            //    paylasilabilir post linki verir (canli dogrulandi: /photo/?fbid postu+etkilesimi aciyor).
            //    TEMIZ yol-permalink tercih; yoksa FOTO permalinki yedek. __cft__ tracking ATILIR, fbid/set/v/
            //    story_fbid/id KORUNUR. ⚠/stories/{pageId}/{id} = hikaye-goruntuleyici (post DEGIL) -> HARIC.
            var as = card ? card.querySelectorAll('a[href]') : [];
            var _foto = null;
            for (var i = 0; i < as.length; i++) {
                var raw = as[i].getAttribute('href') || '';
                var abs = raw.replace(/^https?:\/\/[^/]+/i, '');
                var yol = abs.split('?')[0].split('#')[0];
                var qs = (abs.indexOf('?') >= 0) ? abs.slice(abs.indexOf('?') + 1).split('#')[0] : '';
                // 2a) TEMIZ yol-permalink: /{slug}/posts|videos/{id}, /reel/{id}, /permalink/{id}, /groups/{g}/posts|permalink/{id}
                if (/^\/(?:[^/?#]+\/(?:posts|videos)\/[^/?#]|reel\/[^/?#]|permalink\/[^/?#]|groups\/[^/?#]+\/(?:posts|permalink)\/[^/?#])/i.test(yol)) {
                    return 'https://www.facebook.com' + yol;
                }
                // 2b) permalink.php / story.php: story_fbid(+id) KORU
                if (/^\/(?:permalink|story)\.php$/i.test(yol) && /(?:^|&)story_fbid=\d/i.test(qs)) {
                    var _kp = []; qs.split('&').forEach(function (p) { if (/^(?:story_fbid|id)=\d/i.test(p)) _kp.push(p); });
                    if (_kp.length) return 'https://www.facebook.com' + yol + '?' + _kp.join('&');
                }
                // 2c) watch: v KORU
                if (/^\/watch\/?$/i.test(yol)) { var _vm = qs.match(/(?:^|&)(v=\d+)/i); if (_vm) return 'https://www.facebook.com/watch/?' + _vm[1]; }
                // 2d) FOTO: fbid(+set) KORU -> YEDEK (temiz permalink yoksa). Cogu feed postunda var; gercek post linki.
                if (!_foto && /^\/photo(?:\.php)?\/?$/i.test(yol) && /(?:^|&)fbid=\d/i.test(qs)) {
                    var _kp2 = []; qs.split('&').forEach(function (p) { if (/^(?:fbid|set)=/i.test(p)) _kp2.push(p); });
                    if (_kp2.length) _foto = 'https://www.facebook.com/photo/?' + _kp2.join('&');
                }
            }
            if (_foto) return _foto;
        } catch (e) {}
        try {   // 3) Feed yedegi: yazar adiyla eslesen profil/grup-uye linki (gercek https)
            if (yazar && card) {
                var as2 = card.querySelectorAll('a[href]');
                for (var j = 0; j < as2.length; j++) {
                    var tx = (as2[j].innerText || '').replace(/\s+/g, ' ').trim();
                    if (tx && tx === yazar) { var t2 = temiz(as2[j].getAttribute('href')); if (t2) return t2; }
                }
            }
        } catch (e) {}
        // 4) Sentetik (gorsel anahtari + dedup icin benzersiz)
        var hbase = (yazar || '') + '|';
        try { hbase += (card.innerText || card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220); } catch (e) { hbase += (location.pathname || 'fb'); }
        return 'xmanual://fb-' + _xFbHash(hbase);
    }
    function _xFbDurum(btn, renk, mesaj, ikonTur) {
        try {
            btn.classList.remove('x-gx-ok', 'x-gx-warn');
            if (renk === 'ok') btn.classList.add('x-gx-ok');
            else if (renk === 'warn') btn.classList.add('x-gx-warn');
            var ic = btn.querySelector('.x-gx-fb-ic');
            if (ic) { while (ic.firstChild) ic.removeChild(ic.firstChild); ic.appendChild(_xGxSsIkon(ikonTur || 'ekle')); }
            if (btn.__tip && typeof mesaj === 'string') btn.__tip.textContent = mesaj;
        } catch (e) {}
    }
    function _xFbDurumBitir(btn, renk, mesaj, sure, ikonTur) {
        _xFbDurum(btn, renk, mesaj, ikonTur || 'ekle');
        setTimeout(function () { btn.__busy = false; _xFbDurum(btn, null, "GörüntüX Raporu'na ekle", 'ekle'); }, sure || 1800);
    }
    // ⋯ (gönderi eylemleri) butonunun 36x36 sarmalayicisini + onun basligini (dogrudan ebeveyn
    // flex satir) bul. Climb: n KUCUK (<80px) + ebeveyni GENIS (>260px, baslik satiri) -> {header, before}.
    function _xFbEkleNoktasi(eylemBtn) {
        try {
            var n = eylemBtn, guard = 0;
            while (n && n.parentElement && guard < 10) {
                var nr = n.getBoundingClientRect(), pr = n.parentElement.getBoundingClientRect();
                if (pr.width > 260 && nr.width > 0 && nr.width < 80) return { header: n.parentElement, before: n };
                n = n.parentElement; guard++;
            }
        } catch (e) {}
        return null;
    }
    // GORUNUR ⋯ (gönderi icin eylemler) butonlari (gizli 0x0 ikizleri ele).
    function _xFbEylemBtnlar() {
        var sel = '[aria-label*="gönderisi için eylemler" i], [aria-label*="actions for this post" i], [aria-label*="options for this post" i]';
        var out = [];
        try {
            document.querySelectorAll(sel).forEach(function (el) {
                try { var r = el.getBoundingClientRect(); if (r.width >= 16 && r.height >= 16) out.push(el); } catch (e) {}
            });
        } catch (e) {}
        return out;
    }
    // ⋯ butonundan gönderi KARTINI tirman: begen/yorum/paylas ortak atasi olan yeterince buyuk kap.
    function _xFbKartBul(eylemBtn) {
        try {
            var n = eylemBtn, guard = 0;
            while (n && guard < 28) {
                var r = n.getBoundingClientRect();
                // İLK (en kucuk) etkilesim-iceren post-boyutlu ata = TEK gönderi (climb en-ustte durur).
                // ⚠esik 80 (240 DEGIL): kisa METIN postlari 240'in altinda kalinca climb tek-postu ATLAYIP
                // SONRAKI postu da kapsayan kaba tasiyordu (kullanici: ustteki posta tikladim, alttaki reklam
                // da kadraja girdi). ⋯'ten tirmanip ILK eng-iceren ata zaten o tek postun sarmalayicisi.
                if (r.height > 80 && r.width > 300 && n.querySelector(FB_ENG_SEL)) return n;
                n = n.parentElement; guard++;
            }
        } catch (e) {}
        try {   // Fallback: eylem butonunun yeterince buyuk en yakin atasi
            var m = eylemBtn, g2 = 0;
            while (m && g2 < 28) { var rr = m.getBoundingClientRect(); if (rr.height > 120 && rr.width > 300) return m; m = m.parentElement; g2++; }
        } catch (e) {}
        return null;
    }
    function xFbButonKur() {
        try {
            if (xPlatform() !== 'fb') return;
            if (window.__xGxCaptureAktif) return;   // yakalama sirasinda DOM'a dokunma
            xGxFbStilEkle();
            var btns = _xFbEylemBtnlar();
            for (var i = 0; i < btns.length; i++) {
                var nokta = _xFbEkleNoktasi(btns[i]);
                if (!nokta) continue;
                if (nokta.header.querySelector('.x-gx-fb-btn')) continue;   // bu baslikta zaten var
                var btn = document.createElement('div');
                btn.className = 'x-gx-fb-btn x-gx-ssbtn'; btn.setAttribute('role', 'button'); btn.setAttribute('tabindex', '0');
                btn.setAttribute('aria-label', 'GörüntüX Raporu\'na ekle');
                var ic = document.createElement('span'); ic.className = 'x-gx-fb-ic'; ic.appendChild(_xGxSsIkon('ekle'));
                var tip = document.createElement('span'); tip.className = 'x-gx-fb-tip'; tip.textContent = "GörüntüX Raporu'na ekle";   // ⚠ INLINE literal (var timing BOS verebilir)
                btn.appendChild(ic); btn.appendChild(tip); btn.__tip = tip;
                (function (b, anchor) { b.addEventListener('click', function (ev) { try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {} xFbButonTikla(b, anchor); }); })(btn, btns[i]);
                nokta.header.insertBefore(btn, nokta.before);
            }
            try { _xFbReelButonKur(); } catch (e) {}   // REEL sayfasi: sag aksiyon kolonuna buton
        } catch (e) {}
    }
    // Tik: tiklanan ⋯'in gönderi kartini coz -> __xFbHedefPost -> xFbIdleYakala -> pano -> addToPool.
    async function xFbButonTikla(btn, eylemBtn) {
        if (!btn || btn.__busy) return;
        btn.__busy = true;
        _xFbDurum(btn, null, 'Yakalanıyor…', 'ekle');
        var card = null; try { card = _xFbKartBul(eylemBtn); } catch (e) {}
        if (!card) { _xFbDurumBitir(btn, 'warn', 'Kart bulunamadı — tekrar deneyin', 2600); return; }
        // [POST SAYFASI MODAL] Link'le acilan FB post MODAL'da acilir; MODAL'in ICINDE gercek (descendant)
        // scroller var -> fbFindPost dialog-tespiti kap=MODAL verince scIc=true ve scroll-stitch CALISIR.
        // Ama __xFbHedefPost = IC kart verirsek fbScroller ANCESTOR scroller bulur -> scIc=card.contains(sc)=FALSE
        // -> window-scroll yolu (modali kaydirmaz) -> kart KESIK kalir (kullanici: link'le acilan postta scroll
        // sorunu suruyor). Cozum: ⋯ GORUNUR bir modal/dialog icindeyse __xFbHedefPost BIRAKMA (null) -> fbFindPost
        // KENDI modal yolunu kullansin (kap=modal, scIc=true). Feed'de modal YOK -> kart (window-scroll-stitch).
        var _modalIci = false;
        try { var _md = eylemBtn && eylemBtn.closest('[aria-modal="true"], [role="dialog"]'); if (_md) { var _mr = _md.getBoundingClientRect(); _modalIci = (_mr.width > 100 && _mr.height > 100); } } catch (e) {}
        var yazarAria = _xFbYazarAria(eylemBtn);   // ANASAYFADA fbAuthor BOS doner -> ⋯ aria'dan yazar
        var link = _xFbPostLink(card, eylemBtn, yazarAria);
        var pano = null; try { pano = xPanoHazirla(link); } catch (e) {}
        var origin = 'https://goruntux.rgmedya.tr';
        try { origin = await new Promise(function (r) { chrome.storage.local.get({ server_origin: 'https://goruntux.rgmedya.tr' }, function (x) { r((x && x.server_origin) || 'https://goruntux.rgmedya.tr'); }); }); } catch (e) {}
        var _fbRes = null;
        try {
            window.__xGxCaptureAktif = true;   // tum pollerlari duraklat (hassas scroll/stitch sirasinda DOM'a dokunulmasin)
            window.__xFbHedefPost = _modalIci ? null : card;   // MODAL -> null (fbFindPost kap=modal, scIc scroll-stitch); feed -> kart (window-scroll)
            try { _fbRes = await xFbIdleYakala(); }
            finally { window.__xFbHedefPost = null; window.__xGxCaptureAktif = false; }
        } catch (e) { printLog('FB buton yakalama hatasi: ' + ((e && e.message) || e)); }
        if (!_fbRes || !_fbRes.shot || _fbRes.shot.length < 100) {
            if (pano) { try { pano.iptal(); } catch (e) {} }
            _xFbDurumBitir(btn, 'warn', 'Yakalanamadı — tekrar deneyin', 2600); return;
        }
        var _panoOk = false; if (pano) { try { _panoOk = await pano.gorseliVer(_fbRes.shot); } catch (e) {} }
        try {
            chrome.runtime.sendMessage({
                action: 'addToPool', origin: origin, title: _fbRes.author || yazarAria || 'Facebook Gönderisi', link: link, image: _fbRes.shot, is_profile: false, group_override: ''
            }, function (addRes) {
                if (addRes && addRes.status === 'success') { _xFbDurumBitir(btn, 'ok', _panoOk ? 'Eklendi · Panoda' : 'Rapora eklendi', 1800, 'ok'); }
                else if (addRes && addRes.status === 'duplicate') { _xFbDurumBitir(btn, 'warn', 'Zaten havuzda', 2000); }
                else { _xFbDurumBitir(btn, 'warn', 'Eklenemedi' + (addRes && addRes.message ? (': ' + addRes.message) : ''), 3000); }
            });
        } catch (e) {
            if (pano) { try { pano.iptal(); } catch (x) {} }
            _xFbDurumBitir(btn, 'warn', 'Bağlantı koptu — F5 yapın', 3200);
        }
    }
    // ============================================================================
    // [FB REEL BUTON] facebook.com/reel/{id} sayfasinin sag dikey aksiyon kolonuna
    // (Begen/Yorum/Paylas/⋯) GoruntuX butonu enjekte et. Reel ⋯ aria'si "Diğer seçenekler"
    // (feed'deki "gönderisi için eylemler" DEGIL) -> _xFbEylemBtnlar MATCH ETMEZ -> ayri yol.
    // Yakalama Dock ile BIREBIR: xFbIdleYakala reel modu (URL /reel/ -> _isReel), __xFbHedefPost
    // SET EDILMEZ (reel sayfasinda tek reel -> fbFindPost kendi reel tespitini yapar). Link = sayfa
    // permalink'i (/reel/{id}), baslik = reel yazari (fbAuthor reel dali -> "Sahibin Profilini Gör").
    // ============================================================================
    function _xFbReelStackBul() {
        try {
            // Reel ⋯ ("Diğer seçenekler"): sag yarida, gorunur. (More options = EN yedegi.)
            var ell = null;
            var cand = document.querySelectorAll('[aria-label*="Diğer seçenekler" i], [aria-label*="More options" i]');
            for (var i = 0; i < cand.length; i++) {
                var r = cand[i].getBoundingClientRect();
                if (r.width >= 20 && r.height >= 20 && r.left > window.innerWidth * 0.55 && r.top > 0 && r.top < window.innerHeight) { ell = cand[i]; break; }
            }
            if (!ell) return null;
            // ⋯'ten tirman: ilk >=3-cocuklu, dar (<=90px) + uzun (>120px) DIKEY-KOLON ata = aksiyon yigini.
            var n = ell, g = 0;
            while (n && g < 9) {
                try {
                    var cs = getComputedStyle(n), rr = n.getBoundingClientRect();
                    if (n.children.length >= 3 && cs.display === 'flex' && cs.flexDirection === 'column' && rr.width <= 90 && rr.height > 120) return n;
                } catch (x) {}
                n = n.parentElement; g++;
            }
        } catch (e) {}
        return null;
    }
    function _xFbReelButonKur() {
        try {
            if (xPlatform() !== 'fb') return;
            if (location.pathname.indexOf('/reel/') !== 0) return;   // YALNIZ reel sayfasi
            if (window.__xGxCaptureAktif) return;
            xGxFbStilEkle();
            var stack = _xFbReelStackBul();
            if (!stack) return;
            if (stack.querySelector('.x-gx-fb-reel')) return;        // zaten var
            var btn = document.createElement('div');
            btn.className = 'x-gx-fb-btn x-gx-fb-reel x-gx-ssbtn'; btn.setAttribute('role', 'button'); btn.setAttribute('tabindex', '0');
            btn.setAttribute('aria-label', "Reel'i GörüntüX Raporu'na ekle");
            var ic = document.createElement('span'); ic.className = 'x-gx-fb-ic'; ic.appendChild(_xGxSsIkon('ekle'));
            var tip = document.createElement('span'); tip.className = 'x-gx-fb-tip'; tip.textContent = "GörüntüX Raporu'na ekle";   // ⚠ INLINE literal
            btn.appendChild(ic); btn.appendChild(tip); btn.__tip = tip;
            btn.addEventListener('click', function (ev) { try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {} xFbReelButonTikla(btn); });
            stack.insertBefore(btn, stack.firstChild);               // Begen'in USTUNE (kolon ilk cocuk)
        } catch (e) {}
    }
    // Tik: reel modu yakalama (Dock ile ayni) -> pano -> addToPool. __xFbHedefPost SET ETME.
    async function xFbReelButonTikla(btn) {
        if (!btn || btn.__busy) return;
        btn.__busy = true;
        _xFbDurum(btn, null, 'Yakalanıyor…', 'ekle');
        var link = ''; try { link = (location.href || '').split('#')[0].split('?')[0]; } catch (e) { link = location.href || ''; }
        if (!link) link = 'https://www.facebook.com' + location.pathname;
        var pano = null; try { pano = xPanoHazirla(link); } catch (e) {}
        var origin = 'https://goruntux.rgmedya.tr';
        try { origin = await new Promise(function (r) { chrome.storage.local.get({ server_origin: 'https://goruntux.rgmedya.tr' }, function (x) { r((x && x.server_origin) || 'https://goruntux.rgmedya.tr'); }); }); } catch (e) {}
        var _fbRes = null;
        try {
            window.__xGxCaptureAktif = true;
            window.__xFbHedefPost = null;   // reel: fbFindPost KENDI reel tespiti (tek reel; Dock gibi)
            try { _fbRes = await xFbIdleYakala(); }
            finally { window.__xFbHedefPost = null; window.__xGxCaptureAktif = false; }
        } catch (e) { printLog('FB reel yakalama hatasi: ' + ((e && e.message) || e)); }
        if (!_fbRes || !_fbRes.shot || _fbRes.shot.length < 100) {
            if (pano) { try { pano.iptal(); } catch (e) {} }
            _xFbDurumBitir(btn, 'warn', 'Yakalanamadı — tekrar deneyin', 2600); return;
        }
        var _panoOk = false; if (pano) { try { _panoOk = await pano.gorseliVer(_fbRes.shot); } catch (e) {} }
        try {
            chrome.runtime.sendMessage({
                action: 'addToPool', origin: origin, title: _fbRes.author || 'Facebook Reel', link: link, image: _fbRes.shot, is_profile: false, group_override: ''
            }, function (addRes) {
                if (addRes && addRes.status === 'success') { _xFbDurumBitir(btn, 'ok', _panoOk ? 'Eklendi · Panoda' : 'Rapora eklendi', 1800, 'ok'); }
                else if (addRes && addRes.status === 'duplicate') { _xFbDurumBitir(btn, 'warn', 'Zaten havuzda', 2000); }
                else { _xFbDurumBitir(btn, 'warn', 'Eklenemedi' + (addRes && addRes.message ? (': ' + addRes.message) : ''), 3000); }
            });
        } catch (e) {
            if (pano) { try { pano.iptal(); } catch (x) {} }
            _xFbDurumBitir(btn, 'warn', 'Bağlantı koptu — F5 yapın', 3200);
        }
    }
    // Baslangic: yalniz Facebook'ta; stil + hemen dene + poller (SPA + feed'de yeni kartlar kaydikca).
    function xFbButonInit() {
        if (xPlatform() !== 'fb') return;
        try { xGxFbStilEkle(); } catch (e) {}
        try { xFbButonKur(); } catch (e) {}
        setInterval(function () { try { xFbButonKur(); } catch (e) {} }, 700);
    }

    // ============================================================================
    // [TIKTOK PER-POST BUTON] TikTok video sayfasında her gönderinin SAĞ AKSIYON
    // KOLONUNA (SectionActionBarContainer: avatar/beğeni/yorum/favori/paylaş/müzik;
    // FB Reels kolonuyla aynı desen) yeşil GörüntüX "+" butonu. Tık -> __xTtHedefKart
    // = tıklanan container -> xTtIdleYakala (tek-kare, captcha-dur, çerez-shadow gizle,
    // video karesi sıfırla) -> addToPool. Link = location.href (dock ile aynı; sunucu
    // kanoniklestirir). Container'da temiz video permalink <a> YOK -> link odaklı videodan.
    // ============================================================================
    function xGxTtStilEkle() {
        xGxSsStilEkle();   // ortak iç-içe daire+kare+artı ikon + hover/durum
        if (document.getElementById('x-gx-tt-style')) return;
        var s = document.createElement('style'); s.id = 'x-gx-tt-style';
        s.textContent = [
            '.x-gx-tt-btn{ box-sizing:border-box; position:relative; display:inline-flex; flex-direction:column; align-items:center;',
            '   justify-content:center; padding:4px; margin:4px 6px 2px; cursor:pointer; background:transparent;',
            '   border:none; -webkit-appearance:none; appearance:none; transition:transform .12s ease; flex:0 0 auto; }',
            '.x-gx-tt-btn:hover{ transform:scale(1.06); }',
            '.x-gx-tt-btn .x-gx-ssico{ width:40px !important; height:40px !important; }',
            '.x-gx-tt-btn .x-gx-tt-ic{ display:inline-flex; align-items:center; justify-content:center; line-height:0; }',
            '.x-gx-tt-btn .x-gx-tt-ic svg{ display:block; overflow:visible; }',
            // Rail ekranın SAĞ kenarında -> tooltip SOLA açılır (sağa taşmasın).
            '.x-gx-tt-btn .x-gx-tt-tip{ position:absolute; top:50%; right:calc(100% + 10px); left:auto; bottom:auto;',
            '   transform:translate(4px,-50%); background:rgba(15,20,25,.96); color:#fff; font-weight:600; font-size:12px;',
            '   line-height:1; white-space:nowrap; padding:6px 9px; border-radius:6px; opacity:0; pointer-events:none;',
            '   z-index:99999; box-shadow:0 2px 10px rgba(0,0,0,.3); transition:opacity .12s ease, transform .12s ease; }',
            '.x-gx-tt-btn:hover .x-gx-tt-tip{ opacity:1; transform:translate(0,-50%); }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(s);
    }
    function _xTtDurum(btn, renk, mesaj, ikonTur) {
        try {
            btn.classList.remove('x-gx-ok', 'x-gx-warn');
            if (renk === 'ok') btn.classList.add('x-gx-ok');
            else if (renk === 'warn') btn.classList.add('x-gx-warn');
            var ic = btn.querySelector('.x-gx-tt-ic');
            if (ic) { while (ic.firstChild) ic.removeChild(ic.firstChild); ic.appendChild(_xGxSsIkon(ikonTur || 'ekle')); }
            if (btn.__tip && typeof mesaj === 'string') btn.__tip.textContent = mesaj;
        } catch (e) {}
    }
    function _xTtDurumBitir(btn, renk, mesaj, sure, ikonTur) {
        _xTtDurum(btn, renk, mesaj, ikonTur || 'ekle');
        setTimeout(function () { btn.__busy = false; _xTtDurum(btn, null, "GörüntüX Raporu'na ekle", 'ekle'); }, sure || 1800);
    }
    function xTtButonKur() {
        try {
            if (xPlatform() !== 'tt') return;
            if (window.__xGxCaptureAktif) return;
            xGxTtStilEkle();
            // ⚠LAYOUT-BAĞIMSIZ (kullanıcı: feed + yorum-paneli sayfalarında buton yoktu). TikTok'un birden çok
            // düzeni var ve KART KABI değişir: video-detay overlay=recommend-list-item-container, "Sizin İçin"
            // feed=anchoring-player-column, direkt-detay=DivContentFlex, yorum-paneli=yatay satır. O yüzden
            // recommend-list-item-container'ı DEĞİL, AKSIYON GRUBUNU (like+share ortak atası = SectionActionBar;
            // dikey ray VEYA yatay satır) doğrudan hedefle. Kart = grup+video içeren en yakın ata (tık onu hedefler).
            document.querySelectorAll('[data-e2e="like-icon"], [data-e2e="browse-like-icon"]').forEach(function (like) {
                try {
                    // Aksiyon grubu = like+COMMENT ortak atası. ⚠share DEĞİL: yorum-paneli layout'unda share ayrı
                    // sosyal-ikon grubunda (like'la ortak yakın ata yok) -> share-anchor orada başarısızdı. comment
                    // HER layout'ta like'ın yanında (dikey ray / yatay satır).
                    var grup = like.parentElement, g = 0, es = null;
                    while (grup && g < 12) { es = grup.querySelector('[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"]'); if (es) break; grup = grup.parentElement; g++; }
                    if (!grup || !es) return;
                    var kart = grup, g2 = 0;
                    while (kart && g2 < 16 && !kart.querySelector('video')) { kart = kart.parentElement; g2++; }
                    if (!kart || !kart.querySelector('video')) return;
                    if (kart.querySelector('.x-gx-tt-btn')) return;   // bu kartta zaten var (ray VEYA ok-kabı fark etmez)
                    var btn = document.createElement('div');
                    btn.className = 'x-gx-tt-btn x-gx-ssbtn'; btn.setAttribute('role', 'button'); btn.setAttribute('tabindex', '0');
                    btn.setAttribute('aria-label', "Bu videoyu GörüntüX Raporu'na ekle");
                    var ic = document.createElement('span'); ic.className = 'x-gx-tt-ic'; ic.appendChild(_xGxSsIkon('ekle'));
                    var tip = document.createElement('span'); tip.className = 'x-gx-tt-tip'; tip.textContent = "GörüntüX Raporu'na ekle";   // ⚠ INLINE literal
                    btn.appendChild(ic); btn.appendChild(tip); btn.__tip = tip;
                    (function (b, k) { b.addEventListener('click', function (ev) { try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {} xTtButonTikla(b, k); }); })(btn, kart);
                    // KONUM: buton DİKEY RAYIN EN ÜSTÜNDE (kullanıcı tekrar istedi: "bu hizanın en üstünde"). İki düzen:
                    //  (a) Video-detay overlay: avatar/profil rayın tepesinde GÖRÜNÜR -> avatarın (ray-içi üst
                    //      sarmalının) ÜSTÜNE. (b) For You feed: avatar rayda gizli (0x0) + feed-navigation okları
                    //      rayın hemen üstünde aynı kolonda -> okların dikey kabına, prev'in ÜSTÜNE ("yön tuşlarının
                    //      üstünde"); yoksa çakışıp arkada kalıyordu. Ok da yoksa rayın ilk öğesinin üstüne.
                    var _tav = grup.querySelector('[data-e2e="video-author-avatar"]');
                    var _tavGor = false; try { if (_tav) { var _tr = _tav.getBoundingClientRect(); _tavGor = _tr.width > 1 && _tr.height > 1; } } catch (e) {}
                    if (_tavGor) {
                        var _tw = _tav; while (_tw && _tw.parentElement !== grup) _tw = _tw.parentElement;
                        if (_tw) grup.insertBefore(btn, _tw); else grup.insertBefore(btn, grup.firstElementChild);
                    } else {
                        // Rayın üstündeki (aynı kolon: yatay yakın + rayın tepesinin üstünde) feed-navigation-prev'i bul
                        var _gr = grup.getBoundingClientRect(), _ok = null;
                        try {
                            var _oklar = kart.querySelectorAll('[data-e2e="feed-navigation-prev"]');
                            for (var _oi = 0; _oi < _oklar.length; _oi++) { var _or = _oklar[_oi].getBoundingClientRect(); if (_or.width > 1 && Math.abs(_or.left - _gr.left) < 140 && _or.top < _gr.top + 12) { _ok = _oklar[_oi]; break; } }
                        } catch (e) {}
                        var _okKap = null;
                        if (_ok) { var _w = _ok.parentElement, _wi = 0; while (_w && _wi < 6) { if (_w.querySelector('[data-e2e="feed-navigation-next"]')) { _okKap = _w; break; } _w = _w.parentElement; _wi++; } }
                        if (_okKap) { _okKap.insertBefore(btn, _okKap.firstChild); }
                        else if (grup.firstElementChild) { grup.insertBefore(btn, grup.firstElementChild); }
                        else { grup.appendChild(btn); }
                    }
                } catch (e) {}
            });
        } catch (e) {}
    }
    // Tik: tıklanan container'ı hedefle -> xTtIdleYakala -> pano -> addToPool. Captcha sebebi kullanıcıya gösterilir.
    async function xTtButonTikla(btn, kart) {
        if (!btn || btn.__busy) return;
        btn.__busy = true;
        _xTtDurum(btn, null, 'Yakalanıyor…', 'ekle');
        var link = ''; try { link = window.location.href; } catch (e) { link = location.href; }
        var pano = null; try { pano = xPanoHazirla(link); } catch (e) {}
        var origin = 'https://goruntux.rgmedya.tr';
        try { origin = await new Promise(function (r) { chrome.storage.local.get({ server_origin: 'https://goruntux.rgmedya.tr' }, function (x) { r((x && x.server_origin) || 'https://goruntux.rgmedya.tr'); }); }); } catch (e) {}
        var _res = null, _hata = '';
        try {
            window.__xGxCaptureAktif = true;
            window.__xTtHedefKart = kart || null;
            try { _res = await xTtIdleYakala(); }
            catch (e) { _hata = (e && e.message) || ''; }
            finally { window.__xTtHedefKart = null; window.__xGxCaptureAktif = false; }
        } catch (e) { _hata = (e && e.message) || ''; }
        if (_hata) printLog('TT buton yakalama hatasi: ' + _hata);
        if (!_res || !_res.shot || _res.shot.length < 100) {
            if (pano) { try { pano.iptal(); } catch (e) {} }
            var _msg = /captcha|bulmaca/i.test(_hata) ? "Captcha çıktı — TikTok'ta çözüp tekrar dene" : 'Yakalanamadı — tekrar deneyin';
            _xTtDurumBitir(btn, 'warn', _msg, 3200); return;
        }
        var _panoOk = false; if (pano) { try { _panoOk = await pano.gorseliVer(_res.shot); } catch (e) {} }
        try {
            chrome.runtime.sendMessage({
                action: 'addToPool', origin: origin, title: _res.author || 'TikTok Gönderisi', link: link, image: _res.shot, is_profile: false, group_override: ''
            }, function (addRes) {
                if (addRes && addRes.status === 'success') { _xTtDurumBitir(btn, 'ok', _panoOk ? 'Eklendi · Panoda' : 'Rapora eklendi', 1800, 'ok'); }
                else if (addRes && addRes.status === 'duplicate') { _xTtDurumBitir(btn, 'warn', 'Zaten havuzda', 2000); }
                else { _xTtDurumBitir(btn, 'warn', 'Eklenemedi' + (addRes && addRes.message ? (': ' + addRes.message) : ''), 3000); }
            });
        } catch (e) {
            if (pano) { try { pano.iptal(); } catch (x) {} }
            _xTtDurumBitir(btn, 'warn', 'Bağlantı koptu — F5 yapın', 3200);
        }
    }
    function xTtButonInit() {
        if (xPlatform() !== 'tt') return;
        try { xGxTtStilEkle(); } catch (e) {}
        try { xTtButonKur(); } catch (e) {}
        setInterval(function () { try { xTtButonKur(); } catch (e) {} }, 700);
    }

    // AÇIK (odaklı) tweet'i bul = URL'deki /status/<id> ile KENDİ zaman-damgası (permalink) linki eşleşen
    // article. NOT: X tweet satırını [role=link] ile sarabiliyor (permalink dahil) -> [role=link] eleme HATALI;
    // <time> linkinin id'si = focusId doğru ayrım (parent/yanıt kendi id'leriyle; alıntı da kendi id'si).
    function xGxOdakliArticle() {
        try {
            var m = location.href.match(/\/status\/(\d+)/); if (!m) return null;
            var focusId = m[1];
            var arts = document.querySelectorAll('article[data-testid="tweet"]');
            for (var q = 0; q < arts.length; q++) {
                var links = arts[q].querySelectorAll('a[href*="/status/"]');
                for (var k = 0; k < links.length; k++) {
                    if (!links[k].querySelector('time')) continue;   // yalnız zaman-damgası (permalink) linkleri
                    var hm = (links[k].getAttribute('href') || '').match(/\/status\/(\d+)/);
                    if (hm && hm[1] === focusId) return arts[q];
                }
            }
        } catch (e) {}
        return null;
    }
    // Sol-nav YEŞİL "+" (Rapora Ekle) butonunun GÖRÜNÜRLÜĞÜ: yalnız /status/ + açık tweet varken,
    // yakalama/tarama dışında. (Per-tweet buton kaldırıldı; iş bu tek butona taşındı — kullanıcı isteği.)
    // Yeşil butonun MODU: 'tara' (ilerleme halkası) | 'profil' (profil sayfası: kişi ikonu + popup) |
    // 'ekle' (/status/ açık tweet: + ikonu, yakala) | null (gizli). Profil ve /status/ ayrık sayfalar.
    function xNavEkleMod() {
        try {
            var dock = document.getElementById('x-downloader-widget');
            var scanning = (window.__xGxTaramaAktif === true) || !!(dock && dock.classList.contains('scanning'));
            if (scanning) return 'tara';
            if (xGxProfilModAcik() && xGxProfilRaporAcik() && xGxProfilHandle()) return 'profil';
            if (xGxKesfetAcik() && xGxKesfetMi()) return 'ara';
            if (xGxTweetBtnAcik() && /\/status\/\d+/.test(location.href) && xGxOdakliArticle()) return 'ekle';
            // [RT VİDEO] /retweets (reposts/likes/quotes) sayfasında "+" butonu YALNIZ KAYIT SÜRERKEN görünür
            // (o zaman xNavYansit videomod+rt-silik ile SİLİK KIRMIZI). Kayıt yokken (normal açılış) HİÇ görünmez
            // (kullanıcı: silik yeşil/kırmızı bile olmasın, yalnız kayıt için açılınca silik kırmızı).
            if (xGxTweetBtnAcik() && window.__xVideoKayitAktif && /\/status\/\d+\/(retweets|reposts|likes|quotes)/i.test(location.pathname)) return 'ekle';
        } catch (e) {}
        return null;
    }
    function xNavEkleIkonKur(el, mod) {
        try {
            if (!el) return;
            try { xGxSsStilEkle(); } catch (e) {}   // paylasilan nested-ikon CSS (hover/durum) X'te de enjekte olsun
            el.classList.remove('x-gx-ok', 'x-gx-warn');
            var ic = el.querySelector('.x-gx-tw-ic');
            // IKON = ortak nested tasarim (IG/YT ile AYNI): yesil outline daire + mod ici
            // (ekle=cerceve+arti, profil=kisi, ara=arama). DOM-API (_xGxSsIkon) -> undefined
            // tuzagi YOK (fonksiyon hoist'li, hep tanimli; degisken-string referansi degil).
            var tur = (mod === 'profil') ? 'profil' : (mod === 'ara') ? 'ara' : 'ekle';
            if (ic) { while (ic.firstChild) ic.removeChild(ic.firstChild); ic.appendChild(_xGxSsIkon(tur)); }
            if (el.__tip) el.__tip.textContent = (mod === 'profil') ? "Bu profilin GörüntüX Raporu'nu oluştur!"
                : (mod === 'ara') ? "Gelişmiş arama" : "Bu paylaşımı GörüntüX Raporu'na ekle!";
            el.__mod = (mod === 'profil' || mod === 'ara') ? mod : 'ekle';
        } catch (e) {}
    }
    function xNavEkleGuncelle() {
        try {
            var el = document.getElementById('x-gx-nav-ekle'); if (!el) return;
            var mod = xNavEkleMod();
            el.classList.toggle('aktif', !!mod);
            // İkonu YALNIZ mod değişince kur (150ms poll her turda ikonu/geri-bildirimi ezmesin, meşgulken dokunma).
            var ikonMod = (mod === 'profil' || mod === 'ara') ? mod : 'ekle';
            if (mod && mod !== 'tara' && !el.__busy && el.__mod !== ikonMod) xNavEkleIkonKur(el, ikonMod);
        } catch (e) {}
    }
    function xNavEkleSifirla(el) {
        try { xNavEkleIkonKur(el, (el && (el.__mod === 'profil' || el.__mod === 'ara')) ? el.__mod : 'ekle'); } catch (e) {}
    }
    async function xNavEkleTikla(el) {
        if (!el || el.__busy) return;
        // Tarama sürerken yeşil ikon = ilerleme halkası; tık YAPMAZ.
        var _dk = document.getElementById('x-downloader-widget');
        if (window.__xGxTaramaAktif === true || (_dk && _dk.classList.contains('scanning'))) return;
        var mod = xNavEkleMod();
        if (mod === 'profil') {   // profil sayfası: TEK popup (#x-gx-card) 'secim' modunda aç (toggle)
            if (document.getElementById('x-gx-ov')) { xProfilPopupKapat(); return; }
            var h = xGxProfilHandle(); if (h) xProfilPopupAc(h, { mod: 'secim' });
            return;
        }
        if (mod === 'ara') {   // Keşfet: gelişmiş arama popup'ı (toggle)
            if (document.getElementById('x-gx-ov')) { xProfilPopupKapat(); return; }
            xAramaPopupAc();
            return;
        }
        // ---- EKLE modu: /status/ açık tweet yakala (mevcut) ----
        var art = xGxOdakliArticle();
        if (!art) { xTweetBtnDurum(el, 'x-gx-warn', 'Açık tweet yok'); setTimeout(function () { xNavEkleSifirla(el); }, 2200); return; }
        el.__busy = true;
        // Pano yazımı TIKLAMA anında başlamalı (user-activation tuzağı; görsel sözle sonra doldurulur).
        var pano = null; try { pano = xPanoHazirla(); } catch (e) {}
        try { await xTweetYakalaEkle(art, el, pano); } catch (e) { try { if (pano) pano.iptal(); } catch (x) {} }   // yakala + pano + addToPool + feedback (çoklu-seçim dahil)
        el.__busy = false;
        setTimeout(function () { xNavEkleSifirla(el); }, 2800);
    }
    // (Eski ayrı seçim popup'ı xProfilSecimPopupAc KALDIRILDI — seçim artık #x-gx-card 'secim' modunda,
    //  rapor/takvim ile TEK popup; yeşil buton xNavEkleTikla → xProfilPopupAc(handle,{mod:'secim'}).)
    // Profil KARTI tek-yakalama (popup seçenek 1): en üste kaydır, profil kartını yakala, rapora ekle + panoya.
    async function xProfilKartYakala(el) {
        if (!el || el.__busy) return;
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var _cap = window.__xGxCap;
        if (typeof _cap !== 'function') { xTweetBtnDurum(el, 'x-gx-warn', 'Hazır değil — F5 yapın'); setTimeout(function () { xNavEkleSifirla(el); }, 2200); return; }
        var handle = xGxProfilHandle() || '';
        el.__busy = true;
        var pano = null; try { pano = xPanoHazirla(); } catch (e) {}
        var origin = ''; try { origin = await new Promise(function (r) { chrome.storage.local.get({ server_origin: 'https://goruntux.rgmedya.tr' }, function (x) { r(x.server_origin || 'https://goruntux.rgmedya.tr'); }); }); } catch (e) {}
        if (el.__tip) el.__tip.textContent = 'Yakalanıyor…'; try { xNavTipGoster(el, 4000); } catch (e) {}
        try {
            window.scrollTo(0, 0); await sleep(600);
            var pc = document.querySelector('[data-testid="primaryColumn"]');
            if (!pc) throw new Error('profil kartı bulunamadı');
            var _t = (document.title || '').replace(/^\(\d+\)\s*/, ''); var _m = _t.match(/^(.+?)\s*\(@[^)]+\)/); var _ad = (_m && _m[1]) ? _m[1].trim() : '';
            var pb = _ad ? (_ad + ' (@' + handle + ')') : ('@' + handle);
            pc.scrollIntoView({ block: 'start', behavior: 'instant' }); await sleep(420);
            var ss = await _cap(pc) || '';
            if (!ss || ss.length < 100) throw new Error('yakalanamadı');
            var panoOk = false; try { if (pano) panoOk = await pano.gorseliVer(ss); } catch (e) {}
            var res = await new Promise(function (r) { try { chrome.runtime.sendMessage({ action: 'addToPool', origin: origin, title: pb, link: 'https://x.com/' + handle, image: ss, is_profile: true, group_override: '' }, function (x) { r(x || {}); }); } catch (e) { r({ status: 'error' }); } });
            if (res && res.status === 'success') xTweetBtnDurum(el, 'x-gx-ok', panoOk ? 'Profil kartı eklendi · 📋 Panoda' : 'Profil kartı eklendi ✔');
            else if (res && res.status === 'duplicate') xTweetBtnDurum(el, 'x-gx-warn', panoOk ? 'Zaten havuzda · 📋 Panoda' : 'Zaten havuzda');
            else xTweetBtnDurum(el, 'x-gx-warn', 'Eklenemedi');
        } catch (e) { try { if (pano) pano.iptal(); } catch (x) {} xTweetBtnDurum(el, 'x-gx-warn', 'Yakalanamadı'); printLog('[GX Profil Kart] hata: ' + (e && e.message)); }
        el.__busy = false;
        setTimeout(function () { xNavEkleSifirla(el); }, 2800);
    }
    // ====================== KEŞFET: GELİŞMİŞ ARAMA POPUP'ı (yeşil arama ikonu) ======================
    // Alanlar operatörlerle query'ye kurulur ve X arama inputuna (SearchBox_Search_Input) CANLI yazılır
    // (native setter + input event; React ezmez — canlı doğrulandı). Popup = profil popup'ı (#x-gx-card) teması.
    function xAramaXYaz(q) {
        try {
            var input = document.querySelector('input[data-testid="SearchBox_Search_Input"]');
            if (!input) return false;
            var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(input, q);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        } catch (e) { return false; }
    }
    function xAramaQueryKur(yaz) {
        try {
            var card = document.getElementById('x-gx-card'); if (!card) return '';
            var g = function (id) { var e = card.querySelector('#' + id); return e ? String(e.value || '').trim() : ''; };
            var kel = function (s) { return s.split(/\s+/).filter(Boolean); };
            var p = [];
            var tumu = g('ara-tumu'); if (tumu) p.push(tumu);
            var tam = g('ara-tam'); if (tam) p.push('"' + tam.replace(/"/g, '') + '"');
            var herh = kel(g('ara-herhangi')); if (herh.length) p.push('(' + herh.join(' OR ') + ')');
            kel(g('ara-hicbiri')).forEach(function (w) { p.push('-' + w.replace(/^-/, '')); });
            kel(g('ara-etiket')).forEach(function (h) { p.push(h.charAt(0) === '#' ? h : '#' + h); });
            var from = g('ara-from'); if (from) p.push('from:' + from.replace(/^@/, ''));
            var to = g('ara-to'); if (to) p.push('to:' + to.replace(/^@/, ''));
            kel(g('ara-mention')).forEach(function (m) { p.push(m.charAt(0) === '@' ? m : '@' + m); });
            var since = g('ara-since'); if (since) p.push('since:' + since);
            var until = g('ara-until'); if (until) p.push('until:' + until);
            var yanit = g('ara-yanit'); if (yanit === 'only') p.push('filter:replies'); else if (yanit === 'exclude') p.push('-filter:replies');
            var link = g('ara-link'); if (link === 'only') p.push('filter:links'); else if (link === 'exclude') p.push('-filter:links');
            var mr = g('ara-minrep'); if (mr) p.push('min_replies:' + mr);
            var mf = g('ara-minfav'); if (mf) p.push('min_faves:' + mf);
            var mt = g('ara-minrt'); if (mt) p.push('min_retweets:' + mt);
            var dil = g('ara-dil'); if (dil) p.push('lang:' + dil);
            var q = p.join(' ');
            var prev = card.querySelector('#x-gx-ara-prev'); if (prev) prev.textContent = q || '—';
            if (yaz) xAramaXYaz(q);
            return q;
        } catch (e) { return ''; }
    }
    // REVERSE-SYNC: X arama inputundaki query'yi ayrıştırıp popup alanlarına doldur (query kurucunun TERSİ).
    function xAramaQueryAyristir(q) {
        try {
            var card = document.getElementById('x-gx-card'); if (!card) return;
            var set = function (id, v) { var e = card.querySelector('#' + id); if (e) e.value = v; };
            var tumu = [], hicbiri = [], etiket = [], mention = [], tam = '', herhangi = '', dil = '', since = '', until = '', from = '', to = '', yanit = '', link = '', minrep = '', minfav = '', minrt = '';
            var tokens = String(q || '').match(/"[^"]*"|\([^)]*\)|\S+/g) || [];
            tokens.forEach(function (t) {
                var m;
                if (t.charAt(0) === '"') { tam = t.replace(/^"|"$/g, ''); return; }
                if (t.charAt(0) === '(') { herhangi = t.replace(/^\(|\)$/g, '').split(/\s+OR\s+/i).filter(Boolean).join(' '); return; }
                if (/^-?filter:replies$/i.test(t)) { yanit = t.charAt(0) === '-' ? 'exclude' : 'only'; return; }
                if (/^-?filter:links$/i.test(t)) { link = t.charAt(0) === '-' ? 'exclude' : 'only'; return; }
                if ((m = t.match(/^since:(\S+)$/i))) { since = m[1]; return; }
                if ((m = t.match(/^until:(\S+)$/i))) { until = m[1]; return; }
                if ((m = t.match(/^lang:(\S+)$/i))) { dil = m[1]; return; }
                if ((m = t.match(/^from:(\S+)$/i))) { from = m[1]; return; }
                if ((m = t.match(/^to:(\S+)$/i))) { to = m[1]; return; }
                if ((m = t.match(/^min_replies:(\d+)$/i))) { minrep = m[1]; return; }
                if ((m = t.match(/^min_faves:(\d+)$/i))) { minfav = m[1]; return; }
                if ((m = t.match(/^min_retweets:(\d+)$/i))) { minrt = m[1]; return; }
                if (t.charAt(0) === '#') { etiket.push(t); return; }
                if (t.charAt(0) === '@') { mention.push(t); return; }
                if (t.charAt(0) === '-' && t.length > 1) { hicbiri.push(t.slice(1)); return; }
                tumu.push(t);
            });
            set('ara-tumu', tumu.join(' ')); set('ara-tam', tam); set('ara-herhangi', herhangi);
            set('ara-hicbiri', hicbiri.join(' ')); set('ara-etiket', etiket.join(' ')); set('ara-mention', mention.join(' '));
            set('ara-from', from); set('ara-to', to); set('ara-since', since); set('ara-until', until);
            set('ara-minrep', minrep); set('ara-minfav', minfav); set('ara-minrt', minrt);
            var _ds = card.querySelector('#ara-dil'); if (_ds) { _ds.value = dil; if (_ds.value !== dil) _ds.value = ''; }   // listede yoksa Herhangi
            var _ys = card.querySelector('#ara-yanit'); if (_ys) _ys.value = yanit;
            var _ls = card.querySelector('#ara-link'); if (_ls) _ls.value = link;
            // Dolu alanı olan akordiyonları aç (kullanıcı aktif filtreleri görsün).
            card.querySelectorAll('.x-gx-akor').forEach(function (a) {
                var dolu = false;
                a.querySelectorAll('input').forEach(function (i) { if (i.value) dolu = true; });
                a.querySelectorAll('select').forEach(function (s) { if (s.value) dolu = true; });
                if (dolu) a.classList.add('acik');
            });
        } catch (e) {}
    }
    function xAramaPopupAc() {
        if (window.__xGxCaptureAktif) return;
        xGxPopupStilEkle();
        xProfilPopupKapat();   // açık #x-gx-ov varsa kapat
        var ov = document.createElement('div'); ov.id = 'x-gx-ov';
        var card = document.createElement('div'); card.id = 'x-gx-card'; card.className = 'x-gx-ara-card';
        ov.appendChild(card); document.body.appendChild(ov);
        var logo = '<span class="x-gx-ara-logo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path></svg></span>';
        var diller = [['', 'Herhangi'], ['tr', 'Türkçe'], ['en', 'English'], ['ar', 'Arabic'], ['de', 'German'], ['es', 'Spanish'], ['fr', 'French'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['fa', 'Persian'], ['nl', 'Dutch'], ['pl', 'Polish'], ['uk', 'Ukrainian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese']];
        var dilOpt = diller.map(function (d) { return '<option value="' + d[0] + '">' + d[1] + '</option>'; }).join('');
        var akor = function (baslik, acik, govde) {
            return '<div class="x-gx-akor' + (acik ? ' acik' : '') + '"><button type="button" class="x-gx-akor-h">' + baslik + '<span class="x-gx-akor-ch">▾</span></button><div class="x-gx-akor-b">' + govde + '</div></div>';
        };
        card.innerHTML = '<h3>' + logo + ' Gelişmiş Arama</h3><p class="x-gx-sub">Alanları doldur → X arama kutusuna otomatik yazılır</p>'
            + '<div class="x-gx-prev-h">X aramasına yazılan:</div><div class="x-gx-prev" id="x-gx-ara-prev">—</div>'   // ÜSTTE (kullanıcı isteği)
            + akor('Kelimeler', true,
                '<input id="ara-tumu" placeholder="Bu kelimelerin tümü">'
                + '<input id="ara-tam" placeholder="Tam olarak bu ifade" style="margin-top:7px">'
                + '<input id="ara-herhangi" placeholder="Herhangi biri (a b c)" style="margin-top:7px">'
                + '<button type="button" class="x-gx-dahafazla" id="x-gx-kelime-toggle"><span class="t">+ Daha fazla seçenek</span></button>'
                + '<div class="x-gx-ekstra" id="x-gx-kelime-ekstra"><input id="ara-hicbiri" placeholder="Hiçbiri (istenmeyen)"><input id="ara-etiket" placeholder="Etiketler (#konu)"><label>Dil</label><select id="ara-dil">' + dilOpt + '</select></div>')
            + akor('Tarihler', true,
                '<div class="x-gx-ikili"><div><label>Kaçtan</label><input type="date" id="ara-since"></div><div><label>Kaça</label><input type="date" id="ara-until"></div></div>')
            + akor('Hesaplar', false,
                '<div class="x-gx-ikili"><div><label>Kimden</label><input id="ara-from" placeholder="@kullanıcı"></div><div><label>Kime</label><input id="ara-to" placeholder="@kullanıcı"></div></div>'
                + '<label>Bahseden</label><input id="ara-mention" placeholder="@kullanıcı">')
            + akor('Filtreler ve Etkileşim', false,
                '<div class="x-gx-ikili"><div><label>Yanıtlar</label><select id="ara-yanit"><option value="">Hepsi</option><option value="only">Yalnız yanıt</option><option value="exclude">Yanıt hariç</option></select></div>'
                + '<div><label>Bağlantılar</label><select id="ara-link"><option value="">Hepsi</option><option value="only">Yalnız linkli</option><option value="exclude">Link hariç</option></select></div></div>'
                + '<div class="x-gx-uclu"><div><label>Min yanıt</label><input type="number" id="ara-minrep" min="0" placeholder="0"></div><div><label>Min beğeni</label><input type="number" id="ara-minfav" min="0" placeholder="0"></div><div><label>Min RT</label><input type="number" id="ara-minrt" min="0" placeholder="0"></div></div>')
            + '<div class="x-gx-ara-act"><button type="button" class="x-gx-ghost" id="x-gx-ara-temizle">Temizle</button><button type="button" class="x-gx-primary" id="x-gx-ara-ara">Ara</button></div>';
        card.querySelectorAll('.x-gx-akor-h').forEach(function (h) { h.addEventListener('click', function () { h.parentElement.classList.toggle('acik'); try { xGxPopoverKonumla(); } catch (e) {} try { if (card.__sbGuncelle) card.__sbGuncelle(); } catch (e) {} }); });
        card.querySelectorAll('input, select').forEach(function (f) { f.addEventListener('input', function () { xAramaQueryKur(true); }); f.addEventListener('change', function () { xAramaQueryKur(true); }); });
        card.querySelectorAll('select').forEach(function (s) { xAramaSelectKur(s); });   // native select'leri KOYU özel dropdown'a çevir
        xAramaScrollbar(card);   // özel ince overlay scrollbar
        card.querySelector('#x-gx-ara-temizle').onclick = function () {
            card.querySelectorAll('input').forEach(function (i) { i.value = ''; });
            card.querySelectorAll('select').forEach(function (s) { s.selectedIndex = 0; if (s.__xcsSync) s.__xcsSync(); });
            xAramaQueryKur(true);
        };
        card.querySelector('#x-gx-ara-ara').onclick = function () {
            var q = xAramaQueryKur(true);
            if (!q) { try { card.querySelector('#ara-tumu').focus(); } catch (e) {} return; }
            try { window.location.href = 'https://x.com/search?q=' + encodeURIComponent(q) + '&src=typed_query'; } catch (e) {}
        };
        // REVERSE-SYNC: açılışta X arama inputundaki mevcut query'yi popup alanlarına doldur (/search'te dolu gelir).
        try { var _xin = document.querySelector('input[data-testid="SearchBox_Search_Input"]'); if (_xin && _xin.value && _xin.value.trim()) xAramaQueryAyristir(_xin.value.trim()); } catch (e) {}
        // [DAHA FAZLA] Hiçbiri+Etiketler gizli; toggle aç/kapa + son durum hatırla (localStorage x_ara_dahafazla).
        // reverse-sync SONRASI kurulur -> gizli alana değer geldiyse (ya da son durum açıksa) otomatik AÇIK gelir.
        try {
            var _ktog = card.querySelector('#x-gx-kelime-toggle'), _keks = card.querySelector('#x-gx-kelime-ekstra');
            if (_ktog && _keks) {
                var _ekUygula = function (acik, kaydet) {
                    _keks.classList.toggle('acik', acik);
                    var _t = _ktog.querySelector('.t'); if (_t) _t.textContent = acik ? '− Daha az' : '+ Daha fazla seçenek';
                    if (kaydet) { try { localStorage.setItem('x_ara_dahafazla', acik ? '1' : '0'); } catch (e) {} }
                    try { xGxPopoverKonumla(); } catch (e) {}
                    try { if (card.__sbGuncelle) card.__sbGuncelle(); } catch (e) {}
                };
                _ktog.onclick = function () { _ekUygula(!_keks.classList.contains('acik'), true); };
                var _kayitAcik = false; try { _kayitAcik = localStorage.getItem('x_ara_dahafazla') === '1'; } catch (e) {}
                var _dolu = false; try { _dolu = !!(((card.querySelector('#ara-hicbiri') || {}).value) || ((card.querySelector('#ara-etiket') || {}).value) || ((card.querySelector('#ara-dil') || {}).value)); } catch (e) {}
                _ekUygula(_kayitAcik || _dolu, false);
            }
        } catch (e) {}
        try { card.querySelectorAll('select').forEach(function (s) { if (s.__xcsSync) s.__xcsSync(); }); } catch (e) {}   // reverse-sync sonrası özel dropdown etiketleri
        try { if (card.__sbGuncelle) card.__sbGuncelle(); } catch (e) {}   // reverse-sync akordiyon açılınca scrollbar güncelle
        xAramaQueryKur(false);   // önizlemeyi güncelle (X'e TEKRAR yazma — zaten orada)
        xGxPopoverKonumla();
        var disTik = function (e) {
            var o = document.getElementById('x-gx-ov'); if (!o || o.contains(e.target)) return;
            var nb = document.getElementById('x-gx-nav-btn'); if (nb && nb.contains(e.target)) return;
            xProfilPopupKapat();
        };
        var esc = function (e) { if (e.key === 'Escape') xProfilPopupKapat(); };
        var yeniden = function () { try { xGxPopoverKonumla(); } catch (e) {} };
        setTimeout(function () { try { document.addEventListener('click', disTik, true); } catch (e) {} }, 0);
        document.addEventListener('keydown', esc, true);
        window.addEventListener('resize', yeniden); window.addEventListener('scroll', yeniden, true);
        var _acPath = location.pathname;
        var _navT = setInterval(function () {
            if (!document.getElementById('x-gx-ov')) { clearInterval(_navT); return; }
            if (location.pathname !== _acPath) { clearInterval(_navT); try { xProfilPopupKapat(); } catch (e) {} }
        }, 400);
        window.__xGxPopoverTemizle = function () {
            try { document.removeEventListener('click', disTik, true); } catch (e) {}
            try { document.removeEventListener('keydown', esc, true); } catch (e) {}
            try { window.removeEventListener('resize', yeniden); window.removeEventListener('scroll', yeniden, true); } catch (e) {}
            try { clearInterval(_navT); } catch (e) {}
            window.__xGxPopoverTemizle = null;
        };
    }
    // Durum/açıklama tooltip'ini hover BEKLEMEDEN kısa süre göster (yakalama sonucu "Rapora eklendi ·
    // Panoda" vb. kullanıcıya görünür olsun). Mouseenter ile aynı konumlama (fixed; nav kabı kırpıyordu).
    // Nav tooltip konumu (kullanici): SAGA DAYALI, YESIL IKON ALTINDAN -> tooltip SAG kenari =
    // yesil ikon SAG kenari, SOLA acilir (tek satir/nowrap). Sagda tweet var -> ASLA tasmaz;
    // sola sidebar bos. (Viewport sol kenarindan da tasmasin: min 6px.)
    function _xNavTipKonum(el, tip) {
        try {
            if (!el || !tip) return;
            var r = el.getBoundingClientRect();   // yesil ikon (nav-ekle)
            tip.style.transform = 'none';
            tip.style.whiteSpace = 'nowrap';
            tip.style.maxWidth = 'none';
            tip.style.top = Math.round(r.bottom + 8) + 'px';
            tip.style.left = '0px';   // olcum icin
            var tw = Math.round(tip.getBoundingClientRect().width);
            tip.style.left = Math.max(6, Math.round(r.right - tw)) + 'px';   // SAG kenar = ikon sagi
        } catch (e) {}
    }
    function xNavTipGoster(el, sure) {
        try {
            if (!el) return;
            var tip = el.__tip; if (!tip) return;
            _xNavTipKonum(el, tip);
            tip.style.opacity = '1';
            clearTimeout(el.__tipT);
            el.__tipT = setTimeout(function () { try { tip.style.opacity = '0'; } catch (e) {} }, sure || 2600);
        } catch (e) {}
    }
    function xTweetBtnDurum(btn, sinif, tip) {
        try {
            btn.classList.remove('x-gx-ok', 'x-gx-warn'); if (sinif) btn.classList.add(sinif);
            var t = btn.__tip; if (t && tip) t.textContent = tip;
            var ic = btn.querySelector('.x-gx-tw-ic');
            if (ic) {
                // Nested tasarim: ok=onay tiki, warn=cerceve+arti (renk .x-gx-ssbtn.x-gx-ok/.warn CSS'inde).
                if (sinif === 'x-gx-ok') { while (ic.firstChild) ic.removeChild(ic.firstChild); ic.appendChild(_xGxSsIkon('ok')); }
                else if (sinif === 'x-gx-warn') { while (ic.firstChild) ic.removeChild(ic.firstChild); ic.appendChild(_xGxSsIkon('ekle')); }
                else ic.innerHTML = _X_GX_ICO;
            }
            if (sinif) xNavTipGoster(btn);   // durumu hover beklemeden göster
        } catch (e) {}
    }
    // Tıklanan SPESİFİK tweet'i yakala + havuza ekle (dock "Rapora Ekle" mantığı, tek tweet).
    async function xTweetYakalaEkle(article, btn, pano) {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var _cap = window.__xGxCap, _capYanit = window.__xGxCapYanit;
        if (typeof _cap !== 'function') { try { if (pano) pano.iptal(); } catch (e) {} xTweetBtnDurum(btn, 'x-gx-warn', 'Hazır değil — F5 yapın'); return; }
        var origin = ''; try { origin = await new Promise(function (r) { chrome.storage.local.get({ server_origin: 'https://goruntux.rgmedya.tr' }, function (x) { r(x.server_origin || 'https://goruntux.rgmedya.tr'); }); }); } catch (e) {}
        var yazar = (article.getAttribute('data-author-username') || '').toLowerCase();
        var isReply = article.getAttribute('data-is-reply') === 'true' || /yanıt olarak|replying to/i.test(article.innerText || '');
        var meta = xProfilKartMeta(article, yazar);
        btn.style.opacity = '1';
        var tipEl = btn.__tip; if (tipEl) tipEl.textContent = 'Ekleniyor…';
        try {
            try { if (typeof window.xTweetMetniAc === 'function') { window.xTweetMetniAc(); await sleep(250); } } catch (e) {}
            var allArts = document.querySelectorAll('article[data-testid="tweet"]');
            // ÇOKLU-SEÇİM (dock'tan taşınan özellik): açık tweet'in ≥2 ATASI varsa (zincir A←B←C),
            // kullanıcı atalar+eklenen tweet'ten onay kutularıyla seçer; 1 ata (ana+yorum)/tekil ->
            // otomatik (eski xYakalaTweetVeYanit). Bayrak x_coklu_sec='0' -> kapalı.
            var _cokluSec = window.__xGxCokluSec, _yakalaCoklu = window.__xGxYakalaCoklu;
            var _cokluAcik = true; try { if (localStorage.getItem('x_coklu_sec') === '0') _cokluAcik = false; } catch (e) {}
            var _arr = Array.prototype.slice.call(allArts);
            var _fi = _arr.indexOf(article);
            var ss;
            if (_cokluAcik && _fi >= 2 && typeof _cokluSec === 'function' && typeof _yakalaCoklu === 'function') {
                if (tipEl) tipEl.textContent = 'Üst gönderileri seçin…';
                var _adaylar = _arr.slice(0, _fi + 1);   // atalar (0..fi-1) + eklenen tweet (fi), yukarıdan aşağıya
                var _secilenler = await _cokluSec(_adaylar, article);
                if (!_secilenler) { try { if (pano) pano.iptal(); } catch (e) {} xTweetBtnDurum(btn, 'x-gx-warn', 'İptal edildi'); return; }   // iptal -> ekleme yok
                ss = await _yakalaCoklu(_secilenler, _adaylar) || '';
            } else {
                ss = (isReply && typeof _capYanit === 'function') ? (await _capYanit(article, allArts) || '') : (await _cap(article) || '');
            }
            if (!ss || ss.length < 100) { try { if (pano) pano.iptal(); } catch (e) {} xTweetBtnDurum(btn, 'x-gx-warn', 'Yakalanamadı'); return; }
            // Görseli PANOYA kopyala (eski dock davranışı: Ctrl+V ile başka yere yapıştırılabilsin).
            var panoOk = false; try { if (pano) panoOk = await pano.gorseliVer(ss); } catch (e) {}
            var res = await new Promise(function (r) { try { chrome.runtime.sendMessage({ action: 'addToPool', origin: origin, title: meta.baslik, link: meta.link, image: ss, is_profile: false, group_override: meta.groupOverride }, function (x) { r(x || {}); }); } catch (e) { r({ status: 'error' }); } });
            if (res && res.status === 'success') xTweetBtnDurum(btn, 'x-gx-ok', panoOk ? 'Rapora eklendi · 📋 Panoda' : 'Rapora eklendi ✔');
            else if (res && res.status === 'duplicate') xTweetBtnDurum(btn, 'x-gx-warn', panoOk ? 'Zaten havuzda · 📋 Panoda' : 'Zaten havuzda');
            else xTweetBtnDurum(btn, 'x-gx-warn', 'Eklenemedi');
        } catch (e) { try { if (pano) pano.iptal(); } catch (x) {} xTweetBtnDurum(btn, 'x-gx-warn', 'Hata'); printLog('[GX Tweet Btn] hata: ' + (e && e.message)); }
    }
    function xTweetButonPollerBaslat() {
        try {
            if (window.__xGxTweetPoller) return;
            window.__xGxTweetPoller = true;
            xNavEkleGuncelle();
            setInterval(function () { try { xNavEkleGuncelle(); } catch (e) {} }, 150);   // hızlı: tweet açılır açılmaz gelsin
            // SPA gezinmesinde (pushState/geri) poll'u BEKLEMEDEN kısa seri kontrol -> buton anında çıkar.
            try {
                var _seri = function () { for (var ms = 0; ms <= 450; ms += 80) { (function (d) { setTimeout(function () { try { xNavEkleGuncelle(); } catch (e) {} }, d); })(ms); } };
                var _ps = history.pushState;
                history.pushState = function () { var r = _ps.apply(this, arguments); _seri(); return r; };
                window.addEventListener('popstate', _seri);
            } catch (e) {}
        } catch (e) {}
    }

    // ====================== GÖRÜNTÜX NAV BUTONU (X sol-nav, logonun altı) ======================
    // Eski dock gizli yedek; GÖRÜNÜR arayüz = X'in birincil nav'ına, X logosunun hemen altına
    // (Anasayfa'nın üstüne) enjekte edilen yerli öğe. X'in kendi düzeni taşır: geniş=ikon+etiket,
    // dar=yalnız ikon (diğer ikonları aşağı kaydırır). Tık=Panele Git. Dock durumu (tarama
    // halkası/güncelleme) buraya MutationObserver ile yansıtılır (ayrı mantık yok).
    function xNavStilEkle() {
        if (document.getElementById('x-gx-nav-style')) return;
        var s = document.createElement('style'); s.id = 'x-gx-nav-style';
        s.textContent = `
            .x-gx-nav{ position:relative; display:flex; align-items:center; width:100%; box-sizing:border-box;
                cursor:pointer; color:inherit; text-decoration:none; -webkit-tap-highlight-color:transparent; margin:4px 0; }
            /* KAPSÜL: kalıcı açık-mavi hap; padding:0 -> daireler uçlara SIFIRA SIFIR. */
            .x-gx-nav .x-gx-nav-inner{ display:inline-flex; align-items:center; gap:0; padding:0; background:transparent;
                border-radius:9999px; transition:background .15s ease; max-width:100%; }
            .x-gx-nav:hover .x-gx-nav-inner{ background:rgba(29,155,240,.18); }
            /* MAVİ İKON HİZASI: X nav ikonu 26px (sol-dolgu 12px, merkez=item+25); mavi daire 40px daha
               büyük olduğundan sol-kenar aynı olsa bile MERKEZ 5px sola kaçıyordu. Kapsülü +5px kaydır ->
               mavi daire merkezi = Anasayfa/Keşfet ikon merkezi (canlı ölçümle doğrulandı). Yalnız geniş mod. */
            .x-gx-nav:not(.collapsed) .x-gx-nav-inner{ margin-left:5px; }
            /* MAVİ DAİRE (sol uç): zemin daire, içte beyaz işaret (frame+X). */
            /* MAVI ikon = YESIL'in birebir MAVI versiyonu (kullanici): normal mavi-outline daire+cerceve+X,
               hover'da daire MAVI dolar + ic BEYAZ. Cerceve/boyut yesil ile AYNI (viewBox 24, 42px -> .c 39px). */
            .x-gx-nav-ico{ position:relative; flex:0 0 auto; width:40px; height:40px; border-radius:50%; background:transparent; display:inline-flex; align-items:center; justify-content:center; }
            .x-gx-nav-ico > svg.x-gx-nav-logo{ display:block; width:42px; height:42px; overflow:visible; transform-origin:center; transition:transform .12s ease; }
            .x-gx-nav-ico .x-gx-nav-logo .c{ fill:none; stroke:#1d9bf0; stroke-width:1.6; transition:fill .12s ease; }
            .x-gx-nav-ico .x-gx-nav-logo .in{ fill:none; stroke:#1d9bf0; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; transition:stroke .12s ease; }
            /* DOLGU = yalniz MAVI ikon + "GörüntüX" ETIKET hover'inda. ⚠YESIL buton (#x-gx-nav-ekle) de
               nav-inner ICINDE (ayni kapsul; HTML 4415) oldugundan ona hover da .x-gx-nav-inner:hover'i
               tetikliyordu -> mavi YANLISLIKLA doluyordu. :not(:has(yesil:hover)) -> yesil-hover'da mavi
               DOLMAZ (kullanici: yesile gidince mavi saydam kalsin, SADECE buyusun). */
            .x-gx-nav-inner:hover:not(:has(.x-gx-nav-ekle:hover)) .x-gx-nav-logo .c{ fill:#1d9bf0; stroke:#1d9bf0; }
            .x-gx-nav-inner:hover:not(:has(.x-gx-nav-ekle:hover)) .x-gx-nav-logo .in{ stroke:#fff; }
            /* [BÜYÜME — kullanici] Mavi ikon hover'da bir tik BÜYÜR (yesil buton gibi). Yesil de mavi de
               nav-inner ICINDE -> .x-gx-nav-inner:hover ikisine de hover'da mavi ikonu buyutur. DOLGU
               yukaridaki kuralla ayrisir: maviye->mavi dolar+buyur, yesile->mavi BOS buyur. */
            .x-gx-nav-inner:hover .x-gx-nav-logo{ transform:scale(1.06); }
            /* HALKA = absolute HTML <span> (içinde svg %100). SVG elemanını DOĞRUDAN position:absolute+inset
               yapmak bu tarayıcıda dikeyde ~44px kaydırıyordu (SVG replaced-element over-constraint);
               HTML span inset:0'ı güvenilir uygular, svg %100 doldurur -> halka 40px yeşil dairede TAM ORTALI. */
            .x-gx-nav-ring{ position:absolute; inset:0; display:none; }
            .x-gx-nav.scanning .x-gx-nav-ring{ display:block; }
            .x-gx-nav-ring svg{ display:block; width:100%; height:100%; }
            /* Tarama halkası YEŞİL ikon üzerinde (kullanıcı isteği): tarama sürerken yeşil +'yı soluklaştır,
               halka+sayaç yeşil daire üzerinde beyaz. Mavi GörüntüX ikonu NORMAL kalır (artık soluklaşmaz). */
            .x-gx-nav.scanning .x-gx-nav-ekle .x-gx-tw-ic{ opacity:.2; }
            .x-gx-nav-ring .trk{ fill:none; stroke:rgba(255,255,255,.35); stroke-width:4; }
            /* rotate FILL circle'da (SVG elemanında değil): SVG'ye rotate uygulamak yayı yatayda kaydırıyordu.
               transform-box:fill-box + origin:center -> yay ÜSTTEN (12 yön) saat yönünde ilerler. */
            .x-gx-nav-ring .fil{ fill:none; stroke:#fff; stroke-width:4; stroke-linecap:round; transform:rotate(-90deg); transform-box:fill-box; transform-origin:center; transition:stroke-dashoffset .3s ease; }
            .x-gx-nav-cnt{ position:absolute; inset:0; display:none; align-items:center; justify-content:center; font-size:10px; font-weight:800; color:#fff; text-shadow:0 1px 2px rgba(0,0,0,.35); }
            .x-gx-nav.scanning .x-gx-nav-cnt{ display:flex; }
            /* [KAYIT SAYACI] kayıt sürerken record ikonu yerine kırmızı mm:ss sayacı (canlı) -> kullanıcı kaydın sürdüğünü görür */
            .x-gx-rec-sayac{ position:absolute; inset:0; display:none; align-items:center; justify-content:center; box-sizing:border-box; font-size:11px; font-weight:800; color:#f4212e; background:transparent; border:2px solid #f4212e; border-radius:9999px; letter-spacing:.2px; font-variant-numeric:tabular-nums; }   /* İÇİ BOŞ: kırmızı halka + kırmızı rakamlar (solid dolgu YOK) */
            .x-gx-nav-ekle.x-gx-rec-aktif .x-gx-rec-sayac{ display:flex; }
            .x-gx-nav-ekle.x-gx-rec-aktif .x-gx-tw-ic{ visibility:hidden; }
            .x-gx-nav-ekle.x-gx-rec-aktif.x-gx-rt-silik{ opacity:1 !important; }   /* kayıt sürerken SİLİK YOK (sayaç net) — /retweets'te bile */
            .x-gx-nav-badge{ position:absolute; top:-3px; right:-3px; display:none; width:16px; height:16px; border-radius:9999px;
                background:#f5a623; color:#fff; font-size:11px; font-weight:800; align-items:center; justify-content:center; line-height:1; box-shadow:0 0 0 2px var(--w-bg,#000); }
            .x-gx-nav.outdated .x-gx-nav-badge{ display:flex; }
            /* Etiket fontu = X nav etiketi (Anasayfa) fontu. X, fontu LINK'te degil ETIKET SPAN'inde
               tanimliyor (link computed='Times' serif) -> Chirp stack'ini dogrudan ver (serif kaybolur). */
            .x-gx-nav-lbl{ font-family:"TwitterChirp",-apple-system,"system-ui","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
                font-size:20px; font-weight:400; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding:0 15px; }
            .x-gx-nav.collapsed .x-gx-nav-lbl{ display:none; }
            /* Dar mod: kapsül yerine İKİZ DAİRELER alt alta, aynı eksende (mavi üstte, yeşil altında). */
            .x-gx-nav.collapsed{ justify-content:center; }
            .x-gx-nav.collapsed .x-gx-nav-inner{ flex-direction:column; gap:4px; padding:0; background:transparent; }
            /* YEŞİL DAİRE (sağ uç): kapsül içinde, mavinin İKİZİ; daire zemin BURADA, içte beyaz işaret (frame+ARTI).
               Yalnız /status/ + açık tweet varken (.aktif). Tık=o tweeti yakala. */
            /* YENI TASARIM (IG/YT ile ortak nested ikon): arka plan SEFFAF (daire ikonun parcasi,
               .x-gx-ssbtn paylasilan CSS'i renk/hover/durumu yonetir). */
            .x-gx-nav-ekle{ position:relative; display:none; flex:0 0 auto; align-items:center; justify-content:center;
                width:40px; height:40px; border-radius:50%; background:transparent; color:#00ba7c; cursor:pointer; transition:transform .12s ease; }
            .x-gx-nav-ekle.aktif{ display:inline-flex; }
            /* Tarama: yesil daire GERI GELIR (beyaz halka seffaf uzerinde gorunmez; halka+sayac yesilde). */
            .x-gx-nav.scanning .x-gx-nav-ekle{ display:inline-flex; background:#00ba7c; }
            .x-gx-nav-ekle:hover{ transform:scale(1.06); }
            /* !important: paylasilan .x-gx-ssbtn .x-gx-ssico{24px} (SONRA enjekte -> esit ozgulluk, sonraki kazanir)
               bunu eziyordu -> buton 24px/kucuk kaliyordu. 44px ile .c dairesi 40px = MAVI. Tum modlar. */
            .x-gx-nav-ekle .x-gx-ssico{ width:42px !important; height:42px !important; }   /* .c dis-kenar ~39px: MAVI 40px'e denk ama outline iri durdugundan 1px kucuk -> gorsel esit. */
            .x-gx-nav-ekle .x-gx-tw-ic{ display:inline-flex; align-items:center; justify-content:center; line-height:0; }
            .x-gx-nav-ekle .x-gx-tw-ic svg{ display:block; }
            /* [RT VİDEO] Sağ-tıkla açılan video modu: buton kırmızı + kamera; SS "+" ikonu gizlenir. */
            /* [RT VİDEO] Video modu = YEŞİL SS butonunun AYNISI, yalnız KIRMIZI + içte + yerine DOLU NOKTA (record).
               Buton ŞEFFAF kalır (yeşildeki gibi; bg değişmez); sadece ikon renkleri kırmızıya döner. İkon
               _xGxSsIkon('kayit') ile basılır (kare çerçeve + nokta). */
            /* [RT VİDEO] /retweets (reposts/likes/quotes) sayfasında kayıt butonu ENJEKTE edilir ama SİLİK (kullanıcı isteği). */
            .x-gx-nav-ekle.x-gx-rt-silik{ opacity:.45 !important; }
            .x-gx-nav-ekle.x-gx-videomod .x-gx-ssico .c{ stroke:#f4212e !important; fill:none !important; }
            .x-gx-nav-ekle.x-gx-videomod .x-gx-ssico .in{ stroke:#f4212e !important; }
            .x-gx-nav-ekle.x-gx-videomod .x-gx-ssico .in circle{ fill:#f4212e !important; stroke:none !important; }
            .x-gx-nav-ekle.x-gx-videomod:hover .x-gx-ssico .c{ fill:#f4212e !important; stroke:#f4212e !important; }
            .x-gx-nav-ekle.x-gx-videomod:hover .x-gx-ssico .in{ stroke:#fff !important; }
            .x-gx-nav-ekle.x-gx-videomod:hover .x-gx-ssico .in circle{ fill:#fff !important; }
            /* tooltip SAĞDA (Anasayfa'nın altında kalmasın). */
            /* tooltip FIXED + documentElement'e taşınır: X nav'ında TRANSFORM'lu ata (translateZ/scale vb.)
               fixed tooltip'i o ataya hapsedip overflow ile KIRPIYORDU -> span <html>'e taşınır (ata yok),
               CSS .x-gx-nav-tip sınıfıyla uygulanır. Konum hover'da JS ile (viewport koordinatı). */
            .x-gx-nav-tip{ position:fixed; transform:translateY(-50%);
                background:rgba(15,20,25,.96); color:#fff; font-weight:600; font-size:12px; line-height:1; white-space:nowrap; padding:6px 9px;
                border-radius:6px; opacity:0; pointer-events:none; z-index:2147483600; box-shadow:0 2px 10px rgba(0,0,0,.3); transition:opacity .12s ease; }
            .x-gx-nav-cancel{ display:none; flex:0 0 auto; margin:0 8px 0 4px; width:26px; height:26px; border:none; border-radius:9999px;
                background:#e0245e; color:#fff; font-size:13px; cursor:pointer; align-items:center; justify-content:center; }
            .x-gx-nav.scanning:not(.collapsed) .x-gx-nav-cancel{ display:inline-flex; }
            .x-gx-nav-pop{ display:none; position:absolute; left:calc(100% + 10px); top:50%; transform:translateY(-50%);
                background:rgba(15,20,25,.97); color:#fff; font-size:13px; line-height:1.3; padding:10px 12px; border-radius:10px;
                white-space:nowrap; z-index:99999; box-shadow:0 2px 12px rgba(0,0,0,.45); align-items:center; gap:10px; }
            .x-gx-nav.collapsed.scanning:hover .x-gx-nav-pop,
            .x-gx-nav.collapsed.outdated:hover .x-gx-nav-pop{ display:flex; }
            .x-gx-nav-pop .pop-cancel{ border:none; border-radius:9999px; background:#e0245e; color:#fff; width:26px; height:26px; cursor:pointer; flex:0 0 auto; }
            /* PROFİL SEÇENEK satırları (#x-gx-card 'secim' modu içinde; rapor/takvim ile TEK popup). */
            .x-gx-secler{ display:flex; flex-direction:column; gap:2px; margin:6px 0 2px; }
            .x-gx-pp-opt{ display:flex; align-items:center; gap:12px; width:100%; text-align:left; background:transparent; border:none;
                padding:11px 12px; border-radius:10px; cursor:pointer; color:#e7e9ea; }
            .x-gx-pp-opt:hover{ background:rgba(255,255,255,.06); }
            .x-gx-pp-ic{ flex:0 0 auto; width:34px; height:34px; border-radius:9px; display:inline-flex; align-items:center; justify-content:center; }
            .x-gx-pp-ic.c1{ background:rgba(0,186,124,.16); color:#00ba7c; }
            .x-gx-pp-ic.c2{ background:rgba(29,155,240,.16); color:#1d9bf0; }
            .x-gx-pp-tx{ display:flex; flex-direction:column; gap:2px; min-width:0; }
            .x-gx-pp-tx b{ font-size:14px; font-weight:600; line-height:1.25; }
            .x-gx-pp-tx i{ font-size:12px; font-style:normal; color:#8b98a5; }
            /* Seçim → takvim ŞIK GEÇİŞ (içerik değişince kısa fade/yukarı-kayma). */
            #x-gx-card.x-gx-gecis{ animation:xgxgecis .22s ease; }
            @keyframes xgxgecis{ from{ opacity:.25; } to{ opacity:1; } }
            /* [SS'TE GÖRÜNMESİN] Yakalama sürerken yeşil buton tooltip'i + tarama popover'ı gizli (pc'ye taşıp
               kadraja giriyordu). Rapor/seçim popup'ı #x-gx-ov zaten html.x-gx-capturing ile gizli. */
            html.x-gx-capturing .x-gx-nav-tip,
            html.x-gx-capturing .x-gx-nav-pop{ visibility:hidden !important; opacity:0 !important; }
        `;
        (document.head || document.documentElement).appendChild(s);
    }
    function xNavPaneleGit() {
        try { chrome.storage.local.get({ server_origin: 'https://goruntux.rgmedya.tr' }, function (res) { chrome.runtime.sendMessage({ action: 'goToPanel', origin: res.server_origin }); }); } catch (e) {}
    }
    function xNavGuncellemeAc() {
        try { chrome.storage.local.get({ server_origin: 'https://goruntux.rgmedya.tr' }, function (res) { window.open(res.server_origin + '/#eklenti-guncelle', '_blank'); }); } catch (e) {}
    }
    function xNavButonOlustur() {
        var a = document.createElement('a');
        a.id = 'x-gx-nav-btn';
        a.className = 'x-gx-nav collapsed';
        a.href = '#'; a.setAttribute('role', 'link'); a.setAttribute('aria-label', 'GörüntüX');
        a.innerHTML = ''
            + '<span class="x-gx-nav-inner">'
            +   '<span class="x-gx-nav-ico">'
            +     '<svg class="x-gx-nav-logo x-gx-ssico" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle class="c" cx="12" cy="12" r="11" fill="none" stroke="#1d9bf0" stroke-width="1.6"/><g class="in" fill="none" stroke="#1d9bf0" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 10.5V7.5h3"/><path d="M13.5 7.5h3v3"/><path d="M16.5 13.5v3h-3"/><path d="M10.5 16.5H7.5v-3"/><path d="M10 10l4 4"/><path d="M14 10l-4 4"/></g></svg>'
            +     '<span class="x-gx-nav-badge">!</span>'
            +   '</span>'
            +   '<span class="x-gx-nav-lbl">GörüntüX</span>'
            +   '<span id="x-gx-nav-ekle" class="x-gx-nav-ekle x-gx-ssbtn" role="button" tabindex="0" aria-label="Bu paylaşımı GörüntüX Raporu\'na ekle!"><span class="x-gx-tw-ic"><svg width="25" height="25" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12V9h3"/><path d="M20 9h3v3"/><path d="M23 20v3h-3"/><path d="M12 23H9v-3"/><path d="M16 11.5v9M11.5 16h9"/></g></svg></span><span class="x-gx-nav-ring"><svg viewBox="0 0 40 40"><circle class="trk" cx="20" cy="20" r="16"></circle><circle class="fil" cx="20" cy="20" r="16" stroke-dasharray="100.53" stroke-dashoffset="100.53"></circle></svg></span><span class="x-gx-nav-cnt">0/0</span><span class="x-gx-rec-sayac"></span><span class="x-gx-tw-tip x-gx-nav-tip">Bu paylaşımı GörüntüX Raporu\'na ekle!</span></span>'
            +   '<button type="button" class="x-gx-nav-cancel" aria-label="Taramayı durdur">✕</button>'
            + '</span>'
            + '<span class="x-gx-nav-pop"><span class="pop-msg"></span><button type="button" class="pop-cancel" aria-label="Taramayı durdur">✕</button></span>';
        a.addEventListener('click', function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            if (a.classList.contains('outdated')) { xNavGuncellemeAc(); return; }
            xNavPaneleGit();
        });
        var _fwd = function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            if (window.__xGxTaramaAktif) {
                // Profil taraması: iptal bayrağını DOĞRUDAN set et. (Dock SPA'da yeniden kurulup
                // #w-scan-cancel onclick'i kaybolunca ona forward etmek boşa gidiyordu -> iptal çalışmıyordu.)
                try { window.__xGxTaraIptal = true; window.__xGxTaraMsg = 'Durduruluyor…'; } catch (e) {}
                try { var m = document.getElementById('w-scan-msg'); if (m) m.textContent = 'Durduruluyor…'; } catch (e) {}
                try { xNavYansit(); } catch (e) {}
            } else {
                try { var c = document.getElementById('w-scan-cancel'); if (c) c.click(); } catch (e) {}   // genel/Rapormatik tarama
            }
        };
        var cx1 = a.querySelector('.x-gx-nav-cancel'); if (cx1) cx1.addEventListener('click', _fwd);
        var cx2 = a.querySelector('.pop-cancel'); if (cx2) cx2.addEventListener('click', _fwd);
        var ekle = a.querySelector('#x-gx-nav-ekle');
        if (ekle) {
            // Tooltip span'ini <html>'e TAŞI (transform'lu ata = hapis+kırpma; bkz CSS notu). Referansı
            // ekle.__tip'te tut (artık ekle.querySelector('.x-gx-tw-tip') NULL döner -> __tip kullan).
            try {
                var _tip = ekle.querySelector('.x-gx-tw-tip');
                if (_tip) { var _esk = document.getElementById('x-gx-nav-tip'); if (_esk) _esk.remove(); _tip.id = 'x-gx-nav-tip'; document.documentElement.appendChild(_tip); ekle.__tip = _tip; }
            } catch (e) {}
            ekle.addEventListener('click', function (ev) {
                ev.preventDefault(); ev.stopPropagation();
                // [RT VİDEO] Video modundaysak (tweet detayda sağ-tıkla açılır) -> SS yerine RT listesi videosu kaydet.
                if (ekle.classList.contains('x-gx-videomod') && xVideoTweetDetayMi()) { try { xVideoBaslatNav(); } catch (e) {} return; }
                xNavEkleTikla(ekle);
            });
            // [RT VİDEO] Sağ-tık: YALNIZ tweet detay sayfasında butonu video moduna sok / normale döndür.
            // Mod butonun class'ında tutulur -> SPA navigasyonunda buton yeniden kurulunca kendiliğinden sıfırlanır.
            ekle.addEventListener('contextmenu', function (ev) {
                try {
                    if (!xVideoTweetDetayMi()) return;   // detay dışında normal tarayıcı sağ-tık menüsü kalsın
                    ev.preventDefault(); ev.stopPropagation();
                    xNavVideoModToggle(ekle);
                } catch (e) {}
            });
            // Tooltip FIXED + <html>'de olduğundan konumu hover'da JS ile ayarla (butonun sağına, dikey ortalı).
            ekle.addEventListener('mouseenter', function () { try { if (a.classList.contains('scanning')) return; var tip = ekle.__tip; if (!tip) return; _xNavTipKonum(ekle, tip); tip.style.opacity = '1'; } catch (e) {} });
            ekle.addEventListener('mouseleave', function () { try { var tip = ekle.__tip; if (tip) tip.style.opacity = '0'; } catch (e) {} });
        }
        // MAVİ İKON TOOLTIP'i (documentElement'e, ikon ALTINDA): güncelleme uyarısı burada; etiket "GörüntüX" sabit.
        // Metin xNavYansit'te duruma göre set edilir ("Güncelleme gerekli — tıklayarak güncelle" / "GörüntüX paneline git").
        try {
            var _bEsk = document.getElementById('x-gx-nav-btip'); if (_bEsk) _bEsk.remove();
            var btip = document.createElement('span');
            btip.id = 'x-gx-nav-btip'; btip.className = 'x-gx-nav-tip'; btip.textContent = 'GörüntüX paneline git';
            document.documentElement.appendChild(btip);
            a.__btip = btip;
            var ico = a.querySelector('.x-gx-nav-ico');
            if (ico) {
                ico.addEventListener('mouseenter', function () { try { if (a.classList.contains('scanning')) return; var tip = a.__btip; if (!tip || !tip.textContent) return; var r = ico.getBoundingClientRect(); tip.style.left = Math.round(r.left) + 'px'; tip.style.top = Math.round(r.bottom + 8) + 'px'; tip.style.transform = 'none'; tip.style.opacity = '1'; } catch (e) {} });
                ico.addEventListener('mouseleave', function () { try { var tip = a.__btip; if (tip) tip.style.opacity = '0'; } catch (e) {} });
            }
        } catch (e) {}
        return a;
    }
    // [KAYIT SAYACI] Nav record butonunu canlı mm:ss sayacına çevir. KALICI global __xVideoRecT0'dan okur -> SPA
    // tweet->RT geçişinde nav butonu yeniden kurulsa bile sayaç SEKMEZ/SIFIRLANMAZ (aynı başlangıçtan sürer).
    function xRecSayacTik() {
        try {
            var el = document.getElementById('x-gx-nav-ekle'); if (!el) return;
            var aktif = !!(window.__xVideoKayitAktif && window.__xVideoRecT0);
            if (el.classList.contains('x-gx-rec-aktif') !== aktif) el.classList.toggle('x-gx-rec-aktif', aktif);
            if (aktif) {
                var sc = el.querySelector('.x-gx-rec-sayac');
                if (sc) { var s = Math.max(0, Math.floor((Date.now() - window.__xVideoRecT0) / 1000)); var m = Math.floor(s / 60), ss = s % 60; var t = m + ':' + (ss < 10 ? '0' : '') + ss; if (sc.textContent !== t) sc.textContent = t; }
            }
        } catch (e) {}
    }
    try { if (!window.__xRecSayacIv) window.__xRecSayacIv = setInterval(xRecSayacTik, 500); } catch (e) {}
    function xNavYansit() {
        try {
            var nav = document.getElementById('x-gx-nav-btn');
            var dock = document.getElementById('x-downloader-widget');
            if (!nav || !dock) return;
            // [RT VİDEO] Video modu YALNIZ tweet detayda geçerli: başka sayfaya geçilince kırmızı/kamera + kontrol kalmasın.
            try {
                // [NAV KAYIT İKONU] Nav butonu KIRMIZI "kayıt" ikonu gösterir: (a) KAYIT SÜRÜYOR (her sayfada; /retweets'te
                // x-gx-rt-silik ile SOLUK) VEYA (b) kayıt yok + SAF tweet detayında kullanıcı sağ-tık ile video modunu açtı.
                // Aksi halde normal yeşil "+". (STOP kontrol kutusu AYRI: yalnız kayıt sürerken + sayfa içinde durur.)
                var _ekl = document.getElementById('x-gx-nav-ekle');
                if (_ekl) {
                    var _kayitIkon = !!window.__xVideoKayitAktif || (xVideoTweetDetayMi() && _ekl.__userVideoMode === true);
                    if (_kayitIkon !== _ekl.classList.contains('x-gx-videomod')) {
                        _ekl.classList.toggle('x-gx-videomod', _kayitIkon);
                        var _eic = _ekl.querySelector('.x-gx-tw-ic');
                        if (_eic) { while (_eic.firstChild) _eic.removeChild(_eic.firstChild); _eic.appendChild(_xGxSsIkon(_kayitIkon ? 'kayit' : 'ekle')); }
                        if (_ekl.__tip) _ekl.__tip.textContent = _kayitIkon ? (window.__xVideoKayitAktif ? "Video kaydı sürüyor…" : "Video modu — tıkla: RT listesi videosu") : "Bu paylaşımı GörüntüX Raporu'na ekle!";
                    }
                }
                // Stop kontrol kutusu (#x-gx-video-ctrl): detay dışına çıkıp KAYIT SÜRMÜYORSA kapat (kayıt sürerken DURDUR gerekir).
                if (!window.__xVideoKayitAktif && !xVideoTweetDetayMi()) {
                    var _vc = document.getElementById('x-gx-video-ctrl'); if (_vc) { try { _vc.remove(); } catch (e) {} }
                }
                // [RT VİDEO] /retweets (reposts/likes/quotes) sayfasında kayıt butonu SİLİK; diğer sayfalarda net.
                var _ekl2 = document.getElementById('x-gx-nav-ekle');
                if (_ekl2) _ekl2.classList.toggle('x-gx-rt-silik', /\/status\/\d+\/(retweets|reposts|likes|quotes)/i.test(location.pathname));
            } catch (e) {}
            // TARAMA AKTİF BAYRAĞI: toplu tarama sırasında SS alınırken SPA dock'u yeniden kurup
            // .scanning'i düşürse de nav halkası KAYBOLMASIN; ilerleme window-var'lardan okunur
            // (dock #w-scan-* yeniden kurulsa da kalıcı). İş bitince xProfilDockBitir temizler.
            var taraAktif = window.__xGxTaramaAktif === true;
            var scanning = dock.classList.contains('scanning') || taraAktif;
            var wbtn = document.getElementById('w-buton');
            var outdated = !!(wbtn && wbtn.classList.contains('outdated'));
            nav.classList.toggle('scanning', scanning);
            nav.classList.toggle('outdated', outdated && !scanning);
            var txt = document.getElementById('w-scan-txt');
            var sayac = (taraAktif && window.__xGxTaraToplam) ? ((window.__xGxTaraYapilan || 0) + '/' + window.__xGxTaraToplam) : (txt ? (txt.textContent || '') : '');
            var navFil = nav.querySelector('.x-gx-nav-ring .fil');
            if (navFil) {
                var dash = '100.53';
                if (taraAktif && window.__xGxTaraToplam) { var C = 100.53, pct = Math.max(0, Math.min(100, Math.round((window.__xGxTaraYapilan || 0) / window.__xGxTaraToplam * 100))); dash = String(C * (1 - pct / 100)); }
                else { var ring = document.getElementById('w-scan-ring'); if (ring) dash = ring.getAttribute('stroke-dashoffset') || '100.53'; }
                navFil.setAttribute('stroke-dashoffset', dash);
            }
            var cnt = nav.querySelector('.x-gx-nav-cnt');
            if (cnt) cnt.textContent = scanning ? (sayac || '') : '';   // idle'da BOŞ (bayat "undefined/.." gösterme)
            var msg = document.getElementById('w-scan-msg');
            var mText = (taraAktif && window.__xGxTaraMsg) ? window.__xGxTaraMsg : ((msg && msg.textContent) ? msg.textContent : 'Taranıyor…');
            var lbl = nav.querySelector('.x-gx-nav-lbl');
            var popMsg = nav.querySelector('.x-gx-nav-pop .pop-msg');
            var popCancel = nav.querySelector('.x-gx-nav-pop .pop-cancel');
            if (scanning) {
                var lblText = mText;   // sayaç artık YEŞİL halkada; etikette tekrarlama
                if (lbl) lbl.textContent = lblText;
                if (popMsg) popMsg.textContent = lblText;
                if (popCancel) popCancel.style.display = '';
                if (nav.__btip) nav.__btip.textContent = '';
            } else if (outdated) {
                // ETİKET DEĞİŞMEZ ("GörüntüX" kalır); güncelleme uyarısı ikon badge'i (!) + TOOLTIP'te (eski dock gibi).
                if (lbl) lbl.textContent = 'GörüntüX';
                if (popMsg) popMsg.textContent = 'Güncelleme gerekli — tıklayarak güncelle';
                if (popCancel) popCancel.style.display = 'none';
                if (nav.__btip) nav.__btip.textContent = 'Güncelleme gerekli — tıklayarak güncelle';
            } else {
                if (lbl) lbl.textContent = 'GörüntüX';
                if (popMsg) popMsg.textContent = '';
                if (popCancel) popCancel.style.display = 'none';
                if (nav.__btip) nav.__btip.textContent = 'GörüntüX paneline git';
            }
        } catch (e) {}
    }
    function xNavButonYerlestir() {
        try {
            if (X_GX_DOCK_ESKI) return;
            // Birincil nav = Anasayfa linkini içeren <nav>. Logo bu nav'ın HEMEN ÜSTÜNDE ayrı
            // kapsayıcıda; butonu nav'ın İLK öğesi yapınca logonun hemen altına, Anasayfa'nın üstüne gelir.
            var home = document.querySelector('nav a[href="/home"]');
            if (!home) return;
            var navRoot = home.closest('nav');
            if (!navRoot) return;
            xNavStilEkle();
            var btn = document.getElementById('x-gx-nav-btn');
            if (!btn) btn = xNavButonOlustur();
            if (btn.parentElement !== navRoot || navRoot.firstElementChild !== btn) {
                navRoot.insertBefore(btn, navRoot.firstElementChild);
            }
            // Dar mod? Anasayfa öğesinin genişliğinden anla (ikon-nav ~50px, etiketli ~250px).
            var collapsed = home.getBoundingClientRect().width < 100;
            btn.classList.toggle('collapsed', collapsed);
            xNavObserverKur();
            xNavYansit();
        } catch (e) {}
    }
    // ========================================================================
    // [TIK SECIM / Step 2] Tweet'lerde Grok'un SOLUNA "tik" ikonu + alttan kayan secim menusu.
    // Tik -> tweet linki Rapor'matik kuyruguna (panel) CANLI eklenir (toggle). Secim
    // chrome.storage.local (x_secili_tweetler) ile KALICI + tum X sekmeleri arasi senkron.
    // /status (tweet detay) sayfasinda tik BASTIRILIR. CSS'te BACKTICK YOK (template-literal tuzagi).
    // ========================================================================
    function xTikHostX() { return /(?:^|\.)x\.com$/i.test(location.hostname) || /(?:^|\.)twitter\.com$/i.test(location.hostname); }
    function xTikStilKur() {
        if (document.getElementById('x-gx-tik-style')) return;
        var st = document.createElement('style');
        st.id = 'x-gx-tik-style';
        st.textContent = [
            '.x-gx-tik{background:none;border:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;min-width:34px;border-radius:9999px;padding:0;margin:0;transition:background .12s;}',
            '.x-gx-tik svg{width:19px;height:19px;display:block;}',
            '.x-gx-tik:hover{background:rgba(29,155,240,0.1);}',
            '.x-gx-tik.x-gx-tik-on:hover{background:rgba(29,155,240,0.15);}',
            '#x-gx-tik-bar{position:fixed;left:50%;bottom:20px;transform:translate(-50%,160%);z-index:2147483000;display:flex;align-items:center;gap:12px;background:#15202b;border:1px solid #1d9bf0;border-radius:14px;padding:10px 14px;box-shadow:0 8px 28px rgba(0,0,0,0.38);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;max-width:94vw;transition:transform .3s cubic-bezier(.2,.8,.2,1);}',
            '#x-gx-tik-bar.x-gx-tik-bar-in{transform:translate(-50%,0);}',
            '#x-gx-tik-bar .x-gx-tik-sayac{width:34px;height:34px;min-width:34px;border-radius:50%;background:#1d9bf0;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;}',
            '#x-gx-tik-bar .x-gx-tik-mesaj{line-height:1.25;color:#e7e9ea;}',
            '#x-gx-tik-bar .x-gx-tik-bas{font-weight:600;font-size:14px;}',
            '#x-gx-tik-bar .x-gx-tik-alt{color:#8b98a5;font-size:12px;}',
            '#x-gx-tik-bar button{cursor:pointer;border-radius:9999px;font-size:13px;white-space:nowrap;font-family:inherit;}',
            '#x-gx-tik-bar .x-gx-tik-iptal{background:transparent;border:1px solid #38444d;color:#e7e9ea;padding:7px 14px;}',
            '#x-gx-tik-bar .x-gx-tik-iptal:hover{background:rgba(255,255,255,0.06);}',
            '#x-gx-tik-bar .x-gx-tik-git{background:#1d9bf0;border:0;color:#fff;font-weight:600;padding:7px 15px;display:inline-flex;align-items:center;gap:6px;}',
            '#x-gx-tik-bar .x-gx-tik-git:hover{background:#1a8cd8;}',
            // [SS KADRAJ] Rapor'matik yakalamasi sirasinda (<html>.x-gx-capturing) tik UI gizli -> ekran goruntusune girmesin.
            // Alt menu display:none (overlay, akis yok); tweet-ici tik butonu visibility:hidden (layout kaymasin, kirpma bozulmasin).
            'html.x-gx-capturing #x-gx-tik-bar{display:none !important;}',
            'html.x-gx-capturing .x-gx-tik-wrap{visibility:hidden !important;}',
            '.x-gx-tik-sec{box-shadow:inset 0 0 0 2px #1d9bf0 !important;}',   // [TIK ÇERÇEVE] seçili tweet kartına mavi kenarlık (içi BOŞ; box-shadow inset=layout kaymaz + X outline/focus halkasıyla ÇAKIŞMAZ -> mouse gezince git-gel YOK)
            'html.x-gx-capturing .x-gx-tik-sec{box-shadow:none !important;}'   // yakalamada çerçeve SS\'e girmesin
        ].join('');
        (document.head || document.documentElement).appendChild(st);
    }
    function xTikBoya() {
        try {
            if (window.__xGxCaptureAktif) return;   // [SS KADRAJ] yakalama sirasinda DOM'a dokunma
            if (!xTikHostX()) return;
            xTikStilKur();
            if (/\/status\/\d+/.test(location.pathname)) return;   // tweet DETAY -> tik YOK
            var sec = window.__xTikSecili || {};
            var cerceve = true; try { cerceve = localStorage.getItem('x_tik_cerceve') !== '0'; } catch (e) {}   // [TIK ÇERÇEVE] bayrak (x_tik_cerceve='0' kapatır)
            var arts = document.querySelectorAll('article[data-testid="tweet"]');
            for (var i = 0; i < arts.length; i++) {
                var a = arts[i];
                var grok = a.querySelector('button[aria-label^="Grok"]');
                if (!grok) continue;
                var grokWrap = grok.parentElement;
                var row = grokWrap && grokWrap.parentElement;
                if (!row) continue;
                var tEl = a.querySelector('a[href*="/status/"] time');
                var aEl = tEl && tEl.closest('a[href*="/status/"]');
                var href = aEl && aEl.getAttribute('href');
                if (!href) continue;
                var m = href.match(/\/status\/(\d+)/);
                if (!m) continue;
                var id = m[1];
                var link = 'https://x.com' + href.split('?')[0].split('#')[0];
                var gc = 'rgb(83,100,113)';   // Grok ikonunun GUNCEL rengi (tema uyumu)
                try { var gsvg = grok.querySelector('svg'); if (gsvg) { var cc = getComputedStyle(gsvg).color; if (cc) gc = cc; } } catch (e) {}
                var btn = row.querySelector('.x-gx-tik');
                if (!btn) {
                    var wrap = document.createElement('div');
                    wrap.className = (grokWrap.className || '') + ' x-gx-tik-wrap';
                    btn = document.createElement('button');
                    btn.className = 'x-gx-tik';
                    btn.type = 'button';
                    btn.setAttribute('aria-label', 'Rapor\'matik için seç');
                    btn.title = 'Rapor\'matik için seç';
                    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path></svg>';   // INLINE (undefined-degisken tuzagindan kacin)
                    btn.addEventListener('click', function (ev) {
                        ev.preventDefault(); ev.stopPropagation();
                        try { if (window.__xTikToggle) window.__xTikToggle(this.getAttribute('data-id'), this.getAttribute('data-link')); } catch (e) {}
                    }, true);
                    wrap.appendChild(btn);
                    // [SCROLL KAYMA FIX — kök-neden] Tik 34px eylem-cubugu satirini ~2px itiyor; sanallastirilmis
                    // ~70 tweet'te birikip (docH +150) X profil geri-donusunde OTOMATIK asagi-kaymaya yol aciyordu
                    // (teshis: tikN 0->10 TAM kaymayla eslesti). Cozum: tik'i Grok butonuyla AYNI yukseklige sabitle
                    // -> satir YUKSELMEZ -> tweet yuksekligi degismez -> kayma kokten gider.
                    try { var _gh = grok.getBoundingClientRect().height; if (_gh > 12 && _gh < 60) { var _gp = Math.round(_gh) + 'px'; btn.style.height = _gp; btn.style.width = _gp; btn.style.minWidth = _gp; } } catch (e) {}
                    row.insertBefore(wrap, row.firstChild);   // Grok'un SOLUNA
                }
                btn.setAttribute('data-id', id);
                btn.setAttribute('data-link', link);
                var on = !!sec[id];
                btn.style.color = on ? '#1d9bf0' : gc;
                if (on) btn.classList.add('x-gx-tik-on'); else btn.classList.remove('x-gx-tik-on');
                if (on && cerceve) a.classList.add('x-gx-tik-sec'); else a.classList.remove('x-gx-tik-sec');   // [TIK ÇERÇEVE] seçili tweet kartına mavi kenarlık
            }
        } catch (e) {}
    }
    function xTikMenu() {
        try {
            if (window.__xGxCaptureAktif) return;   // [SS KADRAJ] yakalama sirasinda menuyu olusturma/dokunma (CSS zaten display:none)
            var bar = document.getElementById('x-gx-tik-bar');
            if (!xTikHostX()) { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); return; }
            var sec = window.__xTikSecili || {};
            var n = 0; for (var k in sec) { if (Object.prototype.hasOwnProperty.call(sec, k)) n++; }
            if (n === 0) { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); return; }
            if (!bar) {
                xTikStilKur();
                bar = document.createElement('div');
                bar.id = 'x-gx-tik-bar';
                bar.innerHTML =
                    '<div class="x-gx-tik-sayac" id="x-gx-tik-n">0</div>'
                  + '<div class="x-gx-tik-mesaj"><div class="x-gx-tik-bas" id="x-gx-tik-bas">0 gönderi seçildi</div><div class="x-gx-tik-alt">Rapor\'matik linklerine eklendi</div></div>'
                  + '<button type="button" class="x-gx-tik-iptal" id="x-gx-tik-iptal">İptal</button>'
                  + '<button type="button" class="x-gx-tik-git" id="x-gx-tik-git">Rapor\'matik\'e Git <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 12h12M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"></path></svg></button>';
                document.body.appendChild(bar);
                var ib = bar.querySelector('#x-gx-tik-iptal');
                if (ib) ib.addEventListener('click', function (ev) {
                    ev.preventDefault(); ev.stopPropagation();
                    // İptal: tik secimini SIFIRLA (tikler griler + menu kapanir) AMA linkler Rapor'matik'te KALIR.
                    try { window.__xTikSecili = {}; } catch (e) {}
                    try { chrome.storage.local.set({ x_secili_tweetler: [] }); } catch (e) {}   // onChanged: tum X sekmeleri sifirlanir
                    try { chrome.runtime.sendMessage({ action: 'tikPanelReset' }, function () { if (chrome.runtime.lastError) {} }); } catch (e) {}   // panel xWidgetTikLinks=[] (kuyruk KALIR)
                    if (window.__xTikBoya) window.__xTikBoya();
                    if (window.__xTikMenu) window.__xTikMenu();
                }, true);
                var gb = bar.querySelector('#x-gx-tik-git');
                if (gb) gb.addEventListener('click', function (ev) {
                    ev.preventDefault(); ev.stopPropagation();
                    var s = window.__xTikSecili || {}; var arr = [];
                    for (var kk in s) { if (Object.prototype.hasOwnProperty.call(s, kk)) arr.push(s[kk]); }
                    try { chrome.runtime.sendMessage({ action: 'tikPaneleGit', links: arr }, function () { if (chrome.runtime.lastError) {} }); } catch (e) {}
                }, true);
                requestAnimationFrame(function () { var b = document.getElementById('x-gx-tik-bar'); if (b) b.classList.add('x-gx-tik-bar-in'); });
            }
            var nn = bar.querySelector('#x-gx-tik-n'); if (nn) nn.textContent = n;
            var bb = bar.querySelector('#x-gx-tik-bas'); if (bb) bb.textContent = n + ' gönderi seçildi';
        } catch (e) {}
    }
    function xTikInit() {
        // Her enjeksiyonda GUNCEL fonksiyonlari window'a bagla (IIFE yeni URL'de yeniden calisir).
        window.__xTikBoya = xTikBoya;
        window.__xTikMenu = xTikMenu;
        window.__xTikToggle = function (id, link) {
            try {
                if (!id) return;
                window.__xTikSecili = window.__xTikSecili || {};
                if (window.__xTikSecili[id]) delete window.__xTikSecili[id];
                else window.__xTikSecili[id] = link || '';
                var arr = [];
                for (var k in window.__xTikSecili) { if (Object.prototype.hasOwnProperty.call(window.__xTikSecili, k)) arr.push({ id: k, link: window.__xTikSecili[k] }); }
                try { chrome.storage.local.set({ x_secili_tweetler: arr }); } catch (e) {}
                try { chrome.runtime.sendMessage({ action: 'tikSecimSenkron', links: arr.map(function (x) { return x.link; }) }, function () { if (chrome.runtime.lastError) {} }); } catch (e) {}
                if (window.__xTikBoya) window.__xTikBoya();
                if (window.__xTikMenu) window.__xTikMenu();
            } catch (e) {}
        };
        // BIR KEZ (window bayragi): durum yukle + depo dinleyici + yedek interval.
        if (!window.__xTikKuruldu) {
            window.__xTikKuruldu = true;
            window.__xTikSecili = window.__xTikSecili || {};
            var _ty = function () { try { if (window.__xTikBoya) window.__xTikBoya(); if (window.__xTikMenu) window.__xTikMenu(); } catch (e) {} };
            try {
                chrome.storage.local.get(['x_secili_tweetler'], function (r) {
                    try { ((r && r.x_secili_tweetler) || []).forEach(function (it) { if (it && it.id) window.__xTikSecili[it.id] = it.link || ''; }); } catch (e) {}
                    _ty();
                });
            } catch (e) {}
            try {
                chrome.storage.onChanged.addListener(function (ch, area) {
                    if (area !== 'local' || !ch.x_secili_tweetler) return;
                    window.__xTikSecili = {};
                    try { (ch.x_secili_tweetler.newValue || []).forEach(function (it) { if (it && it.id) window.__xTikSecili[it.id] = it.link || ''; }); } catch (e) {}
                    _ty();
                });
            } catch (e) {}
            setInterval(_ty, 800);
            // [TIK ÇERÇEVE git-gel FIX v2] X, tweet'e HOVER edince article className'ini React ile YENİDEN YAZIYOR
            // -> eklediğimiz .x-gx-tik-sec SINIFI siliniyor -> çerçeve kayboluyor, 800ms sonra (interval) geri geliyor = git-gel.
            // (outline->box-shadow değişimi işe YARAMADI: sorun CSS DEĞİL, sınıfın SİLİNMESİ.) Çözüm: article class'ı
            // değişince (React yazar yazmaz) seçili tweet'e sınıfı ANINDA geri koy — observer mutasyondan SONRA çalışır, React'i yener.
            try {
                if (window.MutationObserver) {
                    window.__xTikCercMo = new MutationObserver(function (muts) {
                        try {
                            if (window.__xGxCaptureAktif) return;
                            var sec = window.__xTikSecili || {};
                            var bos = true; for (var _bk in sec) { if (Object.prototype.hasOwnProperty.call(sec, _bk)) { bos = false; break; } }
                            if (bos) return;   // seçim yoksa hiç iş yapma (X'in yoğun DOM'unda ucuz kalsın)
                            var cerceve = true; try { cerceve = localStorage.getItem('x_tik_cerceve') !== '0'; } catch (e) {}
                            if (!cerceve) return;
                            for (var i = 0; i < muts.length; i++) {
                                var t = muts[i].target;
                                if (!t || t.nodeType !== 1 || !t.classList || !t.matches) continue;
                                if (!t.matches('article[data-testid="tweet"]')) continue;
                                if (t.classList.contains('x-gx-tik-sec')) continue;   // zaten var -> dokunma (sonsuz döngü yok)
                                var tEl = t.querySelector('a[href*="/status/"] time');
                                var aEl = tEl && tEl.closest('a[href*="/status/"]');
                                var href = aEl && aEl.getAttribute('href');
                                var mm = href && href.match(/\/status\/(\d+)/);
                                if (mm && sec[mm[1]]) t.classList.add('x-gx-tik-sec');   // React sildi -> ANINDA geri koy
                            }
                        } catch (e) {}
                    });
                    window.__xTikCercMo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
                }
            } catch (e) {}
        }
        try { xTikBoya(); } catch (e) {}
        try { xTikMenu(); } catch (e) {}
    }

    // ============ [RT LİSTE VİDEOSU] ============
    // X RT/beğeni/alıntı listesinde ORTA BLOĞU (liste) VİDEO kaydet. Tüm sekme DEĞİL: getDisplayMedia ile sekme
    // akışı alınır, canvas ile liste rect'ine KIRPILIR (Region Capture content-script'te garantisiz -> canvas-kırp
    // güvenli), MediaRecorder -> .webm indir. Oto-kaydır + Durdur + İndir. Ses yok. Yalnız X (sosyal).
    function xVideoHostX() { try { return /(^|\.)x\.com$/i.test(location.hostname) || /(^|\.)twitter\.com$/i.test(location.hostname); } catch (e) { return false; } }
    // [RT VİDEO] Tweet detay (/status/<id>) sayfası mı? Sağ-tık video modu YALNIZ burada çalışır.
    // SADECE saf tweet detayı (/status/<id>). /status/<id>/retweets|reposts|likes|quotes ALT-sayfaları HARİÇ:
    // oralarda video modu (kırmızı) başlatılamaz (tek-tweet kaydı ana tweet sayfasından başlar) -> xNavYansit red'i sıfırlar.
    function xVideoTweetDetayMi() { try { return xVideoHostX() && /\/status\/\d+/.test(location.pathname) && !/\/status\/\d+\/(retweets|reposts|likes|quotes)/i.test(location.pathname); } catch (e) { return false; } }
    // [BAŞLIK HARİÇ] X'in tepedeki yapışkan "← Gönderi" başlık barının ALT Y'si (yoksa 0). Kadrajın üst klibi
    // olarak kullanılır -> ne introda ne listede bu bar videoya girer.
    function xVideoUstBaslikAlt() {
        try {
            var col = document.querySelector('[data-testid="primaryColumn"]');
            if (!col) return 0;
            var kids = col.querySelectorAll('div');
            for (var i = 0; i < kids.length && i < 60; i++) {
                var el = kids[i];
                var st = getComputedStyle(el);
                if (st.position === 'sticky' || st.position === 'fixed') {
                    var r = el.getBoundingClientRect();
                    if (r.top <= 3 && r.height >= 24 && r.height <= 120 && r.width >= 150) return Math.round(r.bottom);
                }
            }
        } catch (e) {}
        return 0;
    }
    // [BAŞLIK GİZLE — SS GİBİ] SS yakalama (captureArticle) viewport tepesindeki küçük sticky/fixed barları
    // (← Gönderi üst barı vb.) display:none yapar; video kaydında AYNISINI yapıyoruz -> bar videoya GİRMEZ.
    // Kendi öğelerimiz (video kontrolü, nav butonu, dock) hariç. Kayıt sonunda geri açılır.
    function xVideoBarlariGizle() {
        var gizli = [];
        try {
            document.querySelectorAll('*').forEach(function (el) {
                try {
                    if (el.closest && el.closest('#x-gx-video-ctrl, #x-gx-nav-btn, #x-downloader-widget')) return;
                    var st = getComputedStyle(el);
                    if ((st.position === 'fixed' || st.position === 'sticky') && st.display !== 'none') {
                        var r = el.getBoundingClientRect();
                        if (r.top <= 15 && r.bottom > 0 && el.offsetHeight < 100) {
                            gizli.push({ el: el, d: el.style.display });
                            el.style.setProperty('display', 'none', 'important');
                        }
                    }
                } catch (e) {}
            });
        } catch (e) {}
        return gizli;
    }
    function xVideoBarlariGeri(gizli) {
        try { (gizli || []).forEach(function (h) { try { if (h.d) h.el.style.display = h.d; else h.el.style.removeProperty('display'); } catch (e) {} }); } catch (e) {}
    }
    // [ETKİLEŞİM GİZLE] Intro'da odaklı tweet'in ALT AKSİYON ÇUBUĞU (yanıt/RT/beğeni/yer işareti/paylaş) videoya
    // girmesin -> yanıt/beğeni butonunu içeren [role="group"]'u display:none. ({el,d} şekli xVideoBarlariGeri ile geri açılır.)
    function xVideoEtkilesimGizle() {
        var gizli = [];
        try {
            var art = (typeof xGxOdakliArticle === 'function') ? xGxOdakliArticle() : null;
            if (!art) return gizli;
            var k = art.querySelector('[data-testid="reply"], [data-testid="like"], [data-testid="unlike"], [data-testid="retweet"], [data-testid="unretweet"]');
            var ab = k && (k.closest('[role="group"]') || (k.parentElement && k.parentElement.parentElement));
            if (ab && art.contains(ab)) { gizli.push({ el: ab, d: ab.style.display }); ab.style.setProperty('display', 'none', 'important'); }
        } catch (e) {}
        return gizli;
    }
    // [ALAKALI/ALINTILAR SATIRI GİZLE] Intro'da odaklı tweetin EN ALTINDAKİ "Alakalı ⌄ ... Alıntıları görüntüle >"
    // satırı (quotes çubuğu) + varsa "Alakalı kişiler" (Relevant people) UserCell modülü videoya girmesin.
    // YALNIZ tweet detayda (intro) çağrılır -> reposts listesini vurmaz.
    function xVideoAlakaliGizle() {
        var gizli = [];
        try {
            if (/\/status\/\d+\/(retweets|reposts|likes|quotes)/i.test(location.pathname)) return gizli;   // alt-sayfalarda DOKUNMA
            var art = (typeof xGxOdakliArticle === 'function') ? xGxOdakliArticle() : null;
            if (!art) return gizli;
            function gizle(el) {
                try {
                    if (!el || !art.contains(el)) return;
                    // satır konteyneri: YÜKSEKLİK-tabanlı -> yukarı çık ama yalnız BİR SATIR boyu kal (<=64px);
                    // tweet içerik bloğu yüzlerce px olduğundan ONA GENİŞLEMEZ (eski genişlik-tabanlı koca bloğu siliyordu).
                    var p = el, row = el;
                    for (var d = 0; d < 9 && p && p !== art && p.parentElement; d++) {
                        var h = 0; try { h = p.getBoundingClientRect().height; } catch (e) {}
                        if (h > 64) break;
                        row = p; p = p.parentElement;
                    }
                    if (row && row !== art && art.contains(row) && row.style.display !== 'none') { gizli.push({ el: row, d: row.style.display }); row.style.setProperty('display', 'none', 'important'); }
                } catch (e) {}
            }
            var q = art.querySelector('a[href*="/quotes"]'); if (q) gizle(q);   // "Alıntıları görüntüle" quotes linki -> satır
            var sp = art.querySelectorAll('span,a,button,div');
            for (var i = 0; i < sp.length && i < 700; i++) {
                if (sp[i].children.length) continue;
                var tx = (sp[i].textContent || '').trim().toLowerCase();
                if (tx === 'alakalı' || tx === 'alıntıları görüntüle' || tx === 'alıntıları gör' || tx === 'en son') gizle(sp[i]);
            }
            // "Alakalı kişiler" (Relevant people) UserCell modülü de (modal dışı)
            var cells = art.parentElement ? art.parentElement.querySelectorAll('[data-testid="UserCell"]') : [];
            for (var j = 0; j < cells.length; j++) {
                if (cells[j].closest('[aria-modal="true"]')) continue;
                var blok = (cells[j].closest && cells[j].closest('[data-testid="cellInnerDiv"]')) || cells[j].parentElement;
                if (blok && blok.style.display !== 'none') { gizli.push({ el: blok, d: blok.style.display }); blok.style.setProperty('display', 'none', 'important'); }
            }
        } catch (e) {}
        return gizli;
    }
    // Video kontrolünü (#x-gx-video-ctrl) kayıt (nav) butonunun TAM ALT HİZASINDA + AYNI BOYUTTA konumla.
    // Nav butonu sol rayda olduğundan altı da içerik sütununun solunda kalır -> videoya girmez (+ olc sol-klip emniyet).
    function xVideoCtrlKonumla(ctrl) {
        try {
            if (!ctrl) return;
            var nav = document.getElementById('x-gx-nav-ekle') || document.getElementById('x-gx-nav-btn');
            if (!nav) return;
            var r = nav.getBoundingClientRect();
            var sz = Math.round(r.width) || 40;   // nav ile AYNI boyut
            var btns = ctrl.querySelectorAll('.x-gx-video-ikon');
            for (var i = 0; i < btns.length; i++) { btns[i].style.width = sz + 'px'; btns[i].style.height = sz + 'px'; var _ic = btns[i].querySelector('.x-gx-ssico'); if (_ic) { var gs = Math.round(sz * 0.6); _ic.style.width = gs + 'px'; _ic.style.height = gs + 'px'; } }
            ctrl.style.left = Math.round(r.left + r.width / 2 - sz / 2) + 'px';   // nav MERKEZİYLE hizalı (tam alt)
            ctrl.style.top = Math.round(r.bottom + 6) + 'px';
            ctrl.style.right = 'auto'; ctrl.style.bottom = 'auto';
        } catch (e) {}
    }
    // Video kontrolü için SADECE-İKON buton (kayıt butonu tarzı; metin yok). renk = ikon rengi (currentColor).
    function xVideoIkonBtn(tur, baslik, renk, onClick) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'x-gx-video-ikon'; b.title = baslik; b.setAttribute('aria-label', baslik);
        if (renk) b.style.color = renk;
        b.appendChild(_xGxSsIkon(tur));
        b.addEventListener('click', onClick);
        return b;
    }
    // [RT VİDEO] Sol-nav yeşil butonun video modundaki sol-tık eylemi: RT listesi videosunu başlat.
    function xVideoBaslatNav() {
        try {
            if (window.__xVideoKayitAktif) { xVideoToast("Zaten kayıt sürüyor."); return; }
            xVideoStil();
            var ctrl = document.getElementById('x-gx-video-ctrl');
            if (!ctrl) { ctrl = document.createElement('div'); ctrl.id = 'x-gx-video-ctrl'; document.documentElement.appendChild(ctrl); }
            xVideoBaslat(ctrl);
        } catch (e) {}
    }
    // [RT VİDEO] Butonu video moduna sok / normale döndür: class (renk CSS'ten) + İKONU değiştir (ekle "+" <-> kayit "nokta").
    function xNavVideoModToggle(btn) {
        try {
            var acik = btn.classList.toggle('x-gx-videomod');
            btn.__userVideoMode = acik;   // [DURUM] kullanıcı sağ-tık toggle'ı -> xNavYansit bu durumu korur (kayıt yokken saf tweet detayında kırmızı kalır)
            var ic = btn.querySelector('.x-gx-tw-ic');
            if (ic) { while (ic.firstChild) ic.removeChild(ic.firstChild); ic.appendChild(_xGxSsIkon(acik ? 'kayit' : 'ekle')); }
            var tip = btn.__tip;
            if (acik) {
                if (tip) tip.textContent = "Video modu: TIKLA = RT listesi videosu · sağ-tık = geri";
                xVideoToast("Video modu — tıkla: RT listesi videosu kaydet");
            } else {
                if (tip) tip.textContent = "Bu paylaşımı GörüntüX Raporu'na ekle!";
                xVideoToast("SS moduna dönüldü");
            }
        } catch (e) {}
    }
    function xVideoSayfaMi() {
        try {
            if (!xVideoHostX()) return false;
            if (/\/status\/\d+\/(retweets|likes|quotes)/i.test(location.pathname)) return true;
            return !!document.querySelector('[aria-modal="true"] [data-testid="UserCell"]');
        } catch (e) { return false; }
    }
    // Bir UserCell'in verilen sınır içindeki KAYDIRILABİLİR atasını bul (yoksa null).
    function xVideoKaydirKap(cell, sinir) {
        var el = cell.parentElement, kap = null;
        while (el && el !== sinir && el.parentElement && el !== document.body) {
            try { var st = getComputedStyle(el); if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 6) { kap = el; break; } } catch (e) {}
            el = el.parentElement;
        }
        return kap;
    }
    // Orta blok (kırpılacak = kaydırılan liste kabı). KRİTİK: UserCell YALNIZ reposts MODAL'ı ya da gerçek
    // /retweets SAYFASI içinden alınır. Tweet detay sayfasının KENAR ÇUBUĞUNDAKİ stray UserCell ("İlgili
    // kişiler"/"Takip önerileri") ASLA kullanılmaz -> yoksa tüm detay sayfası (yorumlar) aşağı sürüklenir. Bulunamazsa null = abort.
    function xVideoListeBul() {
        try {
            // 1) Reposts MODAL'ı (en yaygın): modal içi kaydırma kabı.
            var modal = document.querySelector('[aria-modal="true"]');
            if (modal) {
                var mcell = modal.querySelector('[data-testid="UserCell"]');
                if (mcell) {
                    var kap = xVideoKaydirKap(mcell, modal);
                    if (!kap) { try { if (modal.scrollHeight > modal.clientHeight + 6) kap = modal; } catch (e) {} }
                    if (kap) return { kadraj: kap, scroll: kap };
                }
            }
            // 2) Tam /retweets SAYFASI (modal yok ama URL /retweets + primaryColumn'da UserCell): sayfa=liste, yorum YOK.
            if (/\/status\/\d+\/(retweets|reposts)/i.test(location.pathname)) {
                var col = document.querySelector('[data-testid="primaryColumn"]');
                var pcell = col && col.querySelector('[data-testid="UserCell"]');
                if (pcell) {
                    var kap2 = xVideoKaydirKap(pcell, col);
                    // kadraj = primaryColumn (tüm sütun) -> "Gönderi etkinliği" başlığı + "Yeniden gönderiler/Alıntılar"
                    // tabları KADRAJDA kalır (kullanıcı istedi); scroll iç kap ya da sayfa.
                    return { kadraj: col, scroll: (kap2 || document.scrollingElement || document.documentElement) };
                }
            }
            return null;   // ne modal ne /retweets sayfası -> abort (SAYFA kaydırılmaz)
        } catch (e) { return null; }
    }
    function xVideoInit() {
        if (!xVideoHostX()) return;
        if (window.__xVideoKuruldu) return;
        window.__xVideoKuruldu = true;
        // [TETİK] Toolbar (Chrome eklenti) butonu X tweet (status) sayfasında -> background 'xVideoGoster' mesajı -> kontrolü göster.
        try { chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) { try { if (msg && msg.action === 'xVideoGoster') xVideoGoster(); else if (msg && msg.action === 'videomatikKomut' && msg.links) xVideomatikHazirla(msg.links); } catch (e) {} }); } catch (e) {}
    }
    function xVideoBekle(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
    // Odaklı (ana) tweet = TEK-SS aracının yakaladığı AYNI article (xGxOdakliArticle: URL /status/<id> ile
    // kendi permalink zaman-damgası eşleşen article). Böylece intro kadrajı = SS SINIRI = yalnız odaklı tweet;
    // YORUMLAR ayrı article'larda kaldığından video kadrajına ASLA giremez (olc() kadrajEl sınırına kırpar).
    function xVideoAnaTweet() {
        try {
            var odak = (typeof xGxOdakliArticle === 'function') ? xGxOdakliArticle() : null;
            if (odak) { var tx0 = odak.querySelector('[data-testid="tweetText"]'); return { el: odak, len: tx0 ? ((tx0.textContent || '').trim().length) : 40 }; }
            // yedek (xGxOdakliArticle yoksa): time bir <a> İÇİNDE DEĞİL (yanıtlar elenir).
            var arts = document.querySelectorAll('article[data-testid="tweet"]');
            for (var i = 0; i < arts.length; i++) {
                var t = arts[i].querySelector('time');
                if (t && t.closest && !t.closest('a')) {
                    var tx = arts[i].querySelector('[data-testid="tweetText"]');
                    return { el: arts[i], len: tx ? ((tx.textContent || '').trim().length) : 40 };
                }
            }
        } catch (e) {}
        return null;
    }
    function xVideoGoster() {
        try {
            if (window.__xVideoKayitAktif) return;
            xVideoStil();
            var ctrl = document.getElementById('x-gx-video-ctrl');
            if (!ctrl) { ctrl = document.createElement('div'); ctrl.id = 'x-gx-video-ctrl'; document.documentElement.appendChild(ctrl); }
            ctrl.setAttribute('data-mod', 'bas');
            while (ctrl.firstChild) ctrl.removeChild(ctrl.firstChild);
            var ana = xVideoAnaTweet();
            var info = document.createElement('div'); info.className = 'x-gx-video-info';
            info.textContent = ana ? 'RT listesi videosu: önce ana tweet, sonra liste' : 'Ana tweet sayfasında aç';
            var b = document.createElement('button'); b.type = 'button'; b.className = 'x-gx-video-bas'; b.textContent = '⏺ Kaydet';
            b.addEventListener('click', function () { try { xVideoBaslat(ctrl); } catch (e) {} });
            var kapat = document.createElement('button'); kapat.type = 'button'; kapat.className = 'x-gx-video-bas'; kapat.style.background = '#1c2732'; kapat.textContent = '✕ Kapat';
            kapat.addEventListener('click', function () { try { ctrl.remove(); } catch (e) {} });
            ctrl.appendChild(info); ctrl.appendChild(b); ctrl.appendChild(kapat);
        } catch (e) {}
    }
    // Repost (RT) listesini aç. "Açık" SAYILMA koşulu: reposts MODAL'ı VEYA gerçek /retweets SAYFASI
    // (sayfadaki stray UserCell DEĞİL -> yoksa kenar çubuğu yüzünden hiç navige olmuyordu). Değilse ODAKLI
    // tweet'in reposts sayısı linkine tıkla (yoksa /retweets URL push) -> modal/sayfa + UserCell bekle.
    function xVideoRepostAc(cb) {
        function _acikMi() {
            try {
                if (document.querySelector('[aria-modal="true"] [data-testid="UserCell"]')) return true;
                if (/\/status\/\d+\/(retweets|reposts)/i.test(location.pathname) && document.querySelector('[data-testid="primaryColumn"] [data-testid="UserCell"]')) return true;
            } catch (e) {}
            return false;
        }
        try {
            if (_acikMi()) { cb(true); return; }
            var odak = (typeof xGxOdakliArticle === 'function') ? xGxOdakliArticle() : null;   // linki ODAKLI tweet'ten al (yanıtınkinden değil)
            var a = (odak && (odak.querySelector('a[href$="/retweets"]') || odak.querySelector('a[href$="/reposts"]')))
                 || document.querySelector('a[href$="/retweets"], a[href$="/reposts"]');
            if (a) { try { a.click(); } catch (e) {} }
            else { try { var yeni = location.pathname.replace(/\/$/, '') + '/retweets'; history.pushState(null, '', yeni); window.dispatchEvent(new PopStateEvent('popstate')); } catch (e) {} }
            var dn = 0;
            var iv = setInterval(function () {
                dn++;
                if (_acikMi()) { clearInterval(iv); cb(true); }
                else if (dn > 50) { clearInterval(iv); cb(false); }   // ~7.5sn
            }, 150);
        } catch (e) { cb(false); }
    }
    function xVideoStil() {
        if (document.getElementById('x-gx-video-style')) return;
        var st = document.createElement('style'); st.id = 'x-gx-video-style';
        st.textContent = [
            // SADECE-İKON kontroller: sol nav butonunun altında, dar kolon (metin/kutular YOK).
            '#x-gx-video-ctrl{position:fixed;left:16px;top:120px;z-index:2147483600;display:flex;flex-direction:column;gap:6px;align-items:center;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;width:auto;}',
            // [SADE] DOLU daire (renk=buton rengi) + BEYAZ glyph; dış-daire çizgisi yok. Temiz "durdur" görünümü.
            '.x-gx-video-ikon{width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;border:0;background:currentColor;padding:0;border-radius:50%;cursor:pointer;color:#f4212e;box-shadow:0 2px 10px rgba(0,0,0,.3);}',
            '.x-gx-video-ikon:hover{filter:brightness(1.08);}',
            '.x-gx-video-ikon .x-gx-ssico{display:block;width:24px;height:24px;overflow:visible;}',
            '.x-gx-video-ikon .x-gx-ssico .c{display:none;}',
            '.x-gx-video-ikon .x-gx-ssico .in{fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
            '.x-gx-video-ikon .x-gx-ssico .in rect{fill:#fff;stroke:none;}',
            // [VIDEO'MATIK PROMPT] eski küçük sağ-alt buton yerine ORTADA büyük "Kaydı Başlat" prompt (getDisplayMedia jesti).
            '#x-gx-vm-prompt{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;}',
            '.x-gx-vmp-card{width:100%;max-width:380px;background:#15202b;border:1px solid #2f3b47;border-radius:18px;padding:30px 26px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.6);}',
            '.x-gx-vmp-logo{width:52px;height:52px;margin:0 auto 14px;}',
            '.x-gx-vmp-logo svg{display:block;width:52px;height:52px;}',
            '.x-gx-vmp-baslik{font-size:19px;font-weight:800;color:#e7e9ea;margin-bottom:6px;}',
            '.x-gx-vmp-alt{font-size:13px;color:#8899a6;line-height:1.5;margin-bottom:20px;}',
            '.x-gx-vmp-btn{width:100%;padding:14px;border:0;border-radius:12px;background:#f4212e;color:#fff;font-size:16px;font-weight:800;cursor:pointer;box-shadow:0 6px 20px rgba(244,33,46,.4);display:flex;align-items:center;justify-content:center;gap:9px;}',
            '.x-gx-vmp-btn:hover{filter:brightness(1.08);}',
            '.x-gx-vmp-btn .pt{width:12px;height:12px;border-radius:50%;background:#fff;}',
            '.x-gx-vmp-iptal{margin-top:10px;width:100%;padding:9px;border:0;border-radius:10px;background:transparent;color:#8899a6;font-size:13px;cursor:pointer;}',
            '.x-gx-vmp-iptal:hover{color:#e7e9ea;}'
        ].join('');
        (document.head || document.documentElement).appendChild(st);
    }
    function xVideoBtnGuncelle() {
        if (window.__xGxCaptureAktif || window.__xVideoKayitAktif) return;   // yakalama/kayıt sırasında dokunma
        var ctrl = document.getElementById('x-gx-video-ctrl');
        if (!xVideoSayfaMi()) { if (ctrl) { try { ctrl.remove(); } catch (e) {} } return; }
        if (ctrl && ctrl.getAttribute('data-mod') === 'bas') return;
        if (ctrl && ctrl.getAttribute('data-mod') === 'bitti') return;   // "İndir" ekranını ezme
        xVideoStil();
        if (!ctrl) { ctrl = document.createElement('div'); ctrl.id = 'x-gx-video-ctrl'; document.documentElement.appendChild(ctrl); }
        ctrl.setAttribute('data-mod', 'bas');
        while (ctrl.firstChild) ctrl.removeChild(ctrl.firstChild);
        var b = document.createElement('button'); b.type = 'button'; b.className = 'x-gx-video-bas'; b.textContent = '⏺ Liste Videosu Kaydet';
        b.addEventListener('click', function () { try { xVideoBaslat(ctrl); } catch (e) {} });
        ctrl.appendChild(b);
    }
    async function xVideoBaslat(ctrl) {
        if (window.__xVideoKayitAktif) return;
        var ana = xVideoAnaTweet();   // intro için ana tweet; yoksa faz 1 atlanır, doğrudan listeye geçilir
        var stream;
        try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false, preferCurrentTab: true }); }
        catch (e) { xVideoToast('Kayıt iptal edildi / başlatılamadı.', true); return; }
        window.__xVideoKayitAktif = true;
        try { window.__xVideoScrollStop = false; } catch (e) {}   // önceki kaydın durdur() bayrağı yeni FAZ 1 pan'ını atlatmasın
        var vid = document.createElement('video'); vid.muted = true; vid.playsInline = true; vid.srcObject = stream;
        try { await vid.play(); } catch (e) {}
        await new Promise(function (res) { if (vid.videoWidth) { res(); return; } vid.onloadedmetadata = function () { res(); }; setTimeout(res, 1400); });
        var cnv = document.createElement('canvas'); var cx = cnv.getContext('2d');
        var kadrajEl = (ana && ana.el) || null;   // FAZ 1 hedef = ana tweet; FAZ 2'de liste bloğuna geçer
        var ustKlip = 0;   // [BAŞLIK HARİÇ] kadrajın ÜST sınırını bu Y'nin altına kıstır -> liste fazında "← Gönderi" + modal başlığı kadraja girmez.
        var _barGizli = [];   // gizlenen barlar + etkileşim çubuğu (rec.onstop + FAZ 2'de geri açılır)
        function olc() {
            var r = kadrajEl ? kadrajEl.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
            var vw = vid.videoWidth || window.innerWidth, vh = vid.videoHeight || window.innerHeight;
            var sX = vw / Math.max(1, window.innerWidth), sY = vh / Math.max(1, window.innerHeight);
            var L = Math.max(0, r.left), T = Math.max(ustKlip, Math.max(0, r.top)), R = Math.min(window.innerWidth, r.right), B = Math.min(window.innerHeight, r.bottom);
            // [TOOLKIT HARİÇ] kayıt kontrol kutusu (#x-gx-video-ctrl) normalde kadrajın solunda (nav altı) kalır;
            // dar düzende kadraja girerse videoda görünür -> dikey örtüşüyorsa sol kenarı kontrolün sağına çek
            // (sadece soldaki boşluk+kontrol kırpılır; liste avatarları sağda korunur).
            try {
                var vc = document.getElementById('x-gx-video-ctrl');
                if (vc && vc.firstChild) { var vr = vc.getBoundingClientRect(); if (vr.width > 0 && vr.bottom > T && vr.top < B && vr.right > L && vr.left < R) L = Math.min(R, vr.right + 3); }
            } catch (e) {}
            if (B < T) B = T;
            return { sx: L * sX, sy: T * sY, sw: Math.max(1, (R - L) * sX), sh: Math.max(1, (B - T) * sY) };
        }
        function canvasBoyutla() {   // [SABİT BOYUT] canvas DAİMA "RT liste boyutu" (içerik sütunu × görünür yükseklik); faz değişse de SABİT kalır -> video hep aynı ölçü. Küçük tweet introsunda kalan alan beyaz (ciz contain+beyaz).
            var vw = vid.videoWidth || window.innerWidth, vh = vid.videoHeight || window.innerHeight;
            var sX = vw / Math.max(1, window.innerWidth), sY = vh / Math.max(1, window.innerHeight);
            var L = 0, R = window.innerWidth; try { var _col = document.querySelector('[data-testid="primaryColumn"]'); if (_col) { var _cr = _col.getBoundingClientRect(); L = Math.max(0, _cr.left); R = Math.min(window.innerWidth, _cr.right); } } catch (e) {}
            var sw = Math.max(1, (R - L) * sX), sh = Math.max(1, window.innerHeight * sY);
            var maxW = 820, k = Math.min(1, maxW / sw);
            cnv.width = Math.max(2, Math.round(sw * k)); cnv.height = Math.max(2, Math.round(sh * k));
        }
        // [GENİŞLEME FIX] Kayıt BAŞLAMADAN önce her şeyi oturt: uzun metni aç, ana tweeti çerçevele, üst barları +
        // ETKİLEŞİM çubuğunu (beğeni/yorum) gizle, Chrome paylaşım çubuğu + bar-gizleme reflow'u otursun diye bekle
        // -> başlangıçtaki "hafif genişleme"/zıplama kayda GİRMEZ.
        try { if (kadrajEl && typeof window.xTweetMetniAc === 'function') window.xTweetMetniAc(); } catch (e) {}
        try { _barGizli = xVideoBarlariGizle().concat(xVideoEtkilesimGizle()); } catch (e) {}
        try { if (kadrajEl) _barGizli = _barGizli.concat(xVideoAlakaliGizle()); } catch (e) {}   // intro: tweet altı "Alakalı kişiler" modülü gizle
        if (kadrajEl) { try { kadrajEl.scrollIntoView({ block: 'start' }); } catch (e) {} }
        await xVideoBekle(700);
        if (!window.__xVideoKayitAktif) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} return; }
        canvasBoyutla();
        var raf = 0, calisiyor = true, _dondur = false;   // _dondur: FAZ geçişinde canlı akışı ÇİZME (beyaz flaş fix) -> canvas son kareyi donmuş tutar
        var _fc = document.createElement('canvas'), _fcx = _fc.getContext('2d'), _fadeT = 0, _fadeDur = 520, _recT0 = 0, _splitler = [];   // [GEÇİŞ CROSSFADE] + [OTO-BÖL] her geçiş (tweet<->liste) anını _splitler'e yaz -> düzenleyici oto böler
        function _fadeBaslat() { try { _fc.width = cnv.width; _fc.height = cnv.height; _fcx.clearRect(0, 0, _fc.width, _fc.height); _fcx.drawImage(cnv, 0, 0); var _now = (window.performance && performance.now) ? performance.now() : Date.now(); _fadeT = _now; if (_recT0) { try { _splitler.push((_now - _recT0) / 1000); } catch (e2) {} } } catch (e) { _fadeT = 0; } }
        function ciz() { if (!calisiyor) return; if (!_dondur) { var c = olc(); try { var _fd = false, _a = 1; if (_fadeT) { _a = (((window.performance && performance.now) ? performance.now() : Date.now()) - _fadeT) / _fadeDur; if (_a < 1) { _fd = true; } else { _fadeT = 0; _a = 1; } } if (_fd) { cx.drawImage(_fc, 0, 0, cnv.width, cnv.height); } else { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, cnv.width, cnv.height); } var ar = c.sw / Math.max(1, c.sh); var dw = cnv.width, dh = Math.round(dw / ar); if (dh > cnv.height) { dh = cnv.height; dw = Math.round(dh * ar); } if (_fd) { cx.save(); cx.globalAlpha = _a; } cx.drawImage(vid, c.sx, c.sy, c.sw, c.sh, Math.round((cnv.width - dw) / 2), 0, dw, dh); if (_fd) { cx.restore(); } } catch (e) {} } raf = requestAnimationFrame(ciz); }
        ciz();
        var cstream = cnv.captureStream(15);   // [KÜÇÜK DOSYA] 15fps
        var mime = 'video/webm';
        try { if (window.MediaRecorder && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) mime = 'video/webm;codecs=vp9'; } catch (e) {}
        var rec;
        try { rec = new MediaRecorder(cstream, { mimeType: mime, videoBitsPerSecond: 1200000 }); }   // [KÜÇÜK DOSYA] 1.2Mbps
        catch (e) { try { rec = new MediaRecorder(cstream); } catch (e2) { calisiyor = false; try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e3) {} window.__xVideoKayitAktif = false; xVideoToast('Video kaydı bu tarayıcıda desteklenmiyor.', true); return; } }
        var chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        var bitti = false, _kullaniciDurdurdu = false;
        function durdur() { if (bitti) return; bitti = true; try { window.__xVideoScrollStop = true; } catch (e) {} try { if (window.__xVideoScrollIv) clearInterval(window.__xVideoScrollIv); } catch (e) {} try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {} }
        // [İSTEK] Kullanıcı kaydı (STOP) ya da paylaşımı (Chrome çubuğu) DURDURURSA video ASLA Videolarım'a kaydedilmez.
        function kullaniciDurdur() { _kullaniciDurdurdu = true; durdur(); }
        rec.onstop = function () {
            calisiyor = false; try { if (raf) cancelAnimationFrame(raf); } catch (e) {}
            try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
            try { xVideoBarlariGeri(_barGizli); _barGizli = []; } catch (e) {}   // gizlenen üst barları geri aç
            window.__xVideoKayitAktif = false;
            if (_kullaniciDurdurdu) { try { var _c = document.getElementById('x-gx-video-ctrl'); if (_c) _c.remove(); } catch (e) {} try { xVideoToast('Kayıt durduruldu — video kaydedilmedi.'); } catch (e) {} return; }
            var blob = new Blob(chunks, { type: 'video/webm' });
            xVideoCtrlBitti(ctrl, blob, _splitler);
        };
        try { rec.start(); } catch (e) { calisiyor = false; window.__xVideoKayitAktif = false; try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e4) {} xVideoToast('Kayıt başlamadı.', true); return; }
        window.__xVideoRec = rec; try { _recT0 = (window.performance && performance.now) ? performance.now() : Date.now(); window.__xVideoRecT0 = Date.now(); } catch (e) {}   // [OTO-BÖL] video t=0 + [SAYAÇ] canlı sayaç başlangıcı (KALICI global -> SPA geçişinde sekmez)
        try { stream.getVideoTracks()[0].addEventListener('ended', kullaniciDurdur); } catch (e) {}   // Chrome "paylaşımı durdur" -> KAYDETME
        xVideoCtrlKayit(ctrl, kullaniciDurdur);
        // --- FAZ AKIŞI: (1) ana tweet introsu (uzunluğa göre süre), (2) repostları aç + liste kaydır ---
        (async function akis() {
            try {
                if (kadrajEl) {   // FAZ 1: ana tweet INTROSU = SABİT çerçeve (çerçeveleme + bar/etkileşim gizleme rec.start ÖNCESİ yapıldı).
                    // Kadraj = odaklı tweet (olc kırpar) -> YORUMLAR + alt etkileşim çubuğu girmez. Süre = metin okuma + video varsa ~5sn.
                    ustKlip = 0;   // üst barlar gizli -> klip YOK, tweet üstü TAM görünür
                    canvasBoyutla();
                    var _vid = null; try { _vid = kadrajEl.querySelector('video'); } catch (e) {}
                    var _videoSure = 0;
                    if (_vid) { try { _vid.muted = true; var _p = _vid.play(); if (_p && _p.catch) _p.catch(function () {}); } catch (e) {} _videoSure = 5000; }   // video/GIF -> oynat + ~5sn
                    var _okuma = Math.min(10000, Math.max(2500, (ana.len || 40) * 45));   // metin uzunluğuna göre okuma süresi
                    var _ustDur = Math.min(1600, _okuma);   // üstte kısa dur (yazar + metin başı okunur)
                    await xVideoBekle(_ustDur);
                    if (!window.__xVideoKayitAktif) return;
                    // [UZUN TWEET] tweet ekrandan uzunsa ALTINI DA GÖSTER: sayfayı tweet altına kadar yavaşça pan et.
                    // crop kadrajEl=odaklı article'a bağlı -> YORUMLAR kadraja girmez. Kalan intro süresince, en az ~110px/sn.
                    try {
                        var _tsc = document.scrollingElement || document.documentElement;
                        var _ov = kadrajEl.getBoundingClientRect().bottom - window.innerHeight;
                        if (_ov > 6) {
                            var _panSure = Math.max(_okuma + _videoSure - _ustDur, _ov / 0.11);
                            var _bas = _tsc.scrollTop || 0;
                            await new Promise(function (res) {
                                var _st = 0;
                                function _pt(ts) {
                                    try {
                                        if (!window.__xVideoKayitAktif || window.__xVideoScrollStop) { res(); return; }
                                        if (!_st) { _st = ts; requestAnimationFrame(_pt); return; }
                                        var _pr = Math.min(1, (ts - _st) / _panSure);
                                        _tsc.scrollTop = _bas + _ov * _pr;
                                        if (_pr >= 1) { setTimeout(res, 500); return; }   // altta kısa dur
                                        requestAnimationFrame(_pt);
                                    } catch (e) { res(); }
                                }
                                requestAnimationFrame(_pt);
                            });
                        } else {
                            await xVideoBekle(Math.max(0, _okuma + _videoSure - _ustDur));   // kısa tweet: kalan süre sabit
                        }
                    } catch (e) {}
                    if (!window.__xVideoKayitAktif) return;
                }
                // FAZ 2: repost listesini aç. [BEYAZ FLAŞ FIX] geçiş boyunca canlı akışı ÇİZME -> canvas son kareyi
                // (ana tweet) donmuş tutar; X'in /retweets yeniden-çizimindeki anlık BEYAZ ekran kayda GİRMEZ.
                _dondur = true;
                var acildi = await new Promise(function (res) { xVideoRepostAc(res); });
                if (!window.__xVideoKayitAktif) return;
                if (!acildi) { xVideoToast('Repost listesi açılamadı.', true); durdur(); return; }
                await xVideoBekle(250);
                var liste = xVideoListeBul();
                if (!liste || !liste.kadraj) { xVideoToast('Liste bulunamadı.', true); durdur(); return; }
                kadrajEl = liste.kadraj;
                // [İSTEK] RT LİSTE SAYFASININ "Gönderi etkinliği" + "Yeniden gönderiler/Alıntılar" tab barları KALSIN
                // (videoda yer alsın) -> introda gizlenen üst barları GERİ AÇ; listede gizleme + klip YOK.
                try { xVideoBarlariGeri(_barGizli); _barGizli = []; } catch (e) {}
                ustKlip = 0;   // liste başlığı + tablar kadraja DAHİL
                try { liste.scroll.scrollTop = 0; } catch (e) {}
                await xVideoBekle(300);   // en üste dön + yerleşsin
                canvasBoyutla();   // sabit "RT liste boyutu" (değişmez)
                _fadeBaslat(); _dondur = false;   // geçiş bitti: donmuş kareden listeye yumuşak CROSSFADE
                await xVideoBekle(2000);   // [İSTEK] liste açılınca EN ÜSTTE ~2sn beklesin, sonra scroll başlasın
                xVideoOtoKaydir(liste.scroll, durdur);
            } catch (e) { durdur(); }
        })();
    }
    // ================= VIDEO'MATIK: çok-tweet -> TEK video (VideoX panelinden sürülür) =================
    // VideoX linkleri background 'videomatikKomut' ile gelir. getDisplayMedia JESTİ X sekmesinde gerektiğinden
    // widget sağ-altta kırmızı "başlat" butonu gösterir; kullanıcı tıklayınca TEK kayıt başlar ve linkler arası
    // SPA (pushState) gezinerek her tweet'in intro + /retweets listesini aynı kayda alır.
    function xVmLinkAyikla(links) {
        var out = [];
        (links || []).forEach(function (l) { try { var m = String(l).match(/(?:x|twitter)\.com\/([^\/\s?#]+)\/status\/(\d+)/i); if (m && !out.some(function (t) { return t.id === m[2]; })) out.push({ url: 'https://x.com/' + m[1] + '/status/' + m[2], id: m[2] }); } catch (e) {} });
        return out;
    }
    function xVideomatikHazirla(links) {
        try {
            if (window.__xVideoKayitAktif) { xVideoToast('Zaten kayıt sürüyor.'); return; }
            var tweets = xVmLinkAyikla(links);
            if (!tweets.length) { xVideoToast('Geçerli tweet linki yok.', true); return; }
            xVideoStil();
            // [TEK BÜYÜK PROMPT] Eski küçük sağ-alt buton yerine ORTADA büyük "Kaydı Başlat" prompt. Tıklama =
            // getDisplayMedia için gereken KULLANICI JESTİ -> preferCurrentTab ile basit "Bu sekmeyi paylaş" onayı.
            var eski = document.getElementById('x-gx-vm-prompt'); if (eski) eski.remove();
            var ov = document.createElement('div'); ov.id = 'x-gx-vm-prompt';
            var card = document.createElement('div'); card.className = 'x-gx-vmp-card';
            var logo = document.createElement('div'); logo.className = 'x-gx-vmp-logo';
            logo.innerHTML = '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="7" fill="#f4212e"/><g fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12V9h3"/><path d="M20 9h3v3"/><path d="M23 20v3h-3"/><path d="M12 23H9v-3"/></g><circle cx="16" cy="16" r="3.2" fill="#ffffff"/></svg>';
            var bas = document.createElement('div'); bas.className = 'x-gx-vmp-baslik'; bas.textContent = "Video'matik kaydına hazır";
            var alt = document.createElement('div'); alt.className = 'x-gx-vmp-alt';
            alt.innerHTML = '<b>' + tweets.length + ' tweet</b> ardı ardına taranıp tek videoda birleştirilecek. Başlatınca tarayıcı <b>"Bu sekmeyi paylaş"</b> onayı ister — onayla, gerisi otomatik olur.';
            var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'x-gx-vmp-btn';
            btn.innerHTML = '<span class="pt"></span> Kaydı Başlat';
            var iptal = document.createElement('button'); iptal.type = 'button'; iptal.className = 'x-gx-vmp-iptal'; iptal.textContent = 'Vazgeç';
            card.appendChild(logo); card.appendChild(bas); card.appendChild(alt); card.appendChild(btn); card.appendChild(iptal);
            ov.appendChild(card); document.documentElement.appendChild(ov);
            btn.addEventListener('click', function () { try { ov.remove(); } catch (e) {} xVideomatikBaslat(tweets); });
            iptal.addEventListener('click', function () { try { ov.remove(); } catch (e) {} });
            try { btn.focus(); } catch (e) {}
        } catch (e) {}
    }
    // Odaklı tweet article'ı: önce xGxOdakliArticle (permalink eşleşmeli), yoksa xVideoAnaTweet YEDEĞİ.
    // (Video'matik pushState gezinmesinde xGxOdakliArticle ara sıra null dönüyordu -> kadrajEl=null -> olc() TÜM
    //  sayfayı (nav+sidebar) kadraja alıyordu. Yedek ile kadraj HER ZAMAN tweet sütununa kırpılır.)
    function xVmOdak() { try { var a = (typeof xGxOdakliArticle === 'function') ? xGxOdakliArticle() : null; if (a) return a; var b = xVideoAnaTweet(); return (b && b.el) ? b.el : null; } catch (e) { return null; } }
    function xVmGit(url) {
        return new Promise(function (res) {
            try { var u = new URL(url); if (location.pathname !== u.pathname) { history.pushState(null, '', u.pathname); window.dispatchEvent(new PopStateEvent('popstate')); } } catch (e) {}
            var n = 0, iv = setInterval(function () { n++; var art = xVmOdak(); if (art) { clearInterval(iv); setTimeout(res, 500); } else if (n > 50) { clearInterval(iv); res(); } }, 150);
        });
    }
    async function xVideomatikBaslat(tweets) {
        if (window.__xVideoKayitAktif) return;
        var stream;
        try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false, preferCurrentTab: true }); }
        catch (e) { xVideoToast('Kayıt iptal / başlatılamadı.', true); return; }
        window.__xVideoKayitAktif = true;
        try { window.__xVideoScrollStop = false; } catch (e) {}
        var vid = document.createElement('video'); vid.muted = true; vid.playsInline = true; vid.srcObject = stream;
        try { await vid.play(); } catch (e) {}
        await new Promise(function (res) { if (vid.videoWidth) { res(); return; } vid.onloadedmetadata = function () { res(); }; setTimeout(res, 1400); });
        var cnv = document.createElement('canvas'); var cx = cnv.getContext('2d');
        var kadrajEl = null, ustKlip = 0;
        function olc() {
            var r = kadrajEl ? kadrajEl.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
            var vw = vid.videoWidth || window.innerWidth, vh = vid.videoHeight || window.innerHeight;
            var sX = vw / Math.max(1, window.innerWidth), sY = vh / Math.max(1, window.innerHeight);
            var L = Math.max(0, r.left), T = Math.max(ustKlip, Math.max(0, r.top)), R = Math.min(window.innerWidth, r.right), B = Math.min(window.innerHeight, r.bottom);
            try { var vc = document.getElementById('x-gx-video-ctrl'); if (vc && vc.firstChild) { var vr = vc.getBoundingClientRect(); if (vr.width > 0 && vr.bottom > T && vr.top < B && vr.right > L && vr.left < R) L = Math.min(R, vr.right + 3); } } catch (e) {}
            if (B < T) B = T;
            return { sx: L * sX, sy: T * sY, sw: Math.max(1, (R - L) * sX), sh: Math.max(1, (B - T) * sY) };
        }
        function canvasBoyutla() {   // [SABİT BOYUT] canvas DAİMA "RT liste boyutu" (içerik sütunu × görünür yükseklik) -> faz/tweet değişse de SABİT; küçük tweet kalanı beyaz (ciz contain+beyaz).
            var vw = vid.videoWidth || window.innerWidth, vh = vid.videoHeight || window.innerHeight;
            var sX = vw / Math.max(1, window.innerWidth), sY = vh / Math.max(1, window.innerHeight);
            var L = 0, R = window.innerWidth; try { var _col = document.querySelector('[data-testid="primaryColumn"]'); if (_col) { var _cr = _col.getBoundingClientRect(); L = Math.max(0, _cr.left); R = Math.min(window.innerWidth, _cr.right); } } catch (e) {}
            var sw = Math.max(1, (R - L) * sX), sh = Math.max(1, window.innerHeight * sY);
            var maxW = 820, k = Math.min(1, maxW / sw);
            cnv.width = Math.max(2, Math.round(sw * k)); cnv.height = Math.max(2, Math.round(sh * k));
        }
        canvasBoyutla();
        var raf = 0, calisiyor = true, _dondur = false;   // _dondur: FAZ geçişinde canlı akışı ÇİZME (beyaz flaş fix) -> canvas son kareyi donmuş tutar
        var _fc = document.createElement('canvas'), _fcx = _fc.getContext('2d'), _fadeT = 0, _fadeDur = 520, _recT0 = 0, _splitler = [];   // [GEÇİŞ CROSSFADE] + [OTO-BÖL] her geçiş (tweet<->liste) anını _splitler'e yaz -> düzenleyici oto böler
        function _fadeBaslat() { try { _fc.width = cnv.width; _fc.height = cnv.height; _fcx.clearRect(0, 0, _fc.width, _fc.height); _fcx.drawImage(cnv, 0, 0); var _now = (window.performance && performance.now) ? performance.now() : Date.now(); _fadeT = _now; if (_recT0) { try { _splitler.push((_now - _recT0) / 1000); } catch (e2) {} } } catch (e) { _fadeT = 0; } }
        function ciz() { if (!calisiyor) return; if (!_dondur) { var c = olc(); try { var _fd = false, _a = 1; if (_fadeT) { _a = (((window.performance && performance.now) ? performance.now() : Date.now()) - _fadeT) / _fadeDur; if (_a < 1) { _fd = true; } else { _fadeT = 0; _a = 1; } } if (_fd) { cx.drawImage(_fc, 0, 0, cnv.width, cnv.height); } else { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, cnv.width, cnv.height); } var ar = c.sw / Math.max(1, c.sh); var dw = cnv.width, dh = Math.round(dw / ar); if (dh > cnv.height) { dh = cnv.height; dw = Math.round(dh * ar); } if (_fd) { cx.save(); cx.globalAlpha = _a; } cx.drawImage(vid, c.sx, c.sy, c.sw, c.sh, Math.round((cnv.width - dw) / 2), 0, dw, dh); if (_fd) { cx.restore(); } } catch (e) {} } raf = requestAnimationFrame(ciz); }
        ciz();
        try { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, cnv.width, cnv.height); } catch (e) {} _dondur = true;   // [FIX] ilk tweet çerçevelenene kadar TÜM sayfayı (nav+sidebar) kaydetme -> temiz başla; akış ilk tweet'i çerçeveleyince çözer
        var cstream = cnv.captureStream(15);
        var mime = 'video/webm';
        try { if (window.MediaRecorder && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) mime = 'video/webm;codecs=vp9'; } catch (e) {}
        var rec;
        try { rec = new MediaRecorder(cstream, { mimeType: mime, videoBitsPerSecond: 1200000 }); }
        catch (e) { try { rec = new MediaRecorder(cstream); } catch (e2) { calisiyor = false; try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e3) {} window.__xVideoKayitAktif = false; xVideoToast('Video kaydı desteklenmiyor.', true); return; } }
        var chunks = [], bitti = false, _barGizli = [], _kullaniciDurdurdu = false, _recBasladi = false;
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        function _recTemizle() {   // [#8] kayıt HİÇ başlamadan durdurulursa onstop çalışmaz -> elle temizle (video kaydedilmez)
            calisiyor = false; try { if (raf) cancelAnimationFrame(raf); } catch (e) {}
            try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
            try { xVideoBarlariGeri(_barGizli); } catch (e) {}
            window.__xVideoKayitAktif = false;
            try { var _c = document.getElementById('x-gx-video-ctrl'); if (_c) _c.remove(); } catch (e) {}
            try { xVideoToast('Kayıt durduruldu — video kaydedilmedi.'); } catch (e) {}
        }
        function durdur() { if (bitti) return; bitti = true; try { window.__xVideoScrollStop = true; } catch (e) {} if (_recBasladi) { try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {} } else { _recTemizle(); } }
        // [İSTEK] Kullanıcı kaydı (STOP) ya da paylaşımı (Chrome çubuğu) DURDURURSA video ASLA Videolarım'a kaydedilmez.
        function kullaniciDurdur() { _kullaniciDurdurdu = true; durdur(); }
        rec.onstop = function () {
            calisiyor = false; try { if (raf) cancelAnimationFrame(raf); } catch (e) {}
            try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
            try { xVideoBarlariGeri(_barGizli); } catch (e) {}
            window.__xVideoKayitAktif = false;
            try { var _c = document.getElementById('x-gx-video-ctrl'); if (_c) _c.remove(); } catch (e) {}
            if (_kullaniciDurdurdu) { try { xVideoToast('Kayıt durduruldu — video kaydedilmedi.'); } catch (e) {} return; }
            var blob = new Blob(chunks, { type: 'video/webm' });
            var _trt = ''; try { var _d = new Date(); var _p = function (n) { return (n < 10 ? '0' : '') + n; }; _trt = _d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) + ' ' + _p(_d.getHours()) + '-' + _p(_d.getMinutes()) + '-' + _p(_d.getSeconds()); } catch (e) { _trt = ''; }
            var ad = ((tweets.length === 1) ? tweets[0].id : 'VideoX') + (_trt ? (' - ' + _trt) : '');   // tek link: <id> - 24 Kasım 2026 HH-MM-SS; çoklu: VideoX - tarih saat
            try { var fr = new FileReader(); fr.onload = function () { try { chrome.runtime.sendMessage({ action: 'deliverVideo', dataUrl: fr.result, name: ad, hedef: 'videox', splitler: _splitler }, function () { void chrome.runtime.lastError; }); try { chrome.runtime.sendMessage({ action: 'videoxGit' }, function () { void chrome.runtime.lastError; }); } catch (e) {} xVideoToast('Video VideoX paneline kaydedildi.'); } catch (e) {} }; fr.readAsDataURL(blob); } catch (e) {}
        };
        // [#8 BAŞTAKİ BEYAZ FIX] rec'i ŞİMDİ başlatma; ilk GERÇEK içerik (ilk tweet introsu) çizilince başlat ->
        // baştaki beyaz kayda GİRMEZ, video doğrudan tweet-detay introsuyla başlar.
        window.__xVideoRec = rec;
        function _recBaslat() {
            if (_recBasladi || bitti) return;
            try { rec.start(); } catch (e) { _recTemizle(); return; }
            _recBasladi = true;
            try { _recT0 = (window.performance && performance.now) ? performance.now() : Date.now(); window.__xVideoRecT0 = Date.now(); } catch (e) {}   // [OTO-BÖL] gerçek t=0 + [SAYAÇ] canlı sayaç başlangıcı (KALICI global)
        }
        async function _icerikAc() {   // ilk içerik: beyaz/crossfade YOK + kaydı başlat; sonrakiler: yumuşak crossfade
            if (!_recBasladi) { _dondur = false; try { await xVideoBekle(140); } catch (e) {} _recBaslat(); }
            else { _fadeBaslat(); _dondur = false; }
        }
        try { stream.getVideoTracks()[0].addEventListener('ended', kullaniciDurdur); } catch (e) {}   // Chrome "paylaşımı durdur" -> KAYDETME
        var dctrl = document.getElementById('x-gx-video-ctrl'); if (!dctrl) { dctrl = document.createElement('div'); dctrl.id = 'x-gx-video-ctrl'; document.documentElement.appendChild(dctrl); }
        xVideoCtrlKayit(dctrl, kullaniciDurdur);
        (async function akis() {
            try {
                for (var i = 0; i < tweets.length; i++) {
                    if (!window.__xVideoKayitAktif) break;
                    _dondur = true;   // [BEYAZ FLAŞ FIX] tweet'e gezinirken canlı akışı çizme (beyaz yeniden-çizim kayda girmez)
                    await xVmGit(tweets[i].url);
                    if (!window.__xVideoKayitAktif) break;
                    var art = xVmOdak();
                    try { xVideoBarlariGeri(_barGizli); } catch (e) {} _barGizli = [];
                    try { if (art && typeof window.xTweetMetniAc === 'function') window.xTweetMetniAc(); } catch (e) {}
                    try { _barGizli = xVideoBarlariGizle().concat(xVideoEtkilesimGizle()); if (art) _barGizli = _barGizli.concat(xVideoAlakaliGizle()); } catch (e) {}
                    if (art) {   // FAZ 1 intro
                        kadrajEl = art; ustKlip = 0;
                        try { art.scrollIntoView({ block: 'start' }); } catch (e) {}
                        await xVideoBekle(650); canvasBoyutla();
                        await _icerikAc();   // [#8] İLK intro: beyaz/crossfade YOK + kaydı başlat; sonraki tweetler: yumuşak CROSSFADE
                        var _v = null; try { _v = art.querySelector('video'); } catch (e) {}
                        var _vs = 0; if (_v) { try { _v.muted = true; var _p = _v.play(); if (_p && _p.catch) _p.catch(function () {}); } catch (e) {} _vs = 5000; }
                        var _tx = art.querySelector('[data-testid="tweetText"]'); var _len = _tx ? ((_tx.textContent || '').trim().length) : 40;
                        var _ok = Math.min(10000, Math.max(2500, _len * 45));
                        await xVideoBekle(Math.min(1600, _ok));
                        try { var _tsc = document.scrollingElement || document.documentElement; var _ov = art.getBoundingClientRect().bottom - window.innerHeight; if (_ov > 6 && window.__xVideoKayitAktif) { var _ps = Math.max(_ok + _vs - 1600, _ov / 0.11), _bs = _tsc.scrollTop || 0; await new Promise(function (res) { var _st = 0; function _pt(ts) { try { if (!window.__xVideoKayitAktif) { res(); return; } if (!_st) { _st = ts; requestAnimationFrame(_pt); return; } var _pr = Math.min(1, (ts - _st) / _ps); _tsc.scrollTop = _bs + _ov * _pr; if (_pr >= 1) { setTimeout(res, 500); return; } requestAnimationFrame(_pt); } catch (e) { res(); } } requestAnimationFrame(_pt); }); } else { await xVideoBekle(Math.max(0, _ok + _vs - 1600)); } } catch (e) {}
                    }
                    if (!window.__xVideoKayitAktif) break;
                    _dondur = true;   // [BEYAZ FLAŞ FIX] reposts geçişinde canlı akışı çizme
                    var acildi = await new Promise(function (res) { xVideoRepostAc(res); });   // FAZ 2 reposts
                    if (!window.__xVideoKayitAktif) break;
                    if (acildi) {
                        try { xVideoBarlariGeri(_barGizli); _barGizli = []; } catch (e) {}
                        await xVideoBekle(300);
                        var liste = xVideoListeBul();
                        if (liste && liste.kadraj) {
                            kadrajEl = liste.kadraj; ustKlip = 0;
                            try { liste.scroll.scrollTop = 0; } catch (e) {}
                            await xVideoBekle(300); canvasBoyutla();
                            await _icerikAc();   // [#8] liste: ilk içerikse kaydı başlat (crossfade yok), değilse donmuş kareden listeye CROSSFADE
                            await xVideoBekle(2000);
                            await new Promise(function (res) { xVideoOtoKaydir(liste.scroll, res); });
                        }
                    }
                }
            } catch (e) {}
            durdur();
        })();
    }
    function xVideoOtoKaydir(kap, bitir) {
        try {
            // [AKICI — TİTREMESİZ] Interval yerine requestAnimationFrame: kaydırma EKRAN TAZELEMESİYLE SENKRON ->
            // 25Hz interval'ın yarattığı sarsıntı (judder/titreme) biter. Hız dt-tabanlı (~58px/sn, çok yavaş) -> fps'ten
            // bağımsız SABİT. Her RT eden net geçer; sanallaştırma scrollTop'u zıplatırsa pos gerçek konuma çekilir.
            var el = kap || document.scrollingElement || document.documentElement;
            // [GÜVENLİK] SAYFA kökünü (documentElement/body/scrollingElement) YALNIZ gerçek /retweets SAYFASINDAYKEN
            // kaydır (orada sayfa=liste, yorum yok). Aksi halde tweet detay sayfasını yorumların içinden aşağı
            // sürüklerdik -> onun yerine güvenle bitir.
            var _kok = (el === document.scrollingElement || el === document.documentElement || el === document.body);
            if (_kok && !/\/status\/\d+\/(retweets|reposts)/i.test(location.pathname)) { try { bitir(); } catch (e) {} return; }
            var HIZ = 58, pos = el.scrollTop || 0, sonT = 0, durgun = 0;   // [%50 DAHA YAVAŞ] 230->115->58; her RT eden iyice net
            window.__xVideoScrollStop = false;
            function tik(ts) {
                try {
                    if (window.__xVideoScrollStop || !window.__xVideoKayitAktif) return;
                    if (!sonT) { sonT = ts; requestAnimationFrame(tik); return; }
                    var dt = Math.min(0.05, (ts - sonT) / 1000); sonT = ts;   // sn (cap 50ms -> sekme uyurken sıçrama yok)
                    var maxT = (el.scrollHeight || 0) - (el.clientHeight || 0);
                    if (Math.abs((el.scrollTop || 0) - pos) > 60) pos = el.scrollTop || 0;   // sanallaştırma zıplamasını yakala
                    if (pos >= maxT - 1) {
                        durgun += dt;
                        if (durgun >= 2.0) { bitir(); return; }   // ~2sn büyümezse SON (tüm RT edenler yüklenip videoya girer)
                    } else { durgun = 0; pos = Math.min(maxT, pos + HIZ * dt); el.scrollTop = pos; }
                    requestAnimationFrame(tik);
                } catch (e) {}
            }
            requestAnimationFrame(tik);
        } catch (e) {}
    }
    function xVideoCtrlKayit(ctrl, durdur) {
        try {
            xVideoStil();
            ctrl.setAttribute('data-mod', 'kayit');
            while (ctrl.firstChild) ctrl.removeChild(ctrl.firstChild);
            // SADECE-İKON: DURDUR (kırmızı). Basar basmaz toolkit KAPANIR (sonra kayıt durur + panele gider).
            ctrl.appendChild(xVideoIkonBtn('durdur', 'Kaydı durdur', '#f4212e', function () { try { ctrl.remove(); } catch (e) {} try { durdur(); } catch (e) {} }));
            xVideoCtrlKonumla(ctrl);   // sol nav butonunun ALTINA
        } catch (e) {}
    }
    function xVideoCtrlBitti(ctrl, blob, splitler) {
        // [İSTEK] X sayfasında İNDİRME YOK. Video VideoX paneline (Videolarım) gönderilir (hedef=videox -> KALICI).
        // Ad = odaklı tweet ID'li. X kontrolü kapanır.
        try { var _c = ctrl || document.getElementById('x-gx-video-ctrl'); if (_c) _c.remove(); } catch (e) {}
        try {
            var _oid = ''; try { var _oa = (typeof xGxOdakliArticle === 'function') ? xGxOdakliArticle() : null; var _om = (location.href.match(/\/status\/(\d+)/) || []); _oid = _om[1] || ''; } catch (e) {}
            var fr = new FileReader();
            fr.onload = function () {
                try {
                    var _trt = ''; try { var _d = new Date(); var _p = function (n) { return (n < 10 ? '0' : '') + n; }; _trt = _d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }) + ' ' + _p(_d.getHours()) + '-' + _p(_d.getMinutes()) + '-' + _p(_d.getSeconds()); } catch (e) { _trt = ''; }
                    var ad = (_oid ? _oid : 'VideoX') + (_trt ? (' - ' + _trt) : '');   // tek tweet: <tweetID> - 24 Kasım 2026 HH-MM-SS
                    chrome.runtime.sendMessage({ action: 'deliverVideo', dataUrl: fr.result, name: ad, hedef: 'videox', splitler: (splitler || []) }, function () { void chrome.runtime.lastError; });
                    try { chrome.runtime.sendMessage({ action: 'videoxGit' }, function () { void chrome.runtime.lastError; }); } catch (e) {}  // [İSTEK] kayıt bitince VideoX paneline yönlendir
                    xVideoToast('Video VideoX paneline (Videolarım) kaydedildi.');
                } catch (e) { xVideoToast('Video panele gönderilemedi.', true); }
            };
            fr.onerror = function () { xVideoToast('Video okunamadı.', true); };
            fr.readAsDataURL(blob);
        } catch (e) { xVideoToast('Video işlenemedi.', true); }
    }
    function xVideoToast(msg, hata) {
        try {
            var t = document.createElement('div');
            t.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);z-index:2147483640;background:' + (hata ? '#b00020' : '#1d9bf0') + ';color:#fff;font:600 13px -apple-system,Segoe UI,Arial;padding:10px 16px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);';
            t.textContent = msg; document.documentElement.appendChild(t);
            setTimeout(function () { try { t.remove(); } catch (e) {} }, 2600);
        } catch (e) {}
    }

    // Gizli dock durum değişimlerini (tarama halkası/güncelleme) nav butonuna ANLIK yansıt.
    // baslat() SPA'da yeniden çalışıp dock'u YENİDEN kurabildiğinden (satır ~634 eski dock'u siler),
    // gözlemciyi daima GÜNCEL dock düğümüne bağla (düğüm değiştiyse yeniden kur). 700ms poll zaten yedek.
    function xNavObserverKur() {
        try {
            var dock = document.getElementById('x-downloader-widget');
            if (!dock || !window.MutationObserver) return;
            if (window.__xGxNavMoNode === dock) return;   // zaten bu dock gözleniyor
            if (window.__xGxNavMo) { try { window.__xGxNavMo.disconnect(); } catch (e) {} }
            window.__xGxNavMo = new MutationObserver(function () { xNavYansit(); });
            window.__xGxNavMo.observe(dock, { attributes: true, childList: true, subtree: true, characterData: true });
            window.__xGxNavMoNode = dock;
        } catch (e) {}
    }
    function xNavButonPollerBaslat() {
        try {
            if (X_GX_DOCK_ESKI) return;
            if (window.__xGxNavPoller) return;
            window.__xGxNavPoller = true;
            xNavButonYerlestir();
            setInterval(function () { try { xNavButonYerlestir(); } catch (e) {} }, 700);
            window.addEventListener('resize', function () { try { xNavButonYerlestir(); } catch (e) {} });
            // Yeşil buton mod-poll'u TÜM X sayfalarında çalışsın (Keşfet 'ara' modu dahil; kendi içinde gate'li).
            try { xTweetButonPollerBaslat(); } catch (e) {}
        } catch (e) {}
    }
    // [#1/#4] /all'a yönlendirmeden sonra beklemedeki taramayı sürdür (widget /all'da yüklenince).
    function xProfilBeklemedekiTaramaKontrol() {
        try {
            if (!xGxAllSayfasiMi()) return;
            chrome.storage.local.get(['x_gx_pending_scan'], function (r) {
                var p = r && r.x_gx_pending_scan;
                if (!p || !p.handle) return;
                var h = xGxProfilHandle();
                if (!h || h.toLowerCase() !== String(p.handle).toLowerCase()) return;
                if (Date.now() - (p.ts || 0) > 120000) { try { chrome.storage.local.remove('x_gx_pending_scan'); } catch (e) {} return; }
                try {
                    chrome.storage.local.remove('x_gx_pending_scan', function () {
                        // timeline yüklensin diye kısa bekle, sonra tarama akışını başlat
                        setTimeout(function () { try { xProfilTaramaCalistir(p.handle, p.secim); } catch (e) {} }, 1800);
                    });
                } catch (e) {}
            });
        } catch (e) {}
    }
    function xProfilPopupGuncelle(handle, durum) {
        var card = document.getElementById('x-gx-card'); if (!card) return;
        setTimeout(function () { try { xGxPopoverKonumla(); } catch (e) {} }, 0);   // içerik/boyut değişince popover'ı yeniden yasla
        var logo = `<svg width="24" height="24" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1d9bf0"/><g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12V9h3"/><path d="M20 9h3v3"/><path d="M23 20v3h-3"/><path d="M12 23H9v-3"/><path d="M13 13l6 6M19 13l-6 6"/></g></svg>`;
        var bas = `<h3>${logo} GörüntüX Raporu</h3><p class="x-gx-sub">@${handle} profilinin tüm paylaşım, RT ve yorumları</p>`;
        if (durum.mod === 'yukleniyor') {
            card.innerHTML = bas + `<div class="x-gx-spin"><span class="d"></span> Panel durumu kontrol ediliyor…</div>`;
            return;
        }
        if (durum.mod === 'mesaj') {   // [#5] yerli alert yerine popup-içi mesaj
            card.innerHTML = bas + (durum.html || '')
                + `<div class="x-gx-act"><button class="x-gx-primary" id="x-gx-tamam">Tamam</button></div>`;
            var _tb = card.querySelector('#x-gx-tamam'); if (_tb) _tb.onclick = xProfilPopupKapat;
            return;
        }
        if (durum.mod === 'ilerleme') {   // süren işlem -> buton YOK (kapatılamaz gösterge)
            card.innerHTML = bas + (durum.html || '');
            return;
        }
        if (durum.mod === 'onay') {   // hasat sonucu -> kullanıcı onaylayınca tara
            card.innerHTML = bas + (durum.html || '')
                + `<div class="x-gx-act"><button class="x-gx-ghost" id="x-gx-iptal">Vazgeç</button>`
                + `<button class="x-gx-primary" id="x-gx-onayla">Taramayı başlat</button></div>`;
            var _ib = card.querySelector('#x-gx-iptal'); if (_ib) _ib.onclick = xProfilPopupKapat;
            var _ob = card.querySelector('#x-gx-onayla'); if (_ob) _ob.onclick = function () { try { if (durum._onayla) durum._onayla(); } catch (e) {} };
            try { card.querySelectorAll('.x-gx-tipcb').forEach(function (cb) { cb.onchange = function () { var w = card.querySelector('#x-gx-tipwarn'); if (w) w.style.display = 'none'; try { xGxPopoverKonumla(); } catch (e) {} }; }); } catch (e) {}
            return;
        }
        if (durum.mod === 'secim') {   // YEŞİL BUTON: tek popup, önce 2 seçenek (profil kartı / rapor)
            card.innerHTML = `<h3>${logo} GörüntüX</h3><p class="x-gx-sub">@${xGxKac(handle)} — ne yapmak istersin?</p>`
                + '<div class="x-gx-secler">'
                +   '<button type="button" class="x-gx-pp-opt" id="x-gx-sec-kart"><span class="x-gx-pp-ic c1"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/></svg></span><span class="x-gx-pp-tx"><b>Profil Kartı ekran görüntüsü</b><i>Yalnız profil kartını yakala → rapora ekle</i></span></button>'
                +   '<button type="button" class="x-gx-pp-opt" id="x-gx-sec-rapor"><span class="x-gx-pp-ic c2"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 3h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 13h8M8 17h5"/></svg></span><span class="x-gx-pp-tx"><b>Bu profilin GörüntüX Raporu\'nu oluştur</b><i>Takvim/tarih aralığı → tüm aktiviteyi tara</i></span></button>'
                + '</div>';
            var _sk = card.querySelector('#x-gx-sec-kart');
            if (_sk) _sk.onclick = function () { xProfilPopupKapat(); try { xProfilKartYakala(document.getElementById('x-gx-nav-ekle')); } catch (e) {} };
            var _sr = card.querySelector('#x-gx-sec-rapor');
            if (_sr) _sr.onclick = function () {
                // ŞIK GEÇİŞ (titreme fix): (1) "yukleniyor" spinner'ını HEMEN gösterme -> yalnız 220ms'de
                // hâlâ yanıt gelmezse (yavaş panel). Hızlı yanıtta secim DOĞRUDAN takvime geçer, ara-flash yok.
                // (2) fade yalnız final render'dan hemen önce tetiklenir -> içerik opak crossfade ile girer,
                // sert pop + konum sıçraması maskelenir (eskiden fade tek sefer oynayıp takvim sert geliyordu).
                var _cozuldu = false;
                var _loadTmr = setTimeout(function () { if (!_cozuldu) xProfilPopupGuncelle(handle, { mod: 'yukleniyor' }); }, 220);
                xPanelRaporDurumSorgula(handle, function (durum2) {
                    _cozuldu = true; clearTimeout(_loadTmr);
                    try { card.classList.remove('x-gx-gecis'); void card.offsetWidth; card.classList.add('x-gx-gecis'); } catch (e) {}
                    xProfilPopupGuncelle(handle, durum2);
                });
            };
            return;
        }
        if (durum.mod === 'devam') {
            var tar = xGxTarihTR(durum.sonTarihISO);
            card.innerHTML = bas
                + `<div class="x-gx-info">Panelde açık rapor bulundu${durum.ad ? ': <b>' + xGxKac(durum.ad) + '</b>' : ''}.<br>`
                + `En son içerik: <b>${tar || '—'}</b>.<br>Bu profilin <b>o tarihten bugüne</b> yeni içerikleri, raporun sonuna eklenecek.</div>`
                + `<div class="x-gx-act"><button class="x-gx-ghost" id="x-gx-iptal">Vazgeç</button>`
                + `<button class="x-gx-primary" id="x-gx-basla">Devam et ve tara</button></div>`
                + `<p class="x-gx-note">Tarama ölçülü hızda yapılır (X hız sınırına takılmamak için). İstediğin an durdurabilirsin.</p>`;
            card.querySelector('#x-gx-iptal').onclick = xProfilPopupKapat;
            card.querySelector('#x-gx-basla').onclick = function () { xProfilTaramaBaslat(handle, { mod: 'devam', sonTarihISO: durum.sonTarihISO }); };
            return;
        }
        // takvim (fresh) — varsayılan: bitiş ŞİMDİ (tarih+saat), başlangıç 1 yıl öncesi 00:00
        var bugun = xGxBugunISO();
        var _dn = new Date(); var _pp = function (n) { return (n < 10 ? '0' : '') + n; };
        var simdiDT = _dn.getFullYear() + '-' + _pp(_dn.getMonth() + 1) + '-' + _pp(_dn.getDate()) + 'T' + _pp(_dn.getHours()) + ':' + _pp(_dn.getMinutes());
        var basDT = bugun + 'T00:00';   // Başlangıç varsayılanı = BUGÜN 00:00 (popup'ın açıldığı gün; eski "1 yıl önce" kaldırıldı)
        var panelNot = (durum.panelAcik === false)
            ? `<p class="x-gx-note">Not: Panelde açık/dolu bir rapor yok; baştan rapor için tarih aralığı seç. (Devam etmek istersen önce panelde ilgili raporu aç.)</p>` : '';
        card.innerHTML = bas
            + `<div class="x-gx-info">Baştan rapor: taranacak <b>tarih+saat aralığını</b> seç. Seçilen aralık <b>eskiden yeniye</b> raporlanır (önce profil kartı).</div>`
            + `<div class="x-gx-row"><div style="flex:1"><label>Başlangıç</label><input type="datetime-local" id="x-gx-bas" max="${simdiDT}" value="${basDT}"></div>`
            + `<div style="flex:1"><label>Bitiş</label><input type="datetime-local" id="x-gx-bit" max="${simdiDT}" value="${simdiDT}"></div></div>`
            + `<div class="x-gx-act"><button class="x-gx-ghost" id="x-gx-iptal">Vazgeç</button>`
            + `<button class="x-gx-primary" id="x-gx-basla">Taramayı başlat</button></div>`
            + panelNot;
        card.querySelector('#x-gx-iptal').onclick = xProfilPopupKapat;
        card.querySelector('#x-gx-basla').onclick = function () {
            var bas = card.querySelector('#x-gx-bas').value, bit = card.querySelector('#x-gx-bit').value;
            if (!bas || !bit) { alert('Lütfen başlangıç ve bitiş tarihlerini seç.'); return; }
            if (bas > bit) { alert('Başlangıç tarihi bitişten sonra olamaz.'); return; }
            xProfilTaramaBaslat(handle, { mod: 'takvim', baslangicISO: bas, bitisISO: bit });
        };
    }
    // FAZ 4 YER TUTUCU: /all tarama motoru burada bağlanacak. Şimdilik seçilen modu/parametreleri gösterir.
    function xProfilTaramaBaslat(handle, secim) {
        xProfilPopupKapat();
        printLog('[GX Profil Rapor] TARAMA @' + handle + ' mod=' + secim.mod);
        if (xGxAllSayfasiMi()) { xProfilTaramaCalistir(handle, secim); return; }
        // /all'da değiliz (profil kökü/alt-sekme) -> işaretle + /all'a GİT; widget /all'da
        // yeniden yüklenince beklemedeki taramayı sürdürür (xProfilBeklemedekiTaramaKontrol).
        xProfilMesajGoster(handle, '<div class="x-gx-spin"><span class="d"></span> Tümü (/all) sayfasına gidiliyor…</div>', false, true);
        try {
            chrome.storage.local.set({ x_gx_pending_scan: { handle: handle, secim: secim, ts: Date.now() } }, function () {
                try { location.href = 'https://x.com/' + handle + '/all'; } catch (e) {}
            });
        } catch (e) { try { location.href = 'https://x.com/' + handle + '/all'; } catch (_) {} }
    }
    // Faz 4b: HASAT -> URL listesi -> panelin KANITLANMIŞ "Başlat" akışına besle
    // (startAutomation: /api/auto/start [unify açıkken havuzu TEMİZLEMEZ=veri-kaybı-güvenli] +
    // startWordScan -> mevcut wordTaramaYonetimi motoru yakalar). Profil kartı ilk, öğeler ESKİ->YENİ.
    // Yorum = status URL'sine gidince thread bağlamıyla gelir (tek tek aç doğal).
    async function xProfilTaramaCalistir(handle, secim) {
        try {
            xProfilMesajGoster(handle, '<div class="x-gx-spin"><span class="d"></span> İçerik taranıyor… (sayfa kaydırılıyor, ölçülü hız)</div>', false, true);
            printLog('[GX Hasat] başladı @' + handle + ' mod=' + secim.mod);
            var sonuc = await xProfilHasat(handle, secim, { maxTur: 300, bekle: 650 });
            var urls = ['https://x.com/' + handle];   // profil kartı (profile_header) ilk
            sonuc.ogeler.forEach(function (o) { if (o.link) urls.push(o.link); });   // eski->yeni
            var tipSay = {}; sonuc.ogeler.forEach(function (o) { tipSay[o.tip] = (tipSay[o.tip] || 0) + 1; });
            printLog('[GX Tarama] ' + urls.length + ' URL (profil + ' + sonuc.ogeler.length + ' öğe)');
            if (urls.length <= 1) {
                xProfilMesajGoster(handle, '<div class="x-gx-info">Bu aralıkta yakalanacak <b>yeni içerik bulunamadı</b>.' + (secim.mod === 'devam' ? '<br>Rapor zaten güncel görünüyor.' : '') + '</div>');
                return;
            }
            // [ONAY] Ne bulundu göster; kullanıcı ONAYLAYINCA tarama başlar.
            xProfilOnayGoster(handle, secim, sonuc, urls, tipSay);
        } catch (e) { printLog('[GX Tarama] hata: ' + (e && e.message)); xProfilMesajGoster(handle, '<div class="x-gx-info">Beklenmeyen hata: ' + xGxKac(e && e.message) + '</div>'); }
    }
    // [ONAY] Hasat sonucu: ne bulundu göster, kullanıcı ONAYLAYINCA tarama başlar.
    function xProfilOnayGoster(handle, secim, sonuc, urls, tipSay) {
        var ilk = sonuc.ogeler[0], son = sonuc.ogeler[sonuc.ogeler.length - 1];
        var aralik = ilk ? (xGxTarihTR(new Date(ilk.dateMs).toISOString()) + ' → ' + xGxTarihTR(new Date(son.dateMs).toISOString())) : '';
        // TÜR SEÇİMİ (kullanıcı isteği): yalnız istenen türleri (Paylaşım/RT/Yorum) rapora al.
        var tipler = [{ k: 'paylasim', ad: 'Paylaşım' }, { k: 'rt', ad: 'RT' }, { k: 'yorum', ad: 'Yorum' }];
        var secHtml = tipler.filter(function (t) { return (tipSay[t.k] || 0) > 0; }).map(function (t) {
            return '<label class="x-gx-tipsec"><input type="checkbox" class="x-gx-tipcb" value="' + t.k + '" checked><span>' + t.ad + '</span><b>' + (tipSay[t.k] || 0) + '</b></label>';
        }).join('');
        var html = '<div class="x-gx-info"><b>' + sonuc.ogeler.length + ' içerik</b> bulundu'
            + (aralik ? ' <span style="color:#536471">(' + aralik + ')</span>' : '') + '</div>'
            + '<div class="x-gx-tiplbl">Rapora eklenecek türler:</div>'
            + '<div class="x-gx-tipsecler">' + secHtml + '</div>'
            + '<div class="x-gx-tipwarn" id="x-gx-tipwarn" style="display:none">En az bir içerik türü seç.</div>';
        var durum = {
            mod: 'onay', html: html, _onayla: function () {
                var secili = {};
                try { document.querySelectorAll('.x-gx-tipcb:checked').forEach(function (cb) { secili[cb.value] = true; }); } catch (e) {}
                var filtreli = sonuc.ogeler.filter(function (o) { return secili[o.tip]; });
                if (!filtreli.length) { var w = document.getElementById('x-gx-tipwarn'); if (w) w.style.display = ''; return; }   // hiç tür yok -> uyar
                xProfilTiklaYakala(handle, secim, Object.assign({}, sonuc, { ogeler: filtreli }));
            }
        };
        xGxPopupStilEkle();
        if (!document.getElementById('x-gx-card')) xProfilPopupAc(handle, durum); else xProfilPopupGuncelle(handle, durum);
    }
    // [#2 TIKLA-DETAY YAKALAMA] "Manuel gibi": /all'da hedef kartın GÖVDESİNE tıkla -> X
    // uygulama-içi (SPA) detaya gider ve RT'de "@handle yeniden yayınladı" BAŞLIĞI KORUNUR
    // (CANLI DOĞRULANDI: kart-gövdesi tıklama başlığı taşır; permalink/link-açma taşımaz).
    // Detayda tam tweet (xTweetMetniAc ile "Daha fazla göster" açık) + başlık odak article
    // içinde -> captureArticle yakalar. Yakala -> history.back() ile /all'a dön -> sıradaki.
    // Tampon yeni->eski, sonra TARİHE göre TERS (eski->yeni) + addToPool (profil kartı önce).
    async function xProfilTiklaYakala(handle, secim, sonuc) {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var _cap = window.__xGxCap, _capYanit = window.__xGxCapYanit;
        if (typeof _cap !== 'function') { xProfilMesajGoster(handle, '<div class="x-gx-info">Yakalama motoru hazır değil — sayfayı yenileyip (F5) tekrar deneyin.</div>'); return; }
        xProfilPopupKapat();   // onay popup'ını kapat -> ilerleme SAĞDAKİ DOCK'ta
        window.__xGxTaraIptal = false;
        try { window.__xGxRingHedef = null; window.__xGxRingGoster = 0; if (window.__xGxRingTick) { clearInterval(window.__xGxRingTick); window.__xGxRingTick = null; } } catch (e) {}   // [İLERLEMELİ HALKA] taze başla
        try { var _cbtn = document.getElementById('w-scan-cancel'); if (_cbtn) { _cbtn.onclick = function (ev) { if (ev) ev.stopPropagation(); window.__xGxTaraIptal = true; var _mm = document.getElementById('w-scan-msg'); if (_mm) _mm.textContent = 'Durduruluyor…'; }; } } catch (e) {}
        var origin = '';
        try { origin = await new Promise(function (r) { chrome.storage.local.get({ server_origin: 'https://goruntux.rgmedya.tr' }, function (x) { r(x.server_origin || 'https://goruntux.rgmedya.tr'); }); }); } catch (e) {}
        var addPool = function (item) { return new Promise(function (resolve) { try { chrome.runtime.sendMessage(Object.assign({ action: 'addToPool', origin: origin }, item), function (res) { resolve(res || {}); }); } catch (e) { resolve({ status: 'error' }); } }); };
        var bekle = function (kosul, ms) { return new Promise(function (resolve) { var t0 = Date.now(); (function kon() { try { if (kosul()) { resolve(true); return; } } catch (e) {} if (Date.now() - t0 > ms) { resolve(false); return; } setTimeout(kon, 150); })(); }); };
        // YAKALAMA ZAMAN AŞIMI: captureArticle tek bir öğede (ör. yüklenmeyen görsel) ÇÖZÜLMEZSE tüm
        // tarama sonsuza askıda kalıyordu ("1/2'de takılı"). Promise.race ile sınırla; aşarsa o öğeyi atla.
        var YAKALA_TO = 25000;
        var zamanAsimi = function (p, ms) { return Promise.race([Promise.resolve(p).catch(function () { return ''; }), new Promise(function (r) { setTimeout(function () { r('__TO__'); }, ms); })]); };
        var yakalaToKurtar = function () { try { xGxButonlariGoster(); } catch (e) {} };   // flag + butonları geri yükle (hung capture kilidini aç)
        var odakArticle = function (tid) {
            var arts = document.querySelectorAll('article[data-testid="tweet"]');
            if (tid) { for (var i = 0; i < arts.length; i++) { if (arts[i].querySelector('a[href*="/status/' + tid + '"]')) return arts[i]; } }
            for (var j = 0; j < arts.length; j++) { var te = arts[j].querySelector('time'); if (te && !te.closest('a')) return arts[j]; }
            return arts[0] || null;
        };
        var targets = {}; sonuc.ogeler.forEach(function (o) { targets[o.id] = o; });
        var toplam = sonuc.ogeler.length, done = {}, tampon = {};
        var toplamT = toplam + 1;   // [PROFİL KARTI SAYILSIN] profil kartı da bir adım -> toplam = N öğe + 1
        // 1) PROFİL KARTI (en üst) — halkada SAYILAN ilk adım olarak görünür (0/T -> alınınca 1/T)
        xProfilDockIlerleme(0, toplamT, 'Profil kartı alınıyor…');
        try {
            window.scrollTo(0, 0); await sleep(800);
            var pc = document.querySelector('[data-testid="primaryColumn"]');
            if (pc) {
                var _t = (document.title || '').replace(/^\(\d+\)\s*/, ''); var _m = _t.match(/^(.+?)\s*\(@[^)]+\)/); var _ad = (_m && _m[1]) ? _m[1].trim() : '';
                var pb = _ad ? (_ad + ' (@' + handle + ')') : ('@' + handle);
                pc.scrollIntoView({ block: 'start', behavior: 'instant' }); await sleep(450);
                var pss = await zamanAsimi(_cap(pc), YAKALA_TO);
                if (pss === '__TO__') { pss = ''; yakalaToKurtar(); printLog('[GX Tıkla] profil kartı YAKALAMA ZAMAN AŞIMI'); }
                if (pss && pss.length > 100) await addPool({ title: pb, link: 'https://x.com/' + handle, image: pss, is_profile: true, group_override: '' });
            }
        } catch (e) { printLog('[GX Tıkla] profil kartı hata: ' + (e && e.message)); }
        xProfilDockIlerleme(1, toplamT, 'Profil kartı alındı');   // profil kartı = 1. adım tamam -> halka dolmaya başladı
        // 2) ÖĞELER: /all üstten -> hedef kart GÖVDESİNE tıkla -> detay -> yakala -> back
        window.scrollTo(0, 0); await sleep(700);
        var bosTur = 0, oncekiH = 0, guvenlik = 0, limit = toplam * 4 + 80;
        while (Object.keys(done).length < toplam && guvenlik < limit) {
            if (window.__xGxTaraIptal) break;   // dock iptal butonu
            guvenlik++;
            var secCard = null, secId = null, secInfo = null;
            var arts = document.querySelectorAll('article[data-testid="tweet"]');
            for (var a = 0; a < arts.length; a++) {
                var art = arts[a], id = art.getAttribute('data-tweet-id') || '';
                if (!id) { var sa = art.querySelector('a[href*="/status/"]'); if (sa) { var mm = (sa.getAttribute('href') || '').match(/\/status\/(\d{5,25})/); if (mm) id = mm[1]; } }
                if (id && targets[id] && !done[id]) { secCard = art; secId = id; secInfo = targets[id]; break; }
            }
            if (secCard) {
                done[secId] = true;
                try {
                    secCard.scrollIntoView({ block: 'center', behavior: 'instant' }); await sleep(400);
                    var tt = secCard.querySelector('[data-testid="tweetText"]') || secCard;
                    var oncekiURL = location.href;
                    tt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));   // GÖVDE tıklama -> SPA detay (RT başlığı korunur)
                    var gitti = await bekle(function () { return location.href !== oncekiURL && /\/status\/\d+/.test(location.href); }, 5000);
                    if (gitti) {
                        await sleep(950);
                        try { if (typeof window.xTweetMetniAc === 'function') { window.xTweetMetniAc(); await sleep(300); } } catch (e) {}   // "Daha fazla göster" aç
                        var detArt = odakArticle(secId);
                        if (detArt) {
                            var meta = xProfilKartMeta(detArt, handle);   // detayda socialContext VAR -> RT doğru atıf
                            detArt.scrollIntoView({ block: 'start', behavior: 'instant' }); await sleep(260);
                            var allArts = document.querySelectorAll('article[data-testid="tweet"]');
                            var ss = (secInfo.tip === 'yorum' && typeof _capYanit === 'function') ? (await zamanAsimi(_capYanit(detArt, allArts), YAKALA_TO)) : (await zamanAsimi(_cap(detArt), YAKALA_TO));
                            if (ss === '__TO__') { ss = ''; yakalaToKurtar(); printLog('[GX Tıkla] kart ' + secId + ' YAKALAMA ZAMAN AŞIMI'); }
                            if (ss && ss.length > 100) tampon[secId] = { image: ss, baslik: meta.baslik, link: meta.link, groupOverride: meta.groupOverride, dateMs: secInfo.dateMs };
                        }
                        history.back();
                        await bekle(function () { return /\/all\b/.test(location.href); }, 5000);
                        await sleep(750);
                    }
                } catch (e) { printLog('[GX Tıkla] kart ' + secId + ' hata: ' + (e && e.message)); try { if (/\/status\//.test(location.href)) { history.back(); await sleep(1200); } } catch (_) {} }
                xProfilDockIlerleme(1 + Object.keys(tampon).length, toplamT, 'Yakalanıyor…');   // +1 = profil kartı
            } else {
                window.scrollBy(0, Math.round(window.innerHeight * 0.85)); await sleep(600);
                var h = document.documentElement.scrollHeight;
                if (h <= oncekiH) { bosTur++; if (bosTur >= 6) break; } else { bosTur = 0; oncekiH = h; }
            }
        }
        // 3) TARİHE GÖRE TERS (ESKİ->YENİ) + addToPool
        var liste = Object.keys(tampon).map(function (k) { return tampon[k]; }).sort(function (a, b) { return a.dateMs - b.dateMs; });
        var eklendi = 0, hata = 0;
        for (var L = 0; L < liste.length; L++) {
            xProfilDockIlerleme(1 + (L + 1), liste.length + 1, 'Rapora ekleniyor…');   // +1 = profil kartı (sayımda tutarlı)
            var it = liste[L];
            var rr = await addPool({ title: it.baslik, link: it.link, image: it.image, is_profile: false, group_override: it.groupOverride });
            if (rr && (rr.status === 'success' || rr.status === 'duplicate')) eklendi++; else hata++;
            await sleep(180);
        }
        try { xGxButonlariGoster(); } catch (e) {}   // olası askıda-yakalama kilidini kesin aç (buton/flag geri)
        xProfilDockBitir();
        xProfilMesajGoster(handle, '<div class="x-gx-info"><b>' + eklendi + ' içerik</b> rapora eklendi' + (hata ? (' <span style="color:#536471">(' + hata + ' atlandı)</span>') : '') + (window.__xGxTaraIptal ? ' <span style="color:#536471">(durduruldu)</span>' : '') + '.<br>GörüntüX paneline yönlendiriliyorsun…</div>', true);
        // Tarama bitince GörüntüX paneline git — sosyal medya sekmesi (X) AÇIK kalır (goToPanel kapatmaz).
        // Kullanıcı isteği: "sadece GörüntüX paneline git". Popup kısa görünsün diye ufak gecikme.
        setTimeout(function () { try { xNavPaneleGit(); } catch (e) {} }, 1400);
    }
    // Kart meta: başlık + link + RT grup-override (idle "Rapora Ekle" ile aynı mantık).
    function xProfilKartMeta(card, handle) {
        var accountName = card.getAttribute('data-author-name') || '', username = card.getAttribute('data-author-username') || '';
        if (!accountName || !username) {
            var un = card.querySelector('[data-testid="User-Name"]');
            if (un) { var sp = un.querySelectorAll('span'); if (sp.length) accountName = accountName || sp[0].innerText; for (var i = 0; i < sp.length; i++) { if (sp[i].innerText.indexOf('@') === 0) { username = username || sp[i].innerText; break; } } }
        }
        if (username && username.charAt(0) !== '@') username = '@' + username;
        var baslik = (username && accountName && username.replace(/^@+/, '').toLowerCase() !== accountName.toLowerCase()) ? (accountName + ' (' + username + ')') : (accountName || username || ('@' + handle));
        var tid = ''; var sa = card.querySelector('a[href*="/status/"]'); if (sa) { var sm = (sa.getAttribute('href') || '').match(/\/status\/(\d+)/); if (sm) tid = sm[1]; }
        var sahip = username ? username.replace(/^@/, '') : handle;
        var link = tid ? ('https://x.com/' + sahip + '/status/' + tid) : location.href.split('?')[0];
        var groupOverride = '';
        try {
            var sc = card.querySelector('[data-testid="socialContext"]');
            if (sc && /yeniden\s+yayınladı|reposted|retweeted/i.test(sc.textContent || '')) {
                var aEl = sc.closest('a') || sc.querySelector('a'); var rtHandle = '';
                if (aEl) { var hm = (aEl.getAttribute('href') || '').match(/^\/([^/?#]+)/); var rez = ["i", "home", "search", "notifications", "messages", "explore", "settings"]; if (hm && hm[1] && rez.indexOf(hm[1].toLowerCase()) === -1) rtHandle = hm[1]; }
                if (rtHandle) {
                    var rtAd = (sc.textContent || '').replace(/\s*(gönderiyi\s+yeniden\s+yayınladı|yeniden\s+yayınladı|reposted|Retweeted).*$/i, '').trim();
                    groupOverride = rtHandle.toLowerCase();
                    baslik = rtAd ? (rtAd + ' (@' + rtHandle + ')') : ('@' + rtHandle);
                    if (tid) link = 'rt:' + rtHandle.toLowerCase() + ':' + tid;   // sentetik benzersiz anahtar (çakışma önler)
                }
            }
        } catch (e) {}
        return { baslik: baslik, link: link, groupOverride: groupOverride };
    }
    // [FAZ 4 HASAT] x.com/<handle>/all'da aşağı kaydırarak paylaşım/RT/yorumları toplar.
    // Tip: inject.js data-* (data-is-retweet/-reply/-tweet-id, paylaşılan DOM; ISOLATED
    // widget MAIN world etiketlerini okur) VARSA onu, yoksa DOM-yedek (socialContext/
    // "yanıt olarak"/status-link). Tarih Snowflake id'den. id ile dedup (virtualization).
    // Durma: devam=sınır id/tarih; takvim=aralık altına inince. Sonuç ESKİ→YENİ sıralı.
    async function xProfilHasat(handle, secim, opts) {
        opts = opts || {};
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var SNOW = function (id) { try { return Number((BigInt(id) >> BigInt(22)) + BigInt(1288834974657)); } catch (e) { return 0; } };
        handle = (handle || '').toLowerCase();
        var sinirMs = (secim.mod === 'devam' && secim.sonTarihISO) ? Date.parse(secim.sonTarihISO) : 0;
        // ISO artık datetime-local (tarih+saat, 'T' içerir); eski tarih-only ISO için 'T..' ekle (geri uyum).
        var basMs = (secim.mod === 'takvim' && secim.baslangicISO) ? Date.parse(secim.baslangicISO.indexOf('T') >= 0 ? secim.baslangicISO : (secim.baslangicISO + 'T00:00:00')) : 0;
        var bitMs = (secim.mod === 'takvim' && secim.bitisISO) ? Date.parse(secim.bitisISO.indexOf('T') >= 0 ? secim.bitisISO : (secim.bitisISO + 'T23:59:59')) : Infinity;
        var bulunan = {}, durduk = false, sebep = '', bosTur = 0, oncekiH = 0, maxTur = opts.maxTur || 400;
        for (var tur = 0; tur < maxTur && !durduk; tur++) {
            if (opts.iptalKontrol && opts.iptalKontrol()) { sebep = 'iptal'; break; }
            var cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');
            for (var ci = 0; ci < cells.length; ci++) {
                var arts = cells[ci].querySelectorAll('article[data-testid="tweet"]');
                if (!arts.length) continue;
                var sc = cells[ci].querySelector('[data-testid="socialContext"]');
                var scTxt = sc ? (sc.textContent || '') : '';
                for (var ai = 0; ai < arts.length; ai++) {
                    var a = arts[ai];
                    var id = a.getAttribute('data-tweet-id') || '';
                    var statusA = a.querySelector('a[href*="/status/"]');
                    var href = statusA ? statusA.getAttribute('href').split('?')[0].replace(/\/(analytics|photo|video|retweets|likes).*$/, '') : '';
                    if (!id && href) { var mm = href.match(/\/status\/(\d{5,25})/); if (mm) id = mm[1]; }
                    if (!id || bulunan[id]) continue;
                    var isRT = a.getAttribute('data-is-retweet') === 'true' || /yeniden (yayınladı|gönderdi)|reposted/i.test(scTxt);
                    var isReply = a.getAttribute('data-is-reply') === 'true' || /yanıt olarak|replying to/i.test(a.innerText || '');
                    var isPinned = /sabitlendi|pinned/i.test(scTxt);
                    var author = (a.getAttribute('data-author-username') || '').toLowerCase();
                    if (!author && href) { var am = href.match(/^\/([^\/]+)\/status/); if (am) author = am[1].toLowerCase(); }
                    var dateMs = SNOW(id);
                    // [PROFİL-DIŞI BAĞLAM ATLA] Yorumun cevap verdiği PARENT tweet (başkasının, akışta
                    // bağlam olarak görünen) ayrı öğe sayılmasın. Tut: profilin KENDİ içeriği (author==handle)
                    // VEYA profilin RT'si (isRT). Diğerleri (author!=handle & RT değil) = parent bağlamı -> ATLA.
                    if (author && author !== handle && !isRT) continue;
                    bulunan[id] = { id: id, link: href ? ('https://x.com' + href) : '', tip: isRT ? 'rt' : (isReply ? 'yorum' : 'paylasim'), author: author, dateMs: dateMs, isPinned: isPinned };
                    if (secim.mod === 'devam' && sinirMs) { if (id === secim.sonId || (dateMs && dateMs <= sinirMs && !isPinned)) { durduk = true; sebep = 'sinir'; } }
                    if (secim.mod === 'takvim' && basMs && dateMs && dateMs < basMs && !isPinned) { durduk = true; sebep = 'aralik-alt'; }
                }
                if (durduk) break;
            }
            if (durduk) break;
            window.scrollBy(0, Math.round(window.innerHeight * 0.9));
            await sleep(opts.bekle || 650);
            var h = document.documentElement.scrollHeight;
            if (h <= oncekiH) { bosTur++; if (bosTur >= (opts.bosLimit || 4)) { sebep = 'son'; break; } }
            else { bosTur = 0; oncekiH = h; }
        }
        var arr = Object.keys(bulunan).map(function (k) { return bulunan[k]; });
        arr = arr.filter(function (it) {
            if (secim.mod === 'takvim') { if (it.dateMs > bitMs) return false; if (basMs && it.dateMs < basMs) return false; }
            if (secim.mod === 'devam' && sinirMs && it.dateMs && it.dateMs <= sinirMs) return false;
            return true;
        });
        arr.sort(function (a, b) { return a.dateMs - b.dateMs; });   // ESKİ -> YENİ
        return { ogeler: arr, sebep: sebep, hamSayi: Object.keys(bulunan).length };
    }
    // --- küçük tarih yardımcıları ---
    function xGxBugunISO() { try { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); } catch (e) { return ''; } }
    function xGxGunEkleISO(iso, gun) { try { var d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + gun); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); } catch (e) { return iso; } }
    function xGxTarihTR(iso) { try { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return ''; return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear(); } catch (e) { return ''; } }
    function xGxKac(s) { try { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); } catch (e) { return ''; } }
    // SPA gezinme + X başlık yeniden-render'ına karşı: tek kalıcı poller (window-korumalı,
    // widget her enjekte edildiğinde tekrar başlatmaz). Profil dışında no-op.
    function xProfilRaporPollerBaslat() {
        try {
            if (window.__xGxProfilPollerAktif) return;
            window.__xGxProfilPollerAktif = true;
            xProfilRaporButonuEkle();   // hemen dene
            // HIZLI: profil başlığı (placementTracking) DOM'a girer girmez enjekte et (dock ile
            // aynı anda hissi). Eskiden yalnız 600ms poll vardı -> buton geç geliyordu.
            try {
                var _mo = new MutationObserver(function () {
                    try { if (xGxProfilHandle()) xProfilRaporButonuEkle(); } catch (e) {}
                    if (document.querySelector('.x-gx-rapor-btn')) { try { _mo.disconnect(); } catch (e) {} }
                });
                _mo.observe(document.documentElement, { childList: true, subtree: true });
                // SPA gezinmede başlık yeniden render olursa observer'ı kısa süre sonra yeniden kur
                setInterval(function () {
                    try { if (xGxProfilHandle() && !document.querySelector('.x-gx-rapor-btn')) { xProfilRaporButonuEkle(); } } catch (e) {}
                }, 600);
            } catch (e) {
                setInterval(function () { try { if (xGxProfilHandle()) xProfilRaporButonuEkle(); } catch (e) {} }, 600);
            }
        } catch (e) {}
    }
    // Profil kartı / tweet ekran görüntüsü alınırken butonumuz SS'e girmesin: captureArticle
    // başında display:none (akış içi -> boşluk bırakmaz), finally'de geri. Tek seferlik (stitch bozulmaz).
    function xGxButonlariGizle() {
        window.__xGxCaptureAktif = true;   // poller'ları duraklat (yakalama sırasında taze buton enjekte etme)
        try { document.querySelectorAll('.x-gx-rapor-btn, .x-gx-tw-btn, .x-gx-ig-btn').forEach((b) => b.classList.add('x-gx-gizli')); } catch (e) {}
        // [SS'TE POPUP OLMASIN] KURŞUN-GEÇİRMEZ: yakalama boyunca <html>'e sınıf ekle; CSS !important ile
        // HER #x-gx-ov (mevcut VEYA yakalama penceresinde geç oluşan) display:none olur. + inline yedek.
        try { document.documentElement.classList.add('x-gx-capturing'); } catch (e) {}
        try { var ov = document.getElementById('x-gx-ov'); if (ov) ov.style.display = 'none'; } catch (e) {}
    }
    function xGxButonlariGoster() {
        try { document.querySelectorAll('.x-gx-rapor-btn, .x-gx-tw-btn, .x-gx-ig-btn').forEach((b) => b.classList.remove('x-gx-gizli')); } catch (e) {}
        try { document.documentElement.classList.remove('x-gx-capturing'); } catch (e) {}
        try { var ov = document.getElementById('x-gx-ov'); if (ov) ov.style.display = ''; } catch (e) {}
        window.__xGxCaptureAktif = false;
    }

    function renderIdleWidget(storageKey) {
        try {
            printLog("renderIdleWidget çağrıldı...");
            
            const oldCb = document.getElementById('w-cb-container');
            if (oldCb) oldCb.remove();
            
            chrome.storage.local.get({
                server_origin: "https://goruntux.rgmedya.tr"
            }, (res) => {
                // v3.79: sunucu adresi widget'ta GOSTERILMEZ (kullanici istegi). res.server_origin
                // asagidaki buton onclick'inde hala kullaniliyor, o yuzden storage okumasi kaliyor.
                durumText.innerHTML = `🛡️ <b>GörüntüX</b><br>
                                       Durum: <b>Bağlantı Hazır ✔️</b>`;
                
                // v3.72: buton artik TEKIL WORD URETMEZ (o yol zaten 410 ile emekliydi);
                // yakalanan icerigi PANELIN HAVUZUNA ekler. Tweet + profil sayfalarinda calisir.
                xSetButon("Rapora Ekle");
                buton.className = 'xdock-btn connected';   // baglanti hazir -> yesil + isik sacar (glow)
                buton.style.backgroundColor = '';          // onceki durum(lar)in inline rengini temizle
                buton.disabled = false;

                buton.onclick = async () => {
                    buton.disabled = true;
                    xSetButon("⏳ Yakalanıyor...");
                    // Yesil "connected" gorunumu gecici durumlarda da korunur; _sifirla idle'a doner.
                    const _sifirla = () => { buton.disabled = false; buton.className = 'xdock-btn connected'; buton.style.backgroundColor = ''; xSetButon("Rapora Ekle"); };

                    const _urlSade = window.location.href.split('?')[0];

                    // ===== PLATFORM DAĞITIMI (idle "Rapora Ekle") =====
                    // X: aşağıdaki mevcut yol (DOKUNULMADI, sıfır regresyon). Instagram: captureArticle
                    // IG'yi kendi bulur+yakalar (igFindPost içeride — taramayla AYNI yakalayıcı). Link =
                    // kanonik gönderi URL'si (?'lı kısım zaten atıldı). Yazar = xIgYazar. Profil X'e özel.
                    if (xPlatform() === 'ig') {
                        var _igLink = _urlSade;
                        var _panoIg = xPanoHazirla(_igLink);   // pano yazımını tıklama anında başlat (gesture taze)
                        var _igSs = "";
                        try {
                            var _igEl = document.querySelector('article') || document.body;
                            _igSs = await captureArticle(_igEl) || "";
                        } catch (e) { printLog("IG yakalama hatası: " + ((e && e.message) || e)); }
                        if (!_igSs || _igSs.length < 100) {
                            _panoIg.iptal();
                            alert("Ekran görüntüsü alınamadı, tekrar deneyin.");
                            _sifirla(); return;
                        }
                        var _igPanoOk = await _panoIg.gorseliVer(_igSs);
                        var _igBaslik = xIgYazar();
                        xSetButon("⏳ Ekleniyor...");
                        chrome.runtime.sendMessage({
                            action: "addToPool",
                            origin: res.server_origin,
                            title: _igBaslik,
                            link: _igLink,
                            image: _igSs,
                            is_profile: false,
                            group_override: ""
                        }, (addRes) => {
                            if (addRes && addRes.status === "success") {
                                xSetButon(_igPanoOk ? "✔️ Eklendi · 📋 Panoda" : "✔️ Rapora eklendi");
                                setTimeout(_sifirla, 1500);
                            } else if (addRes && addRes.status === "duplicate") {
                                xSetButon("⚠️ Zaten havuzda");
                                setTimeout(_sifirla, 1800);
                            } else {
                                var _hataMsg = "Rapora eklenemedi (sunucu): " + (addRes && addRes.message ? addRes.message : "yanıt yok");
                                if (_igPanoOk) _hataMsg += "\n\nAncak görsel PANONUZA kopyalandı — Ctrl+V ile istediğiniz yere yapıştırabilirsiniz.";
                                alert(_hataMsg);
                                _sifirla();
                            }
                        });
                        return;
                    }

                    // Facebook: xFbIdleYakala (taramanın gorev-bağımsız ikizi). Link = TAM URL (FB'de
                    // kimlik SORGUDA olabilir -> '?' ATMA; sunucu x_temizle_link ile kanoniklestirir).
                    // Başlık = fbAuthor (düz görünen ad; @slug YOK — tarama kararı). Profil X'e özel.
                    if (xPlatform() === 'fb') {
                        var _fbLink = window.location.href;
                        var _panoFb = xPanoHazirla(_fbLink);
                        var _fbRes = null;
                        try { _fbRes = await xFbIdleYakala(); }
                        catch (e) { printLog("FB yakalama hatası: " + ((e && e.message) || e)); }
                        if (!_fbRes || !_fbRes.shot || _fbRes.shot.length < 100) {
                            _panoFb.iptal();
                            alert("Ekran görüntüsü alınamadı, tekrar deneyin.");
                            _sifirla(); return;
                        }
                        var _fbPanoOk = await _panoFb.gorseliVer(_fbRes.shot);
                        xSetButon("⏳ Ekleniyor...");
                        chrome.runtime.sendMessage({
                            action: "addToPool",
                            origin: res.server_origin,
                            title: _fbRes.author || 'Facebook Gönderisi',
                            link: _fbLink,
                            image: _fbRes.shot,
                            is_profile: false,
                            group_override: ""
                        }, (addRes) => {
                            if (addRes && addRes.status === "success") {
                                xSetButon(_fbPanoOk ? "✔️ Eklendi · 📋 Panoda" : "✔️ Rapora eklendi");
                                setTimeout(_sifirla, 1500);
                            } else if (addRes && addRes.status === "duplicate") {
                                xSetButon("⚠️ Zaten havuzda");
                                setTimeout(_sifirla, 1800);
                            } else {
                                var _hataMsg = "Rapora eklenemedi (sunucu): " + (addRes && addRes.message ? addRes.message : "yanıt yok");
                                if (_fbPanoOk) _hataMsg += "\n\nAncak görsel PANONUZA kopyalandı — Ctrl+V ile istediğiniz yere yapıştırabilirsiniz.";
                                alert(_hataMsg);
                                _sifirla();
                            }
                        });
                        return;
                    }

                    // TikTok: xTtIdleYakala (taramanın gorev-bağımsız ikizi). Link = TAM URL (sunucu
                    // x_temizle_link kanoniklestirir). Başlık = URL'deki @kullanıcı. Profil X'e özel.
                    if (xPlatform() === 'tt') {
                        var _ttLink = window.location.href;
                        var _panoTt = xPanoHazirla(_ttLink);
                        var _ttRes = null;
                        try { _ttRes = await xTtIdleYakala(); }
                        catch (e) { printLog("TT yakalama hatası: " + ((e && e.message) || e)); }
                        if (!_ttRes || !_ttRes.shot || _ttRes.shot.length < 100) {
                            _panoTt.iptal();
                            alert("Ekran görüntüsü alınamadı, tekrar deneyin.");
                            _sifirla(); return;
                        }
                        var _ttPanoOk = await _panoTt.gorseliVer(_ttRes.shot);
                        xSetButon("⏳ Ekleniyor...");
                        chrome.runtime.sendMessage({
                            action: "addToPool",
                            origin: res.server_origin,
                            title: _ttRes.author || 'TikTok Gönderisi',
                            link: _ttLink,
                            image: _ttRes.shot,
                            is_profile: false,
                            group_override: ""
                        }, (addRes) => {
                            if (addRes && addRes.status === "success") {
                                xSetButon(_ttPanoOk ? "✔️ Eklendi · 📋 Panoda" : "✔️ Rapora eklendi");
                                setTimeout(_sifirla, 1500);
                            } else if (addRes && addRes.status === "duplicate") {
                                xSetButon("⚠️ Zaten havuzda");
                                setTimeout(_sifirla, 1800);
                            } else {
                                var _hataMsg = "Rapora eklenemedi (sunucu): " + (addRes && addRes.message ? addRes.message : "yanıt yok");
                                if (_ttPanoOk) _hataMsg += "\n\nAncak görsel PANONUZA kopyalandı — Ctrl+V ile istediğiniz yere yapıştırabilirsiniz.";
                                alert(_hataMsg);
                                _sifirla();
                            }
                        });
                        return;
                    }

                    // YouTube: xYtIdleYakala (taramanın gorev-bağımsız ikizi; yalnız /watch). Link = TAM
                    // URL (kimlik ?v='de; sunucu kanoniklestirir). Başlık = kanal adı (DOM). Profil X'e özel.
                    if (xPlatform() === 'yt') {
                        var _ytLink = window.location.href;
                        var _panoYt = xPanoHazirla(_ytLink);
                        var _ytRes = null;
                        try { _ytRes = await xYtIdleYakala(); }
                        catch (e) { printLog("YT yakalama hatası: " + ((e && e.message) || e)); }
                        if (!_ytRes || !_ytRes.shot || _ytRes.shot.length < 100) {
                            _panoYt.iptal();
                            alert("Ekran görüntüsü alınamadı, tekrar deneyin.");
                            _sifirla(); return;
                        }
                        var _ytPanoOk = await _panoYt.gorseliVer(_ytRes.shot);
                        xSetButon("⏳ Ekleniyor...");
                        chrome.runtime.sendMessage({
                            action: "addToPool",
                            origin: res.server_origin,
                            title: _ytRes.author || 'YouTube Videosu',
                            link: _ytLink,
                            image: _ytRes.shot,
                            is_profile: false,
                            group_override: ""
                        }, (addRes) => {
                            if (addRes && addRes.status === "success") {
                                xSetButon(_ytPanoOk ? "✔️ Eklendi · 📋 Panoda" : "✔️ Rapora eklendi");
                                setTimeout(_sifirla, 1500);
                            } else if (addRes && addRes.status === "duplicate") {
                                xSetButon("⚠️ Zaten havuzda");
                                setTimeout(_sifirla, 1800);
                            } else {
                                var _hataMsg = "Rapora eklenemedi (sunucu): " + (addRes && addRes.message ? addRes.message : "yanıt yok");
                                if (_ytPanoOk) _hataMsg += "\n\nAncak görsel PANONUZA kopyalandı — Ctrl+V ile istediğiniz yere yapıştırabilirsiniz.";
                                alert(_hataMsg);
                                _sifirla();
                            }
                        });
                        return;
                    }

                    // v3.88: GECERSIZ sayfada EKLEME YAPMA. Widget bir an takili kalsa bile
                    // (SPA gezinme gecisi) anasayfada "Rapora Ekle" HOME TIMELINE'ini yakalamasin
                    // (kullanici: "anasayfada rapor ekle deyince eklememeli"). _profilMi asagida
                    // "/status/ yoksa profil" varsaydigi icin home'u profil sanip yakaliyordu.
                    {
                        const _tw = /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(_urlSade);
                        const _foto = /\/status\/\d+\/(?:photo|media|video)(?:\/|$)/i.test(_urlSade);
                        const _pmG = _urlSade.match(/^https?:\/\/(?:x|twitter)\.com\/([^/?#]+)\/?$/i);
                        const _rezG = ["home","explore","notifications","messages","search","i","settings",
                                       "compose","hashtag","login","logout","signup","share","intent",
                                       "tos","privacy","about","download","jobs","developer"];
                        const _prof = !!(_pmG && _pmG[1] && _rezG.indexOf(_pmG[1].toLowerCase()) === -1);
                        if (_foto || !(_tw || _prof)) {
                            alert("Bu sayfada rapora ekleme yapılamaz. Bir tweet ya da profil sayfasına gidin.");
                            _sifirla(); return;
                        }
                    }

                    const _profilMi = !/\/status\/\d+/.test(_urlSade);
                    let ekranGoruntusu = "", baslik = "", groupOverride = "";
                    let link = _urlSade;   // RT'li tweette asagida sentetik benzersiz anahtara donusur

                    // v4.9: PANOYA yazmayı TIKLAMA ANINDA (yakalamadan ÖNCE, gesture taze) başlat.
                    // Görsel bir SÖZ olarak verilir; yakalama bitince doldurulur. Böylece yakalama
                    // uzun sürse de (yanıt tweetinde 2 yakalama dahil) pano yazımı engellenmez.
                    // Link = _urlSade (gerçek içerik URL'si; RT sentetik anahtarı değil).
                    var _pano = xPanoHazirla(_urlSade);

                    if (_profilMi) {
                        // PROFIL: primaryColumn'u yakala. captureArticle URL'den isProfile'i
                        // algilayip yuksekligi profil kartina sinirliyor (bkz. ~:1278).
                        const primaryCol = document.querySelector('[data-testid="primaryColumn"]');
                        if (!primaryCol) { alert("Profil içeriği sayfada bulunamadı!"); _sifirla(); return; }
                        // Baslik = gorunen ad (@kullanıcı). Gorunen ad document.title'dan
                        // ("Ad (@kullanıcı) / X"); bildirim sayaci "(3) " onekini temizle (v3.70).
                        const _handle = (_urlSade.match(/(?:x|twitter)\.com\/([^/?#]+)/i) || [])[1] || "";
                        const _t = (document.title || "").replace(/^\(\d+\)\s*/, '');
                        const _m = _t.match(/^(.+?)\s*\(@[^)]+\)/);
                        const _ad = (_m && _m[1]) ? _m[1].trim() : "";
                        baslik = _ad ? (_ad + " (@" + _handle + ")") : (_handle ? ("@" + _handle) : "");
                        primaryCol.scrollIntoView({ block: 'start', behavior: 'instant' });
                        await new Promise(r => setTimeout(r, 500));
                        ekranGoruntusu = await captureArticle(primaryCol) || "";
                    } else {
                        // TWEET: dogru article'i bul (id ile, yoksa link-siz <time>, yoksa ilk).
                        const tweetId = (_urlSade.match(/status\/(\d+)/) || [])[1] || null;
                        let article = null;
                        const articles = document.querySelectorAll('article[data-testid="tweet"]');
                        if (tweetId) {
                            for (const art of articles) {
                                if (art.querySelector(`a[href*="/status/${tweetId}"]`)) { article = art; break; }
                            }
                            if (!article) {
                                for (const art of articles) {
                                    const timeEl = art.querySelector('time');
                                    if (timeEl && !timeEl.closest('a')) { article = art; break; }
                                }
                            }
                        }
                        if (!article && articles.length > 0) article = articles[0];
                        if (!article) { alert("Tweet içeriği sayfada bulunamadı!"); _sifirla(); return; }

                        let accountName = article.getAttribute('data-author-name') || "";
                        let username = article.getAttribute('data-author-username') || "";
                        if (!accountName || !username) {
                            const userNameEl = article.querySelector('[data-testid="User-Name"]');
                            if (userNameEl) {
                                const spans = userNameEl.querySelectorAll('span');
                                if (spans.length > 0) accountName = spans[0].innerText;
                                for (let span of spans) { if (span.innerText.startsWith('@')) { username = span.innerText; break; } }
                            }
                        }
                        if (username && !username.startsWith('@')) username = '@' + username;
                        // Baslik "Ad (@kullanıcı)" — app.py'nin submit_word_result mantiginin ayni.
                        if (username && accountName && username.replace(/^@+/, '').toLowerCase() !== accountName.toLowerCase())
                            baslik = accountName + " (" + username + ")";
                        else
                            baslik = accountName || username;

                        // RT TESPITI (kullanici karari): tweet RT edilmisse RT YAPANIN basligi
                        // altinda gruplansin. socialContext ("X gönderiyi yeniden yayınladı")
                        // RT yapani gosterir; onun @kullanici adini href'ten, gorunen adini
                        // metinden al. Bulunamazsa SAHIP basligi kalir (regresyon yok).
                        // NOT: tweet SAHIBI zaten gorselde (article basligi) gorunur; ayrica
                        //      RT eden de socialContext ile gorselde -> bilgi kaybi yok.
                        try {
                            const sc = article.querySelector('[data-testid="socialContext"]');
                            if (sc) {
                                const a = sc.closest('a') || sc.querySelector('a');
                                let rtHandle = "";
                                if (a) {
                                    const hm = (a.getAttribute('href') || "").match(/^\/([^/?#]+)/);
                                    const rez = ["i","home","search","notifications","messages","explore","settings"];
                                    if (hm && hm[1] && rez.indexOf(hm[1].toLowerCase()) === -1) rtHandle = hm[1];
                                }
                                let rtAd = (sc.textContent || "")
                                    .replace(/\s*(gönderiyi\s+yeniden\s+yayınladı|yeniden\s+yayınladı|Retweetledi|reposted|Retweeted).*$/i, "")
                                    .trim();
                                if (rtHandle) {
                                    groupOverride = rtHandle.toLowerCase();
                                    baslik = rtAd ? (rtAd + " (@" + rtHandle + ")") : ("@" + rtHandle);
                                    // KIMLIK = RT YAPAN + TWEET (link DEGIL). Sebep: ayni tweet'i
                                    // birden cok hesap RT edebilir (A ve C, B'nin tweet'i). Link
                                    // ikisinde de AYNI (x.com/B/status/ID) -> dedup ikinciyi
                                    // reddeder VE gorseller birbirini ezer. Bu yuzden RT'li ogeye
                                    // SENTETIK benzersiz anahtar veriyoruz: "rt:{rt_yapan}:{tweet_id}".
                                    // Bu anahtar x_temizle_link + normalize_link_key + xNormLink
                                    // uclusunden DEGISMEDEN gecer (X olmayan dize) ve detect_platform
                                    // 'x' doner -> X bolumu. Raporda/onizlemede GIZLENIR ("rt:" oneki).
                                    let _tid = "";
                                    const _stA = article.querySelector('a[href*="/status/"]');
                                    if (_stA) { const _sm = (_stA.getAttribute('href') || "").match(/\/status\/(\d+)/); if (_sm) _tid = _sm[1]; }
                                    if (!_tid) { const _um = _urlSade.match(/\/status\/(\d+)/); if (_um) _tid = _um[1]; }
                                    if (_tid) link = "rt:" + rtHandle.toLowerCase() + ":" + _tid;
                                }
                            }
                        } catch (e) {}

                        // v4.33: eklenen tweetin ≥2 ATASI varsa (derin zincir A←B←C / flood) -> KULLANICI SEÇER
                        // (atalar + eklenen tweet onay kutularıyla sunulur, seçilenler dikey birleştirilir). 1 ata
                        // (ana+yorum) veya tekil -> ESKİ otomatik (xYakalaTweetVeYanit) dokunulmaz. Bayrak x_coklu_sec='0' -> kapalı.
                        var _cokluAcik = true; try { if (localStorage.getItem('x_coklu_sec') === '0') _cokluAcik = false; } catch (e) {}
                        var _arr = Array.prototype.slice.call(articles || []);
                        var _fi = _arr.indexOf(article);
                        if (_cokluAcik && _fi >= 2) {
                            var _adaylar = _arr.slice(0, _fi + 1);   // atalar (0..fi-1) + eklenen tweet (fi), yukarıdan aşağıya
                            var _secilenler = await xCokluTweetSec(_adaylar, article);
                            if (!_secilenler) {   // İptal -> hiçbir şey ekleme
                                _pano.iptal(); _sifirla(); return;
                            }
                            ekranGoruntusu = await xYakalaCoklu(_secilenler, _adaylar);
                        } else {
                            // v4.5: yanıt/yorum tweeti ise DOĞRUDAN yanıt verilen (parent) tweeti de kat (ana+yorum=mükemmel).
                            ekranGoruntusu = await xYakalaTweetVeYanit(article, articles);
                        }
                    }

                    if (!ekranGoruntusu || ekranGoruntusu.length < 100) {
                        alert("Ekran görüntüsü alınamadı, tekrar deneyin.");
                        _pano.iptal();   // v4.9: yakalama başarısız -> tıklamada başlatılan pano yazımını iptal et
                        _sifirla(); return;
                    }

                    // v4.9: görsel hazır -> pano SÖZÜNÜ çöz. Yazım tıklama anında (gesture taze) başlamıştı;
                    // burada görseli doldururuz -> yakalama uzun sürse bile pano yazımı engellenmez.
                    var _panoOk = await _pano.gorseliVer(ekranGoruntusu);

                    xSetButon("⏳ Ekleniyor...");
                    chrome.runtime.sendMessage({
                        action: "addToPool",
                        origin: res.server_origin,
                        title: baslik,
                        link: link,
                        image: ekranGoruntusu,
                        is_profile: _profilMi,
                        group_override: groupOverride
                    }, (addRes) => {
                        if (addRes && addRes.status === "success") {
                            xSetButon(_panoOk ? "✔️ Eklendi · 📋 Panoda" : "✔️ Rapora eklendi");
                            // v3.74 (kullanici istegi): panele YONLENDIRME YOK. Icerik sunucudaki
                            // havuza eklendi; kullanici panele kendisi gidince orada gorunur.
                            // (Eskiden burada focusOrOpenPanel cagriliyordu.)
                            setTimeout(_sifirla, 1500);
                        } else if (addRes && addRes.status === "duplicate") {
                            xSetButon("⚠️ Zaten havuzda");
                            setTimeout(_sifirla, 1800);
                        } else {
                            var _hataMsg = "Rapora eklenemedi (sunucu): " + (addRes && addRes.message ? addRes.message : "yanıt yok");
                            if (_panoOk) _hataMsg += "\n\nAncak görsel PANONUZA kopyalandı — Ctrl+V ile istediğiniz yere yapıştırabilirsiniz.";
                            alert(_hataMsg);
                            _sifirla();
                        }
                    });
                };

                // v4.15: sürüm kontrolü ARKA PLANDA — butonu BEKLETMEZ (her gezinmede beyaz flaş yok).
                // Buton yukarıda ZATEN "Rapora Ekle" (mavi) oldu; burada yalnız sonuç "eski" gelirse
                // kilit ekranına geçilir. FAIL-OPEN: sunucuya ulaşılamaz/latest boşsa kilitleme
                // (panelin xSurumKiyas mantığının ikizi). NEDEN sona alındı: v4.13'te bu fetch butonun
                // ETIKETINI bekletiyordu -> uzak sunucuda buton beyaz kalıp gecikmeli doluyordu (regresyon).
                chrome.runtime.sendMessage({ action: "getVersionStatus", origin: res.server_origin }, (vres) => {
                    if (chrome.runtime.lastError) { return; }   // mesaj ulaşmadı -> fail-open (kilitleme)
                    var _yerel = (vres && vres.localVersion) || "";
                    var _guncel = (vres && vres.latestVersion) || "";
                    // İÇERİK-HASH DAMGASI: sürüm "1.0·hash" -> semver (isVersionOlder) DEĞİL, STRING EŞİTSİZLİĞİ
                    // (hash sıralı değil; sunucu daima "en güncel", kurulu farklıysa güncel değil).
                    if (_yerel && _guncel && _yerel !== _guncel) {
                        renderVersionLockedWidget(_yerel, _guncel);
                    } else if (!buton.disabled) {
                        // Guncel/fail-open: baglanti isigi yesil kalsin (onceki .outdated'i temizle).
                        buton.classList.remove('outdated');
                        buton.classList.add('connected');
                    }
                });
            });
        } catch (e) {
            showError(e);
        }
    }

    // Kullanıcı isteği (v4.2): "Rapora Ekle"de içeriği PANOYA kopyala (Ctrl+V ile başka yere yapıştır).
    // Görüntü PNG data URL -> base64->Blob DOĞRUDAN (fetch/canvas YOK, x.com CSP).
    // v4.12 KULLANICI KARARI: panoya YALNIZ temiz görsel; link panoya HİÇ konmaz (rapordaki link zaten
    // ayrı köprü). v4.11'in link-şeridi gömme yolu (xLinkStripEkle) + v4.10 text/plain GERİ ALINDI.
    // Neden: WhatsApp panoda görsel varken metni almıyor; kullanıcı görselde şerit-link istemedi.
    //
    // v4.9 SAĞLAM YÖNTEM (user-activation tuzağı): navigator.clipboard.write kullanıcı-etkileşimi ister
    // ve ~5sn'de dolar; yakalama birkaç sn sürdüğü için ESKİDEN yazım engelleniyordu. Çözüm: write'ı
    // TIKLAMA ANINDA (yakalamadan önce) çağır; görseli SÖZ (Promise) olarak ver, yakalama bitince çöz.
    // Döner: { gorseliVer(dataUrl)->Promise<bool>, iptal() }.
    function xPanoHazirla(link) {
        var _bos = { gorseliVer: function () { return Promise.resolve(false); }, iptal: function () {} };
        if (!navigator.clipboard || !window.ClipboardItem || !navigator.clipboard.write) { return _bos; }
        var _res = null, _rej = null;
        var imgPromise = new Promise(function (r, j) { _res = r; _rej = j; });
        // v4.12 KULLANICI KARARI: panoya YALNIZ temiz görsel — link/text/plain panoya HİÇ konmaz
        // (rapordaki link zaten ayrı köprü). `link` parametresi artık kullanılmıyor (uyumluluk için duruyor).
        var parcalar = { 'image/png': imgPromise };
        var yazma = null;
        try {
            yazma = navigator.clipboard.write([new ClipboardItem(parcalar)]);
            yazma.catch(function () {});   // reject/iptal sessiz (asagida ele alinir)
        } catch (e) { return _bos; }
        return {
            gorseliVer: async function (dataUrl) {
                try {
                    var virgul = String(dataUrl).indexOf(',');
                    if (String(dataUrl).indexOf('data:') !== 0 || virgul < 0) { _rej(new Error('gecersiz')); return false; }
                    var bin = atob(dataUrl.slice(virgul + 1));
                    var arr = new Uint8Array(bin.length);
                    for (var i = 0; i < bin.length; i++) { arr[i] = bin.charCodeAt(i); }
                    _res(new Blob([arr], { type: 'image/png' }));   // görseller PNG; ClipboardItem anahtarı da image/png
                    if (yazma) { await yazma; return true; }
                    return false;
                } catch (e) { try { _rej(e); } catch (x) {} printLog("Panoya yazma hatası: " + ((e && e.message) || e)); return false; }
            },
            iptal: function () { try { _rej(new Error('iptal')); } catch (e) {} }
        };
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

    // GUNCELLEME VAR: baglanti isigi (=Rapora Ekle butonu) SARI olur, uyari balonu (#w-conn-warn)
    // acilir/genisler, buton KILITLENIR (Rapora Ekle devre disi). Balona/butona tiklama indirme
    // sayfasini acar. durumText/ayri kutu YOK (yeni dock tasarimi).
    function renderVersionLockedWidget(localVersion, latestVersion) {
        try {
            printLog("renderVersionLockedWidget çağrıldı...");

            const acIndir = () => {
                chrome.storage.local.get({ server_origin: "https://goruntux.rgmedya.tr" }, (res) => {
                    // Guncel eklenti .zip'i (panelin sundugu route). ESKIDEN /x-rapor-arti idi ->
                    // sunucuda boyle bir route YOK (404). Panelin indir dugmesiyle ayni uc.
                    window.open(`${res.server_origin}/api/extension/download_zip`, "_blank");
                });
            };
            // [GÜNCELLE LİNKİ] "Eklentiyi güncelle!" -> paneli #eklenti-guncelle hash'iyle aç; panel eklenti-güncelleme
            // KILAVUZU modalini acar (indirme + 'ayni klasore ac + yenile + X F5' adimlari o modalda). Eskiden dogrudan
            // zip indiriyordu (nasil guncellenecegini anlatmadan).
            const acGuncelle = () => {
                chrome.storage.local.get({ server_origin: "https://goruntux.rgmedya.tr" }, (res) => {
                    window.open(`${res.server_origin}/#eklenti-guncelle`, "_blank");
                });
            };

            buton.classList.remove('connected');
            buton.classList.add('outdated');
            buton.style.backgroundColor = '';   // rengi .outdated sinifi versin (sari)
            buton.disabled = true;              // Rapora Ekle kilitli
            const ico = buton.querySelector('.xdock-ico');
            const lbl = buton.querySelector('.xdock-lbl');
            if (ico) ico.textContent = '!';   // sarı butonda yalnız BEYAZ ünlem (CSS: .outdated .xdock-ico)
            if (lbl) lbl.textContent = 'Güncelleme gerekli';
            buton.classList.remove('xdock-show-lbl');

            const warn = document.getElementById('w-conn-warn');
            if (warn) {
                warn.innerHTML = `⚠️ <b>Güncelleme gerekli.</b><br><span class="xdock-warn-link">Eklentiyi güncelle! →</span>`;
                warn.onclick = (e) => { e.stopPropagation(); acGuncelle(); };
            }
        } catch (e) {
            showError(e);
        }
    }

    // STATE MACHINE: Word Report scraping management
    // Limit / yükleme engeli uyarısı — TEK KAYNAK (v3.68).
    // Hem tivit (CASE 2) hem profil (CASE 1) yakalama yolu bunu kullanır. Eskiden yalnızca
    // tivit yolunda vardı; profil yüklenemezse SESSİZCE atlanıp kuyruktan düşüyordu, yani X
    // seni profil kartı çekerken kısıtladığında o profil rapordan kayboluyordu. Kopya çıkıp
    // ikizi ayrışmasın diye ortak fonksiyon. sebepMetni: "Tivit yüklenemedi." / "Profil
    // yüklenemedi." gibi tek satırlık açıklama.
    // Davranış: 120 sn geri sayım -> aynı URL'yi yeniden dener (location.reload). "Şimdi
    // Yenile" beklemeden dener; "Atla" bu öğeyi kuyruktan çıkarıp sonrakine geçer (profil
    // yolunun ESKİ davranışı artık bu butonun arkasında, tek tık uzakta).
    function limitEngeliGoster(gorev, storageKey, sebepMetni) {
        gorev.retry_count = (gorev.retry_count || 0) + 1;
        printLog(`Hata: ${sebepMetni} Yeniden deneme adımı: ${gorev.retry_count}`);

        // Dock'u KENARDA tutarak ANLIK genislet: durum karti + Yenile/Atla gorunur olsun.
        // (Cozum yolu location.reload/navigate oldugu icin sinif sonrasinda kendiliginden temizlenir.)
        try { const _w = document.getElementById('x-downloader-widget'); if (_w) { _w.classList.remove('scanning'); _w.classList.add('xdock-dialog'); } } catch (e) {}

        let saniyeKalan = 120;
        durumText.innerHTML = `
            <div style="text-align:center;">
                <span style="color:#e0245e; font-size:14px; font-weight:bold;">⚠️ Limit / Yükleme Engeli!</span><br>
                <span style="font-size:12px; color:var(--w-text-muted);">${sebepMetni} (Deneme ${gorev.retry_count})</span><br>
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
                        setTimeout(() => { window.location.href = nextUrl; }, 100);
                    } else {
                        location.reload();
                    }
                });
            };
        }
    }

    async function wordTaramaYonetimi(gorev, storageKey) {
        try {
            try { window.__xWordIptal = 0; } catch (e) {}   // aktif/yeni tarama -> iptal-capture bayrağını temizle
            let hamUrl = window.location.href.split('?')[0];
            let activeTask = gorev.kuyruk[0];
            
            if (!activeTask) {
                durumText.innerHTML = `🎉 <b>Tüm Linkler Tarandı!</b><br>Word Raporunu panel üzerinden indirebilirsiniz.`;
                xSetButon("Kapat");
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
            
            // Faz FB-2: FB /share/{p|v|r}/{kod} linklerini GERCEK gonderiye yonlendirir.
            // Duz string esitligi kullanirsak "yanlis sayfadayim" deyip activeUrl'e geri
            // doneriz, FB tekrar yonlendirir -> SONSUZ DONGU. fbHedefeUlastikMi bunu cozer.
            // hamUrl sorgusuz oldugu icin share_url kaybolur -> TAM href ile kontrol et.
            const _fbUlasti = (xPlatform() === 'fb') && fbHedefeUlastikMi(window.location.href, activeUrl);
            if (!_fbUlasti && normalizeUrl(hamUrl) !== normalizeUrl(activeUrl)) {
                // DONGU KIRICI (platformdan bagimsiz guvenlik): ayni ogede 2'den fazla
                // yonlendirme denemesi olduysa oge atlanir. Yoksa bir yonlendirme zinciri
                // sekmeyi sonsuza kadar mesgul eder (FB'de bu ayrica otomasyon imzasidir).
                gorev.redirect_attempts = (gorev.redirect_attempts || 0) + 1;
                if (gorev.redirect_attempts > 2) {
                    printLog(`[Yonlendirme] ${gorev.redirect_attempts}. denemede hedefe ulasilamadi, oge ATLANIYOR. hedef=${activeUrl} gercek=${window.location.href}`);
                    gorev.redirect_attempts = 0;
                    gorev.kuyruk.shift();
                    let _ru = {}; _ru[storageKey] = gorev;
                    chrome.storage.local.set(_ru, () => {
                        if (gorev.kuyruk.length > 0) {
                            const _n = gorev.kuyruk[0].url || gorev.kuyruk[0];
                            setTimeout(() => { window.location.href = _n; }, 400);
                        } else {
                            swSendReliable({
                                action: "submitWordResult",
                                origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                                job_id: gorev.job_id, results: [], final: true
                            }, () => {
                                chrome.storage.local.remove(storageKey, () => {
                                    try { xGxTaramaGostergeKapat(); } catch (e) {} chrome.runtime.sendMessage({ action: "completeJobAndFocusPanel", origin: gorev.server_origin });
                                });
                            });
                        }
                    });
                    return;
                }
                durumText.innerHTML = `🔄 Yönlendiriliyorsunuz...`;
                let _ru2 = {}; _ru2[storageKey] = gorev;
                chrome.storage.local.set(_ru2, () => {
                    // Instagram dahil tüm gönderiler doğrudan (embed olmadan) normal sayfada açılır.
                    setTimeout(() => { window.location.href = activeUrl; }, 100);
                });
                return;
            }
            // Hedefe ulastik -> sayaci sifirla (bir sonraki oge temiz baslasin).
            if (gorev.redirect_attempts) {
                gorev.redirect_attempts = 0;
                let _rz = {}; _rz[storageKey] = gorev;
                chrome.storage.local.set(_rz, () => {});
            }
            
            xSetButon("🛑 Taramayı Durdur");
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
                    // v3.68: Eskiden burada profil SESSİZCE atlanıp kuyruktan düşüyordu.
                    // Artık tivit yolundaki (CASE 2) limit uyarısının AYNISI gösteriliyor:
                    // X kısıtlamasında profil kaybolmaz, 120 sn sonra tekrar denenir.
                    limitEngeliGoster(gorev, storageKey, "Profil yüklenemedi.");
                    return;
                }
                // Profil yüklendi -> sayacı sıfırla (bir sonraki profile sızmasın).
                if (gorev.retry_count) gorev.retry_count = 0;

                let primaryCol = null;
                if (isInstagram) {
                    primaryCol = document.querySelector('.Embed') || document.querySelector('article') || document.querySelector('main[role="main"]') || document.querySelector('main') || document.body;
                } else {
                    primaryCol = document.querySelector('[data-testid="primaryColumn"]');
                }

                await new Promise(r => setTimeout(r, 800));
                
                // TEKDUZE durum yazisi (butun platformlar ayni kalip):
                //   🤖 Görsel alınıyor…    <Platform> · i/N
                // Once X/IG "Kalan: N" diyordu, FB bambaska bir metin kullaniyordu.
                {
                    const _alinan = (gorev.combinedData ? gorev.combinedData.length : 0) + 1;
                    const _toplam = (gorev.total_count) || ((gorev.combinedData ? gorev.combinedData.length : 0) + gorev.kuyruk.length);
                    durumText.innerHTML = `🤖 <b>Görsel alınıyor…</b><br><span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · ${_alinan}/${_toplam}</span>`;
                }

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
                // v3.69 (kullanici istegi): SADECE profil linki verilse bile baslik
                // "Görünen Ad (@kullanıcı)" olsun. Eskiden profil yolunda yalnizca URL'den
                // gelen kullanici adi vardi -> baslik duz "ntvspor" cikiyordu. Simdi gorunen
                // adi da cekiyoruz. Bulamazsak ESKI davranisa duseriz (regresyon YOK).
                // Gruplama LINK'ten geldigi icin (pool_group_key -> tweet_kullanici_adi_oku)
                // username'i @'li yapmak profil+tweet grubunu BOZMAZ.
                let gorunenAd = "";
                if (!isInstagram) {
                    // 1) document.title: X profilinde "Ad (@kullanıcı) / X" — en kararli kaynak.
                    //    DIKKAT: X, okunmamis bildirim varsa basliga "(3) " gibi bir SAYAC
                    //    onekliyor -> "(1) NTV Spor (@NTVSpor) / X". Onu ONCE temizle, yoksa
                    //    gorunen ad "(1) NTV Spor" cikip basliga "(1)" siziyor (saha, v3.69).
                    const _baslik = (document.title || "").replace(/^\(\d+\)\s*/, '');
                    const tm = _baslik.match(/^(.+?)\s*\(@[^)]+\)/);
                    if (tm && tm[1]) gorunenAd = tm[1].trim();
                    // 2) Yedek: profil basligi DOM'u (title henuz guncellenmemisse).
                    if (!gorunenAd) {
                        try {
                            const unEl = document.querySelector('[data-testid="UserName"]');
                            if (unEl) {
                                const ilk = (unEl.innerText || "").split('\n')[0].split('@')[0].trim();
                                if (ilk) gorunenAd = ilk;
                            }
                        } catch (e) {}
                    }
                }
                // account_name = gorunen ad (varsa), username = @kullanıcı.
                // Gorunen ad yoksa VEYA kullanici adiyla ayniysa: eski davranis (ikisi de duz handle).
                const _handleSade = (extractedUser || "").replace(/^@+/, '');
                let _acc, _usr;
                if (gorunenAd && gorunenAd.toLowerCase() !== _handleSade.toLowerCase()) {
                    _acc = gorunenAd;
                    _usr = extractedUser.startsWith('@') ? extractedUser : ('@' + extractedUser);
                } else {
                    _acc = extractedUser;
                    _usr = extractedUser;
                }
                let resItem = {
                    link: activeUrl,
                    account_name: _acc,
                    username: _usr,
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
                        origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                        job_id: gorev.job_id,
                        results: [xStripForServer(resItem, gorev)],
                        final: false
                    }, (response) => {
                        swSendReliable({
                            action: "updateWordProgress",
                            origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
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
                        origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                        job_id: gorev.job_id,
                        results: [xStripForServer(resItem, gorev)],
                        final: true
                    }, () => {
                        swSendReliable({
                            action: "updateWordProgress",
                            origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                            job_id: gorev.job_id,
                            current: progress,
                            total: progress
                        }, () => {
                            chrome.storage.local.remove(storageKey, () => {
                                try { xGxTaramaGostergeKapat(); } catch (e) {}
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

            // ============ Faz FB-2 Adim 2: FACEBOOK YAKALAMA ============
            // Bu blok X seciciye (article[data-testid="tweet"]) HIC ulasmadan erken doner.
            // Ulassaydi FB'de asla bulamaz -> "Tweet yuklenemedi" -> 120sn'de bir
            // location.reload() ile SONSUZ dongu (retry_count'un ust siniri YOK) -> FB'de
            // tekrarlanan yenileme dogrudan otomasyon imzasi (checkpoint/hesap riski).
            //
            // YAKALAMA MODELI — sahadan olculdu (KURU-CALISMA, 2026-07-16, vp=1450x698):
            //   reel : kart 1156x610, kaydirici kartin ATASI (sh=1926) ama kart viewport'a
            //          SIGIYOR (610<698) -> TEK KARE, kaydirma YOK.
            //   posts: kart = MODAL 700x634 (FB gonderi modali IKI SUTUNLU -> ortak ata modal),
            //          gercek icerik modalin ICINDEKI kaydiricida (sh=839/ch=507 — yorumlar
            //          gizlendikten sonra; oncesi 2278) -> 2 DILIM, kadraj = KAYDIRICI bolgesi
            //          (modal DEGIL: modalin ust seridi "X'in Gönderisi" her dilimde TEKRARLARDI).
            const isFacebook = /(^|\.)facebook\.com$/i.test(window.location.hostname);
            if (isFacebook) {
                let _fbGizli = [], _fbGorunur = [], _fbStil = [], _dilimLog = [], _fbSbStyle = null, _sbEls = [];
                try {
                    const _t0 = Date.now();
                    // TEKDUZE durum yazisi — X/IG ile AYNI kalip (bkz. :4303 civari).
                    {
                        const _alinan = (gorev.combinedData ? gorev.combinedData.length : 0) + 1;
                        const _toplam = (gorev.total_count) || ((gorev.combinedData ? gorev.combinedData.length : 0) + gorev.kuyruk.length);
                        durumText.innerHTML = `🤖 <b>Görsel alınıyor…</b><br><span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · ${_alinan}/${_toplam}</span>`;
                    }
                    // 1) Kart: FB gec hidrasyon yapiyor -> ~3sn poll (IG deseni).
                    //    SAHA HATASI (2026-07-16): yalnizca KARTI bekliyordum; etkilesim satiri
                    //    (Beğen/Yorum/Paylaş) FB tarafindan SONRADAN geliyor. Kart erken bulununca
                    //    poll bitiyor, etkilesim henuz yok -> fbBitisY null -> kirpma atlaniyor ->
                    //    yorum kutusu kadraja giriyor. Kanit (saha logu, ayni gonderi turu):
                    //      NTV Spor        sure=1537ms  bitis=-      <- erken cikti
                    //      Futbol Gazetesi sure=3449ms  bitis=700+8  <- bekledi, buldu
                    //    Bu yuzden KART + ETKILESIM ikisini birden bekle.
                    let card = null, _engBekledi = 0;
                    const _engOut = {};
                    // v3.71 (saha): reel'de ray (stats sutunu) 3sn'den GEC geliyor ve sure
                    // dolunca _engOut.list BOS kaliyor. Sonucu ZINCIRLEME:
                    //   liste bos -> fbFindPost'un "medya + etkilesim ortak atasi" dali ATLANIR
                    //             -> yedege duser: media.parentElement = DAR video sarmalayici
                    //             -> kart ~695px (olculdu; dogru kart 767px, stats 783..831'de)
                    //   liste bos -> kadraj GENISLETMESI de calismaz (o da ayni listeye bakar)
                    // Yani stats'i kurtaracak IKI mekanizma da ayni sarta bagli. Bekleme 8sn'ye
                    // cikarildi; ray gelir gelmez zaten break ediliyor -> normal durumda EK
                    // GECIKME YOK, yalnizca gec gelen durumda bekliyoruz.
                    const _isReel = location.pathname.indexOf('/reel/') === 0;
                    const _maxBekle = _isReel ? 40 : 15;
                    for (let w = 0; w < _maxBekle; w++) {
                        card = fbFindPost(_engOut);
                        const _kartHazir = card && card.getBoundingClientRect().height > 100;
                        if (_kartHazir) {
                            // SAHA HATASI (2026-07-20): burada reel icin KOSULSUZ break vardi.
                            // Gerekcesi "reel'de kirpma yok -> etkilesimi beklemeye gerek yok"
                            // idi ve YARIM DOGRUYDU: reel'de alt kirpma (fbBitisY) gerekmiyor,
                            // AMA kadraj GENISLETMESI (stats sutunu) tam da bu dugmelere bakiyor
                            // (_engOut.list). Ray henuz cizilmemisse liste BOS -> _genisletildi=0
                            // -> begen/yorum/paylas sutunu kadraj DISINDA kaliyordu (kullanici
                            // ciktisi: video var, sag sutun YOK).
                            // Artik reel de rayi BEKLIYOR. Gelmezse 3sn sonra eskisi gibi devam
                            // eder -> bugunkunden kotu olamaz.
                            if (_isReel) {
                                // Reel'de ray kartin ALT AGACINDA olmayabilir (ayri sutun) ->
                                // card.querySelector DEGIL, fbFindPost'un topladigi GORUNUR liste.
                                // AMA listeye ILK giren genelde KIRLETICI ("...ile paylasiliyor", ~12x12);
                                // tek basina break edince (video+kirletici) ortak atasi TUM SAYFA kadar
                                // GENIS kart veriyor (saha log 2026-07-28: 1538x865, engBekle=0, engListe=1
                                // -> stats sutunu eksik). Cozum: MAKUL BOYUTLU (>=20px, kirletici olmayan)
                                // EN AZ 2 gercek ray dugmesi gorunene kadar bekle; gelmezse timeout -> eskisi
                                // gibi devam (bugunkunden kotu degil). WIDGET xFbIdleYakala IKIZI ayni.
                                var _ray = (_engOut.list || []).filter(function (e) { var r = e.getBoundingClientRect(); return r.width >= 20 && r.height >= 20; }).length;
                                if (_ray >= 2) break;
                            } else if (card.querySelector(FB_ENG_SEL)) {
                                break;
                            }
                            _engBekledi++;
                        }
                        await new Promise(r => setTimeout(r, 200));
                    }
                    if (!card) throw new Error("gonderi karti bulunamadi");

                    // 1b) AKIL SAGLIGI KAPISI (2026-07-20). Poll dongusu "kart hazir mi" diye
                    //     bakiyor ama DONGUDEN SONRA dogrulamiyordu: card TRUTHY ama 0x0 ise
                    //     `if (!card)` tutmuyor, yakalama bozuk olcuyle devam ediyor ve
                    //     captureAndCrop gecersiz dikdortgende TUM SEKMEYI donduruyordu ->
                    //     rapora sol menu/reklamlarla birlikte tam sayfa giriyordu (sahada oldu).
                    //     Artik: kart makul degilse gonderiyi TEMIZ ATLA. Yanlis goruntuyu
                    //     rapora koymaktansa atlamak dogru — atlama gorunur, yanlis goruntu degil.
                    {
                        const _cr = card.getBoundingClientRect();
                        if (_cr.width < 120 || _cr.height < 120) {
                            throw new Error(`kart olcusu gecersiz (${Math.round(_cr.width)}x${Math.round(_cr.height)})`);
                        }
                        if (_cr.width > window.innerWidth * 0.95 && _cr.height > window.innerHeight * 0.95) {
                            throw new Error(`kart TUM SAYFA kadar (${Math.round(_cr.width)}x${Math.round(_cr.height)}) — kadraj guvenilmez`);
                        }
                    }

                    // 2) Yorumlari gizle (kullanici karari) + kesik metni ac.
                    //    Yorum gizleme ayrica kart yuksekligini YAPISAL olarak stabillestirir
                    //    (tembel yuklenen yorumlar yakalama sirasinda kartı buyutuyordu).
                    _fbGizli = fbYorumlariGizle(card);
                    const smN = await fbMetniAc(card);
                    await new Promise(r => setTimeout(r, 300));   // reflow

                    // 3) Widget kadrajda gorunmesin (IG'deki gibi visibility — reflow/flas olmasin).
                    [document.getElementById('x-downloader-widget'), document.getElementById('w-cb-container')]
                        .forEach(function (el) { if (el) { _fbGorunur.push([el, el.style.visibility]); el.style.visibility = 'hidden'; } });
                    await new Promise(r => setTimeout(r, 120));

                    // 4) Kaydirici + kadraj
                    const _mode = location.pathname.indexOf('/reel/') === 0 ? 'reel' : 'posts';
                    const sc = fbScroller(card);
                    const scIc = !!(sc && card.contains(sc));   // 'ic' => modal ici kaydirici (posts)
                    const kadrajEl = scIc ? sc : card;
                    const dpr = window.devicePixelRatio || 1;

                    // --- Sayfayi elleyen ayarlar OLCUMDEN ONCE (hepsi yerlesimi degistiriyor) ---
                    // (a) KAYDIRMA CUBUGU kadrajda gorunmesin (kullanici istegi 2026-07-16).
                    //     ONCE yalnizca fbScroller'in buldugu ogeye scrollbarWidth:'none'
                    //     uyguluyordum ve cubuk SAHADA KALDI -> cubuk BASKA bir ogeye aitmis.
                    //     Ayrica yedegim (genisligi cropWidth'ten dusmek) GORSELI KIRPIYORDU.
                    //     Cozum: yakalama suresince GECICI stil enjekte et — hangi oge olursa
                    //     olsun butun cubuklari kapsar, -webkit-scrollbar ile Chrome'da kesin
                    //     calisir, ve kadraj genisligine DOKUNMAZ (kirpma yok).
                    //     finally'de kaldirilir.
                    if (!document.getElementById('x-fb-sb-hide')) {
                        const _sbStyle = document.createElement('style');
                        _sbStyle.id = 'x-fb-sb-hide';
                        _sbStyle.textContent =
                            '*::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}' +
                            '*{scrollbar-width:none!important;-ms-overflow-style:none!important}';
                        (document.head || document.documentElement).appendChild(_sbStyle);
                        _fbSbStyle = _sbStyle;
                        await new Promise(r => setTimeout(r, 120));   // reflow
                    }
                    // [KAYDIRMA ÇUBUĞU GİZLE — KURŞUN-GEÇİRMEZ]: scroll kaplarına overflow:hidden (scrollTop ile JS
                    // kaydırma yine çalışır -> stitch bozulmaz; HİÇBİR Chrome/sürümde çubuk çizilmez, özgüllük bağımsız).
                    // scrollbar-width:none eski Chrome'da yok sayıldığından çubuk kalıyordu. finally'de geri alınır.
                    // (Widget xFbIdleYakala ile AYNI önlem.)
                    try {
                        const _sbAdaylar = [card]; if (sc) _sbAdaylar.push(sc);
                        card.querySelectorAll('*').forEach(e => _sbAdaylar.push(e));
                        _sbAdaylar.forEach(e => {
                            try {
                                if (!e || e.__xSbDone) return;
                                const _cs = getComputedStyle(e);
                                if (!(e === sc || /(auto|scroll)/.test(_cs.overflowY + ' ' + _cs.overflowX))) return;
                                e.__xSbDone = true;
                                _sbEls.push([e, e.style.getPropertyValue('overflow'), e.style.getPropertyPriority('overflow')]);
                                e.style.setProperty('overflow', 'hidden', 'important');
                            } catch (x) {}
                        });
                    } catch (x) {}
                    if (scIc && sc) {
                        // (b) YUMUSAK KAYDIRMA: scrollTop animasyonlu ise 320ms'de hedefe varmaz
                        //     -> dilim YANLIS konumda yakalanir (birlestirme izi). IG yolu da
                        //     ayni onlemi aliyor (scrollBehavior='auto').
                        _fbStil.push([sc, 'scrollBehavior', sc.style.scrollBehavior]);
                        sc.style.scrollBehavior = 'auto';
                        // (c) YAPISKAN (sticky) ogeler: kaydirinca YERINDE KALIR ve bir sonraki
                        //     dilimin USTUNDE tekrar gorunur -> birlestirme izi/tekrar.
                        //     Gizlemek yerine static: yerlesim bozulmasin, sadece yapismasin.
                        kadrajEl.querySelectorAll('*').forEach(function (e) {
                            try {
                                if (getComputedStyle(e).position === 'sticky') {
                                    _fbStil.push([e, 'position', e.style.position]);
                                    e.style.position = 'static';
                                }
                            } catch (x) {}
                        });
                        await new Promise(r => setTimeout(r, 200));   // reflow
                    }

                    let kr = kadrajEl.getBoundingClientRect();
                    // REEL: stats sutunu (👍/💬/↗) kartin rect'ine GIRMIYOR -> ata dogru
                    // bulunsa bile kadraj sutunu KESIYOR (saha: kart 1120 genislik, stats yok).
                    // Kadraji GORUNUR etkilesim butonlarini kapsayacak sekilde genislet.
                    // NOT (2026-07-20 olcumu): burada eskiden "position:absolute oldugu icin"
                    // yaziyordu; FB o sutunu artik position:relative ile ciziyor. Genisletme
                    // YINE DE gerekli — sebep konumlandirma degil, sutunun kartin ALT AGACINDA
                    // olmamasi. Gerekceyi konumlandirmaya baglamak yaniltici oldugu icin duzeltildi.
                    // Yalnizca scIc DEGILKEN (kadraj=kart): modal ici kaydiricida kadraj
                    // zaten kaydirilan bolge, genisletmek yanlis olurdu.
                    let _genisletildi = 0;
                    if (!scIc && _engOut.list && _engOut.list.length) {
                        let L = kr.left, T = kr.top, R = kr.right, B = kr.bottom;
                        _engOut.list.forEach(function (e) {
                            const r = e.getBoundingClientRect();
                            if (r.width <= 0 || r.height <= 0) return;
                            // Yalnizca KART sinirlarina makul yakinlikta olanlar (baska
                            // kartin/karuselin butonlari kadraji sismesin).
                            if (r.left < kr.left - 300 || r.right > kr.right + 400) return;
                            if (r.bottom < kr.top - 200 || r.top > kr.bottom + 200) return;
                            // +8px pay: butonun kendi rect'i kapsayicisinin ic boslugunu/
                            // golgesini icermez; paysiz kadraj sutunu KIL PAYI kesiyor.
                            L = Math.min(L, r.left - 8); T = Math.min(T, r.top - 8);
                            R = Math.max(R, r.right + 8); B = Math.max(B, r.bottom + 8);
                        });
                        if (R > kr.right || B > kr.bottom || L < kr.left || T < kr.top) {
                            _genisletildi = Math.round((R - L) - kr.width);
                            kr = { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T };
                        }
                    }
                    const cropLeft = Math.max(0, Math.round(kr.left));
                    // NOT: cubuk yukarida STIL ile gizlendi -> genisligi kadrajdan DUSMUYORUZ.
                    // (Eski yedek "kr.width - sbW" idi ve GORSELI KIRPIYORDU — kullanici
                    // "gorsel genisligini kirmadan coz" dedi.)
                    const cropWidth = Math.round(Math.min(window.innerWidth - cropLeft, kr.width));
                    let fullH = scIc ? sc.scrollHeight : Math.round(kr.height);
                    const pencere = scIc ? sc.clientHeight : Math.round(kr.height);
                    // Kullanici karari: goruntu BEGENI/YORUM/PAYLAS satirinin HEMEN ALTINDA bitsin.
                    // Altta kalanlar ("En alakalı" menusu, "bazı yorumlar filtrelenmiş olabilir",
                    // yorum kutusu) gonderiye ait degil ve [role="article"] olmadiklari icin yorum
                    // gizlemeye TAKILMIYORLAR -> yuksekligi burada kesiyoruz.
                    //
                    // SADECE /posts. REEL'DE UYGULAMA: reel duzeni FARKLI — etkilesim
                    // butonlari SAGDA DIKEY, aciklama ise ALTTA; "butonlarin altinda bitir"
                    // demek reel'de ACIKLAMAYI KESMEK demek (saha hatasi: reel aciklamasi
                    // yok olmustu). Reel'de zaten modal/yorum bolumu yok -> kesmeye gerek de yok.
                    //
                    // KOSUL 'scIc' DEGIL 'mode' (saha hatasi 2026-07-16): scIc "modal ici
                    // kaydirici VAR MI" demek, "reel mi" demek DEGIL. KISA bir /posts
                    // gonderisinde icerik modala SIGIYOR -> kaydirici yok -> scIc=false ->
                    // kirpma ATLANIYORDU ve yorum kutusu ("... adıyla yorum yap") kadraja
                    // giriyordu. Saha logu: NTV Spor "yol=posts/tek-kare, bitis=-, kesilen=0px"
                    // (kaydiricili gonderilerde ise calisiyordu: "posts/modal-kaydir, bitis=700+8").
                    const _bitisTani = {};
                    const _bitis = (_mode !== 'reel') ? fbBitisY(card, sc, scIc, _bitisTani) : null;
                    const _bitisPay = 8;   // butonlarin hemen ALTI (kesik gorunmesin)
                    let _kesildi = 0;
                    if (_bitis && _bitis + _bitisPay < fullH) {
                        _kesildi = fullH - (_bitis + _bitisPay);
                        fullH = _bitis + _bitisPay;
                    }
                    const segs = [];

                    if (!scIc) {
                        // --- reel: tek kare --- (fullH, etkilesim satirinda kesilmis olabilir)
                        const top = Math.max(0, Math.round(kr.top));
                        const h = Math.round(Math.min(window.innerHeight - top, fullH));
                        const res = await new Promise(resolve => {
                            swSendReliable({ action: "captureAndCrop", vw: window.innerWidth, rect: { top: top, left: cropLeft, width: cropWidth, height: h }, dpr: dpr }, resolve);
                        });
                        if (res && res.status === "success" && res.dataUrl) segs.push(res.dataUrl);
                    } else {
                        // --- posts: modal ici kaydiriciyi kaydir, dilimle ---
                        // KRITIK: bir kaydiricinin gidebilecegi EN FAZLA scrollTop = sh - ch
                        // (saha: 839-507 = 332). Naif "scrollTop = y" son dilimde 507 ister,
                        // tarayici 332'ye KIRPAR -> "kaydirma tutmadi" korumasi tetiklenir ve
                        // HER /posts gonderisi atlanirdi. Koruma olmasaydi daha kotusu: dilim
                        // 332..839'u alir, 332..507 IKI KEZ gorunur -> bozuk goruntu, sessizce.
                        // Cozum: hedefi maxScroll'a kirp, aradaki farki (ofset) KADRAJDAN dus.
                        const oncekiTop = sc.scrollTop;
                        const maxScroll = Math.max(0, fullH - pencere);
                        // NOT: scrollbar/scrollBehavior/sticky ayarlari OLCUMDEN ONCE yapildi
                        // (yukarida) — hepsi yerlesimi degistiriyor, olcumden sonra uygulanirsa
                        // kr/fullH/pencere BAYAT kalirdi.
                        let y = 0, guard = 0;
                        while (y < fullH && guard < 20) {
                            guard++;
                            const hedef = Math.min(y, maxScroll);
                            sc.scrollTop = hedef;
                            await new Promise(r => setTimeout(r, 320));
                            // HAPSOLMUS KAYDIRMA: istedigimiz yere gercekten gitti mi?
                            if (Math.abs(sc.scrollTop - hedef) > 4) {
                                printLog(`[Facebook] Kaydirma TUTMADI (istenen=${hedef}, gercek=${sc.scrollTop}) -> IPTAL`);
                                segs.length = 0; break;
                            }
                            kr = kadrajEl.getBoundingClientRect();
                            // Son dilimde kaydirici sonuna dayanir: y ile gercek scrollTop
                            // arasindaki fark kadar ASAGIDAN kadraj al (ust uste binme YOK).
                            const ofset = Math.max(0, y - sc.scrollTop);
                            const sliceH = Math.round(Math.min(pencere - ofset, fullH - y));
                            if (sliceH <= 2) break;
                            const res = await new Promise(resolve => {
                                swSendReliable({ action: "captureAndCrop", vw: window.innerWidth, rect: { top: Math.max(0, Math.round(kr.top + ofset)), left: cropLeft, width: cropWidth, height: sliceH }, dpr: dpr }, resolve);
                            });
                            if (!res || res.status !== "success" || !res.dataUrl) break;
                            // AYNI DILIM korumasi: kaydirma calismiyorsa her dilim AYNI cikar.
                            // Cikti BOS OLMADIGI icin captureLooksBlank (std<6) bunu YAKALAMAZ ->
                            // makul gorunen YANLIS gorsel gonderilir. Tek kesin koruma bu.
                            if (segs.length && segs[segs.length - 1] === res.dataUrl) {
                                printLog("[Facebook] AYNI dilim 2 kez -> kaydirma calismiyor, IPTAL.");
                                segs.length = 0; break;
                            }
                            segs.push(res.dataUrl);
                            _dilimLog.push(`y=${y}/st=${sc.scrollTop}/of=${ofset}/h=${sliceH}`);
                            y += sliceH;
                        }
                        try { sc.scrollTop = oncekiTop; } catch (e) {}
                    }

                    if (!segs.length) throw new Error("parca alinamadi");
                    const raw = (segs.length === 1) ? segs[0] : await igVerticalStitch(segs);
                    const shot = await compressScreenshot(raw);
                    const a = fbAuthor();
                    const mode = _mode;

                    // KULLANICI KARARI (2026-07-17): Word'de PAYLASIM linki degil, FB'nin
                    // YONLENDIRDIGI GERCEK sayfa gorunsun.
                    //   kuyruk : facebook.com/share/p/1DTEaEbLsJ   (kullanicinin yapistirdigi)
                    //   gercek : facebook.com/futbolgazetesi/posts/pfbid...  (FB buraya goturdu)
                    // Yan fayda (asil kazanc): GRUPLAMA da duzeliyor — paylasim linkinde sayfa
                    // adi YOK, o yuzden pool_group_key basliga dusuyordu ("fb:futbol gazetesi",
                    // kirilgan); gercek linkte ad VAR -> "fb:futbolgazetesi" (kararli) ve ayni
                    // sayfanin share'li + dogrudan linkleri AYNI Baslik 2 altinda birlesir.
                    //
                    // Ham href yeterli: sunucu x_temizle_link ile kanoniklestiriyor (?rdid,
                    // ?share_url atilir) ve normalize_link_key FB'de fb_canonical_link'e
                    // delege ettigi icin IDEMPOTENT -> goruntu anahtari ile havuz linkinin
                    // anahtari AYNI kalir. Havuz tarama basinda temizlendigi icin
                    // (/api/auto/start -> pool.clear()) eski /share/p ogesiyle cakisma olmaz.
                    //
                    // DIKKAT: asagidaki printLog bu degiskeni KULLANIYOR -> tanim LOGDAN ONCE
                    // olmali. (Saha hatasi 2026-07-17: log satirinda kullanip asagida let ile
                    // tanimlamistim -> "Cannot access '_kayitLink' before initialization" ->
                    // HER FB yakalamasi patliyordu. Sozdizimi gecerliydi, TDZ calisma-ani hatasi.)
                    let _kayitLink = activeUrl;
                    try {
                        const _href = window.location.href;
                        if (/(^|\.)facebook\.com$/i.test(new URL(_href).hostname)) _kayitLink = _href;
                    } catch (e) {}
                    // TEKDUZE: butun platformlar "Yakalama: N parça (WxH)" kalibiyle baslar;
                    // platforma ozel ayrintilar arkasina eklenir.
                    printLog(
                        `Yakalama: ${segs.length} parça (${cropWidth}x${fullH}), yol=${mode}/${scIc ? 'modal-kaydir' : 'tek-kare'}` +
                        `, yazar="${a.ad}" (${a.kaynak})` +
                        (_kayitLink !== activeUrl ? `, link=YONLENEN(${_kayitLink.split('?')[0].slice(-40)})` : '') +
                        `, yorumGizli=${_fbGizli.length}, seeMore=${smN}` +
                        (_genisletildi ? `, kadrajGenisletildi=+${_genisletildi}px(stats)` : '') +
                        `, bitis=${_bitis === null ? '-' : _bitis + '+' + _bitisPay}${_bitisTani.el ? ' <- ' + _bitisTani.el : ''}, kesilen=${_kesildi}px` +
                        `, sticky=${_fbStil.filter(function (p) { return p[1] === 'position'; }).length}` +
                        (_dilimLog.length ? `, dilimler=[${_dilimLog.join(' | ')}]` : '') +
                        `, engBekle=${_engBekledi}, engListe=${_engOut.list ? _engOut.list.length : 0}` +
                        `, sure=${Date.now() - _t0}ms`
                    );
                    // Kirpma yapilamadiysa SEBEBINI yaz (yorum kutusu kadraja girer -> onemli).
                    if (_mode !== 'reel' && _bitis === null) {
                        printLog(`[TANI] Kirpma YAPILAMADI (sebep=${_bitisTani.sebep || 'bilinmiyor'})` +
                                 (_bitisTani.labels ? `, karttaki aria-label'lar: ${_bitisTani.labels.join(' | ')}` : ''));
                    }

                    // 5) Sonuc: baslik = DUZ GORUNEN AD ("Futbol Gazetesi", "ESRA EROL").
                    //    KULLANICI KARARI DEGISTI (2026-07-16): once "Ad (@slug)" istenmisti
                    //    (X ile tutarli olsun diye), sahada gorunce "(@futbolgazetesi) gerek yok"
                    //    dendi -> username BOS gonderiyoruz; app.py submit_word_result'in
                    //    else dali title = account_name yapiyor (app.py degisikligi GEREKMIYOR).
                    //    Gruplama ETKILENMEZ: pool_group_key slug'i LINK'ten turetiyor, bu
                    //    alandan degil. a.ad hicbir zaman bos kalmaz (fbAuthor slug'a duser).
                    // KULLANICI KARARI (2026-07-17): Word'de PAYLASIM linki degil, FB'nin
                    // YONLENDIRDIGI GERCEK sayfa gorunsun.
                    //   kuyruk : facebook.com/share/p/1DTEaEbLsJ   (kullanicinin yapistirdigi)
                    //   gercek : facebook.com/futbolgazetesi/posts/pfbid...  (FB buraya goturdu)
                    // Yan fayda (asil kazanc): GRUPLAMA da duzeliyor — paylasim linkinde sayfa
                    // adi YOK, o yuzden pool_group_key "fb:@facebook_user" tek torbasina
                    // dusuyordu; gercek linkte ad VAR -> "fb:futbolgazetesi" olur ve gonderi
                    // sayfasinin kendi Baslik 2'si altinda toplanir.
                    //
                    // Ham href yeterli: sunucu x_temizle_link ile kanoniklestiriyor (?rdid,
                    // ?share_url gibi izleme parametreleri atilir) ve normalize_link_key FB'de
                    // fb_canonical_link'e delege ettigi icin IDEMPOTENT -> goruntu anahtari
                    // (xNormLink(resItem.link)) ile havuz linkinin anahtari AYNI kalir.
                    // Havuz tarama basinda temizlendigi icin (/api/auto/start -> pool.clear())
                    // eski /share/p ogesiyle cakisma olmaz.
                    const resItem = {
                        link: _kayitLink,
                        account_name: a.ad || '',
                        username: '',
                        screenshot: shot,
                        is_profile: false
                    };
                    _fbGizli.forEach(function (p) { try { p[0].style.display = p[1] || ''; } catch (e) {} });
                    _fbGorunur.forEach(function (p) { try { p[0].style.visibility = p[1] || ''; } catch (e) {} });
                    _fbStil.forEach(function (p) { try { p[0].style[p[1]] = p[2] || ''; } catch (e) {} });
                    try { if (_fbSbStyle) { _fbSbStyle.remove(); _fbSbStyle = null; } } catch (e) {}
                    try { _sbEls.forEach(function (p) { try { var e = p[0]; if (p[1]) e.style.setProperty('overflow', p[1], p[2] || ''); else e.style.removeProperty('overflow'); try { delete e.__xSbDone; } catch (_) { e.__xSbDone = undefined; } } catch (x) {} }); _sbEls = []; } catch (e) {}
                    _fbGizli = []; _fbGorunur = []; _fbStil = [];

                    gorev.combinedData.push(resItem);
                    gorev.retry_count = 0;
                    gorev.kuyruk.shift();
                    const kaldi = gorev.kuyruk.length;
                    const toplam = (gorev.total_count) || (gorev.combinedData.length + kaldi);
                    // TEKDUZE durum yazisi (butun platformlar ayni kalip)
                    durumText.innerHTML = `✅ <b>Gönderi alındı</b><br><span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · ${gorev.combinedData.length}/${toplam}</span>`;
                    swSendReliable({
                        action: "submitWordResult",
                        origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                        job_id: gorev.job_id,
                        results: [xStripForServer(resItem, gorev)],
                        final: kaldi === 0
                    }, () => {
                        swSendReliable({
                            action: "updateWordProgress",
                            origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                            job_id: gorev.job_id,
                            current: gorev.combinedData.length,
                            total: toplam
                        }, () => {
                            if (kaldi > 0) {
                                let u = {}; u[storageKey] = gorev;
                                chrome.storage.local.set(u, () => {
                                    const nextUrl = gorev.kuyruk[0].url || gorev.kuyruk[0];
                                    setTimeout(() => { window.location.href = nextUrl; }, 600);
                                });
                            } else {
                                chrome.storage.local.remove(storageKey, () => {
                                    try { xGxTaramaGostergeKapat(); } catch (e) {} chrome.runtime.sendMessage({ action: "completeJobAndFocusPanel", origin: gorev.server_origin });
                                });
                            }
                        });
                    });
                    return;
                } catch (e) {
                    printLog("[Facebook] YAKALAMA HATA: " + (e.message || e) + " -> gonderi atlaniyor");
                } finally {
                    // Sayfayi ELLEDIK (yorum gizleme + widget + sticky/scrollBehavior) -> her
                    // durumda geri al.
                    _fbGizli.forEach(function (p) { try { p[0].style.display = p[1] || ''; } catch (e) {} });
                    _fbGorunur.forEach(function (p) { try { p[0].style.visibility = p[1] || ''; } catch (e) {} });
                    _fbStil.forEach(function (p) { try { p[0].style[p[1]] = p[2] || ''; } catch (e) {} });
                    // Gecici cubuk-gizleme stili: HER durumda kaldir (sayfada iz birakmasin).
                    try {
                        if (_fbSbStyle) { _fbSbStyle.remove(); _fbSbStyle = null; }
                        const _kalan = document.getElementById('x-fb-sb-hide');
                        if (_kalan) _kalan.remove();
                    } catch (e) {}
                    try { _sbEls.forEach(function (p) { try { var e = p[0]; if (p[1]) e.style.setProperty('overflow', p[1], p[2] || ''); else e.style.removeProperty('overflow'); try { delete e.__xSbDone; } catch (_) { e.__xSbDone = undefined; } } catch (x) {} }); _sbEls = []; } catch (e) {}
                }
                // --- Yakalama basarisiz: gonderiyi TEMIZ atla (retry dongusune GIRME) ---
                // TEKDUZE durum yazisi (butun platformlar ayni kalip)
                durumText.innerHTML = `
                    <div style="text-align:center;">
                        <span style="color:#f7ba14; font-size:13px; font-weight:bold;">⏭️ Gönderi atlandı</span><br>
                        <span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · ekran görüntüsü alınamadı, sonrakine geçiliyor.</span>
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
                            origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                            job_id: gorev.job_id,
                            results: [],
                            final: true
                        }, () => {
                            chrome.storage.local.remove(storageKey, () => {
                                try { xGxTaramaGostergeKapat(); } catch (e) {}
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

            // ============ Faz YT-2: YOUTUBE YAKALAMA (video) ============
            // Bu blok X seciciye HIC ulasmadan doner (aksi halde 120sn'de bir reload ile
            // SONSUZ DONGU — FB v3.15 ve TikTok Faz 1'inde yasandi).
            //
            // YERLESIM — sahadan olculdu (2026-07-20, vp=1440x900, cikis yapilmis, TR):
            //   #movie_player   [16,68,943,530]    oynatici
            //   h1 baslik       [16,610,943,28]
            //   kanal+abone     [68,648,..]/[68,670,..]
            //   eylem cubugu    [550,650,254,40]   (begeni sayisi + Paylas + Kaydet)
            //   goruntulenme    [28,713,919,20]    "4,8 Mn görüntüleme 13 saat önce"
            //   -> KADRAJ = oynatici ustu .. goruntulenme alti (kullanici karari:
            //      oynatici + baslik + kanal + istatistik; aciklama ve yorumlar DISARIDA)
            //   Sagdaki oneriler (x>975) ve ust nav (y<56) kadrajin DISINDA kaliyor.
            //
            // Faz 2a: yalnizca /watch. /shorts/ ve /post/ AYRI yerlesim -> Faz 2b'de;
            // simdilik TEMIZ ATLANIYOR (asagida).
            if (xPlatform() === 'yt' && location.pathname.toLowerCase() === '/watch') {
                let _ytGorunur = [], _ytGizli = [];
                try {
                    {
                        const _alinan = (gorev.combinedData ? gorev.combinedData.length : 0) + 1;
                        const _toplam = (gorev.total_count) || ((gorev.combinedData ? gorev.combinedData.length : 0) + gorev.kuyruk.length);
                        durumText.innerHTML = `🤖 <b>Görsel alınıyor…</b><br><span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · ${_alinan}/${_toplam}</span>`;
                    }

                    // 1) Oynatici + baslik gelene kadar bekle (YouTube SPA, gec hidrasyon).
                    //    NOT: goruntulenme satirinin METNI beklenmez — YouTube rakamlari
                    //    DONEN ANIMASYONLA ciziyor, textContent "1234567890..." veriyor ama
                    //    EKRANDA dogru sayi gorunuyor (olculdu). Metne gore beklemek
                    //    25 tur (7.5sn) sonunda bile bitmezdi.
                    let ply = null, bas = null;
                    for (let w = 0; w < 20; w++) {
                        ply = document.querySelector('#movie_player');
                        bas = document.querySelector('h1.ytd-watch-metadata, #title h1');
                        if (ply && bas && ply.getBoundingClientRect().height > 100) break;
                        await new Promise(r => setTimeout(r, 300));
                    }
                    if (!ply || !bas) throw new Error("oynatici/baslik bulunamadi");

                    // 2) REKLAM BITENE KADAR BEKLE. Reklam oynarken oynaticida REKLAM var ve
                    //    video.duration REKLAMIN suresini veriyor (olculdu: 6.1sn, gercek video
                    //    8170.9sn). Yakalama o anda yapilsa rapora REKLAM girerdi.
                    //    Isaret: #movie_player'da 'ad-showing' sinifi. En fazla ~12sn beklenir;
                    //    bitmezse yine de devam edilir (bos rapor yerine dogru cerceve sansi).
                    let _reklamBekledi = 0;
                    for (let w = 0; w < 40; w++) {
                        if (!/(^|\s)ad-showing(\s|$)/.test(ply.className)) break;
                        _reklamBekledi++;
                        const atla = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button');
                        if (atla) { try { atla.click(); } catch (e) {} }   // "Reklami atla" cikarsa kullan
                        await new Promise(r => setTimeout(r, 300));
                    }

                    // 3) Kareyi SABITLE: duraklat + basa sar -> ayni video her taramada AYNI
                    //    goruntu (TikTok'ta ogrenilen). Reklam bittikten SONRA yapilir.
                    const vid = document.querySelector('#movie_player video');
                    let _kareOnce = null, _kareSonra = null;
                    if (vid) {
                        _kareOnce = +(vid.currentTime || 0).toFixed(2);
                        await new Promise(function (res) {
                            let bitti = false; const fin = () => { if (!bitti) { bitti = true; res(); } };
                            try { vid.pause(); } catch (e) {}
                            if (Math.abs(vid.currentTime || 0) < 0.05) { fin(); return; }
                            try { vid.addEventListener('seeked', fin, { once: true }); } catch (e) {}
                            try { vid.currentTime = 0; } catch (e) { fin(); }
                            setTimeout(fin, 1500);
                        });
                        _kareSonra = +(vid.currentTime || 0).toFixed(2);
                    }

                    // 4) Kadraja BINEBILECEK katmanlari gizle (tiklama YOK — onay/abonelik
                    //    durumu degistirmeyiz; FB cerez bandi kararinin aynisi).
                    // OYNATICI KONTROLLERI de gizlenir: pause() YouTube'a kontrolleri
                    // GOSTERTIYOR (duraklat dugmesi, ilerleme cubugu, "0:00 / 2:14", ayarlar).
                    // Kullanicinin istedigi cerceve KONTROLSUZ videoydu; kare sabitlemenin
                    // yan etkisi olarak kadraja giriyorlardi.
                    ['ytd-consent-bump-v2-lightbox',
                     'ytd-popup-container tp-yt-paper-dialog',
                     'tp-yt-iron-overlay-backdrop',
                     'ytd-mealbar-promo-renderer',
                     '#masthead-container',
                     '.ytp-chrome-top', '.ytp-chrome-bottom',
                     '.ytp-gradient-top', '.ytp-gradient-bottom',
                     '.ytp-large-play-button', '.ytp-play-button-overlay'].forEach(function (sel) {
                        document.querySelectorAll(sel).forEach(function (el) {
                            const r = el.getBoundingClientRect();
                            if (r.width < 1 || r.height < 1) return;
                            _ytGizli.push([el, el.style.display]);
                            el.style.setProperty('display', 'none', 'important');
                        });
                    });
                    await new Promise(r => setTimeout(r, 250));   // reflow

                    // 5) KADRAJ = oynatici + baslik + kanal + istatistik birlesimi.
                    //    SABIT KOORDINAT YOK: yerlesim pencere genisligine gore degisiyor.
                    const parcalar = [];
                    // TUM eslesmeleri tara, ILK GORUNUR olani al.
                    // SAHA HATASI (2026-07-20, canli olcum): querySelector ILK eslesmeyi verir
                    // ve YouTube'da o cogu zaman 0x0 bir ikiz oluyor:
                    //   querySelectorAll('#top-level-buttons-computed') -> 3 adet: 0x0, 254x40, 0x0
                    // Eski kod ilkini (0x0) alip gorunurluk kapisinda ELIYORDU -> begeni/paylas
                    // satiri kadraja HIC girmiyordu (sessiz: hata yok, sadece eksik cerceve).
                    // Ayni tuzak Facebook'ta da yasanmisti (gizli 0x0 bildirim dialog'u modal
                    // secimini kaciriyordu) -> gorunurluk secimin PARCASI olmali, sonradan
                    // gelen bir filtre degil.
                    const ekle = function (sel) {
                        const hepsi = document.querySelectorAll(sel);
                        for (let qi = 0; qi < hepsi.length; qi++) {
                            const r = hepsi[qi].getBoundingClientRect();
                            if (r.width > 1 && r.height > 1) { parcalar.push(r); return; }
                        }
                    };
                    ekle('#movie_player');
                    ekle('h1.ytd-watch-metadata');
                    ekle('#owner');
                    ekle('#top-level-buttons-computed');
                    // ACIKLAMA KUTUSU (kullanici duzeltmesi 2026-07-20): once yalnizca
                    // ytd-watch-info-text (goruntulenme satiri) alinip orada kesiliyordu.
                    // Kullanici istedigi ciktiyi gosterdi: aciklama kutusunun TAMAMI da
                    // girmeli ("149 B görüntüleme 2 yıl önce" + aciklama metni + "...daha fazla").
                    // #bottom-row o kutuyu KAPSIYOR (olculdu 1150x800: info [.,651,.,20]
                    // -> bottom-row [16,627,715,116] alt=743).
                    ekle('#bottom-row');
                    if (!parcalar.length) throw new Error("kadraj ogesi bulunamadi");

                    const PAY = 8;
                    let L = Math.min.apply(null, parcalar.map(r => r.left)) - PAY;
                    let T = Math.min.apply(null, parcalar.map(r => r.top)) - PAY;
                    let R2 = Math.max.apply(null, parcalar.map(r => r.right)) + PAY;
                    let B_tam = Math.max.apply(null, parcalar.map(r => r.bottom)) + PAY;
                    // SINIR: YORUMLAR. Kadraj asla yorumlara TASMAMALI — kaydirirken
                    // yorumlari iceri almak TikTok'ta yasadigimiz "sonraki karti yakalama"
                    // hatasinin aynisi olurdu (olculdu 960x760: kadraj alt=625, yorumlar 641).
                    try {
                        const _ym = document.querySelector('#comments');
                        if (_ym) {
                            const _yr = _ym.getBoundingClientRect();
                            if (_yr.height > 0) B_tam = Math.min(B_tam, _yr.top);
                        }
                    } catch (e) {}
                    // SINIR: SAG KENAR = OYNATICININ SAG KENARI (v3.60, olculerek bulundu).
                    //
                    // Kullanici ciktisinda kadrajin saginda ~16px'lik bir serit vardi ve
                    // v3.55/v3.56/v3.57/v3.58'de yaptigim dort duzeltmenin hicbiri onu
                    // kaldirmadi. Sebebi 1280x593'te birebir olculdu:
                    //
                    //   #movie_player          sag = 814
                    //   h1.ytd-watch-metadata  sag = 814
                    //   div#description        sag = 814   <- kutunun GERCEK kenari
                    //   #below                 sag = 814
                    //   #bottom-row            sag = 826   <- 12px OLU dolgu
                    //   #primary               sag = 830
                    //   #secondary             sol = 830   <- primary'nin bittigi yerde BASLIYOR
                    //
                    // Iki sonuc cikiyor:
                    // 1) Kadraji sisiren sey #bottom-row: kendi tek gorunur cocugundan
                    //    (#description, 814) 12px GENIS. Ustune +PAY binince primary'nin
                    //    kenarina dayaniyor.
                    // 2) #primary.right'a kirpmak (v3.56) TANIM GEREGI ise yaramaz, cunku
                    //    #secondary tam orada basliyor — iki sinir ayni sayi.
                    //
                    // Pencere kisayken 16:9 oynatici yuksekligine sikisip daraliyor ve
                    // sutunun saginda bos bir sut kaliyor; serit iste o bosluk (ve onun
                    // hemen saginda baslayan oneriler).
                    // Gercek icerik kenari OYNATICININ sag kenari — baslik, aciklama ve
                    // #below hepsi tam orada bitiyor. Sol taraftaki PAY ile bakisik olsun
                    // diye ayni PAY sagda da birakiliyor (o bolge zaten bos zemin).
                    //
                    // #primary/#secondary kirpmalari GERIDE BIRAKILIYOR: full-bleed modda
                    // oynatici sutundan genis olabiliyor, o zaman ust sinir onlardan gelir.
                    // "Ilk eslesme 0x0" tuzagi (v3.58) icin ilk GORUNUR eslesme aranir.
                    const _ilkGorunur = function (sel) {
                        const hepsi = document.querySelectorAll(sel);
                        for (let qi = 0; qi < hepsi.length; qi++) {
                            const r = hepsi[qi].getBoundingClientRect();
                            if (r.width > 1 && r.height > 1) return r;
                        }
                        return null;
                    };
                    try {
                        const _ply = _ilkGorunur('#movie_player');
                        if (_ply) R2 = Math.min(R2, _ply.right + PAY);
                        const _pr = _ilkGorunur('#primary');
                        if (_pr) R2 = Math.min(R2, _pr.right);
                        const _sr = _ilkGorunur('#secondary');
                        if (_sr) R2 = Math.min(R2, _sr.left);
                    } catch (e) {}
                    L = Math.max(0, Math.round(L)); T = Math.max(0, Math.round(T));
                    R2 = Math.min(window.innerWidth, Math.round(R2));
                    B_tam = Math.round(B_tam);
                    const B = Math.min(window.innerHeight, B_tam);
                    const cw = R2 - L, ch2 = B - T;
                    if (cw < 120 || ch2 < 120) throw new Error(`kadraj gecersiz (${cw}x${ch2})`);
                    if (cw > window.innerWidth * 0.98 && ch2 > window.innerHeight * 0.98) {
                        throw new Error(`kadraj TUM SAYFA kadar (${cw}x${ch2}) — guvenilmez`);
                    }

                    // 6) Widget YALNIZCA kadraja biniyorsa gizlensin (TikTok'taki karar).
                    const _biner = function (el) {
                        if (!el) return false;
                        const r = el.getBoundingClientRect();
                        if (r.width < 1 || r.height < 1) return false;
                        return !(r.right <= L || r.left >= R2 || r.bottom <= T || r.top >= B);
                    };
                    let _gizlenen = 0;
                    [document.getElementById('x-downloader-widget'),
                     document.getElementById('w-cb-container')].forEach(function (w) {
                        if (_biner(w)) {
                            _ytGorunur.push([w, w.style.visibility]);
                            w.style.setProperty('visibility', 'hidden', 'important');
                            _gizlenen++;
                        }
                    });

                    // KAYDIR + BIRLESTIR (kullanici: "bunun icin scroll yapmak gerek").
                    // Kadraj ekrana sigmayinca aciklama kutusu kesiliyordu. YouTube'da
                    // PENCERE kayiyor (TikTok/FB'deki hapsolmus kaydiricinin aksine) ve
                    // oynatici yapiskan DEGIL, mini oynaticiya da donmuyor -> olculdu:
                    // scrollBy(250) sonrasi oynatici y 68 -> -182, mini YOK.
                    // Raylar TikTok'takiyle ayni: hareket dogrulanir, tutmazsa/asiri olursa
                    // ya da iki dilim AYNI cikarsa TEK KAREYE dusulur (bugunku davranis).

                    const dpr = window.devicePixelRatio || 1;
                    const _capture = async function (top, h) {
                        const rr = await new Promise(resolve => {
                            swSendReliable({ action: "captureAndCrop", vw: window.innerWidth, rect: { top: top, left: L, width: cw, height: h }, dpr: dpr }, resolve);
                        });
                        if (!rr || rr.status !== "success" || !rr.dataUrl) throw new Error("captureAndCrop basarisiz");
                        return rr.dataUrl;
                    };
                    let _delta = Math.max(0, B_tam - window.innerHeight);
                    let _yol = 'tek-kare', _parca = 1, _ham = null;
                    if (_delta > 0 && _delta <= 700) {
                        const _oncekiY = window.scrollY;
                        const _dav = document.documentElement.style.scrollBehavior;
                        try {
                            document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
                            const ust = await _capture(T, window.innerHeight - T);
                            window.scrollBy(0, _delta);
                            await new Promise(r => setTimeout(r, 350));
                            const _gercek = window.scrollY - _oncekiY;
                            if (_gercek < 4) {
                                printLog(`kaydirma TUTMADI (istendi=${_delta}, oldu=${_gercek}) -> tek kareye dusuluyor`);
                            } else if (_gercek > _delta + 20) {
                                printLog(`kaydirma ASIRI (istendi=${_delta}, oldu=${_gercek}) -> tek kareye dusuluyor`);
                            } else {
                                // KAYDIRMADAN SONRA YENIDEN OLC — tahmin ETME.
                                // v3.55'te 2. dilimin YUKSEKLIGI 'gerceklesen kaydirma' kadar
                                // aliniyordu; gereken ise TASAN miktar. Ikisi tutmayinca arada
                                // BOSLUK kaliyor ve birlestirme yerinde icerik KESILIYORDU
                                // (kullanici ciktisi: kanal satiri ortadan ikiye bolunmus).
                                // Ray'im bunu goremiyordu: yalnizca "hic kaymadi mi" diye bakiyordu.
                                // Yeniden olcmek hem bu farki hem de kaydirma sirasinda olusan
                                // yerlesim kaymalarini KENDILIGINDEN duzeltir.
                                let _B2 = 0;
                                const _yenidenOlc = function () {
                                    const p2 = [];
                                    ['#movie_player', 'h1.ytd-watch-metadata', '#owner',
                                     '#top-level-buttons-computed', '#bottom-row'].forEach(function (sel) {
                                        const e2 = document.querySelector(sel);
                                        if (!e2) return;
                                        const r2 = e2.getBoundingClientRect();
                                        if (r2.width > 1 && r2.height > 1) p2.push(r2);
                                    });
                                    if (!p2.length) return 0;
                                    let b2 = Math.max.apply(null, p2.map(r => r.bottom)) + PAY;
                                    const ym2 = document.querySelector('#comments');
                                    if (ym2) {
                                        const yr2 = ym2.getBoundingClientRect();
                                        if (yr2.height > 0) b2 = Math.min(b2, yr2.top);
                                    }
                                    return Math.min(window.innerHeight, Math.round(b2));
                                };
                                _B2 = _yenidenOlc();
                                const _altUst = Math.max(0, window.innerHeight - _gercek);
                                const _altYuk = Math.round(_B2 - _altUst);
                                if (_altYuk < 4) {
                                    printLog(`2. dilim yuksekligi gecersiz (${_altYuk}) -> tek kareye dusuluyor`);
                                } else {
                                    const alt = await _capture(_altUst, _altYuk);
                                    if (ust === alt) {
                                        printLog("iki dilim AYNI -> birlestirme iptal, tek kareye dusuluyor");
                                    } else {
                                        _ham = await igVerticalStitch([ust, alt]);
                                        _yol = 'kaydir-birlestir'; _parca = 2;
                                        _delta = _altYuk;   // loga GERCEK birlesen yukseklik yazilsin
                                    }
                                }
                            }
                        } catch (e) {
                            printLog("kaydir-birlestir hatasi: " + (e.message || e) + " -> tek kareye dusuluyor");
                        } finally {
                            window.scrollTo(0, _oncekiY);   // sayfayi BULDUGUMUZ gibi birak
                            document.documentElement.style.scrollBehavior = _dav || '';
                        }
                    }
                    if (!_ham) _ham = await _capture(T, ch2);
                    const shot = await compressScreenshot(_ham);
                    if (!shot) throw new Error("sikistirma basarisiz");

                    printLog(`Yakalama: ${_parca} parça (${cw}x${_yol === 'tek-kare' ? ch2 : (B_tam - T)}), yol=watch/${_yol}, ekranDisi=${_delta}px, kare=${_kareOnce}s->${_kareSonra}s, reklamBekle=${_reklamBekledi}, katmanGizli=${_ytGizli.length}, widgetGizlendi=${_gizlenen}`);

                    // Kanal adi: gruplama icin (URL'de YOK -> DOM'dan).
                    let _kanal = '';
                    try {
                        const k = document.querySelector('#owner ytd-channel-name a, #owner ytd-channel-name yt-formatted-string');
                        _kanal = k ? String(k.textContent || '').replace(/\s+/g, ' ').trim() : '';
                    } catch (e) {}

                    const resItem = {
                        link: window.location.href,   // sunucu x_temizle_link ile kanoniklestirir
                        account_name: _kanal,
                        username: '',
                        screenshot: shot,
                        is_profile: false
                    };
                    _ytGizli.forEach(function (p) { try { p[0].style.display = p[1] || ''; } catch (e) {} });
                    _ytGorunur.forEach(function (p) { try { p[0].style.visibility = p[1] || ''; } catch (e) {} });
                    _ytGizli = []; _ytGorunur = [];

                    gorev.combinedData.push(resItem);
                    gorev.retry_count = 0;
                    gorev.kuyruk.shift();
                    const kaldi = gorev.kuyruk.length;
                    const toplam = (gorev.total_count) || (gorev.combinedData.length + kaldi);
                    durumText.innerHTML = `✅ <b>Gönderi alındı</b><br><span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · ${gorev.combinedData.length}/${toplam}</span>`;
                    swSendReliable({
                        action: "submitWordResult",
                        origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                        job_id: gorev.job_id,
                        results: [xStripForServer(resItem, gorev)],
                        final: kaldi === 0
                    }, () => {
                        swSendReliable({
                            action: "updateWordProgress",
                            origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                            job_id: gorev.job_id,
                            current: gorev.combinedData.length,
                            total: toplam
                        }, () => {
                            if (kaldi > 0) {
                                let u = {}; u[storageKey] = gorev;
                                chrome.storage.local.set(u, () => {
                                    const nextUrl = gorev.kuyruk[0].url || gorev.kuyruk[0];
                                    setTimeout(() => { window.location.href = nextUrl; }, 600);
                                });
                            } else {
                                chrome.storage.local.remove(storageKey, () => {
                                    try { xGxTaramaGostergeKapat(); } catch (e) {} chrome.runtime.sendMessage({ action: "completeJobAndFocusPanel", origin: gorev.server_origin });
                                });
                            }
                        });
                    });
                    return;
                } catch (e) {
                    printLog("YAKALAMA HATA: " + (e.message || e) + " -> gonderi atlaniyor");
                } finally {
                    _ytGizli.forEach(function (p) { try { p[0].style.display = p[1] || ''; } catch (e) {} });
                    _ytGorunur.forEach(function (p) { try { p[0].style.visibility = p[1] || ''; } catch (e) {} });
                }
                // hata -> asagidaki TEMIZ ATLAMA'ya dus
            }

            // ============ Faz YT-2b bekliyor: Shorts / topluluk gonderisi ============
            // Bu iki yerlesim henuz yazilmadi -> TEMIZ ATLA (retry dongusune GIRME).
            if (xPlatform() === 'yt') {
                printLog("Yakalama yapilamadi -> gonderi atlaniyor");
                durumText.innerHTML = `
                    <div style="text-align:center;">
                        <span style="color:#f7ba14; font-size:13px; font-weight:bold;">⏭️ Gönderi atlandı</span><br>
                        <span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · ekran görüntüsü alınamadı, sonrakine geçiliyor.</span>
                    </div>`;
                gorev.retry_count = 0;
                gorev.kuyruk.shift();
                let ytUpd = {}; ytUpd[storageKey] = gorev;
                chrome.storage.local.set(ytUpd, () => {
                    if (gorev.kuyruk.length > 0) {
                        const nextUrl = gorev.kuyruk[0].url || gorev.kuyruk[0];
                        setTimeout(() => { window.location.href = nextUrl; }, 600);
                    } else {
                        swSendReliable({
                            action: "submitWordResult",
                            origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                            job_id: gorev.job_id, results: [], final: true
                        }, () => {
                            chrome.storage.local.remove(storageKey, () => {
                                try { xGxTaramaGostergeKapat(); } catch (e) {} chrome.runtime.sendMessage({ action: "completeJobAndFocusPanel", origin: gorev.server_origin });
                            });
                        });
                    }
                });
                return;
            }

            // ============ Faz TT-2: TIKTOK YAKALAMA ============
            // Bu blok X seciciye (article[data-testid="tweet"]) HIC ulasmadan doner. Ulassaydi
            // TikTok'ta asla bulamaz -> "Tweet yuklenemedi" -> 120sn'de bir location.reload()
            // ile SONSUZ DONGU (retry_count'un ust siniri YOK). FB Faz 1'inde (v3.15) tam bunu
            // yasadik; TikTok Faz 1'inde de atlanmisti (v3.43'te kapatildi).
            //
            // YAKALAMA MODELI — sahadan olculdu (2026-07-17, vp=1280x720, cikis yapilmis, TR):
            //   Sayfa bir AKIS: [data-e2e="recommend-list-item-container"] 17 tane; HEDEF ILKI,
            //     altindakiler TikTok'un ONERILERI. Ilkini almazsak rastgele oneri raporlanir.
            //   Kart [264,0,959,720]; video [436,16,550,688]; sag ray (begeni/yorum/kaydet/
            //     paylas) x≈1003-1051, y≈272-704; aciklama [448,670,436,55] videonun altina biner.
            //   Kart TEK EKRANA SIGIYOR (688 < 720) -> kaydir+birlestir YOK, tek kare + kirpma.
            //   Pencere KAYMIYOR (sh==ch==720); gercek kaydirici DivColumnListContainer
            //     (sh=12240) — kart sigdigi icin ona dokunmuyoruz.
            //
            // IG/FB'DEN KOLAY OLMASININ SEBEBI: kullanicinin TikTok HESABI YOK -> DOM'da giris
            // yapmis kullanici yok -> "yazar = operator" tuzagi YAPISAL olarak imkansiz; hiz/
            // checkpoint korumasi da gereksiz. Yazar zaten URL'de (/@kullanici/video/{id}).
            if (xPlatform() === 'tt') {
                let _ttGorunur = [], _ttGizli = [];
                try {
                    {
                        const _alinan = (gorev.combinedData ? gorev.combinedData.length : 0) + 1;
                        const _toplam = (gorev.total_count) || ((gorev.combinedData ? gorev.combinedData.length : 0) + gorev.kuyruk.length);
                        durumText.innerHTML = `🤖 <b>Görsel alınıyor…</b><br><span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · ${_alinan}/${_toplam}</span>`;
                    }

                    // 1) Kart: TikTok gec hidrasyon yapiyor -> ~3sn poll (FB/IG deseni).
                    //    HEDEF = ILK kart. querySelector zaten ilkini verir; yine de acikca
                    //    belirtiyorum ki sonraki okuyan "neden [0]" diye sormasin.
                    let kart = null, video = null;
                    for (let w = 0; w < 15; w++) {
                        kart = document.querySelector('[data-e2e="recommend-list-item-container"]');
                        video = kart ? kart.querySelector('video') : null;
                        // Etkilesim rayini da BEKLE: FB'de yalnizca karti bekleyip erken cikinca
                        // etkilesim henuz gelmemis oluyordu ve kadraj disinda kaliyordu.
                        if (kart && video && kart.querySelector('[data-e2e="like-count"]')) break;
                        await new Promise(r => setTimeout(r, 200));
                    }
                    if (!kart) throw new Error("gonderi karti bulunamadi");

                    // 1.5) CAPTCHA KAPISI — yakalamadan ONCE.
                    // TikTok otomasyondan suphelenince video sayfasinin USTUNE kaydirmali
                    // bulmaca cikariyor ("Bulmacaya uyması için kaydırıcıyı sürükleyin").
                    // SAHADAN OLCULDU (2026-07-17): captcha aciktayken kart, video VE like-count
                    // DOM'da DURUYOR -> kart poll'u BASARILI olur, yakalama devam eder ve rapora
                    // videonun ustunde CAPTCHA PENCERESI olan bir goruntu girer. Hata vermez.
                    // Bu yuzden acik kapi SART.
                    //
                    // ATLAMAK degil DURDURMAK: captcha bir kez ciktiysa sonraki gonderilerde de
                    // cikar -> hepsi atlanir, bos rapor + bosa gecen zaman. FB checkpoint
                    // kararinin aynisi: dur, kullaniciya soyle, o elle cozup yeniden baslatsin.
                    // (Captcha'yi otomatik cozmek YOK.)
                    if (document.querySelector('#captcha-verify-container-main-page, .captcha-verify-container')) {
                        printLog("DOGRULAMA BULMACASI (captcha) algilandi -> tarama DURDURULUYOR. "
                               + "Lutfen tiktok.com'da bulmacayi cozup taramayi yeniden baslatin.");
                        durumText.innerHTML = `
                            <div style="text-align:center;">
                                <span style="color:#f4212e; font-size:13px; font-weight:bold;">🛑 Doğrulama bulmacası</span><br>
                                <span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · tarama durduruldu. Bulmacayı çözüp yeniden başlatın.</span>
                            </div>`;
                        durdurVeTemizle(storageKey, null, gorev.server_origin,
                            "TikTok doğrulama bulmacası (captcha) çıktı — tarama durduruldu. "
                            + "tiktok.com'da bulmacayı çözüp taramayı yeniden başlatın.");
                        return;
                    }

                    // 2) Cerez bandini GIZLE. IKI KAT GIZLI: <tiktok-cookie-banner> SHADOW DOM'da
                    //    ve host'u SIFIR boyutlu ([0,720,0,0]) -> genel "sabit ogeleri gizle"
                    //    mantigi onu NE gorur (querySelector shadow'a girmez) NE de boyut
                    //    filtresinden gecirir. Acik kural SART; yoksa bant sessizce kadraja girer.
                    //    TIKLAMA YOK: "Tümüne izin ver" onay durumunu DEGISTIRIR, gizlemek degistirmez
                    //    (FB cerez bandi kararinin aynisi).
                    document.querySelectorAll('tiktok-cookie-banner').forEach(function (b) {
                        _ttGizli.push([b, b.style.display]);
                        b.style.setProperty('display', 'none', 'important');
                    });

                    // 3) Widget'i gizleme karari 6. adimda (kadraj hesaplandiktan SONRA) verilir:
                    //    yalnizca GERCEKTEN cakisiyorsa gizlenir. Bkz. asagidaki "3b".

                    // 4) Kareyi SABITLE: duraklat + basa sar. YAPILMAZSA cikti RASTGELE olur —
                    //    olculdu: sayfa acildiginda video 20.43s'deydi (sure 82.47), yani ayni
                    //    gonderi her taramada FARKLI gorsel verirdi.
                    let _kareOnce = null, _kareSonra = null;
                    if (video) {
                        _kareOnce = +(video.currentTime || 0).toFixed(2);
                        await new Promise(function (res) {
                            let bitti = false;
                            const fin = function () { if (!bitti) { bitti = true; res(); } };
                            try { video.pause(); } catch (e) {}
                            if (Math.abs(video.currentTime || 0) < 0.05) { fin(); return; }
                            try { video.addEventListener('seeked', fin, { once: true }); } catch (e) {}
                            try { video.currentTime = 0; } catch (e) { fin(); }
                            setTimeout(fin, 1200);   // yedek: 'seeked' hic gelmezse asili kalma
                        });
                        _kareSonra = +(video.currentTime || 0).toFixed(2);
                    }

                    // 5) Kesik aciklamayi ac ("daha fazlası"). En iyi caba: TikTok React ile
                    //    calisiyor ve sentetik click TUTMAYABILIR (olculdu: el.click() olculeri
                    //    degistirmedi). Basarisiz olursa yakalama YINE DE devam eder — aciklama
                    //    kesik cikar ama gonderi atlanmaz.
                    let _acildi = false;
                    try {
                        const btn = Array.from(kart.querySelectorAll('button,span,div')).find(function (e) {
                            const t = (e.textContent || '').trim().toLowerCase();
                            return (t === 'daha fazlası' || t === 'more' || t === 'daha fazla')
                                && e.getBoundingClientRect().width > 10;
                        });
                        if (btn) {
                            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (tip) {
                                btn.dispatchEvent(new MouseEvent(tip, { bubbles: true, cancelable: true, view: window }));
                            });
                            _acildi = true;
                        }
                    } catch (e) {}
                    await new Promise(r => setTimeout(r, 350));   // reflow

                    // 6) KADRAJ: kadraja GIRMESI GEREKEN ogelerin BIRLESIMI. Sabit koordinat
                    //    YAZMIYORUZ — TikTok yerlesimi ekran boyutuna gore degisiyor; olculen
                    //    [436,16,550,688] yalnizca 1280x720'de gecerliydi.
                    const parcalar = [];
                    const ekle = function (sel) {
                        const e = kart.querySelector(sel);
                        if (!e) return;
                        const r = e.getBoundingClientRect();
                        if (r.width > 1 && r.height > 1) parcalar.push(r);
                    };
                    ekle('video');
                    ekle('[data-e2e="video-desc"]');
                    ekle('[data-e2e="video-author-avatar"]');
                    ['like', 'comment', 'favorite', 'share'].forEach(function (k) { ekle('[data-e2e="' + k + '-count"]'); });
                    ekle('[data-e2e="video-music"]');
                    if (!parcalar.length) throw new Error("kadraj ogesi bulunamadi");

                    const PAY = 8;   // ray ikonlarinin/golgenin rect'e girmeyen kismi icin
                    let L = Math.min.apply(null, parcalar.map(function (r) { return r.left; })) - PAY;
                    let T = Math.min.apply(null, parcalar.map(function (r) { return r.top; })) - PAY;
                    let R = Math.max.apply(null, parcalar.map(function (r) { return r.right; })) + PAY;
                    let B = Math.max.apply(null, parcalar.map(function (r) { return r.bottom; })) + PAY;

                    // KARTIN SINIRINA HAPSET — sahada patladi (2026-07-17, kullanici ciktisi):
                    // Kart TAM EKRAN boyunda (720) ve cocuklarini KIRPIYOR. Acilmis aciklamanin
                    // RECT'i 720'yi asabiliyor AMA orada aciklamanin devami YOK — kart onu
                    // kirpmis durumda; 720'nin altinda SIRADAKI KART var.
                    // Bunu "ekran disinda kalan icerik" sanip kaydirinca 2. dilim SONRAKI
                    // VIDEOYU yakaladi ve birlesik goruntunun altina yapisti.
                    // Kart siniri kadrajin GERCEK ust siniri: disinda bize ait hicbir sey yok.
                    const _kr = kart.getBoundingClientRect();
                    L = Math.max(L, _kr.left - PAY);
                    T = Math.max(T, _kr.top - PAY);
                    R = Math.min(R, _kr.right + PAY);
                    B = Math.min(B, _kr.bottom);
                    // Viewport'a KIRP: kadrajin disi yakalanamaz (captureVisibleTab yalnizca
                    // gorunen alani verir) -> istemeden kaydirilmis/bos serit gelmesin.
                    L = Math.max(0, Math.round(L)); T = Math.max(0, Math.round(T));
                    R = Math.min(window.innerWidth, Math.round(R)); B = Math.min(window.innerHeight, Math.round(B));
                    const cw = R - L, ch2 = B - T;
                    if (cw < 40 || ch2 < 40) throw new Error("kadraj cok kucuk: " + cw + "x" + ch2);

                    // 3b) Widget'i YALNIZCA KADRAJA BINIYORSA gizle (kullanici istegi 2026-07-17:
                    //     "TikTok'ta widget'i anlik gorunmez yapma"). Istegin ozu dogru — gereksiz
                    //     titremesin — ama KOSULSUZ kaldirmak yanlis olurdu: widget
                    //     position:fixed; top:100px; right:20px; width:290px (bkz. :510), yani
                    //     1280 genislikte x=970..1260. TikTok kadraji x=436..1051 ve ETKILESIM
                    //     RAYI (begeni/yorum/kaydet/paylas) x=1003..1051 -> TAM widget'in altinda;
                    //     dikeyde de widget y=100'den, ray y=272'den basliyor. Gizlemeseydik
                    //     begeni/yorum sayilarinin USTUNE widget binerdi.
                    //     X'te gizleme yok cunku tweet solda kalir, widget'a girmez — kullanicinin
                    //     X gozlemi dogru, TikTok'a genellemesi degil.
                    //     Cakisma yoksa (genis ekran) HIC DOKUNULMAZ -> titreme de olmaz.
                    //     visibility (display degil) -> reflow/flas yok (IG'de ogrenilen).
                    const _binerMi = function (el) {
                        if (!el) return false;
                        const r = el.getBoundingClientRect();
                        if (r.width < 1 || r.height < 1) return false;
                        return !(r.right <= L || r.left >= R || r.bottom <= T || r.top >= B);
                    };
                    let _gizlenen = 0;
                    [document.getElementById('x-downloader-widget'),
                     document.getElementById('w-cb-container')].forEach(function (w) {
                        if (_binerMi(w)) {
                            _ttGorunur.push([w, w.style.visibility]);
                            w.style.setProperty('visibility', 'hidden', 'important');
                            _gizlenen++;
                        }
                    });

                    // 7) KAYDIR + BIRLESTIR (kullanici istegi 2026-07-17: "ekrana sigmayinca
                    //    kesik oldu, scrape yapabilirdi").
                    //
                    // Aciklama "daha fazlası" ile ACILINCA icerik viewport'u ASIYOR ve kadraj
                    // viewport'a kirpildigi icin son satir KESILIYORDU.
                    //
                    // TIKTOK'UN TUZAGI: pencere KAYMIYOR (olculdu: sh==ch==720). Kayan sey
                    // videolarin AKIS KABI ve o kap YAPISKAN (scroll-snap) olabilir -> kaydirmak
                    // SIRADAKI VIDEOYA atlatabilir. Bu yuzden FB'nin raylari:
                    //   - hareketi DOGRULA; tutmadiysa tek kareye DUS
                    //   - snap yuzunden ASIRI kaydiysa GERI AL ve tek kareye DUS
                    //   - hicbir durumda gonderiyi ATLAMA (en kotu ihtimal = bugunku davranis)
                    const dpr = window.devicePixelRatio || 1;
                    const _capture = async function (top, h) {
                        const rr = await new Promise(resolve => {
                            swSendReliable({ action: "captureAndCrop", vw: window.innerWidth, rect: { top: top, left: L, width: cw, height: h }, dpr: dpr }, resolve);
                        });
                        if (!rr || rr.status !== "success" || !rr.dataUrl) throw new Error("captureAndCrop basarisiz");
                        return rr.dataUrl;
                    };

                    // Kirpilmamis gercek alt sinir — viewport'a kirpMADAN, ama KARTA HAPSEDILMIS.
                    // Kart sinirini asan hicbir sey BIZE AIT DEGIL (sonraki karttir) -> onu
                    // kaydirarak "kurtarmaya" calismak sonraki videoyu kadraja sokar (sahada oldu).
                    // Bu yuzden B_tam kartin dibiyle sinirli; kart viewport'a sigiyorsa _delta=0
                    // olur ve kaydirma yolu HIC calismaz.
                    const B_tam = Math.round(Math.min(
                        Math.max.apply(null, parcalar.map(function (r) { return r.bottom; })) + PAY,
                        _kr.bottom
                    ));
                    let _delta = Math.max(0, B_tam - window.innerHeight);   // ekran DISINDA kalan
                    let _yol = 'tek-kare', _parca = 1, _ham = null;

                    if (_delta > 0 && _delta <= 300) {
                        // Gercek kaydiriciyi bul (pencere degil; kartin atalarindan biri)
                        let sc = null, el = kart;
                        while (el && el !== document.body) {
                            const cs = getComputedStyle(el);
                            if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20) { sc = el; break; }
                            el = el.parentElement;
                        }
                        if (sc) {
                            const _oncekiTop = sc.scrollTop;
                            const _snap = sc.style.scrollSnapType, _dav = sc.style.scrollBehavior;
                            try {
                                // snap KAPAT: acikken tarayici bizim kucuk kaydirmamizi yutar ya da
                                // sonraki videoya YAPISTIRIR.
                                sc.style.setProperty('scroll-snap-type', 'none', 'important');
                                sc.style.setProperty('scroll-behavior', 'auto', 'important');
                                const ust = await _capture(T, window.innerHeight - T);   // 1. dilim: gorunen kisim
                                sc.scrollTop = _oncekiTop + _delta;
                                await new Promise(r => setTimeout(r, 250));
                                const _gercek = sc.scrollTop - _oncekiTop;
                                if (_gercek < 4) {
                                    printLog(`kaydirma TUTMADI (istendi=${_delta}, oldu=${_gercek}) -> tek kareye dusuluyor`);
                                } else if (_gercek > _delta + 20) {
                                    printLog(`kaydirma ASIRI (istendi=${_delta}, oldu=${_gercek} — snap?) -> tek kareye dusuluyor`);
                                } else {
                                    const alt = await _capture(window.innerHeight - _gercek, _gercek);   // 2. dilim: kalan
                                    if (ust === alt) {
                                        printLog("iki dilim AYNI -> birlestirme iptal, tek kareye dusuluyor");
                                    } else {
                                        _ham = await igVerticalStitch([ust, alt]);
                                        _yol = 'kaydir-birlestir'; _parca = 2;
                                    }
                                }
                            } catch (e) {
                                printLog("kaydir-birlestir hatasi: " + (e.message || e) + " -> tek kareye dusuluyor");
                            } finally {
                                sc.scrollTop = _oncekiTop;   // sayfayi BULDUGUMUZ gibi birak
                                sc.style.scrollSnapType = _snap || '';
                                sc.style.scrollBehavior = _dav || '';
                            }
                        } else {
                            printLog("kaydirici bulunamadi -> tek kareye dusuluyor");
                        }
                    }

                    if (!_ham) _ham = await _capture(T, ch2);   // tek kare (bugunku davranis)
                    const shot = await compressScreenshot(_ham);
                    if (!shot) throw new Error("sikistirma basarisiz");

                    // TEKDUZE log — butun platformlar ayni kalip.
                    printLog(`Yakalama: ${_parca} parça (${cw}x${_yol === 'tek-kare' ? ch2 : (B_tam - T)}), yol=${_yol}, ekranDisi=${_delta}px, kare=${_kareOnce}s->${_kareSonra}s, dahaFazlasi=${_acildi ? 'evet' : 'hayir'}, widgetGizlendi=${_gizlenen}`);

                    // Yazar URL'den: DOM'a bakmiyoruz (operator tuzagi imkansiz, hesap yok).
                    const _ttAd = (location.pathname.match(/^\/@([^/]+)\//) || [])[1] || '';
                    const resItem = {
                        link: window.location.href,   // sunucu x_temizle_link ile kanoniklestirir
                        account_name: _ttAd ? ('@' + _ttAd) : '',
                        username: '',
                        screenshot: shot,
                        is_profile: false
                    };
                    _ttGizli.forEach(function (p) { try { p[0].style.display = p[1] || ''; } catch (e) {} });
                    _ttGorunur.forEach(function (p) { try { p[0].style.visibility = p[1] || ''; } catch (e) {} });
                    _ttGizli = []; _ttGorunur = [];

                    gorev.combinedData.push(resItem);
                    gorev.retry_count = 0;
                    gorev.kuyruk.shift();
                    const kaldi = gorev.kuyruk.length;
                    const toplam = (gorev.total_count) || (gorev.combinedData.length + kaldi);
                    durumText.innerHTML = `✅ <b>Gönderi alındı</b><br><span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · ${gorev.combinedData.length}/${toplam}</span>`;
                    swSendReliable({
                        action: "submitWordResult",
                        origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                        job_id: gorev.job_id,
                        results: [xStripForServer(resItem, gorev)],
                        final: kaldi === 0
                    }, () => {
                        swSendReliable({
                            action: "updateWordProgress",
                            origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                            job_id: gorev.job_id,
                            current: gorev.combinedData.length,
                            total: toplam
                        }, () => {
                            if (kaldi > 0) {
                                let u = {}; u[storageKey] = gorev;
                                chrome.storage.local.set(u, () => {
                                    const nextUrl = gorev.kuyruk[0].url || gorev.kuyruk[0];
                                    setTimeout(() => { window.location.href = nextUrl; }, 600);
                                });
                            } else {
                                chrome.storage.local.remove(storageKey, () => {
                                    try { xGxTaramaGostergeKapat(); } catch (e) {} chrome.runtime.sendMessage({ action: "completeJobAndFocusPanel", origin: gorev.server_origin });
                                });
                            }
                        });
                    });
                    return;
                } catch (e) {
                    printLog("YAKALAMA HATA: " + (e.message || e) + " -> gonderi atlaniyor");
                } finally {
                    // Sayfayi ELLEDIK (cerez bandi + widget) -> her durumda geri al.
                    _ttGizli.forEach(function (p) { try { p[0].style.display = p[1] || ''; } catch (e) {} });
                    _ttGorunur.forEach(function (p) { try { p[0].style.visibility = p[1] || ''; } catch (e) {} });
                }
                // --- Yakalama basarisiz: gonderiyi TEMIZ atla (retry dongusune GIRME) ---
                durumText.innerHTML = `
                    <div style="text-align:center;">
                        <span style="color:#f7ba14; font-size:13px; font-weight:bold;">⏭️ Gönderi atlandı</span><br>
                        <span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · ekran görüntüsü alınamadı, sonrakine geçiliyor.</span>
                    </div>`;
                gorev.retry_count = 0;
                gorev.kuyruk.shift();
                let ttUpd = {}; ttUpd[storageKey] = gorev;
                chrome.storage.local.set(ttUpd, () => {
                    if (gorev.kuyruk.length > 0) {
                        const nextUrl = gorev.kuyruk[0].url || gorev.kuyruk[0];
                        setTimeout(() => { window.location.href = nextUrl; }, 600);
                    } else {
                        swSendReliable({
                            action: "submitWordResult",
                            origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                            job_id: gorev.job_id,
                            results: [],
                            final: true
                        }, () => {
                            chrome.storage.local.remove(storageKey, () => {
                                try { xGxTaramaGostergeKapat(); } catch (e) {}
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
                // v3.68: mantık limitEngeliGoster ortak yardımcısına tasindi (profil yolu da
                // ayni sistemi kullaniyor artik). Davranis birebir korundu.
                limitEngeliGoster(gorev, storageKey, "Tivit yüklenemedi.");
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

            // TEKDUZE durum yazisi (butun platformlar ayni kalip)
            {
                const _alinan2 = (gorev.combinedData ? gorev.combinedData.length : 0) + 1;
                const _toplam2 = (gorev.total_count) || ((gorev.combinedData ? gorev.combinedData.length : 0) + gorev.kuyruk.length);
                durumText.innerHTML = `🤖 <b>Görsel alınıyor…</b><br><span style="font-size:11px; color:var(--w-text-muted);">${xPlatformAdi()} · ${_alinan2}/${_toplam2}</span>`;
            }

            // v4.6 (Faz 2): X tweeti ise YANIT+PARENT yakala (tekil ise tek). DİĞER platformlar
            // (IG/FB/TT/YT) AYNEN captureArticle -> X-korumalı, additive, sıfır regresyon.
            const _yakalaHedef = async function () {
                try {
                    if (article && article.getAttribute && article.getAttribute('data-testid') === 'tweet') {
                        var _arts = document.querySelectorAll('article[data-testid="tweet"]');
                        // v4.38: TARAMADA da (Rapor'matik link) derin zincir/flood -> KULLANICI SEÇER, onay bekler,
                        // sonra devam (kullanıcı isteği). Tarama link-başına-navigasyon olduğundan _yakalaHedef'teki
                        // await doğal duraklamadır; seçimden sonra yakalar, kuyruğu kaydırır, sonrakine geçer.
                        // İptal -> link KAYBOLMASIN: varsayılan (odak + direkt parent) ile devam. Bayrak x_coklu_sec='0' kapalı.
                        var _cokluAcik = true; try { if (localStorage.getItem('x_coklu_sec') === '0') _cokluAcik = false; } catch (e) {}
                        var _arr = Array.prototype.slice.call(_arts);
                        var _fi = _arr.indexOf(article);
                        if (_cokluAcik && _fi >= 2) {
                            var _adaylarT = _arr.slice(0, _fi + 1);
                            var _secilenler = await xCokluTweetSec(_adaylarT, article);
                            if (_secilenler) return await xYakalaCoklu(_secilenler, _adaylarT) || "";
                        }
                        return await xYakalaTweetVeYanit(article, _arts) || "";
                    }
                } catch (e) { printLog("Yanıt+parent yakalama hatası, tekile dönülüyor: " + ((e && e.message) || e)); }
                return await captureArticle(article) || "";
            };
            let screenshotData = "";
            try {
                screenshotData = await _yakalaHedef();
            } catch (captureErr) {
                printLog("Yakalama hatası oluştu: " + captureErr.message);
                await new Promise(r => setTimeout(r, 1000));
                try {
                    screenshotData = await _yakalaHedef();
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
                    origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                    job_id: gorev.job_id,
                    results: [xStripForServer(resItem, gorev)],
                    final: false
                }, (response) => {
                    if (response && response.status === 'cancelled') {
                        chrome.storage.local.remove(storageKey, () => {
                            try { xGxTaramaGostergeKapat(); } catch (e) {} chrome.runtime.sendMessage({ action: "completeJobAndFocusPanel", origin: gorev.server_origin });
                        });
                        return;
                    }
                    swSendReliable({
                        action: "updateWordProgress",
                        origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                        job_id: gorev.job_id,
                        current: progress,
                        total: totalCount
                    }, (progResponse) => {
                        if (progResponse && progResponse.status === 'cancelled') {
                            chrome.storage.local.remove(storageKey, () => {
                                try { xGxTaramaGostergeKapat(); } catch (e) {} chrome.runtime.sendMessage({ action: "completeJobAndFocusPanel", origin: gorev.server_origin });
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
                    origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                    job_id: gorev.job_id,
                    results: [xStripForServer(resItem, gorev)],
                    final: true
                }, () => {
                    swSendReliable({
                        action: "updateWordProgress",
                        origin: gorev.server_origin || "https://goruntux.rgmedya.tr",
                        job_id: gorev.job_id,
                        current: progress,
                        total: progress
                    }, () => {
                        chrome.storage.local.remove(storageKey, () => {
                            // Background worker'a bu sekmenin kapatılıp panelin odaklanması talimatını veriyoruz.
                            try { xGxTaramaGostergeKapat(); } catch (e) {}
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
                aktifStorageKey = storageKey;   // dock IPTAL dugmesi bunu kullanir
                initWidgetTimer(gorev, storageKey);
                updateWidgetProgress(gorev);
                if (gorev.asama === "word_taramasi") {
                    wordTaramaYonetimi(gorev, storageKey);
                } else {
                    printLog(`Bilinmeyen veya eski görev aşaması (${gorev.asama}) algılandı. Temizleniyor...`);
                    chrome.storage.local.remove(storageKey, () => {
                        location.reload();
                    });
                }
            } else {
                printLog("Aktif görev yok. Tekil tivit kontrolü yapılıyor...");
                // Idle Mod: tekil tweet sayfasi VEYA profil sayfasi -> "Rapora Ekle" butonu.
                // X: tekil tweet regex. Non-X: background TEK GEÇİT'tir (widget yalnız onun
                // executeScript'iyle çalışır) ve non-X'te YALNIZ geçerli gönderide enjekte eder
                // (onUpdated + _gecerliWidgetSayfasi + widgetiGizle); widget.js SPA'da yeniden çalışmaz.
                // Ama buton YALNIZ idle-yakalaması GERÇEKTEN yapılmış platformlarda görünmeli (yarım/bozuk
                // buton olmasın) -> xIdleDestekli kapısı. Platform eklendikçe orası genişler. profil/foto/rt X-özel.
                let _platform = xPlatform();
                let tivitMi = (_platform === 'x')
                    ? /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(temizUrl)
                    : xIdleDestekli(_platform);
                let rtSayfasiMi = temizUrl.endsWith('/retweets') || temizUrl.endsWith('/reposts') || temizUrl.endsWith('/quotes') || temizUrl.endsWith('/likes');
                // v3.88: fotograf/medya alt sayfasi (/status/123/photo/1, /media) -> widget YOK
                // (background ile AYNI kontrol). tivitMi regex'i onek eslestigi icin ayrica dislanir.
                let fotografMi = /\/status\/\d+\/(?:photo|media|video)(?:\/|$)/i.test(temizUrl);
                // Profil sayfasi: x.com/{ad} KÖK veya profil ALT-SEKMELERI (all/with_replies/
                // reposts/media/highlights/superfollows/affiliates). [#1/#4] Buton + /all'a
                // yonlendirme bunlarin HEPSINDE calissin diye alt-sekmeler de profilMi sayilir.
                let profilMi = false;
                {
                    const _pm = temizUrl.match(/^https?:\/\/(?:x|twitter)\.com\/([^/?#]+)(?:\/(all|with_replies|reposts|media|highlights|superfollows|affiliates))?\/?$/i);
                    const _rez = ["home","explore","notifications","messages","search","i","settings",
                                  "compose","hashtag","login","logout","signup","share","intent",
                                  "tos","privacy","about","download","jobs","developer"];
                    if (_pm && _pm[1] && _rez.indexOf(_pm[1].toLowerCase()) === -1) profilMi = true;
                }

                printLog(`Sayfa Analizi: tivitMi=${tivitMi}, rtSayfasiMi=${rtSayfasiMi}, profilMi=${profilMi}, fotografMi=${fotografMi}`);

                if ((((tivitMi && !rtSayfasiMi) || profilMi) && !fotografMi)) {
                    printLog(`${profilMi ? 'Profil' : 'Tekil tivit'} sayfası algılandı. Idle widget yükleniyor.`);
                    renderIdleWidget(directKey || "x_profil_gorevi_tekil");
                    if (profilMi) { xProfilRaporButonuEkle(); xProfilRaporPollerBaslat(); xProfilBeklemedekiTaramaKontrol(); }   // [GÖRÜNTÜX İLE RAPORLA] profil başlığı butonu (tüm profil sekmelerinde) + /all'da beklemedeki tarama
                    xTweetButonPollerBaslat();   // [TWEET DETAY BUTONU] /status/ sayfalarında her tweet'e "Rapora Ekle" butonu (kendi içinde gate'li)
                } else {
                    printLog("Alakasız/foto sayfası. Widget gizleniyor.");
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

    // SILINDI (v3.65): izlenmeleriSunucuyaKaydet + etkilesimleriSunucuyaKaydet.
    // background.js'e "updateTweetViews" / "saveInteractionsToServer" mesajlari gonderiyor,
    // o da app.py'de OLMAYAN /api/tweets/* uclarina POST atiyordu (404, .catch ile yutuluyordu).
    // Tek cagiranlari olu kazima motorunun icindeydi; motorla birlikte gittiler.

    baslat();
})();