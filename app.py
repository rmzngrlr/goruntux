import time
import requests
from flask import Flask, request, jsonify, render_template_string, send_file
import docx
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import parse_xml, OxmlElement
from docx.oxml.ns import nsdecls, qn
from docx.opc.constants import RELATIONSHIP_TYPE
import io
import re
from PIL import Image as PILImage
import base64
import zipfile
import os
import json
import uuid
from urllib.parse import urlparse, parse_qs

# ----------------- GLOBALS & DATA STORAGE -----------------
client_pools = {}
client_jobs = {}

# --- B (havuz birlesmesi): editor "+" ile eklenen manuel bolumler ARTIK gercek sunucu
# havuzu ogesi olur (link alaninda sentetik "xmanual://<uid>" anahtariyla). Bu bayrak kapaliyken
# tum birlesme davranisi devre disi kalir (auto_start eski kosulsuz temizlige doner, detect_platform
# "manual" dondurmez) -> istemci x_unify_manual bayragiyla birlikte temiz, veri-guvenli geri alma.
X_UNIFY_MANUAL = (os.environ.get("X_UNIFY_MANUAL", "1") != "0")

def is_manual_link(link):
    # Editor-manuel bolum sentetik anahtari. normalize_link_key/x_temizle_link bunu OLDUGU GIBI
    # gecirir (ig/fb/tt/yt/x.com host'u degil), overlay/gorsel/havuz kimligi TEK anahtara duser.
    return bool(link) and str(link).lower().startswith("xmanual://")

def get_client_id():
    try:
        c_id = request.args.get("client_id")
        if not c_id:
            c_id = request.form.get("client_id")
        if not c_id and request.is_json:
            try:
                c_id = request.json.get("client_id")
            except:
                pass
        return c_id or request.remote_addr
    except:
        # Fallback if request context is not active
        return "default"

def get_client_pool():
    c_id = get_client_id()
    if c_id not in client_pools:
        client_pools[c_id] = []
    return client_pools[c_id]

def get_client_job():
    c_id = get_client_id()
    if c_id not in client_jobs:
        client_jobs[c_id] = {
            "job_id": None,
            "scrape_mode": None,
            "tweet_urls": [],
            "results": [],
            "results_count": 0,
            "total_count": 0,
            "status": "idle", # idle, running, completed
            "last_extension_heartbeat": 0.0,
            "start_time": 0.0,
            "end_time": 0.0
        }
    return client_jobs[c_id]

# temp_uploads dizini MUTLAK yol olsun: çalışma dizini (CWD) ne olursa olsun (Docker, .bat,
# farklı klasörden başlatma) görsel yazma ve okuma AYNI yeri gösterir; yoksa dosya "yok" görünüp
# /api/manual/image 500 verebiliyordu.
TEMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp_uploads")

def save_temp_image(image_bytes):
    if not image_bytes:
        return None
    try:
        os.makedirs(TEMP_DIR, exist_ok=True)
        filepath = os.path.join(TEMP_DIR, f"{uuid.uuid4().hex}.jpg")
        with open(filepath, "wb") as f:
            f.write(image_bytes)
        return filepath
    except Exception as e:
        print(f"save_temp_image error: {e}", flush=True)
        return None

# Clear temp_uploads directory on startup if it exists
if os.path.exists(TEMP_DIR):
    try:
        for f in os.listdir(TEMP_DIR):
            filepath = os.path.join(TEMP_DIR, f)
            if os.path.isfile(filepath):
                os.remove(filepath)
    except Exception as e:
        print(f"Startup clean error: {e}", flush=True)

temp_files = {}

# Fonts list for styling dropdowns
WORD_POPULER_FONTLAR = [
    "Arial", "Calibri", "Cambria", "Century Gothic", "Comic Sans MS", 
    "Consolas", "Courier New", "Georgia", "Helvetica", "Impact", 
    "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"
]

# ----------------- FLASK APP DEFINITION -----------------
app = Flask(__name__)

@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, post-check=0, pre-check=0, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '-1'
    return response

# ----------------- DOCX FORMATTING HELPERS -----------------
def hex_to_rgb(hex_str):
    hex_str = hex_str.lstrip('#')
    return RGBColor(int(hex_str[0:2], 16), int(hex_str[2:4], 16), int(hex_str[4:6], 16))

def cizgi_ekle(paragraf):
    pPr = paragraf._p.get_or_add_pPr()
    pBdr = parse_xml(r'<w:pBdr %s><w:bottom w:val="single" w:sz="6" w:space="4" w:color="auto"/></w:pBdr>' % nsdecls('w'))
    pPr.append(pBdr)

def belgenin_fontunu_ayarla(doc_obj, font_name):
    style_normal = doc_obj.styles['Normal']
    style_normal.font.name = font_name

def baslik_formatla(metin):
    if not metin:
        return ""
    # We no longer aggressively add parentheses around @usernames
    metin = re.sub(r'\s+', ' ', metin).strip()
    return metin

def tweet_kullanici_adi_oku(link):
    if not link:
        return None
    # X/Twitter: x.com/<kullanıcı>/... adresinde İLK yol parçası kullanıcı adıdır.
    # İlk parçayı almak, profil linkinde sonda /media, /with_replies, /photo,
    # /status/<id> gibi ekler olsa BİLE kullanıcı adını doğru verir; böylece profil
    # kartı aynı hesabın tweetleriyle TEK başlık altında gruplanır.
    # Twitter'ın rezerve yollarını (home, search, i, ...) eleriz.
    m = re.search(r'(?:x|twitter)\.com/([^/?#]+)', link, re.IGNORECASE)
    if m:
        uname = m.group(1).lower()
        reserved = {"home", "explore", "notifications", "messages", "search", "i",
                    "settings", "compose", "hashtag", "login", "logout", "signup",
                    "share", "intent", "tos", "privacy", "about", "download"}
        if uname and uname not in reserved:
            return uname
    # Instagram post/reel link - attempt to get username if it's not a generic /p/ URL
    # Unfortunately standard instagram.com/p/ID urls don't contain the username.
    # We will return None for those and rely on the item's title in manual_generate
    # if we want to group Instagram posts. For now, Instagram posts might not group correctly
    # just by URL. Let's return None and we will patch manual_generate instead.
    return None

# Instagram/X gönderilerinde aynı gönderinin embed/normal veya sonda '/' olan
# varyasyonlarını tek bir link olarak eşleştirmek için normalleştirir.
# Böylece aynı gönderi (biri ekran görüntüsü, biri başlık taşıyan) iki ayrı
# havuz öğesine bölünmez.
def normalize_link_key(link):
    if not link:
        return ""
    # --- Faz FB-1: Facebook'ta KIMLIK SORGUDA olabilir (permalink.php?story_fbid=..&id=..,
    # photo.php?fbid=.., /watch/?v=..) -> '?' ile KESMEK YASAK. Kesilirse aynı sayfadaki
    # TUM permalink gonderileri TEK anahtara duser ve IndexedDB'de goruntuler birbirini EZER
    # (hata vermez; rapor dogru link + YANLIS gorselle cikar).
    # fb_canonical_link IDEMPOTENT -> ham link de kanonik link de AYNI anahtari verir.
    # JS ikizi xNormLink AYNI kurali uygular; IKISINI BIRDEN degistir.
    # NOT: guard substring degil detect_platform — 'evil.com/?u=facebook.com' bu dala SAPMAMALI,
    # yoksa onun anahtari da degisir (sorgusu korunur) ve bayt-esitlik bozulur.
    if detect_platform(link) == "fb":
        # Anahtar her zaman kucuk harf (mevcut davranisla ayni: IG /p/CxYz bugun de kucultuluyor).
        # KANONIK LINK orijinal buyuk-kucuk harfi korur ve .docx'e o girer — anahtar yalnizca anahtardir,
        # ondan URL geri kurulmaz.
        return fb_canonical_link(link).split("#")[0].rstrip("/").lower()
    # --- Faz TT-1: TikTok'ta kimlik YOLDA -> sorgu atilabilir (asagidaki varsayilan dal
    # bunu zaten yapardi). AMA yine de delege ediyoruz cunku tt_canonical_link HOST'u da
    # normalize ediyor (m./çıplak -> www). Varsayilan dala biraksaydik
    # m.tiktok.com/@u/video/1 ile www.tiktok.com/@u/video/1 AYRI anahtar olurdu; havuz
    # linki kanonik (www) uretildigi icin gorsel HAM linkin anahtarina yazilir ve
    # ayrisirlardi -> gorsel SESSIZCE kaybolurdu (FB'de ogrenilen tam bu tuzak).
    # JS ikizi xNormLink AYNI kurali uygular; IKISINI BIRDEN degistir.
    if detect_platform(link) == "tt":
        return tt_canonical_link(link).split("#")[0].rstrip("/").lower()
    # --- Faz YT-1: YouTube'da /watch?v=ID kimligi SORGUDA -> '?' ile KESMEK YASAK
    # (FB'deki tuzagin aynisi). Kesilirse TUM izleme linkleri tek anahtara duser ve
    # IndexedDB'de goruntuler birbirini EZER: rapor dogru link + YANLIS gorselle cikar.
    # yt_canonical_link IDEMPOTENT + youtu.be/live/embed formlarini watch?v=ID'ye
    # indiriyor -> ayni video hangi bicimde yapistirilirsa yapistirilsin TEK anahtar.
    # JS ikizi xNormLink AYNI kurali uygular; IKISINI BIRDEN degistir.
    if detect_platform(link) == "yt":
        return yt_canonical_link(link).split("#")[0].rstrip("/").lower()
    l = link.split("?")[0].split("#")[0].strip()
    l = re.sub(r'/embed/?$', '', l, flags=re.IGNORECASE)
    l = l.rstrip('/')
    return l.lower()

def x_temizle_link(link):
    # X/Twitter linklerindeki sorgu (?s=20, ?t=...) ve hash'i atıp kanonik linke çevir.
    # Instagram: reel/reels/tv + izleme parametreleri (?igsh vb.) atılıp kanonik /p/CODE'e çevrilir
    #   (reel tam-ekran oynatıcıda açılıp SS alınamıyordu; /p/ gönderi kartıyla açılır). Carousel
    #   için ?img_index KORUNUR.
    # Gorunumu/orijinal buyuk-kucuk harfi korur; yalnizca sorgu/hash'i kirpar (X icin).
    try:
        if not link:
            return link
        low = link.lower()
        if "instagram.com" in low:
            m = re.search(r"/(?:p|reel|reels|tv)/([^/?#]+)", link, re.I)
            if not m:
                return link.split("#")[0].split("?")[0]
            out = "https://www.instagram.com/p/" + m.group(1)
            im = re.search(r"[?&]img_index=([^&#]+)", link, re.I)
            if im:
                out += "?img_index=" + im.group(1)
            return out
        # --- Faz FB-1: Facebook (SALT EKLEME — X/IG dallari degismedi) ---
        if detect_platform(link) == "fb":
            return fb_canonical_link(link)
        # --- Faz YT-1: YouTube (SALT EKLEME) ---
        # Sorgu copu atilir (?t=42s zaman damgasi, ?list=PL... oynatma listesi,
        # ?si=/?pp= paylasim izleme kodu) ve youtu.be/live/embed -> watch?v=ID'ye iner.
        if detect_platform(link) == "yt":
            return yt_canonical_link(link)
        # --- Faz TT-1: TikTok (SALT EKLEME) ---
        # Havuza/rapora giren GORUNUR link. Sorgu atilir: ?is_from_webapp=1&web_id=...
        # web_id TARAYICI izleme kimligidir — raporda durmasi hem cirkin hem anlamsiz,
        # ustelik ayni gonderinin iki linkini farkli gosterirdi (FB'de fbclid ile ayni is).
        if detect_platform(link) == "tt":
            return tt_canonical_link(link)
        if "x.com" in low or "twitter.com" in low:
            return link.split("#")[0].split("?")[0]
        return link
    except Exception:
        return link

# ----------------- PLATFORM TESPITI (Faz FB-1) -----------------
# Platform HICBIR YERDE saklanmaz; her seferinde linkten turetilir. Kural UCLU:
# 'x' | 'ig' | 'fb'. BILINMEYEN -> 'x' (bugunku davranis KORUNUR).
# JS ikizleri: XPlat.platform() (/x-platform.js) ve xPlatformOf() (background.js).
# UCUNU BIRDEN degistir; ayrisirlarsa gruplama/anahtar/goruntu eslesmesi bozulur.

def _is_fb_host(h):
    h = (h or "").lower()
    return h == "facebook.com" or h.endswith(".facebook.com")

def _is_tt_host(h):
    # Faz TT-1. FB ile ayni desen: host-hassas (substring DEGIL) ->
    # 'evil.com/?u=tiktok.com' bu dala SAPMAZ.
    # vm./vt. KISA link alan adlaridir ve tiktok.com altindadir -> buraya dahil.
    h = (h or "").lower()
    return h == "tiktok.com" or h.endswith(".tiktok.com")

def _is_yt_host(h):
    # Faz YT-1. Ayni host-hassas desen.
    # youtu.be AYRI bir alan adidir (youtube.com altinda DEGIL) -> ayrica yazilmali.
    h = (h or "").lower()
    return (h == "youtube.com" or h.endswith(".youtube.com")
            or h == "youtu.be" or h.endswith(".youtu.be"))

def _url_host(link):
    try:
        s = (link or "").strip()
        if s and not re.match(r'^https?://', s, re.I):
            s = "https://" + s.lstrip("/")
        return (urlparse(s).hostname or "").lower()
    except Exception:
        return ""

def detect_platform(link):
    low = (link or "").lower()
    if is_manual_link(link):          # B9: editor-manuel bolum -> kendi platformu ('manual')
        return "manual"
    if "instagram.com" in low:        # MEVCUT KURAL — bilerek DEGISTIRILMEDI
        return "ig"
    _h = _url_host(link)
    if _is_fb_host(_h):               # host-hassas. 'evil.com/?u=facebook.com' KACMAZ,
        return "fb"                   # cunku substring degil gercek host'a bakiyoruz.
    if _is_tt_host(_h):               # Faz TT-1
        return "tt"
    if _is_yt_host(_h):               # Faz YT-1 (yeni)
        return "yt"
    return "x"                        # MEVCUT VARSAYILAN
    # NOT: varsayilan 'x' oldugu icin TANINMAYAN her link sessizce X sayilir. TikTok
    # eklenmeden once bir tiktok linki X basligi altinda rapora giriyordu — FB'de de
    # ayni tuzak vardi. Yeni platform eklerken bu dal MUTLAKA once yazilmali.

# Facebook KIMLIK parametreleri. SIRA ONEMLI: kanonik cikti sabit olsun diye
# beyaz-liste bu sirayla yeniden kurulur (asla kara liste — bilinmeyen izleme
# parametresi eklendiginde sessizce sizmasin).
_FB_ID_PARAMS = ("story_fbid", "id", "fbid", "v")

def fb_canonical_link(link):
    """Facebook linkini kanonik forma cevirir.

    IDEMPOTENT olmak ZORUNDA: kendi ciktisina tekrar uygulandiginda AYNI sonucu
    vermeli. Cunku yerel goruntu anahtari HAM link'ten, havuz link'i KANONIK
    link'ten uretiliyor (widget.js deliverLocalImage vs submit_word_result);
    ikisi ayrisirsa GORSEL SESSIZCE KAYBOLUR.

    X/IG'de kimlik YOLDA (/status/123, /p/CODE) ama FB'de sik sik SORGUDA
    (permalink.php?story_fbid=..&id=..) -> '?' ile kesmek YASAK.
    """
    try:
        s = (link or "").strip()
        if not s:
            return link
        if not re.match(r'^https?://', s, re.I):
            s = "https://" + s.lstrip("/")
        u = urlparse(s)
        if not _is_fb_host(u.hostname):
            return link                      # FB DEGIL -> DOKUNMA
        path = (u.path or "/").rstrip("/")
        low = path.lower()
        q = parse_qs(u.query or "", keep_blank_values=False)

        def g(k):
            v = q.get(k) or []
            return v[0] if v and v[0] else None

        base = "https://www.facebook.com"     # m./web./mbasic. -> www. (host normalizasyonu)

        # 1) /groups/{g}/posts/{id}  (permalink/{id} varyanti AYNI gonderi)
        m = re.match(r'^/groups/([^/]+)/(?:posts|permalink)/([^/]+)$', path, re.I)
        if m:
            return base + "/groups/" + m.group(1) + "/posts/" + m.group(2)
        # 2) /{ad}/posts/{id}
        m = re.match(r'^/([^/]+)/posts/([^/]+)$', path, re.I)
        if m:
            return base + "/" + m.group(1) + "/posts/" + m.group(2)
        # 3) /share/{p|v|r}/{kod}
        m = re.match(r'^/share/([pvr])/([^/]+)$', path, re.I)
        if m:
            return base + "/share/" + m.group(1).lower() + "/" + m.group(2)
        # 4) /reel/{id}
        m = re.match(r'^/reel/([^/]+)$', path, re.I)
        if m:
            return base + "/reel/" + m.group(1)
        # 5) /watch/?v={id}
        if low in ("/watch", "/video.php"):
            v = g("v")
            return (base + "/watch/?v=" + v) if v else base + low
        # 6) photo.php?fbid= ve /photo/?fbid= AYNI fotograf (fbid kuresel tekil) -> TEK form.
        #    set/type yalnizca albom baglami, kimlik DEGIL.
        if low in ("/photo.php", "/photo"):
            fbid = g("fbid")
            return (base + "/photo/?fbid=" + fbid) if fbid else base + low
        # 7) permalink.php / story.php — story.php ile permalink.php BILEREK
        #    birlestirilmedi (FB erisimi olmadan dogrulanamaz; Faz 3'e birakildi).
        if low in ("/permalink.php", "/story.php"):
            sf, pid = g("story_fbid"), g("id")
            out = base + low
            if sf:
                out += "?story_fbid=" + sf
                if pid:
                    out += "&id=" + pid
            return out
        # 8) Taninmayan FB formu: host'u normalize et, YALNIZ beyaz-liste parametrelerini tut.
        keep = [(k, g(k)) for k in _FB_ID_PARAMS if g(k)]
        out = base + path
        if keep:
            out += "?" + "&".join(k + "=" + v for k, v in keep)
        return out
    except Exception:
        return link

def fb_page_slug(link):
    """FB linkinden sayfa/grup kimligini SADECE URL'den cikarir; yoksa None.

      /{ad}/posts/{id}               -> 'ad'
      permalink.php?story_fbid=&id=Y -> 'Y'  (sayisal sayfa id'si — cirkin ama KARARLI)
      /groups/{g}/posts/{id}         -> 'group:{g}'
      /share/p, /reel, /watch, /photo -> None  (isim YALNIZCA Faz 2'de yakalamadan gelir)
    """
    try:
        c = fb_canonical_link(link)
        u = urlparse(c if re.match(r'^https?://', c or "", re.I) else "https://" + (c or "").lstrip("/"))
        if not _is_fb_host(u.hostname):
            return None
        path = (u.path or "").rstrip("/")
        m = re.match(r'^/groups/([^/]+)/posts/', path, re.I)
        if m:
            return "group:" + m.group(1).lower()
        m = re.match(r'^/([^/]+)/posts/', path, re.I)
        if m:
            return m.group(1).lower()
        if path.lower() in ("/permalink.php", "/story.php"):
            q = parse_qs(u.query or "")
            v = (q.get("id") or [None])[0]
            return v.lower() if v else None
        return None      # /share/p, /reel, /watch, /photo -> URL'de isim YOK
    except Exception:
        return None

# --- Faz TT-1: TikTok kanonik link ---
# FB'nin aksine KIMLIK YOLDA (/@kullanici/video/{id}) -> "kimlik sorguda" cehennemi YOK.
# Sorgu TAMAMEN atilir: is_from_webapp, web_id (tarayici izleme kimligi), sender_device...
# hepsi izleme copu; hicbiri gonderiyi ayirt etmez.
#
# IDEMPOTENT olmak ZORUNDA (FB'de ogrenildi): gorsel yazma anahtari HAM linkten, havuz
# linki KANONIK linkten uretiliyor. Ayrisirlarsa goruntuler SESSIZCE kaybolur.
#   tt_canonical_link(tt_canonical_link(x)) == tt_canonical_link(x)
#
# HOST: m./çıplak tiktok.com -> www.tiktok.com. AMA vm./vt. KORUNUR — onlar KISA link
# alan adlari, ayri bir gonderi uzayi; www'ye cevirmek farkli bir sayfaya isaret ederdi.
_TT_KISA_HOSTLAR = ("vm.tiktok.com", "vt.tiktok.com")

def tt_canonical_link(link):
    try:
        s = (link or "").strip()
        if not s:
            return ""
        if not re.match(r'^https?://', s, re.I):
            s = "https://" + s.lstrip("/")
        u = urlparse(s)
        host = (u.hostname or "").lower()
        if not _is_tt_host(host):
            return link
        path = (u.path or "/").rstrip("/")
        if host in _TT_KISA_HOSTLAR:
            # Kisa link: hedefi ancak YONLENME cozer (FB /share/ ile ayni durum).
            # Host'a DOKUNMA, yolu oldugu gibi birak, yalnizca sorguyu at.
            return "https://" + host + (path or "/")
        # Ana site: m./çıplak -> www
        return "https://www.tiktok.com" + (path or "/")
    except Exception:
        return link

# --- Faz YT-1: YouTube kanonik link ---
# UC AYRI KIMLIK YERI (kapsam kullanici karari: video + Shorts + topluluk gonderisi):
#   /watch?v=ID   -> kimlik SORGUDA (FB'deki tuzagin aynisi: '?' ile kesmek YASAK)
#   /shorts/ID    -> kimlik YOLDA
#   /post/ID      -> kimlik YOLDA
#
# AYNI VIDEO, FARKLI BICIMLER -> hepsi AYNI kanonige inmeli, yoksa ayni videoyu iki
# bicimde yapistirinca havuzda IKI oge olur ve iki kez ekran goruntusu alinir:
#   youtu.be/ID          (olculdu: www.youtube.com/watch?v=ID'ye YONLENIYOR)
#   /live/ID, /embed/ID, /v/ID
# Shorts BILEREK AYRI birakildi: /shorts/ID ile /watch?v=ID ayni videoyu gosterse de
# YERLESIMLERI tamamen farkli (dikey oynatici vs normal) -> ayni kanonige indirmek
# yanlis yerlesimde yakalama yapardi.
#
# ATILAN sorgu parametreleri: t/start (zaman damgasi), list/index (oynatma listesi),
# pp/si/feature/ab_channel (izleme/paylasim copu). BEYAZ LISTE degil, yalnizca 'v'
# korunuyor -> bilinmeyen yeni parametreler de kendiliginden atilir.
_YT_KISA_HOSTLAR = ("youtu.be", "www.youtu.be")

def yt_canonical_link(link):
    try:
        s = (link or "").strip()
        if not s:
            return ""
        if not re.match(r'^https?://', s, re.I):
            s = "https://" + s.lstrip("/")
        u = urlparse(s)
        host = (u.hostname or "").lower()
        if not _is_yt_host(host):
            return link
        path = (u.path or "/").rstrip("/")
        q = parse_qs(u.query or "")
        def vid(x):
            return x if re.match(r'^[A-Za-z0-9_-]{5,20}$', x or "") else None
        # 1) youtu.be/ID -> watch?v=ID (olculdu: gercekten oraya yonleniyor)
        if host in _YT_KISA_HOSTLAR:
            m = re.match(r'^/([^/]+)$', path)
            v = vid(m.group(1)) if m else None
            return ("https://www.youtube.com/watch?v=" + v) if v else ("https://www.youtube.com" + (path or "/"))
        # 2) /watch?v=ID  (kimlik SORGUDA)
        if path.lower() == "/watch":
            v = vid((q.get("v") or [None])[0])
            if v:
                return "https://www.youtube.com/watch?v=" + v
            return "https://www.youtube.com/watch"
        # 3) /live/ID, /embed/ID, /v/ID -> normal izleme sayfasi (ayni video, ayni yerlesim)
        m = re.match(r'^/(?:live|embed|v)/([^/]+)$', path, re.I)
        if m:
            v = vid(m.group(1))
            if v:
                return "https://www.youtube.com/watch?v=" + v
        # 4) /shorts/ID -> AYRI tutulur (yerlesim farkli)
        m = re.match(r'^/shorts/([^/]+)$', path, re.I)
        if m:
            v = vid(m.group(1))
            if v:
                return "https://www.youtube.com/shorts/" + v
        # 5) /post/ID -> topluluk gonderisi
        m = re.match(r'^/post/([^/]+)$', path, re.I)
        if m:
            return "https://www.youtube.com/post/" + m.group(1)
        # 6) Taninmayan (kanal sayfasi vb.): host normalize + sorguyu at.
        return "https://www.youtube.com" + (path or "/")
    except Exception:
        return link

def yt_kanal_oku(link):
    """YouTube kanal adi — YALNIZCA URL'de varsa.

    /@kanal/... formunda vardir; ama KAPSAMDAKI formlarin hicbirinde (watch?v=,
    /shorts/, /post/) kanal URL'de YOKTUR -> None doner ve gruplama, yakalamadan
    gelen kanal adina duser (FB'deki /share/ durumunun aynisi).
    """
    try:
        if not link or detect_platform(link) != "yt":
            return None
        u = urlparse(yt_canonical_link(link))
        m = re.match(r'^/@([^/]+)', u.path or "", re.I)
        return m.group(1).lower() if m else None
    except Exception:
        return None

def tt_kullanici_adi_oku(link):
    """TikTok kullanici adi — YOLDAN. /@rtedijital/video/123 -> 'rtedijital'.

    FB'nin aksine bu HER kanonik gonderi linkinde VAR (FB'de /share/, /reel/, /watch/
    formlarinda URL'de isim YOKTU ve yakalamayi beklemek gerekiyordu). Yani TikTok'ta
    gruplama Faz 1'de, YAKALAMA OLMADAN calisir.
    Kisa linkte (vm./vt.) isim yok -> None; gercek ad yonlenmeden/yakalamadan gelir.
    """
    try:
        if not link or detect_platform(link) != "tt":
            return None
        u = urlparse(tt_canonical_link(link))
        m = re.match(r'^/@([^/]+)/(?:video|photo)/\d+', u.path or "", re.I)
        return m.group(1).lower() if m else None
    except Exception:
        return None

# Kullanıcı adı çıkarılamadığında kullanılan genel/yer tutucu başlıklar.
# Bunlar gerçek bir kullanıcı adı geldiğinde üzerine yazılabilir kabul edilir.
_GENERIC_TITLES = {"@instagram_user", "instagram_user", "instagram gönderisi", "instagram gonderisi",
                   "@facebook_user", "facebook_user", "facebook gönderisi", "facebook gonderisi",
                   "@tiktok_user", "tiktok_user", "tiktok gönderisi", "tiktok gonderisi",
                   "@youtube_user", "youtube_user", "youtube videosu", "youtube gönderisi", "youtube gonderisi"}

def is_generic_title(t):
    if not t:
        return True
    return t.strip().lower() in _GENERIC_TITLES

def pool_group_key(item):
    # manual_generate ile AYNI gruplama anahtarı: profil kartı ve tweetler aynı hesapta
    # birleşsin diye. X için kullanıcı adı, Instagram için başlık; ikisi de yoksa None (standalone).
    # v3.75: group_override EN YUKSEK oncelik. RT'li tweet "Rapora Ekle" ile eklendiginde
    # widget RT YAPANIN @kullanici adini group_override olarak gonderir; link'ten turetilen
    # tweet SAHIBI yerine RT yapan kullanilir (kullanici karari). Yalnizca X reposttan gelir,
    # bare handle -> X ad uzayi (fb:/tt:/yt: onekleriyle cakismaz).
    _go = (item.get("group_override") or "").strip().lstrip("@").lower()
    if _go:
        return _go
    link = item.get("link", "") or ""
    username = tweet_kullanici_adi_oku(link)
    if not username and link and "instagram.com" in link.lower():
        t = (item.get("title", "") or "").strip()
        username = t.lower() if t else "@instagram_user"
    # --- Faz FB-1 (SALT EKLEME: X/IG dallari yukarida DEGISMEDI) ---
    # FB anahtarlari 'fb:' ONEKLI olmak ZORUNDA: grup anahtarlari platforma gore
    # isimlendirilmemis, dolayisiyla FB sayfasi 'bbcnews' ile X hesabi '@bbcnews'
    # ayni anahtara duser ve TEK Baslik 2 altinda birlesirdi (ayni markayi X/IG/FB'de
    # izlemek bu urunun ana kullanimi -> ilk gunden cakisirdi).
    # SLUG-ONCE (IG'nin baslik-once mantigindan bilerek FARKLI): slug URL'den gelir,
    # yani Faz 1'de YAKALAMA OLMADAN da gruplama calisir ve test edilebilir.
    if not username and link and detect_platform(link) == "fb":
        slug = fb_page_slug(link)
        if slug:
            username = "fb:" + slug
        else:
            # /share/p, /reel, /watch, /photo -> URL'de isim YOK; gercek ad Faz 2'de
            # yakalamadan gelir ve is_generic_title uzerinden yer tutucunun ustune yazilir.
            t = (item.get("title", "") or "").strip()
            username = ("fb:" + t.lower()) if (t and not is_generic_title(t)) else "fb:@facebook_user"
    # --- Faz TT-1 (SALT EKLEME) ---
    # 'tt:' oneki FB ile AYNI gerekce: TikTok @rtedijital ile X @rtedijital ayni anahtara
    # duser ve TEK Baslik 2 altinda birlesirdi. Onek olmadan cakisirlar.
    # SLUG-ONCE: FB'den farkli olarak TikTok'ta ad HER kanonik gonderi linkinde var ->
    # gruplama yakalama olmadan calisir.
    if not username and link and detect_platform(link) == "tt":
        slug = tt_kullanici_adi_oku(link)
        if slug:
            username = "tt:" + slug
        else:
            # Kisa link (vm./vt./t/) -> URL'de isim YOK; gercek ad yonlenmeden veya
            # yakalamadan gelir ve is_generic_title uzerinden yer tutucunun ustune yazilir.
            t = (item.get("title", "") or "").strip()
            username = ("tt:" + t.lower()) if (t and not is_generic_title(t)) else "tt:@tiktok_user"
    # --- Faz YT-1 (SALT EKLEME) ---
    # 'yt:' oneki FB/TT ile AYNI gerekce: YouTube kanali 'ntvspor' ile X hesabi
    # '@ntvspor' ayni anahtara duser ve TEK Baslik 2 altinda birlesirdi.
    # KAPSAMDAKI formlarda (watch?v=, /shorts/, /post/) kanal URL'de YOK -> gercek ad
    # yakalamadan gelir ve is_generic_title uzerinden yer tutucunun ustune yazilir
    # (FB'nin /share/ durumunun aynisi).
    if not username and link and detect_platform(link) == "yt":
        kanal = yt_kanal_oku(link)
        if kanal:
            username = "yt:" + kanal
        else:
            t = (item.get("title", "") or "").strip()
            username = ("yt:" + t.lower()) if (t and not is_generic_title(t)) else "yt:@youtube_user"
    return username if username else None

def iter_paragraphs_with_hyperlinks(paragraph):
    text = ""
    for child in paragraph._p:
        if child.tag.endswith('r'):
            for t in child.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"):
                if t.text: text += t.text
        elif child.tag.endswith('hyperlink'):
            for t in child.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"):
                if t.text: text += t.text
    return text.strip()

def stili_uygula(run, font_name, size_pt, color_hex, bold=False, italic=False, underline=False):
    run.font.name = font_name
    run.font.size = Pt(size_pt)
    run.font.color.rgb = hex_to_rgb(color_hex)
    run.bold = bold
    run.italic = italic
    run.underline = underline

def link_ekle_hyperlink(paragraf, url, metin, font_name, size_pt, color_hex, underline=False):
    part = paragraf.part
    r_id = part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)

    hyperlink = OxmlElement('w:hyperlink')
    hyperlink.set(qn('r:id'), r_id)

    new_run = OxmlElement('w:r')
    rPr = OxmlElement('w:rPr')

    c = OxmlElement('w:color')
    c.set(qn('w:val'), color_hex.lstrip('#'))
    rPr.append(c)

    sz = OxmlElement('w:sz')
    sz.set(qn('w:val'), str(size_pt * 2))
    rPr.append(sz)
    szCs = OxmlElement('w:szCs')
    szCs.set(qn('w:val'), str(size_pt * 2))
    rPr.append(szCs)

    rFonts = OxmlElement('w:rFonts')
    rFonts.set(qn('w:ascii'), font_name)
    rFonts.set(qn('w:hAnsi'), font_name)
    rPr.append(rFonts)

    if underline:
        u = OxmlElement('w:u')
        u.set(qn('w:val'), 'single')
        rPr.append(u)

    new_run.append(rPr)

    text_elem = OxmlElement('w:t')
    text_elem.text = metin
    new_run.append(text_elem)

    hyperlink.append(new_run)
    paragraf._p.append(hyperlink)

# --- .docx gorsel olculeri (kullanici karari 2026-07-17) ---
#
# !!! ARTIK JS IKIZI DEGIL - BILEREK AYRISTI (2026-07-17) !!!
# Word'un ASIL uretildigi yol TARAYICI (LOCAL_DOCX_JS). Orasi kullanici istegi uzerine
# SAYFA BAZLI boyutlamaya gecti: sayfalama Word'den devralindi, ayni sayfaya dusen
# gorsellere ORTAK genislik veriliyor (bkz. LOCAL_DOCX_JS ~4270 "SAYFA BAZLI YERLESIM").
# Bu Python yolu ayni seyi YAPAMAZ ve yapmasi da beklenmiyor:
#   - /api/upload/format ("Format Docx" sekmesi) MEVCUT bir .docx'i yeniden bicimlendirir;
#     havuz verisi/en-boy plani yoktur, sayfalamayi yeniden kurmasi ayri bir istir.
#   - /api/manual/generate yalnizca tarayici uretimi HATA VERIRSE devreye giren gorunmez
#     yedektir (xLocalGenEnabled hep true) -> nadir ve "calissin yeter" yolu.
#   - /api/extension/generate_single tek ogedir; eslestirilecek ikinci gorsel yoktur.
# Bu yuzden burasi GORSEL BAZLI basit kuralda birakildi. Iki yol ayni belgeyi ayni
# olcude uretmez; bu bilinen ve kabul edilen fark. Tarayici yolunu degistirirken buraya
# dokunmak GEREKMEZ - ama sunucu yolunun ciktisi "eski duzen" gorunur.
#
# KURAL: GENISLIK-ONCE. Genislik hedefe sabitlenir, yukseklik en-boy oranindan turer
# -> en-boy orani korunur, goruntu esnetilmez, piksel verisi hic islenmez (yalnizca
# Word'un cizim kutusu degisir).
# ONCEKI KURAL YUKSEKLIK-ONCE idi (yukseklik 3.8" herkese sabit, genislik oranla
# degisir): ayni sayfadaki gorsellerin genislikleri 3.8 kata kadar ayrisiyordu
# (olculdu: 524x1180 gonderi karti -> 1.69", 598x250 kisa metin -> 6.50").
#
# TAVAN NEDEN SART: sayfa Letter (12240x15840 twip) + kenar bosluklari (720/1080)
# -> 7.0" x 10.0" kullanilabilir alan. Orani 0.44 olan bir gonderi karti 6" genislikte
# 13.5" yuksek olur, hicbir sayfaya sigmaz. Tavana takilan gorselin genisligi hedeften
# sapar; istek bu yuzden "esit" degil "esit derecesinde yakin".
# 9.0" = 10.0" metin yuksekligi - ~1.0" baslik+link+aralik payi (baslik puntosu
# kullanici tarafindan ayarlanabildigi icin pay genis tutuldu).
#
# HEDEF GENISLIK NEDEN 6.0" (kullanici karari 2026-07-17, "sayfayi taşma olmadan
# doldurabildigimiz kadar dolduralim"): metin alani 7.0" genis; 5.0" hedefte sayfanin
# sag %33'u hep bos kaliyordu. Simulasyon (10 gonderilik temsili karisim) sunu gosterdi:
# hedefi buyutmek EK SAYFAYA MAL OLMUYOR (5.0"->10 sayfa, 7.0"->10 sayfa) cunku uzun
# kartlar zaten YUKSEKLIK tavanina dayali, genisletmek onlara yer ekletmiyor.
#   5.0" -> alan doluluğu %38, genislik farki 1.25x
#   6.0" -> %46, 1.50x   <- secilen orta yol
#   7.0" -> %52, 1.75x
# Doldurma ile genislik esitligi ZIT yonde: tavana dayanmis gorseli genisletmenin tek
# yolu uzatmak, sayfa buna izin vermiyor -> ikisi ayni anda maksimum olamaz.
# (Kenar bosluklarini daraltmak denendi: 0.75"->0.5" doluluğu %52.1 -> %51.9 YAPIYOR,
#  alan buyudukce payda da buyudugu icin ise yaramiyor -> kenar bosluklari degismedi.)
HEDEF_GORSEL_GENISLIK_INCH = 6.0
GORSEL_TAVAN_YUKSEKLIK_INCH = 9.0

def gorsel_ekle_ve_boyutlandir(doc_obj, gorsel_data):
    if not gorsel_data:
        return
    try:
        if isinstance(gorsel_data, str) and os.path.exists(gorsel_data):
            img = PILImage.open(gorsel_data)
            gorsel_input = gorsel_data
        else:
            gorsel_stream = io.BytesIO(gorsel_data)
            img = PILImage.open(gorsel_stream)
            gorsel_stream.seek(0)
            gorsel_input = gorsel_stream
            
        width, height = img.size
        aspect_ratio = width / height
        # GENISLIK-ONCE (bkz. yukaridaki sabitler; JS ikizi imageXml ile ayni kural).
        hedef_genislik_inch = HEDEF_GORSEL_GENISLIK_INCH
        hedef_yukseklik_inch = hedef_genislik_inch / aspect_ratio
        if hedef_yukseklik_inch > GORSEL_TAVAN_YUKSEKLIK_INCH:
            hedef_yukseklik_inch = GORSEL_TAVAN_YUKSEKLIK_INCH
            hedef_genislik_inch = hedef_yukseklik_inch * aspect_ratio
        p_img = doc_obj.add_paragraph()
        p_img.alignment = WD_ALIGN_PARAGRAPH.LEFT
        p_img.paragraph_format.space_after = Pt(6)
        p_img.add_run().add_picture(gorsel_input, width=Inches(hedef_genislik_inch), height=Inches(hedef_yukseklik_inch))
    except Exception as e:
        print(f"[gorsel_ekle_ve_boyutlandir] Hata: {e}", flush=True)
        try:
            p_img = doc_obj.add_paragraph()
            p_img.alignment = WD_ALIGN_PARAGRAPH.LEFT
            p_img.paragraph_format.space_after = Pt(6)
            if isinstance(gorsel_data, str) and os.path.exists(gorsel_data):
                # Yalnizca genislik verilir -> python-docx yuksekligi orandan hesaplar
                # (zaten genislik-once). Hedef genislige cekildi; tavan yok cunku bu
                # yol sadece olcu okunamadiginda calisan hata yedegi.
                p_img.add_run().add_picture(gorsel_data, width=Inches(HEDEF_GORSEL_GENISLIK_INCH))
            else:
                gorsel_stream = io.BytesIO(gorsel_data)
                p_img.add_run().add_picture(gorsel_stream, width=Inches(HEDEF_GORSEL_GENISLIK_INCH))
        except Exception as inner_e:
            print(f"[gorsel_ekle_ve_boyutlandir] Fallback hatası: {inner_e}", flush=True)

def _eklenti_surumu_oku():
    """Panelin sundugu .zip'teki (yani EN GUNCEL) eklenti surumu — x-word/manifest.json.

    NEDEN ACILISTA BIR KEZ: /api/status 1.5 sn'de bir yoklaniyor; manifest'i her
    yoklamada acmak dakikada ~40 gereksiz disk erisimi olurdu. Docker'da x-word/
    imaja gomulu -> calisirken DEGISMEZ; degisince zaten konteyner yeniden kurulur
    ve bu deger tazelenir.

    Okunamazsa BOS doner ve panel uyariyi HIC gostermez: yanlis "guncelle" uyarisi
    vermektense susmak dogru (kullanici bosuna eklenti yeniden yukler).
    """
    try:
        p = os.path.join(os.path.dirname(__file__), "x-word", "manifest.json")
        with open(p, encoding="utf-8") as f:
            return str(json.load(f).get("version") or "").strip()
    except Exception as e:
        print(f"[eklenti_surum] x-word/manifest.json okunamadi: {e}", flush=True)
        return ""


EKLENTI_SURUMU = _eklenti_surumu_oku()


def eklenti_zip_olustur():
    zip_buffer = io.BytesIO()
    extension_dir = os.path.join(os.path.dirname(__file__), "x-word")
    if not os.path.exists(extension_dir):
        return None
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for root, dirs, files in os.walk(extension_dir):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, start=extension_dir)
                zip_file.write(file_path, arcname)
    zip_buffer.seek(0)
    return zip_buffer.getvalue()

# ----------------- WEB FRONTEND ROUTE -----------------
HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- Eklenti bu isareti gorup SADECE gercek paneli panel olarak kaydeder (guvenilir panel_tab_id) -->
    <meta name="x-rapor-panel" content="1">
    <title>GörüntüX</title>
    <!-- Programa özgü favicon (görüntü/ekran-yakalama kadraj köşeleri + X). Data-URI: kendi kendine
         yeten (ayrı route yok). Renkler #23 ile kodlu; SVG öznitelikleri tek tırnak (href çift tırnak).
         AYNI logo başlıkta da inline SVG olarak kullanılır (.brand-logo). -->
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231d9bf0'/%3E%3Cg fill='none' stroke='%23ffffff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 12V9h3'/%3E%3Cpath d='M20 9h3v3'/%3E%3Cpath d='M23 20v3h-3'/%3E%3Cpath d='M12 23H9v-3'/%3E%3Cpath d='M13 13l6 6M19 13l-6 6'/%3E%3C/g%3E%3C/svg%3E">
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <!-- Mammoth.js library for docx to HTML conversion -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
    <!-- SweetAlert2 library for beautiful notifications -->
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <!-- Twitter (X) Widgets Library for Live Tweet Preview -->
    <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>
    <style>
        :root {
            --bg-primary: #0a0e17;
            --bg-card: rgba(22, 28, 42, 0.6);
            --bg-sidebar: rgba(14, 20, 31, 0.95);
            --bg-input: #111622;
            --bg-modal: rgba(14, 20, 31, 0.95);
            --bg-btn-secondary: rgba(255, 255, 255, 0.05);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-primary: #e7e9ea;
            --text-secondary: #8b98a5;
            --accent-color: #1d9bf0;
            --accent-glow: rgba(29, 155, 240, 0.15);
            --success-color: #00ba7c;
            --success-glow: rgba(0, 186, 124, 0.15);
            --danger-color: #f4212e;
            --danger-glow: rgba(244, 33, 46, 0.15);
            --font-family: 'Outfit', sans-serif;
            --scrollbar-thumb: rgba(255, 255, 255, 0.15);
            --scrollbar-thumb-hover: rgba(255, 255, 255, 0.3);
            /* .main-content dolgusu. .pool-actions sticky bari bu degere BAGLI
               (bottom: calc(-1 * bu)) -> iki yerde ayri yazilirsa biri degistiginde
               bar ya ekran disina kacar ya da altinda havuz ogeleri sizar. Tek kaynak. */
            --content-pad: 40px;
        }

        body.light-theme {
            --bg-primary: #f5f8fa;
            --bg-card: #ffffff;
            --bg-sidebar: #f7f9f9;
            --bg-input: #ffffff;
            --bg-modal: #ffffff;
            --bg-btn-secondary: rgba(0, 0, 0, 0.05);
            --border-color: rgba(0, 0, 0, 0.08);
            --text-primary: #0f1419;
            --text-secondary: #536471;
            --accent-glow: rgba(29, 155, 240, 0.1);
            --success-glow: rgba(0, 186, 124, 0.1);
            --danger-glow: rgba(244, 33, 46, 0.1);
            --scrollbar-thumb: rgba(0, 0, 0, 0.15);
            --scrollbar-thumb-hover: rgba(0, 0, 0, 0.3);
        }

        /* Custom Elegant and Thin Scrollbar Styling */
        * {
            scrollbar-width: thin;
            scrollbar-color: var(--scrollbar-thumb) transparent;
        }

        ::-webkit-scrollbar {
            width: 4px;
            height: 4px;
        }

        ::-webkit-scrollbar-track {
            background: transparent;
        }

        ::-webkit-scrollbar-thumb {
            background: var(--scrollbar-thumb);
            border-radius: 10px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--scrollbar-thumb-hover);
        }

        body.light-theme .item-card {
            background: rgba(0, 0, 0, 0.02);
        }

        body {
            background-color: var(--bg-primary);
            color: var(--text-primary);
            font-family: var(--font-family);
            margin: 0;
            padding: 0;
            display: flex;
            min-height: 100vh;
            overflow: hidden;
        }

        .container {
            display: flex;
            width: 100vw;
            height: 100vh;
        }

        /* Sidebar Styling */
        .sidebar {
            width: 330px;
            background: var(--bg-sidebar);
            border-right: 1px solid var(--border-color);
            padding: 24px;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            gap: 20px;
            overflow-y: auto;
            height: 100vh;
        }

        .sidebar h2 {
            font-size: 18px;
            margin: 0 0 10px 0;
            color: var(--text-primary);
            font-weight: 600;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 12px;
        }

        .sidebar h3 {
            font-size: 13px;
            margin: 10px 0 12px 0;
            color: var(--text-secondary);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.8px;
        }

        .form-group {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 16px;
        }

        .form-group label {
            font-size: 12px;
            color: var(--text-secondary);
            font-weight: 500;
        }

        .form-group select, .form-group input[type="text"], .form-group input[type="number"] {
            background: var(--bg-input);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            padding: 10px 14px;
            border-radius: 10px;
            font-size: 13px;
            outline: none;
            transition: all 0.2s ease;
        }

        .form-group select:focus, .form-group input[type="text"]:focus {
            border-color: var(--accent-color);
            box-shadow: 0 0 0 3px var(--accent-glow);
        }

        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 12px;
            cursor: pointer;
            font-size: 13px;
            user-select: none;
        }

        .checkbox-group input[type="checkbox"] {
            width: 16px;
            height: 16px;
            accent-color: var(--accent-color);
            cursor: pointer;
        }

        /* Main Content Area */
        .main-content {
            flex: 1;
            padding: var(--content-pad);
            box-sizing: border-box;
            overflow-y: auto;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }

        .header {
            margin-bottom: 30px;
        }

        .header h1 {
            font-size: 30px;
            margin: 0 0 8px 0;
            font-weight: 700;
            display: flex;
            align-items: center;
            color: var(--text-primary);
        }

        .header h1 span.emoji {
            margin-right: 12px;
            font-size: 28px;
            display: inline-block;
        }

        .header h1 span.title-text {
            /* Kullanici istegi 2026-07-17: "yesilli mavili degil, temaya gore beyaz ya da
               koyu renk". Once mavi->yesil gradyan vardi (#1d9bf0 -> #00ba7c) ve metne
               background-clip:text + text-fill-color:transparent ile uygulaniyordu.
               UCU DE KALKMAK ZORUNDA: -webkit-text-fill-color:transparent kalirsa 'color'
               EZILIR ve yazi GORUNMEZ olur (gradyan da gittigi icin arkasinda hicbir sey
               kalmaz). --text-primary zaten temaya gore donuyor:
                 koyu tema  -> #e7e9ea (beyaza yakin)
                 acik tema  -> #0f1419 (koyu)
               Not: ayni gradyan .progress-bar-fill'de de var; istek YAZI icindi -> ORASI
               BILEREK DEGISTIRILMEDI. */
            color: var(--text-primary);
            display: inline-block;
        }

        .header p {
            color: var(--text-secondary);
            margin: 0;
            font-size: 14px;
        }

        /* Tabs styling */
        .tabs {
            display: flex;
            border-bottom: 1px solid var(--border-color);
            margin-bottom: 24px;
            gap: 6px;
        }

        .tab-btn {
            background: none;
            border: none;
            color: var(--text-secondary);
            padding: 12px 20px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            position: relative;
            outline: none;
            transition: color 0.2s;
            border-radius: 8px 8px 0 0;
            display: inline-flex;
            align-items: center;
            gap: 7px;
        }
        .tab-btn svg { width: 17px; height: 17px; flex-shrink: 0; }

        .tab-btn:hover {
            color: var(--text-primary);
            background: rgba(255, 255, 255, 0.02);
        }

        .tab-btn.active {
            color: var(--accent-color);
            background: rgba(29, 155, 240, 0.05);
        }

        /* Sekme adindaki kayitli-rapor sayaci (yuvarlak rozet) */
        .tab-count-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 18px;
            height: 18px;
            padding: 0 5px;
            margin-left: 7px;
            border-radius: 9px;
            background: var(--accent-color);
            color: #fff;
            font-size: 11px;
            font-weight: 700;
            line-height: 1;
            vertical-align: middle;
        }

        .tab-btn.active::after {
            content: '';
            position: absolute;
            bottom: -1px;
            left: 0;
            right: 0;
            height: 3px;
            background-color: var(--accent-color);
            border-radius: 3px 3px 0 0;
        }

        .tab-content {
            display: none;
            animation: fadeIn 0.3s ease-in-out;
            flex: 1;
        }

        .tab-content.active {
            display: block;
        }

        /* [SEÇİM ÇUBUĞU FLAŞ FİX] transform KALDIRILDI: sekme fadeIn'inde ata transform'u olunca,
           içindeki position:fixed seçim çubuğu (#x-secim-bar) viewport yerine o ataya göre konumlanıp
           sekme geçişinde 0.3sn ekranda beliriyordu (flaş). Sade opacity-fade -> ata transform'suz -> flaş yok. */
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        /* Card panels */
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 30px;
            backdrop-filter: blur(12px);
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.25);
            margin-bottom: 24px;
        }

        .card h3 {
            margin-top: 0;
            margin-bottom: 15px;
            font-size: 18px;
            font-weight: 600;
        }

        .btn {
            background: var(--accent-color);
            color: white;
            border: none;
            padding: 12px 24px;
            font-size: 14px;
            font-weight: 600;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            outline: none;
            text-decoration: none;
        }

        .btn:hover {
            filter: brightness(1.15);
            transform: translateY(-1px);
            box-shadow: 0 4px 12px var(--accent-glow);
        }

        .btn:active {
            transform: translateY(0);
        }

        .btn-secondary {
            background: rgba(255, 255, 255, 0.06);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
        }

        .btn-secondary:hover {
            background: rgba(255, 255, 255, 0.1);
            box-shadow: none;
        }

        .btn-danger {
            background: var(--danger-color);
        }
        .btn-danger:hover {
            box-shadow: 0 4px 12px var(--danger-glow);
        }

        .btn-success {
            background: var(--success-color);
        }
        .btn-success:hover {
            box-shadow: 0 4px 12px var(--success-glow);
        }

        .btn-block {
            display: flex;
            width: 100%;
            box-sizing: border-box;
        }

        /* File Uploader styling */
        .file-dropzone {
            border: 2px dashed var(--border-color);
            border-radius: 12px;
            padding: 40px;
            text-align: center;
            cursor: pointer;
            transition: all 0.2s;
            background: rgba(255, 255, 255, 0.01);
            margin-bottom: 20px;
        }

        .file-dropzone:hover, .file-dropzone.dragover {
            border-color: var(--accent-color);
            background: rgba(29, 155, 240, 0.03);
        }

        .file-dropzone input[type="file"] {
            display: none;
        }

        .file-dropzone svg {
            width: 48px;
            height: 48px;
            fill: var(--text-secondary);
            margin-bottom: 12px;
        }

        .file-name-display {
            font-size: 14px;
            color: var(--success-color);
            font-weight: 500;
            margin-top: 10px;
            display: none;
        }

        /* Status badges */
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 20px;
            border-radius: 99px;
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 20px;
        }

        .status-connected {
            background: rgba(0, 186, 124, 0.1);
            color: var(--success-color);
            border: 1px solid rgba(0, 186, 124, 0.2);
            box-shadow: 0 0 16px var(--success-glow);
        }

        .status-disconnected {
            background: rgba(29, 155, 240, 0.05);
            color: var(--accent-color);
            border: 1px solid rgba(29, 155, 240, 0.15);
        }

        /* Textarea and inputs */
        textarea {
            background: var(--bg-input);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            width: 100%;
            padding: 14px;
            border-radius: 12px;
            font-family: inherit;
            font-size: 13px;
            resize: none;
            overflow-y: hidden;
            min-height: 50px;
            outline: none;
            box-sizing: border-box;
            margin-bottom: 20px;
            transition: border-color 0.2s ease, box-shadow 0.2s ease;
        }

        textarea:focus {
            border-color: var(--accent-color);
            box-shadow: 0 0 0 3px var(--accent-glow);
        }

        /* Progress Bar */
        .progress-container {
            margin-top: 20px;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 16px;
        }

        .progress-label {
            display: flex;
            justify-content: space-between;
            font-size: 13px;
            color: var(--text-secondary);
            margin-bottom: 8px;
        }

        .progress-bar-bg {
            background: rgba(255, 255, 255, 0.08);
            height: 10px;
            border-radius: 5px;
            overflow: hidden;
        }

        .progress-bar-fill {
            background: linear-gradient(90deg, #1d9bf0, #00ba7c);
            height: 100%;
            width: 0%;
            transition: width 0.3s ease;
        }

        /* Clipboard preview and items list */
        .preview-box {
            background: rgba(0, 186, 124, 0.04);
            border: 1px dashed var(--success-color);
            border-radius: 12px;
            padding: 16px;
            margin-bottom: 20px;
            display: none;
            align-items: center;
            gap: 16px;
        }

        .preview-img {
            max-width: 120px;
            max-height: 80px;
            border-radius: 8px;
            border: 1px solid var(--border-color);
            object-fit: cover;
        }

        .items-list {
            margin-top: 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            /* Havuz ICERIK KADAR uzar (kullanici istegi 2026-07-17). Once max-height:250px
               + overflow-y:auto vardi: kutu 250px'te kesiliyor, fazlasi KUTUNUN ICINDE
               kayiyordu. Platform bolumleri/bloklari tasirken surekli kutu ici kaydirma
               gerekiyordu. Artik kutu icerik kadar uzuyor, gerekirse SAYFA kayiyor.
               padding-right:6px de ayni commit'te kaydirma cubugu olugu olarak gelmisti;
               cubuk kalkinca islevsiz kalip sagda 6px asimetri birakiyordu -> kaldirildi. */
        }

        /* Havuzun eylem satiri (Word Uret / Onizle / Sifirla).
           Kullanici istegi 2026-07-17: "su kisim en altta kalmasin, o sabit kalsin,
           havuz scroll olsun." Havuz artik icerik kadar uzun oldugu icin bu satir
           kartin en dibine (1800px+ asagi) itiliyordu; butona basmak icin havuzun
           tamamini kaydirmak gerekiyordu. Artik ekranin altina yapisik.
           Sticky'nin kaydirma kabi = .main-content (overflow-y:auto, height:100vh);
           kapsayan blok = .card. Kart bardan cok daha uzun oldugu icin yapisma
           mesafesi var. */
        .pool-actions {
            display: flex;
            gap: 12px;
            position: sticky;
            /* NEDEN 0 DEGIL: sticky'nin kabi kaydiricinin ICERIK kutusu, yani
               .main-content'in alt dolgusu (--content-pad) disarida kaliyor.
               bottom:0 ile bar ekranin 40px yukarisinda takiliyor ve o seritten
               havuz ogeleri barin ALTINDAN gorunerek kayiyordu (olculdu: basta
               "Gonderi 10", 400px'te "Gonderi 17/18" siziyordu).
               Negatif deger bari ekranin dibine indirir. */
            bottom: calc(-1 * var(--content-pad));
            z-index: 5;
            /* Kartin 30px dolgusunu kapla; yoksa kayan havuz ogeleri barin
               yanindan ve altindan gorunur. */
            margin: 24px -30px -30px;
            padding: 16px 30px 30px;
            /* OPAK olmak ZORUNDA: --bg-card koyu temada rgba(22,28,42,0.6), yani
               %40 saydam -> duz var(--bg-card) verilirse kayan ogeler barin
               ICINDEN gorunur. Iki katman (kart rengi + opak sayfa rengi) kartin
               ekranda gorunen tonunu birebir uretir ve tema degisince kendi uyar. */
            background: linear-gradient(var(--bg-card), var(--bg-card)), var(--bg-primary);
            border-top: 1px solid var(--border-color);
            /* Negatif margin kart kenarina dayaniyor -> kartin 16px kosesini koru */
            border-radius: 0 0 16px 16px;
        }

        .item-card {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 12px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
        }

        .item-info {
            display: flex;
            align-items: center;
            gap: 12px;
            overflow: hidden;
        }

        .item-thumb {
            width: 80px;
            height: 50px;
            object-fit: cover;
            border-radius: 6px;
            border: 1px solid var(--border-color);
            background: rgba(255, 255, 255, 0.03);
            flex-shrink: 0;
        }

        .item-text {
            display: flex;
            flex-direction: column;
            gap: 4px;
            overflow: hidden;
        }

        .item-title {
            font-size: 13px;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .item-link {
            font-size: 11px;
            color: var(--accent-color);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            cursor: pointer;
        }

        .btn-danger-action:hover {
            background: var(--danger-color) !important;
            color: #ffffff !important;
            box-shadow: 0 0 10px rgba(224, 36, 94, 0.4);
        }

        .custom-toast {
            pointer-events: auto;
            display: flex;
            align-items: center;
            background: var(--bg-card);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            padding: 12px 18px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
            font-size: 14px;
            font-family: var(--font-family);
            font-weight: 500;
            gap: 12px;
            min-width: 280px;
            transform: translateX(120%);
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.1, 0.9, 0.2, 1);
            border-left: 4px solid var(--accent-color);
        }
        .custom-toast.active {
            transform: translateX(0);
            opacity: 1;
        }
        .custom-toast.toast-success {
            border-left-color: var(--success-color);
        }
        .custom-toast.toast-danger {
            border-left-color: var(--danger-color);
        }
        .custom-toast.toast-warning {
            border-left-color: #f59e0b; /* Amber */
        }
        .custom-toast.toast-info {
            border-left-color: var(--accent-color);
        }
        .custom-toast .toast-icon {
            font-size: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .custom-toast .toast-message {
            flex: 1;
        }
        .custom-toast .toast-close {
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 16px;
            padding: 0;
            margin: 0;
            line-height: 1;
            opacity: 0.6;
            transition: opacity 0.2s;
        }
        .custom-toast .toast-close:hover {
            opacity: 1;
            color: var(--text-primary);
        }

        /* Settings Modal & Toggle Button */
        /* Theme Toggle Button Styles */
        .theme-toggle-btn {
            border: 1px solid var(--border-color);
            background: var(--bg-btn-secondary);
            color: var(--text-primary);
            padding: 9px;
            border-radius: 11px;
            cursor: pointer;
            transition: all 0.3s ease;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            outline: none;
        }
        .theme-toggle-btn svg { width: 18px; height: 18px; display: block; }
        
        .theme-toggle-btn:hover {
            background: var(--accent-glow);
            transform: translateY(-2px);
            box-shadow: 0 0 15px rgba(29, 155, 240, 0.2);
        }

        .settings-toggle-btn {
            display: flex;
            align-items: center;
            gap: 8px;
            background: rgba(29, 155, 240, 0.1);
            border: 1px solid rgba(29, 155, 240, 0.2);
            color: var(--accent-color);
            padding: 10px 18px;
            border-radius: 12px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        
        .settings-toggle-btn:hover {
            background: var(--accent-glow);
            transform: translateY(-2px);
            box-shadow: 0 0 15px rgba(29, 155, 240, 0.4);
        }

        /* Üst-sağ kontrol sırası: Tema -> Stil Ayarları -> (en sağda) eklenti durum kutusu */
        .header-controls {
            position: absolute;
            top: 40px;
            right: 40px;
            z-index: 10;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        /* Mobil (x-mobile, UA ile <html>'e eklenir): YALNIZ Otomatik(eklenti) sekmesinde tarama içeriğini
           gizle, "Masaüstü Gerekli" bloğunu göster. Diğer sekmeler etkilenmez. */
        html.x-mobile #auto-desktop-content { display: none !important; }
        html.x-mobile #auto-mobile-block { display: block !important; }

        /* Mobil header: sağ-üst kontroller (absolute) dar ekranda başlıkla ÇAKIŞIYORDU. Mobilde header'ı
           dikey akışa al -> başlık + alt yazı önce, kontroller (Tema/Stil/Eklenti) EN ALTTA (order:3),
           sığmazsa alt satıra sarar (flex-wrap). Masaüstü etkilenmez (yalnız html.x-mobile). */
        html.x-mobile .header { display: flex; flex-direction: column; }
        html.x-mobile .header-controls {
            position: static;
            order: 3;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 14px;
        }
        /* Mobilde eklenti kurulamadığı için "Eklenti yok/kur" durum kutusu ANLAMSIZ -> gizle
           (Tema + Stil Ayarları kalır; onlar Manuel/Kayıtlı Raporlar için mobilde de geçerli). */
        html.x-mobile #ext-status-box { display: none; }

        /* Eklenti durum kutusu (pill). Üç durum: hazır=yeşil, güncelleme gerek=sarı, yok=kırmızı.
           Kırmızı/sarı tıklanabilir (modal); yeşil değil. */
        .ext-status-box {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 18px;
            border-radius: 99px;
            font-size: 13px;
            font-weight: 600;
            white-space: nowrap;
            transition: all 0.3s ease;
            user-select: none;
        }
        .ext-status-box.ext-ok {
            background: rgba(0, 186, 124, 0.1);
            color: var(--success-color);
            border: 1px solid rgba(0, 186, 124, 0.2);
            box-shadow: 0 0 16px var(--success-glow);
            cursor: default;
        }
        .ext-status-box.ext-warn {
            background: rgba(255, 176, 32, 0.12);
            color: #ffb020;
            border: 1px solid rgba(255, 176, 32, 0.3);
            box-shadow: 0 0 16px rgba(255, 176, 32, 0.15);
            cursor: pointer;
        }
        .ext-status-box.ext-err {
            background: rgba(224, 36, 94, 0.1);
            color: var(--danger-color, #e0245e);
            border: 1px solid rgba(224, 36, 94, 0.25);
            cursor: pointer;
        }
        .ext-status-box.ext-warn:hover,
        .ext-status-box.ext-err:hover {
            transform: translateY(-2px);
            box-shadow: 0 0 15px rgba(29, 155, 240, 0.25);
        }

        /* Word Document Preview Modal Styles */
        .preview-modal-content {
            background: var(--bg-modal);
            border: 1px solid var(--border-color);
            width: 95%;
            max-width: 950px;
            height: 90vh;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 40px rgba(29, 155, 240, 0.15);
            animation: modalFadeIn 0.3s cubic-bezier(0.1, 0.9, 0.2, 1);
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .preview-body {
            padding: 0;
            flex: 1;
            overflow: hidden;
            background: #ffffff;
            display: flex;
        }

        .modal {
            display: none;
            position: fixed;
            z-index: 2000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(6, 9, 15, 0.85);
            backdrop-filter: blur(10px);
            align-items: center;
            justify-content: center;
        }

        .modal.active {
            display: flex;
        }

        .modal-content {
            background: var(--bg-modal);
            border: 1px solid var(--border-color);
            width: 90%;
            max-width: 500px;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 40px rgba(29, 155, 240, 0.15);
            animation: modalFadeIn 0.3s cubic-bezier(0.1, 0.9, 0.2, 1);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            max-height: 85vh;
        }

        @keyframes modalFadeIn {
            from { transform: scale(0.9); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }

        .modal-header {
            padding: 20px 24px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .modal-header h2 {
            font-size: 20px;
            margin: 0;
            color: var(--text-primary);
            font-weight: 600;
        }

        .close-btn {
            font-size: 28px;
            font-weight: bold;
            color: var(--text-secondary);
            cursor: pointer;
            transition: color 0.2s ease;
            line-height: 1;
        }

        .close-btn:hover {
            color: var(--danger-color);
        }

        .modal-body {
            padding: 24px;
            overflow-y: auto;
            flex: 1;
        }

        .modal-footer {
            padding: 16px 24px;
            border-top: 1px solid var(--border-color);
            display: flex;
            justify-content: flex-end;
            background: rgba(10, 15, 24, 0.5);
        }
        /* [TEMA] Diyalog/modal altbilgisi açık temada beyaz gövdeyle uyumlu olsun (koyu yarı-saydam -> gri kalıyordu). */
        body.light-theme .modal-footer { background: #f5f8fa; }

        /* Tweet Hover Preview Popover Styles */
        #tweet-preview-popover {
            position: absolute;
            display: none;
            z-index: 9999;
            width: 350px;
            min-height: 80px;
            background: transparent !important;
            border: none !important;
            box-shadow: none !important;
            pointer-events: none;
            overflow: visible !important;
            box-sizing: border-box;
            transition: opacity 0.2s cubic-bezier(0.1, 0.9, 0.2, 1), transform 0.2s cubic-bezier(0.1, 0.9, 0.2, 1);
            transform: scale(0.95);
            opacity: 0;
        }
        
        #tweet-preview-popover.active {
            opacity: 1;
            transform: scale(1);
        }

        /* Fallback blockquote styling (if widgets.js is blocked) */
        .twitter-tweet {
            font-family: inherit !important;
            border: 1px solid var(--border-color) !important;
            background: var(--bg-card) !important;
            border-radius: 12px;
            padding: 16px !important;
            margin: 0 !important;
            max-width: 100% !important;
            box-sizing: border-box;
            color: var(--text-primary) !important;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
        }
        .twitter-tweet a {
            color: #1d9bf0 !important;
            text-decoration: none;
        }

        /* Link list item hover styles */
        .links-preview-row-item {
            transition: background 0.2s ease, border-color 0.2s ease !important;
            cursor: pointer !important;
        }

        .links-preview-row-item:hover {
            background: rgba(255, 255, 255, 0.08) !important;
            border-color: rgba(29, 155, 240, 0.3) !important;
        }

        body.light-theme .links-preview-row-item:hover {
            background: rgba(0, 0, 0, 0.04) !important;
            border-color: rgba(29, 155, 240, 0.3) !important;
        }

        /* Custom SweetAlert2 Dark Styling */
        .swal2-popup.swal2-dark-theme {
            font-family: 'Outfit', sans-serif !important;
            background: #151b23 !important;
            border: 1px solid #30363d !important;
            border-radius: 12px !important;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5) !important;
        }
        .swal2-dark-theme .swal2-title {
            color: #e6edf3 !important;
            font-size: 18px !important;
            font-weight: 600 !important;
        }
        .swal2-dark-theme .swal2-html-container {
            color: #8b98a5 !important;
            font-size: 13px !important;
            line-height: 1.5 !important;
        }
        .swal2-dark-theme .swal2-confirm {
            background-color: #da3633 !important;
            color: #ffffff !important;
            border-radius: 6px !important;
            padding: 8px 20px !important;
            font-weight: 500 !important;
            font-size: 13px !important;
            cursor: pointer !important;
            border: none !important;
            outline: none !important;
        }
        .swal2-dark-theme .swal2-cancel {
            background-color: #21262d !important;
            color: #c9d1d9 !important;
            border: 1px solid #30363d !important;
            border-radius: 6px !important;
            padding: 8px 20px !important;
            font-weight: 500 !important;
            font-size: 13px !important;
            cursor: pointer !important;
            outline: none !important;
        }
        .swal2-dark-theme .swal2-actions {
            gap: 10px !important;
        }
        /* ===== Faz 4: Raporlarım kart galerisi (Google-Dokümanlar tarzı) ===== */
        .x-gal-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 18px; }
        .x-gal-card { position: relative; cursor: pointer; border-radius: 10px; }
        /* [KART HOVER] kutu ZIPLAMASIN (translateY kaldırıldı) -> hover'da yalnız çerçeve mavilensin. */
        .x-gal-page { position: relative; height: 176px; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border-color, rgba(136,153,166,0.25)); overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.22); transition: border-color .12s ease; }
        .x-gal-card:hover .x-gal-page { border-color: var(--accent-color); }
        .x-gal-card.aktif .x-gal-page { border-color: var(--accent-color); box-shadow: 0 0 0 2px var(--accent-color); }
        .x-gal-pageinner { padding: 16px 15px 30px; height: 100%; box-sizing: border-box; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, #000 68%, transparent); mask-image: linear-gradient(to bottom, #000 68%, transparent); }
        .x-gal-card.aktif .x-gal-pageinner { padding-top: 32px; }   /* "● Açık" rozeti başlığa binmesin: aktif kartta içeriği rozetin altından başlat */
        .x-gal-pbaslik { font-weight: 700; font-size: 11.5px; line-height: 1.35; margin: 0 0 5px; color: var(--text-primary, #e7e9ea); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .x-gal-pmetin { font-size: 10px; line-height: 1.5; margin: 0 0 4px; color: var(--text-secondary, #8899a6); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .x-gal-pbos { font-size: 11px; color: var(--text-secondary, #8899a6); opacity: .55; font-style: italic; }
        .x-gal-pimg { display: block; width: 100%; max-height: 78px; object-fit: cover; border-radius: 5px; margin: 6px 0; border: 1px solid var(--border-color, rgba(136,153,166,0.28)); }
        .x-gal-meta { padding: 9px 2px 2px; display: flex; align-items: baseline; gap: 7px; }
        .x-gal-ad { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-primary, #e7e9ea); cursor: text; flex: 1; min-width: 0; }
        /* [KART ADI INLINE] çift tıkla düzenleme durumu: akıcı, taşmasız, odak çerçeveli */
        .x-gal-ad.x-gal-ad-edit { white-space: normal; overflow: visible; text-overflow: clip; outline: 2px solid var(--accent-color, #1d9bf0); background: rgba(29,155,240,0.1); border-radius: 6px; padding: 1px 5px; cursor: text; }
        .x-gal-alt { font-size: 11px; color: var(--text-secondary, #8899a6); white-space: nowrap; flex-shrink: 0; }
        .x-gal-rozet { position: absolute; top: 7px; right: 7px; background: var(--accent-color); color: #fff; font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 10px; z-index: 2; letter-spacing: .3px; }
        .x-gal-check { position: absolute; bottom: 9px; left: 9px; width: 17px; height: 17px; cursor: pointer; accent-color: var(--accent-color); z-index: 3; opacity: 0; transition: opacity .12s ease; }
        .x-gal-card:hover .x-gal-check, .x-gal-check:checked { opacity: 1; }
        .x-gal-ara { position: absolute; bottom: 8px; right: 8px; display: flex; gap: 6px; opacity: 0; transition: opacity .12s ease; z-index: 2; }
        .x-gal-card:hover .x-gal-ara { opacity: 1; }
        .x-gal-ikon { width: 28px; height: 28px; border: 1px solid var(--border-color, rgba(136,153,166,0.3)); border-radius: 7px; cursor: pointer; display: flex; align-items: center; justify-content: center; background: var(--bg-card); color: var(--text-secondary, #8899a6); padding: 0; transition: all .12s ease; }
        .x-gal-ikon:hover { color: var(--accent-color); border-color: var(--accent-color); }
        .x-gal-ikon svg { width: 15px; height: 15px; display: block; }
        .x-gal-yeni { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 176px; border: 2px dashed var(--border-color, rgba(136,153,166,0.45)); border-radius: 8px; color: var(--text-secondary, #8899a6); gap: 6px; transition: all .12s ease; }
        .x-gal-card:hover .x-gal-yeni { border-color: var(--accent-color); color: var(--accent-color); }
        .x-gal-arti { font-size: 34px; line-height: 1; font-weight: 300; }
        /* Seçim eylem çubuğu — rapor işaretlenince alttan belirir */
        .x-secim-bar { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(160%); display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 14px; background: var(--card-bg, #15202b); border: 1px solid var(--border-color, rgba(136,153,166,0.3)); box-shadow: 0 10px 30px rgba(0,0,0,0.45); z-index: 1200; transition: transform .22s cubic-bezier(.2,.8,.2,1); }
        .x-secim-bar.acik { transform: translateX(-50%) translateY(0); }
        .x-secim-sayi { font-size: 13px; font-weight: 600; color: var(--text-primary, #e7e9ea); padding: 0 4px; white-space: nowrap; }
        .x-secim-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 13px; font-size: 13px; font-weight: 600; border-radius: 9px; border: 1px solid var(--border-color, rgba(136,153,166,0.3)); background: transparent; color: var(--text-primary, #e7e9ea); cursor: pointer; transition: all .12s ease; white-space: nowrap; }
        .x-secim-btn svg { width: 15px; height: 15px; display: block; flex-shrink: 0; }
        .x-secim-btn:hover:not(:disabled) { border-color: var(--accent-color); color: var(--accent-color); }
        .x-secim-btn:disabled { opacity: .4; cursor: default; }
        .x-secim-btn.danger:hover:not(:disabled) { border-color: var(--danger-color, #e0245e); color: var(--danger-color, #e0245e); }
        .x-secim-kapat { background: transparent; border: none; color: var(--text-secondary, #8899a6); font-size: 18px; cursor: pointer; padding: 0 2px; line-height: 1; }
        .x-secim-kapat:hover { color: var(--text-primary, #e7e9ea); }
        /* Dolu butonlardaki (Başlat, Kaydet ve İndir vb.) SVG ikon boyutu */
        .btn svg { width: 17px; height: 17px; flex-shrink: 0; }
        /* Havuz aksiyon butonları (İndir / Önizle / Sıfırla) — yeni görünüm: çerçeveli/ghost + SVG */
        .x-havuz-btn { flex: 1 1 0; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 11px 14px; font-size: 14px; font-weight: 600; border-radius: 10px; border: 1px solid var(--border-color); background: transparent; color: var(--text-primary); cursor: pointer; transition: all .15s ease; outline: none; }
        .x-havuz-btn svg { width: 16px; height: 16px; flex-shrink: 0; }
        .x-havuz-btn:hover:not(:disabled) { border-color: var(--accent-color); color: var(--accent-color); background: var(--accent-glow); }
        .x-havuz-btn.vurgu { border-color: var(--accent-color); color: var(--accent-color); }
        .x-havuz-btn.danger { color: var(--danger-color); }
        .x-havuz-btn.danger:hover:not(:disabled) { border-color: var(--danger-color); color: var(--danger-color); background: rgba(224,36,94,0.10); }
        /* Onay/giriş dialoglarında başlık ikonu (tek-renk SVG) */
        .x-dlg-title { display: flex; align-items: center; gap: 9px; }
        .x-dlg-ico { display: inline-flex; align-items: center; color: var(--text-primary); flex-shrink: 0; }
        .x-dlg-ico svg { width: 20px; height: 20px; display: block; }
        .x-dlg-title.danger .x-dlg-ico { color: var(--danger-color); }
        /* Bölüm/modal başlıklarındaki tek-renk SVG ikon */
        .x-shead { display: flex; align-items: center; gap: 8px; }
        .x-shead svg { width: 19px; height: 19px; flex-shrink: 0; }
        .ext-status-box svg { width: 9px; height: 9px; vertical-align: -1px; margin-right: 5px; }
    </style>
</head>
<body>
    <!-- Mobil tespiti: <html>'e x-mobile sınıfı ekle (UA; iPadOS 'masaüstü' UA -> dokunmatik+Mac kalıbı).
         Body'den ÖNCE çalışır -> CSS anında uygular, FLASH olmaz. YALNIZ Otomatik(eklenti) sekmesini etkiler. -->
    <script>(function(){try{var ua=navigator.userAgent||'';if(/Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile|BlackBerry|webOS/i.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints&&navigator.maxTouchPoints>1)){document.documentElement.classList.add('x-mobile');}}catch(e){}})();</script>
    <!-- [TEMA FLASH FİX] Kaydedilmiş tema 'light' ise body SINIFINI boyamadan ÖNCE (senkron) ekle -> açılışta/
         yenilemede anlık dark flash'ı OLMAZ. DOMContentLoaded zaten tekrar uygular + buton ikonunu kurar. -->
    <script>(function(){try{if(localStorage.getItem('theme')==='light'){document.body.classList.add('light-theme');}}catch(e){}})();</script>
    <div class="container">
        <!-- Main Workspace -->
        <div class="main-content" style="position: relative;">
            <div class="header">
                <div class="header-controls">
                    <button class="theme-toggle-btn" onclick="toggleTheme()" id="theme-btn" title="Temayı değiştir"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3.2"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/></svg></button>
                    <div class="ext-status-box ext-err" id="ext-status-box" onclick="onExtStatusClick()"><svg viewBox="0 0 10 10" fill="currentColor"><circle cx="5" cy="5" r="4"/></svg>Eklenti yok</div>
                </div>
                <h1><span class="emoji"><svg width="30" height="30" viewBox="0 0 32 32" style="display:block" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="7" fill="#1d9bf0"/><g fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12V9h3"/><path d="M20 9h3v3"/><path d="M23 20v3h-3"/><path d="M12 23H9v-3"/><path d="M13 13l6 6M19 13l-6 6"/></g></svg></span><span class="title-text">GörüntüX</span></h1>
                <p>Gönderi tarama, Word çıktısı üretme ve rapor biçimlendirme arayüzü</p>
            </div>

            <!-- Tab Buttons -->
            <div class="tabs">
                <!-- Sıra değişti (kullanıcı isteği): Raporlarım ÖNCE ve varsayılan (açılış) sekmesi. İç id'ler
                     (tab-format / tab-auto) AYNEN korundu; yalnız görünen sıra + varsayılan 'active' değişti. -->
                <button class="tab-btn active" data-tab="tab-format" onclick="switchTab('tab-format')"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2a1 1 0 0 1 1-1h3.1l1.3 1.6h7.6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1z"/></svg> Raporlarım<span id="saved-count-badge" class="tab-count-badge" style="display: none;">0</span></button>
                <button class="tab-btn" data-tab="tab-auto" onclick="switchTab('tab-auto')"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l1.5 3.6 3.6 1.4-3.6 1.5-1.5 3.6-1.5-3.6L5.4 7.5l3.6-1.4z"/><path d="M5 12.5l.8 1.9 1.9.8-1.9.8L5 18l-.8-1.9L2.3 15.3l1.9-.9z"/></svg> Rapor'matik</button>
            </div>

            <!-- Tab 1: Format Docx -->
            <div id="tab-format" class="tab-content active">
                <!-- Kayıtlı Raporlar (yerel, çoklu, 1 hafta). Görünürlüğünü renderSavedReports() yönetir;
                     kayıt yoksa gizli. v4.0'da bu sekmenin ÜSTÜNE taşındı (Word aracı altta). -->
                <div id="saved-reports-section" class="card" style="display: none; margin-bottom: 24px;">
                    <div id="saved-reports-list"></div>
                </div>

                <!-- Seçim eylem çubuğu: rapor(lar) işaretlenince alttan belirir (Birleştir/İndir/Sil). -->
                <div id="x-secim-bar" class="x-secim-bar">
                    <span class="x-secim-sayi" id="x-secim-sayi">0 seçili</span>
                    <button class="x-secim-btn" id="x-secim-birlestir" onclick="mergeSelectedReports()" title="Seçili raporları tek rapora birleştir (tekrarlar elenir)"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5a3 3 0 0 0 4.24.17l2.3-2.3a3 3 0 0 0-4.24-4.24l-1.1 1.1"/><path d="M11.5 8.5a3 3 0 0 0-4.24-.17l-2.3 2.3a3 3 0 0 0 4.24 4.24l1.1-1.1"/></svg> Birleştir</button>
                    <button class="x-secim-btn" onclick="downloadSelectedReports()" title="Seçili raporların Word dosyalarını indir"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v10"/><path d="M6 9.5l4 3.5 4-3.5"/><path d="M4.5 16.5h11"/></svg> İndir</button>
                    <button class="x-secim-btn danger" onclick="deleteSelectedReports()" title="Seçili raporları sil"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6h11"/><path d="M8 6V4.5h4V6"/><path d="M6 6l.7 10h6.6L14 6"/><path d="M8.6 9v4M11.4 9v4"/></svg> Sil</button>
                    <button class="x-secim-kapat" onclick="xSecimTemizle()" title="Seçimi temizle">✕</button>
                </div>

                <!-- EMEKLİ (kullanıcı isteği): "Mevcut Bir Word Dosyasını Yeniden Biçimlendirin" paneli
                     gizlendi. Kod + /api/upload/format ucu arka planda DURUYOR; yalnız UI'da görünmüyor. -->
                <div class="card" style="display: none;">
                    <h3 id="word-arac-baslik" onclick="xToggleWordArac()" style="margin: 0; cursor: pointer; display: flex; align-items: center; gap: 8px; user-select: none;">
                        <span id="word-arac-ok" style="display: inline-block; transition: transform 0.2s ease; font-size: 14px;">▸</span>
                        Mevcut Bir Word Dosyasını Yeniden Biçimlendirin
                    </h3>
                    <div id="word-arac-govde" style="display: none; margin-top: 14px;">
                    <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 20px;">
                        Taranan tweetlerin bulunduğu .docx dosyasını buraya yükleyin. Tasarım ayarları dosyadaki tüm tweet başlıklarına ve linklerine otomatik uygulanacaktır.
                    </p>
                    
                    <div class="file-dropzone" onclick="document.getElementById('doc_file').click()" id="dropzone">
                        <svg viewBox="0 0 24 24">
                            <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
                        </svg>
                        <p style="margin: 0; font-weight: 500;">Dosyayı buraya sürükleyin veya tıklayarak seçin</p>
                        <p style="margin: 6px 0 0 0; font-size: 12px; color: var(--text-secondary);">Yalnızca .docx formatı desteklenir</p>
                        <div class="file-name-display" id="file-name-text"></div>
                    </div>
                    <input type="file" id="doc_file" accept=".docx" onchange="fileSelected(this)" multiple style="display: none;">

                    <div style="display: flex; gap: 15px; margin-top: 20px;">
                        <button class="btn btn-block" style="flex: 1; margin: 0;" onclick="submitMod1(false)">💾 Kaydet ve İndir</button>
                        <button class="btn btn-block btn-success" style="flex: 1; margin: 0; background: var(--accent-color);" onclick="submitMod1(true)">👁️ Önizle</button>
                    </div>

                    <!-- Tab 1 Progress Area -->
                    <div class="progress-container" id="format-progress-area" style="display: none; margin-top: 20px;">
                        <div class="progress-label">
                            <span id="format-progress-text">Dosya biçimlendiriliyor...</span>
                            <span id="format-progress-percent">0%</span>
                        </div>
                        <div class="progress-bar-bg">
                            <div class="progress-bar-fill" id="format-progress-fill" style="width: 0%;"></div>
                        </div>
                        <div style="text-align: center; margin-top: 8px; font-size: 13px; color: var(--text-secondary, #8899a6);">
                            <span id="format-timer">⏱ 00:00</span>
                        </div>
                    </div>
                    </div><!-- /word-arac-govde -->
                </div>
                <div id="format-stats-container" style="display: none; margin-top: 24px;"></div>
            </div>

            <!-- Tab 2: Manual Content -->
            <div id="tab-manual" class="tab-content">
                <div class="card">
                    <h3>Çoklu İçerik Giriş Havuzu</h3>
                    <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 20px;">
                        Raporunuza görsel ve başlıkları sıfırdan ekleyin. Aşağıdaki alana görsel sürükleyebilir, seçebilir veya panonuzdaki görseli doğrudan yapıştırabilirsiniz.
                    </p>

                    <div class="form-group">
                        <label for="m_baslik">1. Başlık Metni (Opsiyonel):</label>
                        <input type="text" id="m_baslik" placeholder="Bu içeriğin başlığını yazın...">
                    </div>
                    
                    <div class="form-group">
                        <label for="m_link">2. Gönderi / Web Linki (Opsiyonel):</label>
                        <input type="text" id="m_link" placeholder="x.com/... · instagram.com/p/... · facebook.com/.../posts/...">
                    </div>

                    <!-- Image Input Dropzone (Google Image Search style) -->
                    <div class="form-group">
                        <label>3. Görsel Ekle (Klasörden Seç, Sürükle-Bırak veya Ctrl+V Yap):</label>
                        <div class="file-dropzone" onclick="document.getElementById('m_image_file').click()" id="manual_dropzone">
                            <svg viewBox="0 0 24 24" style="fill: var(--accent-color); width: 36px; height: 36px; margin-bottom: 8px;">
                                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
                            </svg>
                            <p style="margin: 0; font-weight: 500;">Görseli buraya sürükleyin, tıklayarak seçin veya Ctrl+V yapın</p>
                            <p style="margin: 6px 0 0 0; font-size: 11px; color: var(--text-secondary);">Desteklenen formatlar: PNG, JPG, JPEG, GIF</p>
                            <div class="file-name-display" id="manual-file-name-text"></div>
                        </div>
                        <input type="file" id="m_image_file" accept="image/*" onchange="manualFileSelected(this)" style="display: none;">
                    </div>

                    <!-- Hidden input to receive base64 image data -->
                    <input type="hidden" id="hidden_clipboard_data">

                    <!-- Paste preview container -->
                    <div class="preview-box" id="clipboard_preview">
                        <img id="clipboard_preview_img" class="preview-img" src="" alt="Önizleme">
                        <div>
                            <div style="font-size: 13px; font-weight: 600; color: var(--success-color);">Görsel algılandı!</div>
                            <div style="font-size: 11px; color: var(--text-secondary);">Listeye eklemek için aşağıdaki butona basın.</div>
                        </div>
                    </div>

                    <button class="btn btn-block btn-success" style="margin-bottom: 20px;" onclick="addManualContent()">➕ İçeriği Listeye Ekle</button>
                </div>
            </div>

            <!-- Tab 3: Automation -->
            <div id="tab-auto" class="tab-content">
                <!-- Mobilde eklenti çalışmadığından YALNIZ bu sekme "Masaüstü Gerekli" gösterir; gerçek
                     tarama içeriği (#auto-desktop-content) html.x-mobile CSS'iyle gizlenir. Diğer sekmeler
                     mobilde çalışır. -->
                <div id="auto-mobile-block" style="display:none; text-align:center; padding:56px 24px;">
                    <div style="font-size:66px; line-height:1; margin-bottom:22px;">💻</div>
                    <h3 style="font-size:22px; font-weight:700; color:var(--text-primary); margin:0 0 16px;">Masaüstü Bilgisayar Gerekli</h3>
                    <p style="max-width:470px; margin:0 auto; font-size:14px; line-height:1.75; color:var(--text-secondary);">
                        <b>GörüntüX</b>'in otomatik tarama işlemleri bir <b>tarayıcı eklentisine</b> ihtiyaç duyar. Mobil cihazlar eklenti desteğine sahip olmadığından, bu bölümü yalnızca bilgisayarınızdaki bir masaüstü tarayıcıdan (Chrome, Edge, Brave vb.) kullanabilirsiniz.<br><br>
                        <b>Manuel Rapor Hazırla</b> ve <b>Kayıtlı Raporlar</b> sekmeleri mobilde de çalışır.
                    </p>
                </div>
                <div class="card" id="auto-desktop-content">
                    <h3 class="x-shead"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l1.5 3.6 3.6 1.4-3.6 1.5-1.5 3.6-1.5-3.6L5.4 7.5l3.6-1.4z"/><path d="M5 12.5l.8 1.9 1.9.8-1.9.8L5 18l-.8-1.9L2.3 15.3l1.9-.9z"/></svg>Eklenti ile Otomatik Rapor Üretme</h3>
                    <p style="color: var(--text-secondary); font-size: 13px; margin-bottom: 20px;">
                        Chrome tarayıcınıza yükleyeceğiniz <b>GörüntüX</b> eklentisi ile birlikte çalışır. Linkleri yapıştırdıktan sonra eklenti gönderileri tek tek ziyaret ederek ekran görüntülerini otomatik olarak çeker.
                    </p>

                    <!-- Oturum hatırlatması (kullanıcı isteği): kapatılabilir; localStorage ile bir kez
                         kapatılınca çıkmaz (xInitLoginReminder gösterir). Metin HEM tarama HEM eklenti
                         "Rapora Ekle"yi kapsar. Yalnız Otomatik sekmesinde. -->
                    <div id="login-reminder" style="display:none; background: rgba(255,176,32,0.1); border:1px solid rgba(255,176,32,0.3); color:#ffb020; border-radius:12px; padding:12px 40px 12px 14px; margin-bottom:18px; font-size:13px; line-height:1.55; position:relative;">
                        🔐 <b>Oturum hatırlatması:</b> Ekran görüntülerinin eksiksiz ve doğru alınabilmesi için ekleyeceğiniz platformlarda (<b>X, Instagram, Facebook, TikTok</b>) bu tarayıcıda <b>oturumunuz AÇIK</b> olmalıdır (YouTube için gerekmez).<br>
                        • <b>Başlat (tarama):</b> eklenti linkleri tek tek ziyaret ederken oturum kapalıysa giriş duvarına takılır, görüntü alınamaz.<br>
                        • <b>Eklenti (&quot;Rapora Ekle&quot;):</b> görüntüsünü aldığınız sosyal medya sayfasında da oturumunuz açık olmalı; kapalıysa gönderi eksik/yanlış kadrajlanabilir.
                        <span onclick="dismissLoginReminder()" title="Kapat" style="position:absolute; top:8px; right:12px; cursor:pointer; font-size:20px; line-height:1; color:#ffb020;">&times;</span>
                    </div>

                    <div class="form-group" id="links-input-group">
                        <label for="tweet_links_input">Taranacak Gönderi Linkleri (Her Satıra Bir Link):</label>
                        <textarea id="tweet_links_input" style="height: 38px; min-height: 38px; max-height: 38px; resize: none; overflow-y: hidden; line-height: 24px; padding: 6px 12px;" placeholder="X, Instagram veya Facebook linklerini buraya yapıştırın (Her satıra bir link)..."></textarea>
                    </div>

                    <!-- Canlı Link Önizleme ve Silme Alanı -->
                    <div id="links-preview-area" style="display: none; margin-bottom: 20px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 14px; background: rgba(29, 155, 240, 0.05);">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                            <h5 style="margin: 0; font-size: 14px; font-weight: 600; color: #e7e9ea;">📋 Taranacak Gönderiler</h5>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <button type="button" onclick="clearInputLinks()" style="background: rgba(224, 36, 94, 0.1); border: 1px solid rgba(224, 36, 94, 0.2); color: var(--danger-color, #e0245e); font-size: 11px; padding: 2px 8px; border-radius: 6px; cursor: pointer; font-weight: 600; transition: all 0.2s;">Temizle</button>
                                <span id="links-preview-count" style="font-size: 12px; font-weight: bold; background: var(--accent-color, #1d9bf0); color: white; padding: 2px 8px; border-radius: 10px;">0 adet</span>
                            </div>
                        </div>
                        <div id="links-preview-list" style="max-height: 500px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding-right: 4px;">
                            <!-- JS ile doldurulacak -->
                        </div>
                    </div>

                    <div style="display: flex; gap: 15px;" id="auto-action-buttons">
                        <!-- Eklenti ESKI ise refreshStatus bunu disabled yapar. Kapsayicinin
                             (auto-action-buttons) GORUNURLUGUNU tarama durumu yonetiyor -> ona
                             dokunulmaz, yalnizca butonun kendisi kilitlenir. -->
                        <button class="btn" style="flex: 1;" id="auto-start-btn" onclick="startAutomation()"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5c2.8 1.2 4.5 4 4.5 7.5 0 1.3-.3 2.5-.3 2.5H5.8s-.3-1.2-.3-2.5c0-3.5 1.7-6.3 4.5-7.5z"/><circle cx="10" cy="8" r="1.4"/><path d="M5.8 12.5l-2 2.2M14.2 12.5l2 2.2M8.3 15.5s-.3 1.8 1.7 2.5c2-.7 1.7-2.5 1.7-2.5z"/></svg> Başlat</button>
                    </div>

                    <div class="progress-container" id="progress-area" style="display: none;">
                        <div class="progress-label" id="progress-label-container">
                            <span id="progress-text">İlerleme: 0 / 0 tweet</span>
                            <span id="progress-percent">0%</span>
                        </div>
                        <div class="progress-bar-bg" id="progress-bar-container">
                            <div class="progress-bar-fill" id="progress-fill"></div>
                        </div>
                        <div style="text-align: center; margin-top: 8px; font-size: 13px; color: var(--text-secondary, #8899a6);">
                            <span id="automation-timer">⏱ 00:00</span>
                        </div>
                        <div id="stop-button-container" style="text-align: center; margin-top: 15px; display: none;">
                            <button class="btn btn-danger-action" onclick="stopAutomation()" style="background: rgba(224, 36, 94, 0.1); border: 1px solid rgba(224, 36, 94, 0.3); color: var(--danger-color); padding: 10px 24px; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.2s ease; width: 100%;">🛑 Taramayı Durdur / İptal Et</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Not: Eski kalıcı "Aktif rapor çubuğu" KALDIRILDI (kullanıcı isteği). Aktif rapor + oto-kayıt
                 durumu artık yalnız sağ-alt anlık toast ile bildirilir; aktif rapor Raporlarım'da "● Açık"
                 rozetiyle ve adres çubuğundaki /<slug> ile görünür. -->

            <!-- Unified List Section -->
            <div id="manual-list-section" style="display: none; margin-top: 24px;">
                <div class="card">
                    <h4 class="x-shead" style="margin: 0 0 12px 0;" id="manual-list-title"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="4" width="11" height="13" rx="1.5"/><path d="M7.5 4V2.8h5V4"/><path d="M7.5 8.5h5M7.5 11.5h5M7.5 14.5h3"/></svg>Havuzda Bekleyen Rapor İçerikleri</h4>
                    
                    <div class="items-list" id="manual-items-container">
                        <!-- Dynamically loaded items will go here -->
                    </div>

                    <div class="pool-actions">
                        <button id="save-btn" class="x-havuz-btn" style="display: none;" onclick="savePoolReport()" title="Raporu isimle panele kaydet (havuz commit edilir ve sıfırlanır). İndirmez."><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3.5h8l3 3v9.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z"/><path d="M7 3.5v4h5v-4"/><path d="M7 17v-5h6v5"/></svg> Kaydet</button>
                        <button id="download-btn" class="x-havuz-btn" onclick="downloadPoolReport()" title="Havuzdan .docx üret ve indir (kaydetmez, havuzu korur)."><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v10"/><path d="M6 9.5l4 3.5 4-3.5"/><path d="M4.5 16.5h11"/></svg> İndir</button>
                        <button class="x-havuz-btn" onclick="generateManualWord(true)" title="Raporu düzenleyici önizlemede aç"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10z"/><circle cx="10" cy="10" r="2.4"/></svg> Önizle</button>
                        <button class="x-havuz-btn danger" onclick="clearManualList()" title="Havuzdaki tüm içeriği sil (sıfırla)"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6h11"/><path d="M8 6V4.5h4V6"/><path d="M6 6l.7 10h6.6L14 6"/><path d="M8.6 9v4M11.4 9v4"/></svg> Sıfırla</button>
                        <button class="x-havuz-btn" onclick="raporuKapat()" title="Açık raporu silmeden kapat (Raporlarım'da durur)"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M6.8 10.2l2.2 2.2 4.2-4.6"/></svg> Kapat</button>
                    </div>
                </div>
            </div>

            <!-- Kayıtlı Raporlar bölümü "Kayıtlı Raporlar" sekmesinin (tab-format) İÇİNE taşındı (v4.0). -->
        </div>
    </div>

    <!-- Style Settings Modal -->
    <!-- Faz 7: "Stil Ayarları" editör şeridine taşındı. Burası artık GÖRÜNMEZ stil DEPOSU:
         b1_/b_/l_/m_ <input>'ları burada yaşar -> xBuildStyleOpts okur, editör şeridi yazar,
         xInitStyles/xSaveStyles localStorage ile eşler. Ayrı modal/buton YOK (kullanıcı: tam emeklilik). -->
    <div id="styleModal" style="display:none" aria-hidden="true">
            <div class="modal-body">
                <h3 class="x-shead"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3.5h6l7 7-6 6-7-7z"/><circle cx="6.5" cy="6.5" r="1"/></svg>Platform Adı Stili (Platform Ayracı)</h3>
                <div style="font-size: 11px; color: var(--text-secondary); margin: 4px 0 10px; line-height: 1.4;">
                    Yalnızca çıktıda <b>birden fazla platform</b> varsa görünür: gönderiler
                    "X (Twitter)", "Instagram" ve "Facebook" başlıklarıyla ayrılır
                    (havuzda ilk görünen platform önce). Tek platform varsa kullanılmaz.
                </div>
                <div class="form-group">
                    <label for="b1_font">Yazı Tipi (Font):</label>
                    <select id="b1_font">
                        {% for font in fonts %}
                        <option value="{{ font }}" {% if font == 'Arial' %}selected{% endif %}>{{ font }}</option>
                        {% endfor %}
                    </select>
                </div>
                <div class="form-group">
                    <label for="b1_size">Yazı Boyutu (PT):</label>
                    <input type="number" id="b1_size" value="18" min="12" max="36">
                </div>
                <div class="form-group">
                    <label for="b1_color">Metin Rengi:</label>
                    <input type="text" id="b1_color" value="#000000" placeholder="#000000">
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="b1_bold" checked>
                    <label for="b1_bold">Kalın (Bold)</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="b1_italic">
                    <label for="b1_italic">Eğik (Italic)</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="b1_underline">
                    <label for="b1_underline">Altı Çizili</label>
                </div>
                <div class="form-group">
                    <label for="b1_align">Hizalama:</label>
                    <select id="b1_align">
                        <option value="left" selected>Sola</option>
                        <option value="center">Ortaya</option>
                        <option value="right">Sağa</option>
                        <option value="both">İki yana</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="b1_wordstyle">Word Başlık Türü:</label>
                    <select id="b1_wordstyle">
                        <option value="Heading1" selected>Başlık 1</option>
                        <option value="Heading2">Başlık 2</option>
                        <option value="Heading3">Başlık 3</option>
                        <option value="Heading4">Başlık 4</option>
                        <option value="Normal">Normal</option>
                    </select>
                </div>

                <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 15px 0;">

                <h3 class="x-shead"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4.5v11M13 4.5v11M5 10h8"/></svg>Başlık Stili</h3>
                <div class="form-group">
                    <label for="b_font">Yazı Tipi (Font):</label>
                    <select id="b_font">
                        {% for font in fonts %}
                        <option value="{{ font }}" {% if font == 'Arial' %}selected{% endif %}>{{ font }}</option>
                        {% endfor %}
                    </select>
                </div>
                <div class="form-group">
                    <label for="b_size">Yazı Boyutu (PT):</label>
                    <input type="number" id="b_size" value="16" min="10" max="28">
                </div>
                <div class="form-group">
                    <label for="b_color">Metin Rengi:</label>
                    <input type="text" id="b_color" value="#000000" placeholder="#000000">
                </div>
                
                <div class="checkbox-group">
                    <input type="checkbox" id="b_bold" checked>
                    <label for="b_bold">Kalın (Bold)</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="b_italic">
                    <label for="b_italic">Eğik (Italic)</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="b_underline">
                    <label for="b_underline">Altı Çizili</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="b_numbered">
                    <label for="b_numbered">Otomatik Numaralandır (1, 2...)</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="b_basliksiz">
                    <label for="b_basliksiz">Başlıksız (bu başlık Word'de basılmaz)</label>
                </div>
                <div class="form-group">
                    <label for="b_align">Hizalama:</label>
                    <select id="b_align">
                        <option value="left" selected>Sola</option>
                        <option value="center">Ortaya</option>
                        <option value="right">Sağa</option>
                        <option value="both">İki yana</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="b_wordstyle">Word Başlık Türü:</label>
                    <select id="b_wordstyle">
                        <option value="Heading1">Başlık 1</option>
                        <option value="Heading2" selected>Başlık 2</option>
                        <option value="Heading3">Başlık 3</option>
                        <option value="Heading4">Başlık 4</option>
                        <option value="Normal">Normal</option>
                    </select>
                </div>

                <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 15px 0;">

                <h3 class="x-shead"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5a3 3 0 0 0 4.24.17l2.3-2.3a3 3 0 0 0-4.24-4.24l-1.1 1.1"/><path d="M11.5 8.5a3 3 0 0 0-4.24-.17l-2.3 2.3a3 3 0 0 0 4.24 4.24l1.1-1.1"/></svg>Gönderi Linki Stili</h3>
                <div class="form-group">
                    <label for="l_font">Yazı Tipi (Font):</label>
                    <select id="l_font">
                        {% for font in fonts %}
                        <option value="{{ font }}" {% if font == 'Arial' %}selected{% endif %}>{{ font }}</option>
                        {% endfor %}
                    </select>
                </div>
                <div class="form-group">
                    <label for="l_size">Yazı Boyutu (PT):</label>
                    <input type="number" id="l_size" value="12" min="8" max="18">
                </div>
                <div class="form-group">
                    <label for="l_color">Link Rengi:</label>
                    <input type="text" id="l_color" value="#1565c0" placeholder="#1565c0">
                </div>
                
                <div class="checkbox-group">
                    <input type="checkbox" id="l_bold">
                    <label for="l_bold">Kalın (Bold)</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="l_italic">
                    <label for="l_italic">Eğik (Italic)</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="l_underline" checked>
                    <label for="l_underline">Altı Çizili</label>
                </div>
                <div class="form-group">
                    <label for="l_align">Hizalama:</label>
                    <select id="l_align">
                        <option value="left" selected>Sola</option>
                        <option value="center">Ortaya</option>
                        <option value="right">Sağa</option>
                        <option value="both">İki yana</option>
                    </select>
                </div>

                <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 15px 0;">

                <h3 class="x-shead"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6V4.5h12V6"/><path d="M10 4.5v11"/><path d="M7.5 15.5h5"/></svg>Eklenen Metin Stili</h3>
                <div style="font-size: 11px; color: var(--text-secondary); margin: 4px 0 10px; line-height: 1.4;">
                    Editörde <b>görsellerin altına</b> eklediğiniz serbest metinlere uygulanır.
                </div>
                <div class="form-group">
                    <label for="m_font">Yazı Tipi (Font):</label>
                    <select id="m_font">
                        {% for font in fonts %}
                        <option value="{{ font }}" {% if font == 'Arial' %}selected{% endif %}>{{ font }}</option>
                        {% endfor %}
                    </select>
                </div>
                <div class="form-group">
                    <label for="m_size">Yazı Boyutu (PT):</label>
                    <input type="number" id="m_size" value="12" min="8" max="28">
                </div>
                <div class="form-group">
                    <label for="m_color">Metin Rengi:</label>
                    <input type="text" id="m_color" value="#000000" placeholder="#000000">
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="m_bold">
                    <label for="m_bold">Kalın (Bold)</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="m_italic">
                    <label for="m_italic">Eğik (Italic)</label>
                </div>
                <div class="checkbox-group">
                    <input type="checkbox" id="m_underline">
                    <label for="m_underline">Altı Çizili</label>
                </div>
                <div class="form-group">
                    <label for="m_align">Hizalama:</label>
                    <select id="m_align">
                        <option value="left" selected>Sola</option>
                        <option value="center">Ortaya</option>
                        <option value="right">Sağa</option>
                        <option value="both">İki yana</option>
                    </select>
                </div>
                <!-- [SATIR ARALIĞI] Editör şeridinden (Metin grubu) ayarlanır; burada yalnız kalıcılık/okuma için gizli backing. Çıktı (Word) satır aralığı + paragraf önce/sonra boşluğu. -->
                <input type="hidden" id="m_line" value="1.0">
                <input type="checkbox" id="m_space_before" style="display:none">
                <input type="checkbox" id="m_space_after" style="display:none">
                <input type="hidden" id="b_after" value="6">   <!-- [BAŞLIK–PARAGRAF] başlık–paragraf boşluğu (pt); şeritte Başlık grubundan ayarlanır -->
                <!-- [SAYFA NO] Üst çubuk "Sayfa no" menüsünden ayarlanır; burada yalnız kalıcılık için gizli backing. Yalnız Word çıktısı. -->
                <input type="checkbox" id="pn_on" style="display:none">
                <input type="hidden" id="pn_pos" value="footer">
                <input type="hidden" id="pn_align" value="right">
                <input type="hidden" id="pn_fmt" value="plain">

                <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 15px 0;">

                <h3 class="x-shead"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 13l4-4 3 3 3-3 4 4"/><circle cx="7.5" cy="8" r="1.1"/></svg>Görsel</h3>
                <div style="font-size: 11px; color: var(--text-secondary); margin: 4px 0 10px; line-height: 1.4;">
                    Rapordaki tüm görsellere uygulanır. Tek bir görseli ayrı hizalamak için editörde o görsele <b>sağ tıklayın</b>.
                </div>
                <div class="form-group">
                    <label for="g_align">Hizalama:</label>
                    <select id="g_align">
                        <option value="left" selected>Sola</option>
                        <option value="center">Ortaya</option>
                        <option value="right">Sağa</option>
                    </select>
                </div>
            </div>
    </div>

    <!-- Eklenti indirme + kullanma kılavuzu modalı. Yalnız durum kutusu KIRMIZI/SARI iken açılır. -->
    <div id="extModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 class="x-shead"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7.3 3.2a1.6 1.6 0 0 1 3.2 0c0 .4-.1.8-.2 1.3h3v3c.5-.1.9-.2 1.3-.2a1.6 1.6 0 0 1 0 3.2c-.4 0-.8-.1-1.3-.2v3.4h-3.4c.1-.5.2-.9.2-1.3a1.6 1.6 0 0 0-3.2 0c0 .4.1.8.2 1.3H3.5v-3c-.5.1-.9.2-1.3.2a1.6 1.6 0 0 1 0-3.2c.4 0 .8.1 1.3.2v-3h3c-.1-.5-.2-.9-.2-1.3z"/></svg>GörüntüX Eklentisi</h2>
                <span class="close-btn" onclick="closeExtModal()">&times;</span>
            </div>
            <div class="modal-body">
                <!-- Eklenti ESKI iken (sarı durum) gösterilir; openExtModal doldurur. -->
                <div id="ext-modal-warning" style="display: none; background: rgba(255, 176, 32, 0.12); border: 1px solid rgba(255, 176, 32, 0.35); color: #ffb020; border-radius: 12px; padding: 12px 14px; margin-bottom: 18px; font-size: 13px; line-height: 1.5; font-weight: 600;"></div>
                <div style="text-align: center; margin-bottom: 22px;">
                    <a href="/api/extension/download_zip" class="btn btn-primary" style="display: inline-flex; align-items: center; gap: 8px; font-size: 14px;"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v10"/><path d="M6 9.5l4 3.5 4-3.5"/><path d="M4.5 16.5h11"/></svg> Eklentiyi İndir (.zip)</a>
                </div>
                <h3 class="x-shead" style="margin: 0 0 10px;"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5.5S8.5 4 4 4v11c4.5 0 6 1.5 6 1.5S11.5 15 16 15V4c-4.5 0-6 1.5-6 1.5z"/><path d="M10 5.5v11"/></svg>Kurulum ve Kullanım Kılavuzu</h3>
                <ol style="font-size: 13px; line-height: 1.75; color: var(--text-secondary); padding-left: 20px; margin: 0;">
                    <li><b>İndir:</b> Yukarıdaki <b>Eklentiyi İndir</b> ile <code>x-word.zip</code> iner. Sabit bir klasöre çıkar (ör. Masaüstü/GörüntüX). <b>Klasörü taşıma ya da silme</b> — Chrome eklentiyi bu klasör yolundan tanır.</li>
                    <li><b>Kur (ilk kez):</b> Chrome'da <code>chrome://extensions</code> aç → sağ üstten <b>Geliştirici modu</b>'nu aç → <b>Paketlenmemiş öğe yükle</b> → çıkardığın klasörü seç. GörüntüX listeye eklenir.</li>
                    <li><b>Güncelle (yeni sürüm çıkınca):</b> Yeni .zip'i <b>aynı klasörün üzerine</b> çıkar → <code>chrome://extensions</code>'ta GörüntüX kartındaki <b>↻ (yenile)</b> düğmesine bas → açık bir X sekmen varsa <b>F5</b> ile yenile.</li>
                    <li><b>Kullan:</b> Bir gönderi sayfasında (X, Instagram, Facebook, TikTok, YouTube) sağ alttaki <b>Rapora Ekle</b> ile havuza ekle; ya da bu panele link yapıştırıp <b>Başlat</b> ile otomatik taramayı çalıştır.</li>
                </ol>
            </div>
        </div>
    </div>

    <!-- Toast Notifications Container -->
    <div id="toast-container" style="position: fixed; bottom: 24px; right: 24px; z-index: 9999; display: flex; flex-direction: column; gap: 10px; max-width: 350px; pointer-events: none;"></div>

    <script>
        // Official Twitter (X) Widgets Bootstrapper
        window.twttr = (function(d, s, id) {
            var js, fjs = d.getElementsByTagName(s)[0],
                t = window.twttr || {};
            if (d.getElementById(id)) return t;
            js = d.createElement(s);
            js.id = id;
            js.src = "https://platform.twitter.com/widgets.js";
            fjs.parentNode.insertBefore(js, fjs);
            t._e = [];
            t.ready = function(f) {
                t._e.push(f);
            };
            return t;
        }(document, "script", "twitter-wjs"));

        // Initialize client UUID with fallback
        function generateUUID() {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                return crypto.randomUUID();
            }
            return 'xxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        }
        if (!localStorage.getItem('x_client_id')) {
            localStorage.setItem('x_client_id', generateUUID());
        }
        const xClientId = localStorage.getItem('x_client_id');

        // Global fetch interceptor to append client_id to all api requests
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
            let url = typeof input === 'string' ? input : input.url;
            if (url.startsWith('/') || url.includes(window.location.host)) {
                const delimiter = url.includes('?') ? '&' : '?';
                url = url + delimiter + 'client_id=' + xClientId;
                if (typeof input === 'string') {
                    input = url;
                } else {
                    input = new Request(url, input);
                }
            }
            return originalFetch.call(this, input, init);
        };

        // Global caching state to prevent image flashing
        window.lastManuelListJson = null;

        // Tab switching (Global scope)
        function switchTab(tabId) {
            var buttons = document.querySelectorAll('.tab-btn');
            var contents = document.querySelectorAll('.tab-content');
            
            buttons.forEach(function(btn) { btn.classList.remove('active'); });
            contents.forEach(function(content) { content.classList.remove('active'); });
            
            var activeBtn = document.querySelector('[data-tab="' + tabId + '"]');
            var activeContent = document.getElementById(tabId);
            
            if (activeBtn) activeBtn.classList.add('active');
            if (activeContent) activeContent.classList.add('active');

            // Raporlarım'dan ayrılınca rapor seçimini (ve alt çubuğu) temizle -> çubuk başka sekmede takılı kalmasın.
            if (tabId !== 'tab-format' && typeof xSecimTemizle === 'function') { try { xSecimTemizle(); } catch (e) {} }

            refreshStatus();
        }

        // Faz 7: toggleStyleModal KALDIRILDI (styleModal artık görünmez depo; stil editör şeridinde).

        // Eklenti durum kutusu: yalnız KIRMIZI/SARI (window.extBoxClickable) iken modal açılır.
        // YEŞİL (hazır) iken tıklanamaz -> indirme butonu/kılavuz gösterilmez.
        function onExtStatusClick() {
            if (window.extBoxClickable) { openExtModal(); }
        }
        function openExtModal() {
            const m = document.getElementById('extModal');
            if (!m) { return; }
            // Eklenti ESKI ise (sarı durum) dinamik güncelleme uyarısını göster (eski ext-version-warning
            // metninin karşılığı). KIRMIZI (kurulu değil) durumda güncelleme değil kurulum söz konusu -> gizle.
            const uyari = document.getElementById('ext-modal-warning');
            if (uyari) {
                if (window.extensionOutdated) {
                    const kur = window.extensionInstalledVersion || '?';
                    const son = window.extensionLatestVersion || '?';
                    uyari.innerHTML = '&#9888;&#65039; Eklentiniz güncel değil — kurulu <b>v' + kur
                        + '</b>, en güncel <b>v' + son + '</b>. Tarama bu sürümle başlatılamaz. '
                        + 'Aşağıdaki <b>Güncelle</b> adımıyla yeni sürüme geçin (.zip\\'i indir → aynı klasörün '
                        + 'üzerine aç → <code>chrome://extensions</code>\\'ta &#8635; yenile → X sekmesini F5).';
                    uyari.style.display = 'block';
                } else {
                    uyari.style.display = 'none';
                }
            }
            m.classList.add('active');
        }
        function closeExtModal() {
            const m = document.getElementById('extModal');
            if (m) { m.classList.remove('active'); }
        }

        // Close modals when clicking outside of them
        window.addEventListener('click', function(event) {
            const extModal = document.getElementById('extModal');
            if (event.target === extModal) {
                extModal.classList.remove('active');
            }
        });

        // Theme Toggle Functionality
        // Tema ikonları (tek-renk SVG). Koyu modda GÜNEŞ (açığa geç), açık modda AY (koyuya geç).
        var _XSVG_GUNES = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3.2"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/></svg>';
        var _XSVG_AY = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 11.5A6.5 6.5 0 0 1 8.5 4a6.5 6.5 0 1 0 7.5 7.5z"/></svg>';
        function toggleTheme() {
            try {
                const body = document.body;
                const btn = document.getElementById('theme-btn');
                if (body.classList.contains('light-theme')) {
                    body.classList.remove('light-theme');
                    if (btn) { btn.innerHTML = _XSVG_GUNES; btn.title = 'Açık temaya geç'; }
                    try {
                        localStorage.setItem('theme', 'dark');
                    } catch(e) {}
                } else {
                    body.classList.add('light-theme');
                    if (btn) { btn.innerHTML = _XSVG_AY; btn.title = 'Koyu temaya geç'; }
                    try {
                        localStorage.setItem('theme', 'light');
                    } catch(e) {}
                }
            } catch(err) {
                console.error("toggleTheme error:", err);
            }
        }

        // Initialize event listeners after DOM is fully loaded
        document.addEventListener('DOMContentLoaded', function() {
            // Restore saved theme
            try {
                const savedTheme = localStorage.getItem('theme');
                const body = document.body;
                const themeBtn = document.getElementById('theme-btn');
                if (savedTheme === 'light') {
                    body.classList.add('light-theme');
                    if (themeBtn) { themeBtn.innerHTML = _XSVG_AY; themeBtn.title = 'Koyu temaya geç'; }
                } else {
                    body.classList.remove('light-theme');
                    if (themeBtn) { themeBtn.innerHTML = _XSVG_GUNES; themeBtn.title = 'Açık temaya geç'; }
                }
            } catch(e) {
                console.error("Theme restore error:", e);
            }

            const dropzone = document.getElementById('dropzone');
            
            if (dropzone) {
                ['dragenter', 'dragover'].forEach(eventName => {
                    dropzone.addEventListener(eventName, e => {
                        e.preventDefault();
                        dropzone.classList.add('dragover');
                    }, false);
                });

                ['dragleave', 'drop'].forEach(eventName => {
                    dropzone.addEventListener(eventName, e => {
                        e.preventDefault();
                        dropzone.classList.remove('dragover');
                    }, false);
                });

                dropzone.addEventListener('drop', e => {
                    const dt = e.dataTransfer;
                    const files = dt.files;
                    if (files.length > 0) {
                        const allDocx = Array.from(files).every(f => f.name.endsWith('.docx'));
                        if (allDocx) {
                            const fileInput = document.getElementById('doc_file');
                            if (fileInput) {
                                fileInput.files = files;
                                fileSelected(fileInput);
                            }
                        } else {
                            showToast('Lütfen sadece .docx dosyaları yükleyin!', 'danger');
                        }
                    }
                });
            }

            const manualDropzone = document.getElementById('manual_dropzone');
            if (manualDropzone) {
                ['dragenter', 'dragover'].forEach(eventName => {
                    manualDropzone.addEventListener(eventName, e => {
                        e.preventDefault();
                        manualDropzone.classList.add('dragover');
                    }, false);
                });

                ['dragleave', 'drop'].forEach(eventName => {
                    manualDropzone.addEventListener(eventName, e => {
                        e.preventDefault();
                        manualDropzone.classList.remove('dragover');
                    }, false);
                });

                manualDropzone.addEventListener('drop', e => {
                    const dt = e.dataTransfer;
                    const files = dt.files;
                    if (files.length > 0 && files[0].type.startsWith('image/')) {
                        const fileInput = document.getElementById('m_image_file');
                        if (fileInput) {
                            fileInput.files = files;
                            manualFileSelected(fileInput);
                        }
                    } else {
                        showToast('Lutfen sadece gorsel dosyasi yukleyin!', 'danger');
                    }
                });
            }
        });

        function manualFileSelected(input) {
            const display = document.getElementById('manual-file-name-text');
            if (input.files && input.files.length > 0) {
                const file = input.files[0];
                display.innerText = "Secilen Gorsel: " + file.name;
                display.style.display = 'block';
                
                const reader = new FileReader();
                reader.onload = function(e) {
                    const base64data = e.target.result;
                    document.getElementById('hidden_clipboard_data').value = base64data;
                    document.getElementById('clipboard_preview_img').src = base64data;
                    document.getElementById('clipboard_preview').style.display = 'flex';
                    showToast('Gorsel secildi! Listeye ekleyebilirsiniz.', 'success');
                };
                reader.readAsDataURL(file);
            } else {
                display.style.display = 'none';
            }
        }

        function fileSelected(input) {
            const display = document.getElementById('file-name-text');
            if (input.files && input.files.length > 0) {
                if (input.files.length === 1) {
                    display.innerText = "Seçilen Dosya: " + input.files[0].name;
                    showToast('Dosya seçildi: ' + input.files[0].name, 'success');
                } else {
                    display.innerText = `Seçilen ${input.files.length} Dosya: ` + Array.from(input.files).map(f => f.name).join(', ');
                    showToast(`${input.files.length} adet dosya seçildi.`, 'success');
                }
                display.style.display = 'block';
            } else {
                display.style.display = 'none';
            }
        }

        // Elegant Theme-Aware Toast Notifications Helper
        function showToast(message, type = 'success') {
            const container = document.getElementById('toast-container');
            if (!container) return;

            // Create toast wrapper
            const toast = document.createElement('div');
            toast.className = `custom-toast toast-${type}`;
            
            // Choose icon
            let icon = 'ℹ️';
            if (type === 'success') icon = '✅';
            else if (type === 'danger') icon = '❌';
            else if (type === 'warning') icon = '⚠️';
            
            // Set content
            toast.innerHTML = `
                <div class="toast-icon">${icon}</div>
                <div class="toast-message">${message}</div>
                <button type="button" class="toast-close" onclick="this.parentElement.classList.remove('active'); setTimeout(() => this.parentElement.remove(), 300);">&times;</button>
            `;
            
            container.appendChild(toast);
            
            // Trigger animation
            setTimeout(() => {
                toast.classList.add('active');
            }, 10);
            
            // Auto remove
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.classList.remove('active');
                    setTimeout(() => {
                        if (toast.parentNode) {
                            toast.remove();
                        }
                    }, 300);
                }
            }, 3500);
        }

        let formatTimerInterval = null;
        let formatStartTime = null;
        let formatProgressInterval = null;

        function updateFormatTimer() {
            if (!formatStartTime) return;
            const elapsed = Math.floor((Date.now() - formatStartTime) / 1000);
            const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const seconds = String(elapsed % 60).padStart(2, '0');
            const timerEl = document.getElementById('format-timer');
            if (timerEl) {
                timerEl.innerText = "⏱ " + minutes + ":" + seconds;
            }
        }

        function startFormatProgress() {
            const progressArea = document.getElementById('format-progress-area');
            const fill = document.getElementById('format-progress-fill');
            const percent = document.getElementById('format-progress-percent');
            const text = document.getElementById('format-progress-text');
            const timerEl = document.getElementById('format-timer');
            
            if (!progressArea || !fill || !percent || !text) return;
            
            // Disable buttons in Tab 1
            const btns = document.querySelectorAll('#tab-format .btn');
            btns.forEach(b => b.disabled = true);
            
            // Show area
            progressArea.style.display = 'block';
            
            // Reset values
            fill.style.width = '0%';
            percent.innerText = '0%';
            text.innerText = 'Dosya biçimlendiriliyor...';
            if (timerEl) timerEl.innerText = '⏱ 00:00';
            
            formatStartTime = Date.now();
            if (formatTimerInterval) clearInterval(formatTimerInterval);
            formatTimerInterval = setInterval(updateFormatTimer, 1000);
            
            let currentPercent = 0;
            if (formatProgressInterval) clearInterval(formatProgressInterval);
            formatProgressInterval = setInterval(() => {
                if (currentPercent < 90) {
                    const remaining = 90 - currentPercent;
                    currentPercent += Math.max(0.5, remaining * 0.05);
                    const displayPercent = Math.min(90, Math.floor(currentPercent));
                    fill.style.width = displayPercent + '%';
                    percent.innerText = displayPercent + '%';
                }
            }, 100);
        }

        function stopFormatProgress(success = true) {
            if (formatTimerInterval) {
                clearInterval(formatTimerInterval);
                formatTimerInterval = null;
            }
            if (formatProgressInterval) {
                clearInterval(formatProgressInterval);
                formatProgressInterval = null;
            }
            
            const fill = document.getElementById('format-progress-fill');
            const percent = document.getElementById('format-progress-percent');
            const text = document.getElementById('format-progress-text');
            const progressArea = document.getElementById('format-progress-area');
            
            if (fill && percent && text) {
                if (success) {
                    fill.style.width = '100%';
                    percent.innerText = '100%';
                    text.innerText = 'İşlem tamamlandı!';
                } else {
                    text.innerText = 'İşlem başarısız oldu.';
                }
            }
            
            // Enable buttons in Tab 1
            const btns = document.querySelectorAll('#tab-format .btn');
            btns.forEach(b => b.disabled = false);
            
            // Hide progress area after a short delay
            setTimeout(() => {
                if (progressArea) {
                    progressArea.style.display = 'none';
                }
            }, 1000);
        }

        // Mod 1: Format Docx File via AJAX Blob Download / Preview
        function submitMod1(previewMode = false) {
            const fileInput = document.getElementById('doc_file');
            if (!fileInput.files || fileInput.files.length === 0) {
                showToast('Lutfen bir veya daha fazla .docx dosyasi secin!', 'danger');
                return;
            }
            
            // v3.99: Word Düzenle TARAYICIDA. Dosyalar sunucuya YÜKLENMEZ; stil xBuildStyleOpts()'tan gelir.
            startFormatProgress();
            
            // Reset stats container on start
            const statsContainer = document.getElementById('format-stats-container');
            if (statsContainer) {
                statsContainer.style.display = 'none';
                statsContainer.innerHTML = '';
            }

            if (!window.XLocalDocx || !window.XLocalDocx.clientWordDuzenle) {
                stopFormatProgress(false);
                showToast('Word bileşeni yüklenemedi (sayfayı yenileyin).', 'danger');
                return;
            }
            window.XLocalDocx.clientWordDuzenle(fileInput.files, xBuildStyleOpts())
            .then(async function (result) {
                const blob = result.blob;
                // Istatistik ARTIK client'tan (sunucu header'lari yerine).
                if (result.totalLinks != null && result.outputLinks != null && result.fileStats) {
                    try { renderMergeStats(String(result.totalLinks), String(result.outputLinks), result.fileStats); }
                    catch (e) { console.error("Stats render error:", e); }
                }
                stopFormatProgress(true);
                if (previewMode) {
                    // Faz 7: Word Düzenle önizlemesi de artık EDİTÖRDE (ayrıştırılan öğelerle).
                    // Kullanıcı düzenleyip editörün "📥 İndir"i ile indirir; eski showDocxPreview emekli.
                    const filename = fileInput.files.length > 1 ? "GörüntüX_Birlesik.docx" : "GörüntüX_Duzenlenmis.docx";
                    window.lastGeneratedBlob = blob;
                    window.lastGeneratedFilename = filename;
                    if (window.XEditor) { window.XEditor.ac({ items: (result && result.items) || [], fresh: true }); }
                    else { showToast('Editör yüklenemedi (sayfayı yenileyin).', 'danger'); }
                    return;
                }
                // "Kaydet ve Indir": ad sor -> indir -> KAYITLI RAPOR olarak da kaydet (sekmedeki sayac artar).
                var def = xTarihSaatDamgasi();
                var name = await xPrompt('Rapor için bir ad girin:', def, { title: 'Kaydet ve İndir', icon: _XSVG_KAYDET, okText: 'Kaydet' });
                if (name === null) { showToast('İptal edildi.', 'info'); return; }
                name = (name || '').trim() || def;
                var filename = xRaporDosyaAdi(name);
                var url = window.URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url; a.download = filename;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(function () { try { window.URL.revokeObjectURL(url); } catch (e) {} }, 4000);
                // Birlesik ogeler + gomulu gorseller (image_b64) + blob -> XSavedReports.save.
                try {
                    var images = {};
                    var its = result.items || [];
                    for (var i = 0; i < its.length; i++) {
                        var lk = its[i].link || '';
                        if (lk && its[i].image_b64 && window.XLocalImages) {
                            var mime = its[i].image_mime || 'image/jpeg';
                            images[window.XLocalImages.normLink(lk)] = { dataUrl: 'data:' + mime + ';base64,' + its[i].image_b64, mime: mime };
                        }
                    }
                    await window.XSavedReports.whenReady();
                    await window.XSavedReports.save({ name: name, items: its, images: images, blob: blob, filename: filename });
                    showToast("İndirildi ve Raporlarım'a eklendi: " + name, 'success');
                } catch (saveErr) {
                    console.error('Kayıtlı rapora kaydetme hatası:', saveErr);
                    showToast('İndirildi ama kayıtlı raporlara eklenemedi: ' + (saveErr && saveErr.message ? saveErr.message : saveErr), 'warning');
                }
                await renderSavedReports();
            })
            .catch(function (err) {
                stopFormatProgress(false);
                console.error('Word Düzenle (client) hatası:', err);
                showToast('Hata: ' + (err && err.message ? err.message : err), 'danger');
            });
        }

        function renderMergeStats(totalLinks, outputLinks, fileStats) {
            const container = document.getElementById('format-stats-container');
            if (!container) return;

            const dupCount = Math.max(0, parseInt(totalLinks) - parseInt(outputLinks));

            let fileRowsHtml = fileStats.map((file, idx) => {
                return `
                    <tr>
                        <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--text-secondary); text-align: center;">${idx + 1}</td>
                        <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); font-weight: 500; word-break: break-all;">${escapeHtml(file.filename)}</td>
                        <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); color: var(--accent-color); font-weight: bold; text-align: center;">${file.link_count}</td>
                    </tr>
                `;
            }).join('');

            container.innerHTML = `
                <div class="card" style="border: 1px solid rgba(29, 161, 242, 0.2); background: rgba(10, 25, 41, 0.7); backdrop-filter: blur(10px); box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">
                        <span style="font-size: 20px;">📊</span>
                        <h4 style="margin: 0; font-weight: 600; color: #fff;">Dosya Birleştirme İstatistikleri</h4>
                    </div>

                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 20px;">
                        <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">Toplam Giriş</div>
                            <div style="font-size: 22px; font-weight: 800; color: #fff;">${totalLinks} <span style="font-size: 11px; font-weight: normal; color: var(--text-secondary);">link</span></div>
                        </div>
                        <div style="background: rgba(29, 161, 242, 0.05); border: 1px solid rgba(29, 161, 242, 0.15); padding: 12px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 11px; color: var(--accent-color); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">Çıktı (Benzersiz)</div>
                            <div style="font-size: 22px; font-weight: 800; color: var(--accent-color);">${outputLinks} <span style="font-size: 11px; font-weight: normal; color: var(--accent-color);">link</span></div>
                        </div>
                        <div style="background: ${dupCount > 0 ? 'rgba(224, 36, 94, 0.05)' : 'rgba(255,255,255,0.02)'}; border: 1px solid ${dupCount > 0 ? 'rgba(224, 36, 94, 0.15)' : 'rgba(255,255,255,0.05)'}; padding: 12px; border-radius: 8px; text-align: center;">
                            <div style="font-size: 11px; color: ${dupCount > 0 ? 'var(--danger-color)' : 'var(--text-secondary)'}; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;">Elenen Mükerrer</div>
                            <div style="font-size: 22px; font-weight: 800; color: ${dupCount > 0 ? 'var(--danger-color)' : '#fff'};">${dupCount}</div>
                        </div>
                    </div>

                    <div style="max-height: 240px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; background: rgba(0,0,0,0.15);">
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                            <thead>
                                <tr style="background: rgba(255,255,255,0.03);">
                                    <th style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.08); font-weight: 600; text-align: center; width: 40px; color: var(--text-secondary);">#</th>
                                    <th style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.08); font-weight: 600; text-align: left; color: var(--text-secondary);">Dosya Adı</th>
                                    <th style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.08); font-weight: 600; text-align: center; width: 90px; color: var(--text-secondary);">Link Sayısı</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${fileRowsHtml}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
            container.style.display = 'block';
        }

        function escapeHtml(text) {
            return text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

            // Global Paste handler for Tab 2
            document.addEventListener('paste', function(event) {
                // Sadece tab-manual acikken calissin
                const manualTab = document.getElementById('tab-manual');
                if (!manualTab || !manualTab.classList.contains('active')) return;

                const clipboardData = event.clipboardData || (event.originalEvent && event.originalEvent.clipboardData);
                if (!clipboardData) return;
                const items = clipboardData.items;
                if (!items) return;

                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (item && item.kind === 'file' && item.type.startsWith('image/')) {
                        const blob = item.getAsFile();
                        const reader = new FileReader();
                        reader.onload = function(e) {
                            const base64data = e.target.result;
                            document.getElementById('hidden_clipboard_data').value = base64data;
                            document.getElementById('clipboard_preview_img').src = base64data;
                            document.getElementById('clipboard_preview').style.display = 'flex';
                            showToast('Gorsel hafizaya alindi! Listeye ekleyebilirsiniz.', 'success');
                        };
                        reader.readAsDataURL(blob);
                    }
                }
            });

            // Faz #1-A: yerel goruntu bayragini baslat + eklentiyi senkronize et.
            xInitLocalImages();

            // Kayitli Raporlar: suresi dolanlari temizle + listeyi ciz.
            xInitSavedReports();

            // Oturum hatırlatması bandı (kapatılmadıysa göster).
            xInitLoginReminder();

            // Stil ayarları: kaydedilmişleri geri yükle + değişince kaydet (Faz 1 kalıcılık).
            xInitStyles();

            // Start polling loop
            refreshStatus();
            setInterval(refreshStatus, 1500);

            // [VERİ KAYBI FİX — Katman 2] Oto-kayıt debounce penceresinde (~1.5-3sn) yazılan içerik, F5/kapanış
            // tüm zamanlayıcıları öldürdüğü için snapshot'a HİÇ ulaşmadan kaybolurdu (unload-flush YOKTU, #11/#12).
            // Sayfa gizlenince/kapanınca bekleyen oto-kaydı HEMEN flush et (overlay sayfa belleğinde dururken).
            // visibilitychange(hidden) genelde pagehide'dan ÖNCE ve async IndexedDB yazımına daha güvenlidir;
            // pagehide son çare. Yalnız bekleyen iş varken (timer veya __xPoolDirty) -> sekme-değişiminde boş save yok.
            try {
                var _xUnloadFlush = function () { try { if (_xOtoKayitTimer || window.__xPoolDirty) { xOtoKayitFlush(); } } catch (e) {} };
                document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { _xUnloadFlush(); } });
                window.addEventListener('pagehide', _xUnloadFlush);
            } catch (e) {}

            // MV3 servis worker'ı uykuya dalınca "Başlat" iş almıyordu (F5 gerekiyordu).
            // Panel açık olduğu sürece her 4 sn eklentiyi dürtüp SW'yi UYANIK tutuyoruz;
            // böylece tarama her zaman F5 beklemeden başlar. (Başlat'taki anlık dürtmeye ek güvenlik ağı.)
            setTimeout(function(){ if (typeof xWakeExtension === 'function') xWakeExtension(); }, 800);
            setInterval(function(){ if (typeof xWakeExtension === 'function') xWakeExtension(); }, 4000);

        // Add manual content
        function addManualContent() {
            const title = document.getElementById('m_baslik').value;
            const link = document.getElementById('m_link').value;
            const clipboardData = document.getElementById('hidden_clipboard_data').value;
            
            if (!clipboardData) {
                showToast('Lutfen bir gorsel ekleyin (Dosya secin, surukleyin veya Ctrl+V yapin)!', 'danger');
                return;
            }
            
            fetch('/api/manual/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, link, image: clipboardData })
            })
            .then(res => res.json())
            .then(data => {
                if (data.status === 'success') {
                    showToast('Icerik listeye eklendi!', 'success');
                    document.getElementById('m_baslik').value = '';
                    document.getElementById('m_link').value = '';
                    document.getElementById('hidden_clipboard_data').value = '';
                    document.getElementById('clipboard_preview').style.display = 'none';
                    document.getElementById('m_image_file').value = '';
                    document.getElementById('manual-file-name-text').style.display = 'none';
                    refreshStatus();
                } else {
                    showToast('Hata: ' + data.message, 'danger');
                }
            });
        }

        // Clear manual contents list
        async function clearManualList() {
            // FIX-SIFIRLA: havuz birleşmesinden sonra Sıfırla TEK açık temizleme yoludur (Kaydet commit eder).
            // Onay iste; sunucu havuzu + overlay + manuel bloklar + editör belgesi + YEREL GÖRSELLER birlikte silinsin
            // (yoksa IndexedDB'de yetim görsel + bayat overlay kalır).
            var onay = (typeof xConfirm === 'function')
                ? await xConfirm('Havuzdaki tüm içerik (ve eklenen görseller) silinsin mi? Bu geri alınamaz.', { title: 'Sıfırla', icon: _XSVG_COP, okText: 'Sıfırla', danger: true })
                : confirm('Havuzdaki tüm içerik silinsin mi?');
            if (!onay) return;
            xBosaltOnayVer();   // Faz 2: kullanıcı AÇIKÇA boşalttı -> oto-kayıt boş durumu yazsın (K3/#9: rapor-id'ye bağlı)
            try { await fetch('/api/manual/clear', { method: 'POST' }); } catch (e) {}
            window.__openReportName = '';
            window.__xEditorOverlay = { byLink: {}, style: null };
            window.__xManualClusters = [];
            try { if (window.XEditor) { window.XEditor.belge = { stil: {}, birimler: [] }; window.XEditor._dirty = false; } } catch (e) {}
            try { if (window.XLocalImages && window.XLocalImages.clear) { window.XLocalImages.clear(); } } catch (e) {}
            window.accumulatedLinks = [];
            var inputEl = document.getElementById('tweet_links_input');
            if (inputEl) {
                inputEl.value = '';
                if (typeof updateLinksPreview === 'function') { updateLinksPreview(); }
                autoResizeTextarea(inputEl);
            }
            try { if (window.XEditor && window.XEditor.kapat) { window.XEditor.kapat(true); } } catch (e) {}   // içerik gitti -> editörü kapat
            showToast('Liste temizlendi.', 'success');
            refreshStatus();
        }

        // Delete a single manual item by index
        function deleteManualItem(index) {
            fetch('/api/manual/delete/' + index, { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                if (data.status === 'success') {
                    // Faz 2 (düzeltme): boşaltma iznini YALNIZ havuz GERÇEKTEN boşaldığında ver (son öğe silindi).
                    // Aksi halde içerik taşıyan raporu koruyan boş-ezme güvenliği 10 sn gereksiz devre dışı kalır.
                    if (data.remaining === 0) { xBosaltOnayVer(); }   // K3/#9: rapor-id'ye bağlı açık-boşaltma onayı
                    showToast('Icerik silindi.', 'success');
                    refreshStatus();
                } else {
                    showToast('Hata: ' + data.message, 'danger');
                }
            });
        }

        // Generate manual word / Preview
        // --- İstemci-taraflı (tarayıcıda) Word üretimi (deneysel anahtar; varsayılan KAPALI) ---
        function xLocalGenEnabled() {
            // Faz 4 (guvenli emeklilik): Word HER ZAMAN tarayicida uretilir; kullaniciya secim sunulmaz.
            // Sunucu uretimi yalnizca xGenerateLocal hata verirse otomatik, gorunmez guvenlik agi
            // olarak devreye girer (server-fallback + /api/*/generate uclari korunur, geri-alinabilir).
            return true;
        }

        // --- Rapor Editörü önizleme mimarisi (Faz 7: VARSAYILAN AÇIK). Havuz "Önizle" girişleri
        //     artık DAİMA editörü açar; eski showDocxPreview havuz yolu emekli. 'x_editor_enabled'
        //     localStorage ile '0' verilirse acil durumda eski yola düşülebilir (geçici kaçış). ---
        function xEditorEnabled() {
            try { return localStorage.getItem('x_editor_enabled') !== '0'; } catch (e) { return true; }
        }

        // --- Faz #1-A: Yerel ekran goruntusu bayragi ---
        function xLocalImagesEnabled() {
            // Faz #1-D (tam kaldırma): ekran görüntüleri HER ZAMAN yerelde; sunucuya asla gitmez.
            return true;
        }
        function xSetLocalImages(on) {
            try { if (window.XLocalImages) window.XLocalImages.setEnabled(on); } catch (e) {}
            // Eklentiye bildir: widget bu bayraga gore goruntuyu SUNUCUYA gondermeyip panele iletir.
            try { window.postMessage({ type: "X_RAPOR_SET_LOCAL_IMAGES", value: !!on }, "*"); } catch (e) {}
            showToast(on ? 'Ekran görüntüleri artık tarayıcıda tutulacak (deneysel).' : 'Ekran görüntüleri sunucuya gönderilecek (varsayılan).', 'success');
            refreshStatus();
        }
        function xInitLocalImages() {
            try {
                var on = xLocalImagesEnabled();
                var el = document.getElementById('local_images_toggle');
                if (el) el.checked = on;
                // Baslangicta eklentiyi mevcut bayrakla senkronize et.
                window.postMessage({ type: "X_RAPOR_SET_LOCAL_IMAGES", value: on }, "*");
            } catch (e) {}
            // Yeni goruntu gelince / depo hazir olunca havuzu tazele (yerel gorseller gorunsun).
            try {
                // [VERİ KAYBI FİX — Katman 2] Eklenti görseli ASENKRON düşer (widget captureArticle yavaş);
                // eskiden yalnız refreshStatus çağrılır, __xPoolDirty kurulmazdı -> görsel ilk oto-kayıt
                // snapshot'ından SONRA gelince yeniden-kayıt TETİKLENMEZ, snapshot/blob görseli atlardı (#17).
                // __xPoolDirty=true -> poll (4558 civarı) oto-kaydı yeniden planlar, görsel snapshot'a girer.
                window.addEventListener('x-local-image-added', function () { try { window.__xPoolDirty = true; } catch (e) {} refreshStatus(); });
                window.addEventListener('x-local-images-ready', function () { refreshStatus(); });
            } catch (e) {}
        }

        // ---------- KAYITLI RAPORLAR (yerel, coklu, 1 hafta) ----------
        var X_SAVED_REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 hafta (son kayittan)

        function xTarihSaatDamgasi() {
            try {
                var d = new Date();
                function _p(n){ return (n < 10 ? '0' : '') + n; }
                return _p(d.getDate()) + '-' + _p(d.getMonth() + 1) + '-' + d.getFullYear() + ' ' +
                       _p(d.getHours()) + '-' + _p(d.getMinutes()) + '-' + _p(d.getSeconds());
            } catch (e) { return 'rapor'; }
        }
        function xDosyaAdiTemizle(s) {
            // Dosya adinda gecersiz karakterleri (: / \ * ? " < > |) sadelestir.
            return (s == null ? '' : s).toString().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
        }
        function xRaporDosyaAdi(name) {
            var temiz = xDosyaAdiTemizle(name) || 'GörüntüX';
            // #2: Ad ZATEN tarih-saat damgasıysa (kullanıcı ismi değiştirmedi) sonuna BİR DAHA ekleme
            //     -> "27-10-2026 14-30-45 27-10-2026 14-30-46.docx" gibi ÇİFT damga oluşmaz.
            if (/^[0-9]{2}-[0-9]{2}-[0-9]{4} [0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(temiz)) { return temiz + '.docx'; }
            // Aksi halde sürümleri ayırt etmek için tarih-saat eklenir.
            return temiz + ' ' + xTarihSaatDamgasi() + '.docx';
        }

        // Panel-ici STILLI dialog (kullanici istegi: native prompt/confirm degil, panelin .modal
        // gorunumu). xConfirm(msg,opts)->Promise<bool>; xPrompt(msg,def,opts)->Promise<string|null>.
        // Baslik/mesaj textContent ile konur -> kullanici icerigi (rapor adi) guvenli.
        // Onay/giriş dialoglarının başlık ikonları (tek-renk SVG; danger'da kırmızı tonlanır).
        var _XSVG_COP = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6h11"/><path d="M8 6V4.5h4V6"/><path d="M6 6l.7 10h6.6L14 6"/><path d="M8.6 9v4M11.4 9v4"/></svg>';
        var _XSVG_KAYDET = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3.5h8l3 3v9.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-11.5a1 1 0 0 1 1-1z"/><path d="M7 3.5v4h5v-4"/><path d="M7 17v-5h6v5"/></svg>';
        var _XSVG_KALEM = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5l3 3-9 9H4.5v-3z"/><path d="M11.5 5.5l3 3"/></svg>';
        var _XSVG_ARTI = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4v12M4 10h12"/></svg>';
        var _XSVG_ACAC = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 15.5v-9a1 1 0 0 1 1-1h3.1l1.3 1.6h7a1 1 0 0 1 1 1"/><path d="M2.6 15.5l1.9-6.5h13l-1.9 6.5z"/></svg>';
        var _XSVG_ZINCIR = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5a3 3 0 0 0 4.24.17l2.3-2.3a3 3 0 0 0-4.24-4.24l-1.1 1.1"/><path d="M11.5 8.5a3 3 0 0 0-4.24-.17l-2.3 2.3a3 3 0 0 0 4.24 4.24l1.1-1.1"/></svg>';
        function xDialog(opts) {
            opts = opts || {};
            return new Promise(function (resolve) {
                var done = false;
                var isInput = !!opts.input;
                var okStyle = opts.danger ? 'background:var(--danger-color); color:#fff;' : 'background:var(--accent-color); color:#fff;';
                var overlay = document.createElement('div');
                overlay.className = 'modal active';
                overlay.style.zIndex = '3000';
                overlay.innerHTML =
                    '<div class="modal-content" style="max-width:440px;">' +
                        '<div class="modal-header"><h2 class="x-dlg-title' + (opts.danger ? ' danger' : '') + '"><span class="x-dlg-ico"></span><span class="x-dlg-ttxt"></span></h2>' +
                            '<span class="close-btn" data-act="cancel">&times;</span></div>' +
                        '<div class="modal-body">' +
                            '<div class="x-dlg-msg" style="color:var(--text-primary); line-height:1.5; white-space:pre-wrap;"></div>' +
                            (isInput ? '<input type="text" class="x-dlg-input" style="width:100%; margin-top:14px; padding:11px 13px; border:1px solid var(--border-color); border-radius:10px; background:var(--bg-input); color:var(--text-primary); font-size:14px; box-sizing:border-box;">' : '') +
                            (opts.checkbox ? '<label class="x-dlg-check-row" style="display:flex; align-items:center; gap:8px; margin-top:14px; font-size:13px; color:var(--text-secondary); cursor:pointer; user-select:none;"><input type="checkbox" class="x-dlg-check" style="width:16px; height:16px; cursor:pointer; margin:0;"><span class="x-dlg-check-label"></span></label>' : '') +
                        '</div>' +
                        '<div class="modal-footer" style="gap:10px;">' +
                            (opts.thirdText ? '<button type="button" class="btn btn-secondary x-dlg-third" data-act="third" style="margin:0;"></button>' : '') +
                            '<button type="button" class="btn btn-secondary x-dlg-cancel" data-act="cancel" style="margin:0;"></button>' +
                            '<button type="button" class="btn x-dlg-ok" data-act="ok" style="margin:0; ' + okStyle + '"></button>' +
                        '</div>' +
                    '</div>';
                document.body.appendChild(overlay);
                overlay.querySelector('.x-dlg-ttxt').textContent = opts.title || '';
                var _dlgIco = overlay.querySelector('.x-dlg-ico');
                if (_dlgIco) { if (opts.icon) { _dlgIco.innerHTML = opts.icon; } else { _dlgIco.style.display = 'none'; } }
                overlay.querySelector('.x-dlg-msg').textContent = opts.message || '';
                overlay.querySelector('.x-dlg-ok').textContent = opts.okText || 'Tamam';
                overlay.querySelector('.x-dlg-cancel').textContent = opts.cancelText || 'Vazgeç';
                if (opts.thirdText) { var _t3 = overlay.querySelector('.x-dlg-third'); if (_t3) { _t3.textContent = opts.thirdText; } }
                if (opts.checkbox) { var _clbl = overlay.querySelector('.x-dlg-check-label'); if (_clbl) { _clbl.textContent = opts.checkbox; } }
                var inputEl = overlay.querySelector('.x-dlg-input');
                if (inputEl) { inputEl.value = (opts.defaultValue == null ? '' : opts.defaultValue); }
                function finish(result) {
                    if (done) return; done = true;
                    overlay.classList.remove('active');
                    setTimeout(function () { try { overlay.remove(); } catch (e) {} }, 200);
                    resolve(result);
                }
                function onOk() {
                    var _val = isInput ? (inputEl ? inputEl.value : '') : true;
                    if (opts.checkbox) {
                        var _cb = overlay.querySelector('.x-dlg-check');
                        finish({ value: _val, checked: !!(_cb && _cb.checked) });
                    } else {
                        finish(_val);
                    }
                }
                function onCancel() { finish(isInput ? null : false); }
                overlay.addEventListener('click', function (ev) {
                    if (ev.target === overlay) { onCancel(); return; }   // arka plana tikla -> iptal
                    var act = ev.target.getAttribute && ev.target.getAttribute('data-act');
                    if (act === 'ok') { onOk(); } else if (act === 'cancel') { onCancel(); } else if (act === 'third') { finish('third'); }
                });
                overlay.addEventListener('keydown', function (ev) {
                    if (ev.key === 'Enter') { ev.preventDefault(); onOk(); }
                    else if (ev.key === 'Escape') { ev.preventDefault(); onCancel(); }
                });
                setTimeout(function () {
                    try {
                        if (inputEl) { inputEl.focus(); inputEl.select(); }
                        else { var okb = overlay.querySelector('.x-dlg-ok'); if (okb) okb.focus(); }
                    } catch (e) {}
                }, 60);
            });
        }
        function xConfirm(message, opts) {
            opts = opts || {};
            return xDialog({ title: opts.title || 'Onay', message: message, input: false, icon: opts.icon,
                okText: opts.okText || 'Evet', cancelText: opts.cancelText || 'Vazgeç', danger: opts.danger });
        }
        function xPrompt(message, defaultValue, opts) {
            opts = opts || {};
            return xDialog({ title: opts.title || 'Giriş', message: message, input: true, defaultValue: defaultValue, icon: opts.icon,
                okText: opts.okText || 'Tamam', cancelText: opts.cancelText || 'Vazgeç', checkbox: opts.checkbox });
        }

        // "Kaydet ve Indir": .docx uret -> PC'ye indir -> panele YEREL kaydet -> havuzu SIFIRLA
        // (kullanici istegi: eski "Word Uret ve Indir" gibi uret->indir->temizle). Kayit BASARISIZSA
        // havuz KORUNUR (snapshot yok, kaybolmasin). Duzenlemeye devam icin rapor "Ac" ile geri yuklenir.
        // D1 (Kaydet/İndir AYRI): havuz+overlay'den .docx + snapshot verisi üret. İNDİRMEZ/KAYDETMEZ/TEMİZLEMEZ.
        async function xBuildReport(name) {
            if (!window.XLocalDocx) throw new Error('Word üretimi kullanılamıyor.');
            var res = await fetch('/api/pool/data');
            var data = await res.json();
            var items = (data && data.items) || [];
            var _manVar = !!(window.__xManualClusters && window.__xManualClusters.length);
            if (!items.length && !_manVar) return null;   // içerik yok
            // Görselleri TOPLA (snapshot link->dataUrl) + genItems'e image_b64 ENJEKTE et
            // (providedItems yolu XLocalImages enjeksiyonu yapmaz; görselli .docx için şart).
            var images = {};
            if (window.XLocalImages) {
                if (window.XLocalImages.whenReady) { try { await window.XLocalImages.whenReady(); } catch (e) {} }
                for (var i = 0; i < items.length; i++) {
                    var lk = items[i].link || '';
                    if (window.XLocalImages.hasImage(lk)) {
                        var k = window.XLocalImages.normLink(lk);
                        images[k] = { dataUrl: window.XLocalImages.getImageUrl(lk), mime: window.XLocalImages.getMime(lk) };
                        items[i].image_b64 = window.XLocalImages.getBase64(lk);
                        items[i].image_mime = window.XLocalImages.getMime(lk);
                    }
                }
            }
            // Editör overlay'inden parcalar + başlık-override + küme taşıma (h2_override AYRI alan -> kimlik bozulmaz).
            var _ovB = (window.__xEditorOverlay && window.__xEditorOverlay.byLink) ? window.__xEditorOverlay.byLink : {};
            for (var oi = 0; oi < items.length; oi++) {
                var _oe = _ovB[xOvKey(items[oi].link || '')];
                if (_oe) {
                    if (_oe.parcalar && _oe.parcalar.length) { items[oi].parcalar = _oe.parcalar; }
                    if (_oe.h2 != null) { items[oi].h2_override = _oe.h2; }
                    if (_oe.grup != null) { items[oi].group_override = _oe.grup; }
                    if (_oe.h1over != null) { items[oi].h1_override = _oe.h1over; }
                    if (_oe.h1ov) { items[oi].h1_ov = _oe.h1ov; }
                    if (_oe.h2ov) { items[oi].h2_ov = _oe.h2ov; }
                }
            }
            var _wopts = xBuildStyleOpts();
            // FIX-STALE-BELGE: editör AÇIKSA canlı GÖRÜNÜMÜ (__birimler) kullan (taşıma/sıra birebir).
            // Editör KAPALIYSA bayat belge yeni havuz öğelerini atlardı -> __birimler KULLANMA, havuzdan grupla.
            // AMA [5/7/12]: eski (link='') manuel bloklar YALNIZ __birimler ile docx'e girer -> editör kapalıyken
            // __xManualClusters varsa taze birimler kur (buildBirimler) ki o bloklar kaybolmasın.
            var _edAktif = !!(document.getElementById('editorModal') && document.getElementById('editorModal').classList.contains('active'));
            if (_edAktif && window.XEditor && window.XEditor.belge && window.XEditor.belge.birimler && window.XEditor.belge.birimler.length) {
                _wopts.__birimler = window.XEditor.belge.birimler;
            } else if (window.XEditor && window.XEditor.buildBirimler && window.__xManualClusters && window.__xManualClusters.length) {
                try { _wopts.__birimler = await window.XEditor.buildBirimler(items, _wopts); } catch (e) { console.error('buildBirimler hata:', e); }
            }
            var blob = await window.XLocalDocx.generateBlob(_wopts, items);
            var filename = xRaporDosyaAdi(name);
            var _snapItems = items.map(function (it) {
                var o = { title: it.title || '', link: it.link || '' };   // title ORİJİNAL (gruplama anahtarı)
                if (it.parcalar) { o.parcalar = it.parcalar; }
                if (it.h2_override != null) { o.h2_override = it.h2_override; }
                if (it.is_profile) { o.is_profile = true; }
                if (it.group_override) { o.group_override = it.group_override; }
                if (it.h1_override != null) { o.h1_override = it.h1_override; }
                if (it.h1_ov) { o.h1_ov = it.h1_ov; }
                if (it.h2_ov) { o.h2_ov = it.h2_ov; }
                return o;
            });
            return { blob: blob, filename: filename, snapItems: _snapItems, images: images };
        }
        function xTriggerDownload(blob, filename) {
            var url = window.URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { try { window.URL.revokeObjectURL(url); } catch (e) {} }, 4000);
        }
        // Başarılı kayıttan (commit) sonra: sunucu havuzu + yerel görseller + editör durumu SIFIRLA.
        function xResetAfterSave() {
            window.__openReportName = '';
            window.__xEditorOverlay = { byLink: {}, style: null };
            window.__xManualClusters = [];
            try { if (window.XEditor) { window.XEditor.belge = { stil: {}, birimler: [] }; window.XEditor._dirty = false; } } catch (e) {}
            return fetch('/api/manual/clear', { method: 'POST' })
                .then(function () { resetAutomationUIAndBackend(); })
                .catch(function () { resetAutomationUIAndBackend(); });
        }
        // D: "💾 Kaydet" -> panele kaydet + havuzu temizle (commit). İNDİRMEZ. Editör Kaydet de bunu çağırır.
        window.xSnapshotReport = async function (name) {
            var r = await xBuildReport(name);
            if (!r) { showToast('İçerik yok — kaydedilecek bir şey yok.', 'warning'); return false; }
            await window.XSavedReports.whenReady();
            await window.XSavedReports.save({ name: name, items: r.snapItems, images: r.images, blob: r.blob, filename: r.filename, editorStyle: xBuildStyleOpts(), manualClusters: (window.__xManualClusters || []) });
            await renderSavedReports();
            // [Kaydet = COMMIT]: isimle kaydedince havuzu SIFIRLA (kullanıcı isteği). Rapor Kayıtlı
            // Raporlar'da durur; "Aç" ile aynı havuza geri yüklenir, sonra manuel/eklenti/tarama o havuza
            // birikir, tekrar Kaydet upsert eder (openSavedReport __openReportName'i kurar).
            await xResetAfterSave();
            return true;
        };
        window.xClearPoolAfterSave = xResetAfterSave;

        // ============================================================================
        // Faz 2: AKTİF RAPOR + OTO-KAYIT (Google-Dokümanlar tarzı)
        //   Havuz = AÇIK (aktif) rapor. Her değişiklik debounce'lı olarak aktif rapora
        //   (IndexedDB) yazılır. Aktif rapor yoksa ilk içerikte otomatik oluşturulur.
        //   Bayrak x_oto_kayit (varsayılan AÇIK) kapatılırsa eski elle-"Kaydet" modeline döner.
        // ============================================================================
        function xOtoKayitAcik() { try { return localStorage.getItem('x_oto_kayit') !== '0'; } catch (e) { return true; } }
        window.xOtoKayitAcik = xOtoKayitAcik;
        // [VERİ KAYBI FİX] Overlay (sayfa belleği) F5/yeniden-bağlanmada silinir ama HAVUZ (sunucu belleği)
        // yaşar -> uzlaştırmanın "havuz-koru" dalı eskiden overlay'i geri KURMUYORDU; manuel metin boşalır +
        // ilk poll oto-kayıtı boş overlay'i snapshot'a yazıp KALICI siler. Bayrak (varsayılan AÇIK) geri alınabilirlik.
        function xRehidrateAcik() { try { return localStorage.getItem('x_overlay_rehidrate') !== '0'; } catch (e) { return true; } }
        // Snapshot'tan editör overlay'ini (+ manuel kümeler + stil) geri yükle — HAVUZA DOKUNMADAN
        // (havuz zaten canlı/doğru; XLocalImages IndexedDB'de duruyor). openSavedReport 4b adımının (3782-3790)
        // havuz-korumalı ikizi; __xManualClusters (3788) ve editorStyle (3790) DAHİL aynalanır (bulgu #2/#7/#14).
        function xRaporOverlayGeriYukle(rec) {
            if (!rec) return;
            var items = rec.items || [];
            var _ov = { byLink: {}, style: rec.editorStyle || null };
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (it && (it.parcalar || it.h2_override != null || it.group_override != null || it.h1_override != null || it.h1_ov || it.h2_ov)) {
                    _ov.byLink[xOvKey(it.link || '')] = { parcalar: it.parcalar || null, h2: (it.h2_override != null ? it.h2_override : null), grup: (it.group_override != null ? it.group_override : null), h1over: (it.h1_override != null ? it.h1_override : null), h1ov: (it.h1_ov || null), h2ov: (it.h2_ov || null) };
                }
            }
            window.__xEditorOverlay = _ov;
            window.__xManualClusters = (rec.manualClusters || []);
            try { if (window.XEditor) { window.XEditor.belge = { stil: {}, birimler: [] }; } } catch (e) {}
            if (rec.editorStyle) { try { xApplyStyleOpts(rec.editorStyle); } catch (e) {} }
            // [MANUEL HAVUZ] Overlay re-hidre edildi -> havuz bir sonraki poll'da YENİDEN çizilsin ki manuel
            // bölümün başlığı/metni/görseli (overlay'den) havuz kartında görünsün (yenileme sonrası boş kalmasın).
            try { window.__xPoolDirty = true; } catch (e) {}
        }
        function xAktifRaporId() { try { return localStorage.getItem('x_active_report_id') || ''; } catch (e) { return ''; } }
        window.xAktifRaporId = xAktifRaporId;
        // [VERİ KAYBI FİX K3/#9] AÇIK boşaltma onayını (Sıfırla/son öğe silme) rapor-id'ye BAĞLA -> başka raporun
        // snapshot'ı 10sn penceresinde yanlışlıkla boşla ezilmesin. Kayıtlı id yoksa (eski) eski davranış korunur.
        function xBosaltOnayVer() { try { window.__xOtoKayitBosaltOnayTS = Date.now(); window.__xOtoKayitBosaltOnayId = xAktifRaporId(); } catch (e) {} }
        window.xBosaltOnayVer = xBosaltOnayVer;   // x-editor.js (XE._sil son-bölüm silme) de çağırır (ayrı scope)
        function xBosaltIzni(id) {
            try {
                if ((Date.now() - (window.__xOtoKayitBosaltOnayTS || 0)) >= 10000) return false;
                var _bi = window.__xOtoKayitBosaltOnayId;
                return (_bi == null || _bi === '' || _bi === id);
            } catch (e) { return false; }
        }
        // [VERİ KAYBI FİX — REBUILD] Havuz geri-yükleme özelliği açık mı ('0' -> eski davranış, geri-alınabilir).
        function xHavuzGeriYukleAcik() { try { return localStorage.getItem('x_havuz_geri_yukle') !== '0'; } catch (e) { return true; } }
        // [VERİ KAYBI FİX — REBUILD] Sunucu havuzu (Docker rebuild ile) sıfırlanınca aktif raporun öğelerini
        // snapshot'tan SUNUCU HAVUZUNA re-push eder (openSavedReport'un AĞIR yolu DEĞİL: overlay/editör belgesine
        // DOKUNMAZ, flush ETMEZ). Böylece xBuildReport havuzdan tam öğeleri tekrar okur -> boş/kısmi ezme olmaz.
        // Görseller XLocalImages'ta (IndexedDB, sunucu-reset'ten etkilenmez) -> yalnız title/link re-push yeter.
        async function xHavuzuSnapshottanGeriYukle(id) {
            try { var _cur = ((await fetch('/api/pool/data').then(function (r) { return r.json(); })).items) || []; if (_cur.length) return true; } catch (e) {}   // kuyruk beklerken dolduysa no-op
            var rec = null; try { rec = await window.XSavedReports.get(id); } catch (e) {}
            if (!rec || !rec.items || !rec.items.length) return false;   // snapshot'ta re-push edilecek havuz öğesi yok
            try { await fetch('/api/manual/clear', { method: 'POST' }); } catch (e) {}
            for (var j = 0; j < rec.items.length; j++) {
                var it = rec.items[j];
                var body = { title: it.title || '', link: it.link || '', local: true };
                if (it.is_profile) { body.is_profile = true; }
                if (it.group_override) { body.group_override = it.group_override; }
                try { await fetch('/api/manual/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) {}
            }
            return true;
        }
        // Faz 3: URL yardımcıları. Pathname'in İLK segmenti = rapor slug'ı (/<slug>).
        function xUrlSlugOku() {
            try { var p = (window.location.pathname || '/').replace(/^\/+/, '').split('/')[0]; return p ? decodeURIComponent(p) : ''; } catch (e) { return ''; }
        }
        // Adres çubuğunu aktif rapora göre güncelle (slug boşsa '/'). search korunur. Zaten oradaysa no-op.
        function xUrlRaporaGuncelle(slug, replace) {
            try {
                var hedef = slug ? ('/' + encodeURIComponent(slug)) : '/';
                if (window.location.pathname === hedef) return;
                var tam = hedef + (window.location.search || '');
                var st = { xslug: slug || '' };
                if (replace) { history.replaceState(st, '', tam); } else { history.pushState(st, '', tam); }
            } catch (e) {}
        }
        window.xUrlRaporaGuncelle = xUrlRaporaGuncelle;
        function xAktifRaporKur(id, ad, slug, urlReplace) {
            try { if (id) { localStorage.setItem('x_active_report_id', id); } else { localStorage.removeItem('x_active_report_id'); } } catch (e) {}
            try { window.__xYukluRaporId = id || ''; } catch (e) {}   // [VERİ KAYBI FİX K3/#18] bu SEKMENİN yüklediği rapor (in-memory; çok-sekme guard'ı)
            if (ad != null) { window.__xActiveReportName = String(ad); }
            if (slug != null) { window.__xActiveReportSlug = String(slug); }
            window.__openReportName = window.__xActiveReportName || '';   // mevcut upsert/indir adı bununla uyumlu
            xAktifRaporCizgiCiz();
            try { if (typeof xEdRaporAdiDoldur === 'function') xEdRaporAdiDoldur(); } catch (e) {}   // [RAPOR ADI] editör input'u senkron
            if (id) { xUrlRaporaGuncelle(window.__xActiveReportSlug || '', !!urlReplace); }   // Faz 3: adres çubuğu /<slug>
        }
        function xAktifRaporTemizle(urlReplace) {
            try { localStorage.removeItem('x_active_report_id'); } catch (e) {}
            try { window.__xYukluRaporId = ''; } catch (e) {}   // [VERİ KAYBI FİX K3/#18]
            window.__xActiveReportName = ''; window.__xActiveReportSlug = ''; window.__openReportName = '';
            xAktifRaporCizgiCiz();
            xUrlRaporaGuncelle('', !!urlReplace);   // Faz 3: aktif yok -> '/'
        }
        // Üst çubuk (aktif rapor adı + oto-kayıt durumu). Aktif rapor yoksa gizli.
        function xAktifRaporCizgiCiz() {
            var bar = document.getElementById('x-aktif-rapor-bar');
            if (!bar) return;
            var id = xAktifRaporId();
            if (!id) { bar.style.display = 'none'; return; }
            bar.style.display = 'flex';
            var adEl = document.getElementById('x-aktif-rapor-ad');
            if (adEl) { adEl.textContent = window.__xActiveReportName || '(adsız rapor)'; }
        }
        // Kalıcı aktif-rapor çubuğu KALDIRILDI -> oto-kayıt durumu artık sağ-alt ANLIK TOAST ile.
        // "kaydedildi" throttle'lı (en çok 12 sn'de bir, tarama/yazma sırasında spam olmasın);
        // "hata" her zaman; "kaydediliyor"/boş sessiz.
        var _xKayitToastTS = 0;
        function xKayitBildir() {
            var now = Date.now();
            if (now - _xKayitToastTS < 12000) return;
            _xKayitToastTS = now;
            if (typeof showToast === 'function') showToast('✓ Kaydedildi', 'success');
        }
        function xOtoKayitDurum(durum) {
            // "kaydedildi" toast'ı YALNIZ poll oto-kaydında verilir (xOtoKayitPlanla timer'ı) -> aç/yeni/
            // birleştir kendi toast'ını verdiği için burada no-op; "hata" her zaman bildirilir.
            if (durum === 'hata') { if (typeof showToast === 'function') showToast('⚠ Rapor kaydedilemedi.', 'danger'); }
        }
        // Oto-kayıt AÇIKken elle "💾 Kaydet" butonu gizlenir (kaçış kapısı: bayrak kapalıysa görünür).
        function xOtoKayitUICiz() {
            var sb = document.getElementById('save-btn');
            if (sb) { sb.style.display = xOtoKayitAcik() ? 'none' : ''; }
        }
        window.xOtoKayitUICiz = xOtoKayitUICiz;
        var _xOtoKayitTimer = null;
        // ===== TEK SERİ KUYRUK: tüm havuz-mutasyon işlemleri (oto-kayıt / aç / yeni / birleştir / sil-aktif)
        // bu kuyruktan GEÇER -> ASLA çakışmazlar. Böylece stale-id ile yazma, orta-yükleme kısmi kaydı,
        // çift-açılış (çift-tık / hızlı geri-ileri) ve silinen raporun dirilmesi KÖKTEN önlenir. =====
        var _xIslemZinciri = Promise.resolve();
        function xSiraya(fn) {
            var p = _xIslemZinciri.then(fn, fn);
            _xIslemZinciri = p.catch(function () {});   // zincir hatada kırılmasın
            return p;
        }
        window.xSiraya = xSiraya;
        function xOtoKayitPlanla() {
            if (!xOtoKayitAcik()) return;
            if (_xOtoKayitTimer) { clearTimeout(_xOtoKayitTimer); }
            _xOtoKayitTimer = setTimeout(function () { _xOtoKayitTimer = null; xOtoKayitYap().then(function () { try { xKayitBildir(); } catch (e) {} }); }, 1500);
        }
        window.xOtoKayitPlanla = xOtoKayitPlanla;
        // Bekleyen oto-kaydı HEMEN kuyruğa al (rapor değiştirmeden önce flush — son düzenleme kaybolmasın).
        function xOtoKayitFlush() {
            if (!xOtoKayitAcik()) return Promise.resolve();
            if (_xOtoKayitTimer) { clearTimeout(_xOtoKayitTimer); _xOtoKayitTimer = null; }
            return xSiraya(_xOtoKayitYapImpl);
        }
        window.xOtoKayitFlush = xOtoKayitFlush;
        // Poll/public giriş: kuyruğa alır (kuyruktaki yükleme impl'leri flush için _xOtoKayitYapImpl'i DOĞRUDAN çağırır).
        function xOtoKayitYap() { if (!xOtoKayitAcik()) return Promise.resolve(); return xSiraya(_xOtoKayitYapImpl); }
        window.xOtoKayitYap = xOtoKayitYap;
        async function _xOtoKayitYapImpl() {
            if (!xOtoKayitAcik()) return;
            // [VERİ KAYBI FİX] Yükleme/uzlaştırma bitene kadar ERTELE: overlay snapshot'tan geri kurulmadan
            // oto-kayıt çalışırsa boş overlay'i snapshot'a yazıp sağlam raporu ezer (bulgu #3/#6/#15). Nöbetçi
            // _xOtoKayitYapImpl'in İÇİNDE -> wrapper'ları (xOtoKayitPlanla/Yap/Flush) atlayan doğrudan-flush
            // yolları (_newReportImpl/_openSavedReportImpl/_raporuKapatImpl/_mergeSelectedReportsImpl/editör Kaydet) de kapanır.
            if (window.__xRaporYukleniyor) { try { xOtoKayitDurum('kaydedildi'); } catch (e) {} return; }
            try {
                await window.XSavedReports.whenReady();
                var id = xAktifRaporId();
                // [VERİ KAYBI FİX K3/#18] Çok-sekme: x_active_report_id localStorage'ta PAYLAŞILIR. Başka sekme
                // aktif raporu değiştirdiyse bu sekmenin (bellekteki) overlay'i YANLIŞ rapora yazılıp çapraz
                // bozulurdu. Bu sekmenin yüklediği rapor (in-memory __xYukluRaporId) paylaşılan aktif id'den
                // FARKLIYSA YAZMA. (undefined ise eski davranış; id='' oto-oluşturmada guard atlanır.)
                if (id && window.__xYukluRaporId != null && window.__xYukluRaporId !== '' && window.__xYukluRaporId !== id) {
                    try { xOtoKayitDurum('kaydedildi'); } catch (e) {} return;
                }
                // [STANDART STİL] Aktif rapor YOKKEN (id==='') içerik oto-oluşturacak -> standart stille başlasın
                // (eklenti/tarama ile oto-oluşan rapor önceki raporun stilini DEVRALMASIN; "Yeni Rapor" butonu +
                // rapor-kapat zaten standartlıyor, bu da fresh-sayfa/kapatmasız yolu kapatır). Yalnız oto-oluştur.
                if (id === '') { try { xStandartStiliUygula(); } catch (e) {} }
                var ad = window.__xActiveReportName || '';
                xOtoKayitDurum('kaydediliyor');
                var r = null;
                try { r = await xBuildReport(ad || xTarihSaatDamgasi()); } catch (e) { r = null; }
                if (!r) {
                    // İçerik yok. Aktif rapor VARSA boş durumu kalıcılaştır; yoksa yapılacak bir şey yok.
                    if (id) {
                        // GÜVENLİK: içerik taşıyan raporu BOŞ ile EZME. Havuz "gizlice" boşaldıysa (sunucu
                        // yeniden başladı / Docker rebuild) bu GEÇİCİ kayıptır -> rapor korunur. Yalnız kullanıcı
                        // AÇIKÇA boşalttıysa (Sıfırla/sil, son 10 sn) boş durum yazılır.
                        var _izin = xBosaltIzni(id);   // K3/#9: yalnız BU rapor için açık boşaltma (10sn)
                        if (!_izin) {
                            var _rec = null; try { _rec = await window.XSavedReports.get(id); } catch (e) {}
                            var _depoDolu = !!(_rec && ((_rec.items && _rec.items.length) || (_rec.manualClusters && _rec.manualClusters.length)));
                            if (_depoDolu) { xOtoKayitDurum('kaydedildi'); return; }   // içeriği KORU, boşla ezme
                        }
                        await window.XSavedReports.save({ id: id, name: (window.__xActiveReportName || null), items: [], images: {}, blob: null, filename: '', editorStyle: xBuildStyleOpts(), manualClusters: [] });
                        xOtoKayitDurum('kaydedildi'); await renderSavedReports();
                    } else { xOtoKayitDurum(''); }
                    return;
                }
                // [VERİ KAYBI FİX — YAPISAL KORUMA / BACKSTOP] Overlay TAMAMEN boşken (hidre olmamış: F5/router/
                // init-yarışı/istisna yolu) xBuildReport havuzda öğe var diye NON-NULL ama "fakir" (metinsiz) build
                // üretir; eski koruma (yukarıda) yalnız r===null'da çalıştığından bu fakir build sağlam snapshot'ı
                // ezerdi (bulgu #1/#4/#5/#8/#10). KORU: havuzda DURAN (silinmemiş) bir öğenin overlay-içeriği
                // (parcalar/başlık/link override) snapshot'ta VARDI ama yeni build'de YOKSA -> YAZMA, zengin snapshot
                // korunur. Meşru silmeyi engellemez (silinen öğe build'de yoktur); açık boşaltma 10sn penceresinde izinli.
                // Yanlış-blok (nadir) içeriği KORUR, kaybı değil -> veri-kaybı fix'inde güvenli taraf.
                if (id && xRehidrateAcik()
                    && Object.keys(((window.__xEditorOverlay && window.__xEditorOverlay.byLink) || {})).length === 0
                    && !(window.__xManualClusters && window.__xManualClusters.length)
                    && !xBosaltIzni(id)) {   // K3/#9: açık-boşaltma rapor-id'ye bağlı
                    var _recC = null; try { _recC = await window.XSavedReports.get(id); } catch (e) {}
                    if (_recC) {
                        var _ovVar = function (o) { return !!(o && (o.parcalar || o.h2_override != null || o.h1_override != null || o.group_override || o.h1_ov || o.h2_ov)); };
                        var _recMap = {}; (_recC.items || []).forEach(function (_it) { if (_it && _it.link != null) _recMap[xOvKey(_it.link || '')] = _it; });
                        var _fakir = false;
                        for (var _ci = 0; _ci < (r.snapItems || []).length; _ci++) {
                            if (_ovVar(_recMap[xOvKey(r.snapItems[_ci].link || '')]) && !_ovVar(r.snapItems[_ci])) { _fakir = true; break; }
                        }
                        if (!_fakir && (_recC.manualClusters && _recC.manualClusters.length) && (r.snapItems || []).length) { _fakir = true; }   // eski-stil bloklar: snapshot'ta vardı, şimdi hiç yok -> hidre değil
                        if (_fakir) { xOtoKayitDurum('kaydedildi'); return; }   // FAKİR build -> sağlam snapshot KORUNUR
                    }
                }
                // Aktif id varsa O id'ye upsert; yoksa (oto-oluştur) TAZE id ver -> ad çakışması (aynı saniye
                // zaman-damgası) ad-bazlı upsert ile başka raporu EZMESİN.
                var _yeniMi = !id;
                var _kayitId = id || generateUUID();
                var meta = await window.XSavedReports.save({
                    id: _kayitId,
                    name: (id ? (window.__xActiveReportName || null) : (ad || xTarihSaatDamgasi())),
                    items: r.snapItems, images: r.images, blob: r.blob, filename: r.filename,
                    editorStyle: xBuildStyleOpts(), manualClusters: (window.__xManualClusters || [])
                });
                // Oto-oluştur: havuzda içerik vardı ama aktif rapor yoktu -> yeni rapor DOĞDU. Yalnız HÂLÂ
                // aktif yoksa benimse (bir yükleme bu arada aktifi kurduysa, içerik yine de kayıtlı kalır).
                if (_yeniMi && meta && meta.id && xAktifRaporId() === '') {
                    xAktifRaporKur(meta.id, meta.name, meta.slug, true);
                    if (typeof showToast === 'function') showToast('📄 Rapor oluşturuldu: ' + (meta.name || ''), 'success');
                    _xKayitToastTS = Date.now();   // hemen ardından throttle'lı "Kaydedildi" toast'ı bastır (çift olmasın)
                } else {
                    xOtoKayitDurum('kaydedildi');
                }
                await renderSavedReports();
            } catch (err) {
                console.error('Oto-kayıt hatası:', err); xOtoKayitDurum('hata');
            }
        }
        // ➕ Yeni Rapor (kuyruk): mevcut havuzu KAYBETMEDEN boş yeni aktif rapor oluştur.
        async function newReport() {
            // Oto-kayıt KAPALIysa (kaçış kapısı) havuz kalıcı değil -> dolu havuzu onaysız silme.
            if (!xOtoKayitAcik()) {
                var _curN = [];
                try { _curN = (await fetch('/api/pool/data').then(function (r) { return r.json(); })).items || []; } catch (e) {}
                if (_curN.length && typeof xConfirm === 'function') {
                    if (!(await xConfirm('Havuzda ' + _curN.length + ' içerik var ve kaydedilmedi. Yeni boş rapor açmak bunları siler. Devam edilsin mi?', { title: 'Yeni Rapor', icon: _XSVG_ARTI, okText: 'Devam', danger: true }))) return;
                }
            }
            return xSiraya(_newReportImpl);
        }
        window.newReport = newReport;
        async function _newReportImpl() {
            try {
                await window.XSavedReports.whenReady();
                await _xOtoKayitYapImpl();   // flush (DOĞRUDAN, zaten kuyruktayız): mevcut havuz/aktif rapor KAYBOLMASIN (gerekirse oto-oluşturur)
                try { await fetch('/api/manual/clear', { method: 'POST' }); } catch (e) {}
                window.__xEditorOverlay = { byLink: {}, style: null };
                window.__xManualClusters = [];
                try { if (window.XEditor) { window.XEditor.belge = { stil: {}, birimler: [] }; window.XEditor._dirty = false; } } catch (e) {}
                try { if (window.XLocalImages && window.XLocalImages.clear) { await window.XLocalImages.clear(); } } catch (e) {}
                window.accumulatedLinks = [];
                var inputEl = document.getElementById('tweet_links_input');
                if (inputEl) { inputEl.value = ''; if (typeof updateLinksPreview === 'function') { updateLinksPreview(); } if (typeof autoResizeTextarea === 'function') { autoResizeTextarea(inputEl); } }
                try { if (window.XEditor && window.XEditor.kapat) { window.XEditor.kapat(true); } } catch (e) {}
                window.lastManuelListJson = null; window.__xPoolDirty = false;
                xStandartStiliUygula();   // [STANDART STİL] yeni rapor DAİMA standart ayarlarla başlar (son stil sızmasın)
                var ad = xTarihSaatDamgasi();
                // TAZE id: flush bu arada aynı saniye zaman-damgalı bir rapor oto-oluşturmuş olabilir;
                // ad-bazlı kayıt onu EZMESİN -> yeni boş rapora benzersiz id ver.
                var meta = await window.XSavedReports.save({ id: generateUUID(), name: ad, items: [], images: {}, blob: null, filename: '', editorStyle: xBuildStyleOpts(), manualClusters: [] });
                xAktifRaporKur(meta.id, meta.name, meta.slug);   // Faz 3: URL /<slug> (push)
                xOtoKayitDurum('kaydedildi');
                await renderSavedReports();
                refreshStatus();
                showToast('Yeni boş rapor açıldı: ' + ad, 'success');
            } catch (err) {
                console.error('Yeni rapor hatası:', err);
                showToast('Yeni rapor oluşturulamadı: ' + (err && err.message ? err.message : err), 'danger');
            }
        }
        window.newReport = newReport;
        // "➕ Boş Rapor" (Raporlarım): yeni boş rapor oluştur + doğrudan Rapor Editörü'nü aç (Google-Docs tarzı).
        async function yeniRaporVeEditor() {
            try {
                await newReport();   // boş aktif rapor + havuzu temizle (kuyruk)
                if (window.XEditor && window.XEditor.ac) { window.XEditor.ac({ fresh: true }); }   // editörü boş havuzda aç
            } catch (e) { console.error('Yeni rapor+editör hatası:', e); }
        }
        window.yeniRaporVeEditor = yeniRaporVeEditor;
        // ✓ Kapat: açık raporu SİLMEDEN kapat. Son düzenlemeyi kaydeder, raporu AYIRIR (ÖNCE ayır -> sonra
        // havuzu temizle; böylece boşalan havuz rapora yazılmaz, rapor DOLU kalır), çalışma havuzunu/editörü
        // temizler. Rapor Raporlarım'da durur; karttan tekrar açılır. (Seri kuyruktan geçer -> yarış yok.)
        async function raporuKapat() {
            if (!xAktifRaporId()) { if (typeof showToast === 'function') showToast('Açık rapor yok.', 'warning'); return; }
            return xSiraya(_raporuKapatImpl);
        }
        window.raporuKapat = raporuKapat;
        async function _raporuKapatImpl() {
            try {
                await _xOtoKayitYapImpl();   // flush: son düzenlemeyi aktif rapora yaz (kuyruktayız -> doğrudan)
                xAktifRaporTemizle();         // ÖNCE ayır (+ URL '/') -> ardından gelen boş havuz rapora yazılmaz
                try { await fetch('/api/manual/clear', { method: 'POST' }); } catch (e) {}
                window.__xEditorOverlay = { byLink: {}, style: null }; window.__xManualClusters = [];
                try { if (window.XLocalImages && window.XLocalImages.clear) { await window.XLocalImages.clear(); } } catch (e) {}
                try { if (window.XEditor) { window.XEditor.belge = { stil: {}, birimler: [] }; window.XEditor._dirty = false; if (window.XEditor.kapat) window.XEditor.kapat(true); } } catch (e) {}
                window.accumulatedLinks = [];
                var inputEl = document.getElementById('tweet_links_input');
                if (inputEl) { inputEl.value = ''; if (typeof updateLinksPreview === 'function') { updateLinksPreview(); } if (typeof autoResizeTextarea === 'function') { autoResizeTextarea(inputEl); } }
                window.lastManuelListJson = null; window.__xPoolDirty = false;
                try { xStandartStiliUygula(); } catch (e) {}   // [STANDART STİL] rapor kapatılınca şerit standarda dönsün -> sonraki (oto-oluşan) rapor son stili devralmasın
                refreshStatus();
                await renderSavedReports();
                showToast('Rapor kapatıldı — Raporlarım bölümünde duruyor.', 'success');
            } catch (err) {
                console.error('Rapor kapatma hatası:', err);
                showToast('Kapatılamadı: ' + (err && err.message ? err.message : err), 'danger');
            }
        }
        // Üst çubuktaki aktif rapor adını çift-tıkla yeniden adlandır.
        async function xAktifRaporAdiDegistir() {
            var id = xAktifRaporId(); if (!id) return;
            try {
                var cur = window.__xActiveReportName || '';
                var yeni = await xPrompt('Rapor adı:', cur, { title: 'Yeniden Adlandır', icon: _XSVG_KALEM, okText: 'Kaydet' });
                if (yeni === null) return;
                yeni = (yeni || '').trim(); if (!yeni) return;
                await window.XSavedReports.whenReady();
                // KUYRUK: uçuştaki oto-kayıtla META yazma yarışı olmasın (rename aksi halde ezilebilir).
                var rmeta = await xSiraya(function () { return window.XSavedReports.rename(id, yeni); });
                xAktifRaporKur(id, yeni, (rmeta && rmeta.slug) || null, true);   // URL yeni slug'a (replace)
                await renderSavedReports();
                showToast('Rapor adı güncellendi: ' + yeni, 'success');
            } catch (e) { showToast('Ad değiştirilemedi: ' + (e && e.message ? e.message : e), 'danger'); }
        }
        window.xAktifRaporAdiDegistir = xAktifRaporAdiDegistir;
        // [RAPOR ADI] Editör üst çubuğundaki inline alandan rapor adını kaydet (PROMPT YOK): rename + URL /<slug> + liste.
        // Enter veya blur (başka yere tıklama) çağırır. Boş/aynı ise mevcut ada geri döner (no-op). Arka planda snapshot'a yazılır.
        async function xEdRaporAdiKaydet(yeni) {
            var id = xAktifRaporId();
            var input = document.getElementById('ed-rapor-adi');
            var cur = window.__xActiveReportName || '';
            yeni = (yeni || '').trim();
            if (!id || !yeni || yeni === cur) { if (input) input.value = cur; return; }
            try {
                await window.XSavedReports.whenReady();
                // KUYRUK: uçuştaki oto-kayıtla META yazma yarışı olmasın (rename ezilmesin).
                var rmeta = await xSiraya(function () { return window.XSavedReports.rename(id, yeni); });
                xAktifRaporKur(id, yeni, (rmeta && rmeta.slug) || null, true);   // ad + adres çubuğu /<slug> (replace)
                if (input && document.activeElement !== input) input.value = window.__xActiveReportName || yeni;
                try { await renderSavedReports(); } catch (e) {}
            } catch (e) {
                if (input) input.value = cur;   // hata -> eski ada dön
                if (typeof showToast === 'function') showToast('Ad değiştirilemedi: ' + (e && e.message ? e.message : e), 'danger');
            }
        }
        window.xEdRaporAdiKaydet = xEdRaporAdiKaydet;
        // [RAPOR ADI] Editör açılınca / ad başka yerden değişince input'u aktif rapor adıyla doldur (kullanıcı yazarken EZME).
        function xEdRaporAdiDoldur() {
            var input = document.getElementById('ed-rapor-adi'); if (!input) return;
            if (document.activeElement === input) return;
            input.value = window.__xActiveReportName || '';
        }
        window.xEdRaporAdiDoldur = xEdRaporAdiDoldur;
        // Panel "💾 Kaydet" (indirmez): ad sor -> snapshot -> havuzu temizle.
        async function savePoolReport() {
            var btn = document.getElementById('save-btn');
            try {
                var _res0 = await fetch('/api/pool/data'); var _d0 = await _res0.json();
                var _manVar = !!(window.__xManualClusters && window.__xManualClusters.length);
                if (!((_d0 && _d0.items && _d0.items.length) || _manVar)) { showToast('İçerik yok — kaydedilecek bir şey yok.', 'warning'); return; }
                var def = (window.__openReportName && window.__openReportName.trim()) ? window.__openReportName : xTarihSaatDamgasi();
                var name = await xPrompt('Rapor için bir ad girin:', def, { title: 'Kaydet', icon: _XSVG_KAYDET, okText: 'Kaydet' });
                if (name === null) return;
                name = (name || '').trim() || def;
                if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Kaydediliyor...'; }
                var ok = await window.xSnapshotReport(name);
                if (ok) showToast('Panele kaydedildi, havuz sıfırlandı: ' + name, 'success');
            } catch (err) {
                console.error('Kaydet hatası:', err);
                showToast('Kaydedilemedi: ' + (err && err.message ? err.message : err) + ' — havuz korundu.', 'danger');
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = '💾 Kaydet'; }
            }
        }
        // Panel "📥 İndir" (kaydetmez/temizlemez): havuzdan .docx üret ve indir.
        async function downloadPoolReport() {
            var btn = document.getElementById('download-btn');
            try {
                var def = (window.__openReportName && window.__openReportName.trim()) ? window.__openReportName : xTarihSaatDamgasi();
                if (btn) { btn.disabled = true; btn.innerHTML = '⏳ İndiriliyor...'; }
                var r = await xBuildReport(def);
                if (!r) { showToast('İçerik yok — indirilecek bir şey yok.', 'warning'); return; }
                xTriggerDownload(r.blob, r.filename);
                showToast('Word indirildi: ' + r.filename, 'success');
            } catch (err) {
                console.error('İndir hatası:', err);
                showToast('İndirilemedi: ' + (err && err.message ? err.message : err), 'danger');
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = '📥 İndir'; }
            }
        }

        function xKalanSureMetni(updatedAt) {
            var kalan = Math.max(0, (updatedAt || 0) + X_SAVED_REPORT_TTL_MS - Date.now());
            var gun = Math.floor(kalan / (24 * 3600 * 1000));
            var saat = Math.floor((kalan % (24 * 3600 * 1000)) / (3600 * 1000));
            if (gun > 0) return gun + ' gün ' + saat + ' saat';
            if (saat > 0) return saat + ' saat';
            return '<1 saat';
        }
        // Havuz (manual-list-section) goruntusune yumusak kaydir (Ac/Birlestir sonrasi kullaniciyi havuza goturur).
        function xHavuzaKaydir() {
            setTimeout(function () {
                try {
                    var hv = document.getElementById('manual-list-section');
                    if (hv && hv.style.display !== 'none') { hv.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
                } catch (e) {}
            }, 500);
        }
        // "Mevcut Bir Word Dosyasını Yeniden Biçimlendirin" aracı açılır-kapanır (accordion, varsayılan KAPALI).
        function xToggleWordArac() {
            var g = document.getElementById('word-arac-govde');
            var ok = document.getElementById('word-arac-ok');
            if (!g) return;
            var acik = g.style.display !== 'none';
            g.style.display = acik ? 'none' : 'block';
            if (ok) { ok.style.transform = acik ? 'rotate(0deg)' : 'rotate(90deg)'; }
        }
        // Sekme adindaki kayitli-rapor sayaci: n>0 ise yuvarlak rozette goster, 0'da gizle.
        function xUpdateSavedBadge(n) {
            var b = document.getElementById('saved-count-badge');
            if (!b) return;
            if (n > 0) { b.textContent = String(n); b.style.display = ''; }
            else { b.style.display = 'none'; }
        }
        // Faz 4: Raporlarım = Google-Dokümanlar tarzı KART GALERİSİ. İlk kart "➕ Boş Rapor";
        // her rapor kartı: sahte "sayfa" küçük görünümü + ad (çift-tık yeniden adlandır) + tarih/sayı
        // + İndir/Sil ikonları (hover) + birleştirme kutusu + aktif rozeti. Karta tıkla = Aç.
        // Tek-renk (currentColor) SVG ikonlar -> kart indir/sil butonları temaya uyar.
        var _SVG_INDIR = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v10"/><path d="M6 9.5l4 3.5 4-3.5"/><path d="M4.5 16.5h11"/></svg>';
        var _SVG_SIL = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 6h11"/><path d="M8 6V4.5h4V6"/><path d="M6 6l.7 10h6.6L14 6"/><path d="M8.6 9v4M11.4 9v4"/></svg>';
        // Kart içerik önizlemesi (Google-Docs tarzı küçük sayfa). meta.preview yoksa (eski kayıt) bir kez
        // get() ile hesapla + updatedAt'e göre önbellekle (blob tekrar tekrar okunmasın).
        var _xOnizlemeCache = {};
        async function xRaporOnizleme(m) {
            if (m && m.preview) return m.preview;
            if (!m) return [];
            var c = _xOnizlemeCache[m.id];
            if (c && c.u === m.updatedAt) return c.p;
            var p = [];
            try { var full = await window.XSavedReports.get(m.id); p = (window.XSavedReports.buildPreview ? await window.XSavedReports.buildPreview({ items: (full && full.items) || [], images: (full && full.images) || {} }) : []); } catch (e) {}
            _xOnizlemeCache[m.id] = { u: m.updatedAt, p: p };
            return p;
        }
        function xGalOnizlemeHtml(prev) {
            if (!prev || !prev.length) return '<div class="x-gal-pbos">Boş rapor</div>';
            var s = '';
            for (var i = 0; i < prev.length && i < 8; i++) {
                var ln = prev[i] || {};
                if (ln.t === 'h') { s += '<div class="x-gal-pbaslik">' + escapeHtml(ln.s || '') + '</div>'; }
                else if (ln.t === 'img') { s += '<img class="x-gal-pimg" src="' + (ln.s || '') + '" alt="">'; }
                else { s += '<div class="x-gal-pmetin">' + escapeHtml(ln.s || '') + '</div>'; }
            }
            return s;
        }
        async function renderSavedReports() {
            var section = document.getElementById('saved-reports-section');
            var container = document.getElementById('saved-reports-list');
            if (!container) return;
            try { await window.XSavedReports.whenReady(); } catch (e) {}
            var metas = [];
            try { metas = await window.XSavedReports.list(); } catch (e) { metas = []; }
            xUpdateSavedBadge(metas.length);   // sekme adindaki sayaci guncelle (0'da gizli)
            if (section) section.style.display = '';   // galeri HER ZAMAN görünür (boşken bile "Boş Rapor" kartı)
            var aktifId = (typeof xAktifRaporId === 'function') ? xAktifRaporId() : '';
            // Önizlemeleri topla (meta.preview varsa anında; eski kayıtta lazy get, önbellekli).
            var previews = [];
            for (var qi = 0; qi < metas.length; qi++) { previews.push(await xRaporOnizleme(metas[qi])); }
            // İlk kart: Boş Rapor
            var html = '<div class="x-gal-grid">' +
                '<div class="x-gal-card" onclick="yeniRaporVeEditor()" title="Yeni rapor oluştur ve editörü aç">' +
                    '<div class="x-gal-yeni"><span class="x-gal-arti">+</span><span style="font-size:13px; font-weight:600;">Yeni Rapor</span></div>' +
                '</div>';
            html += metas.map(function (m, idx) {
                var tarih = '';
                try { tarih = new Date(m.updatedAt || 0).toLocaleDateString('tr-TR'); } catch (e) { tarih = ''; }
                var adEsc = escapeHtml(m.name || '(adsız)');
                var aktif = (m.id === aktifId);
                return '<div class="x-gal-card' + (aktif ? ' aktif' : '') + '" data-rid="' + m.id + '" onclick="xGalAc(event,this)" title="Aç">' +
                    '<div class="x-gal-page">' +
                        '<input type="checkbox" class="x-sr-check x-gal-check" data-rid="' + m.id + '" onclick="event.stopPropagation()" onchange="xUpdateMergeBtn()" title="Seç (toplu işlem)">' +
                        (aktif ? '<span class="x-gal-rozet">● Açık</span>' : '') +
                        '<div class="x-gal-pageinner">' + xGalOnizlemeHtml(previews[idx]) + '</div>' +
                        '<div class="x-gal-ara">' +
                            '<button class="x-gal-ikon" data-rid="' + m.id + '" onclick="xGalIndir(event,this)" title="İndir">' + _SVG_INDIR + '</button>' +
                            '<button class="x-gal-ikon" data-rid="' + m.id + '" onclick="xGalSil(event,this)" title="Sil">' + _SVG_SIL + '</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="x-gal-meta">' +
                        '<div class="x-gal-ad" data-rid="' + m.id + '" onclick="event.stopPropagation()" ondblclick="xGalRename(event,this)" title="Çift tıkla: adı düzenle (Enter ya da başka yere tıkla = kaydet)">' + adEsc + '</div>' +
                        '<div class="x-gal-alt">' + (m.itemCount || 0) + ' · ' + tarih + '</div>' +
                    '</div>' +
                '</div>';
            }).join('');
            html += '</div>';
            container.innerHTML = html;
            xUpdateMergeBtn();   // liste yeniden cizildi -> secim sifirlandi, çubuğu güncelle
        }
        // Kart olay yardımcıları (iç butonlar/kutu stopPropagation ile kart-tıkla=Aç'ı engeller).
        function xGalAc(ev, el) { try { if (el && el.dataset && el.dataset.rid) openSavedReport(el.dataset.rid, { editorBosAc: true }); } catch (e) {} }
        function xGalIndir(ev, el) { if (ev) ev.stopPropagation(); try { downloadSavedReport(el.dataset.rid); } catch (e) {} }
        function xGalSil(ev, el) { if (ev) ev.stopPropagation(); try { deleteSavedReport(el.dataset.rid); } catch (e) {} }
        // [KART ADI INLINE] Çift tıkla -> POPUP YOK, adı yerinde düzenle (contenteditable). Enter ya da başka yere
        // tıklama (blur) = kaydet; Escape = iptal. Boş/aynı -> eski ada döner.
        function xGalRename(ev, el) {
            if (ev) ev.stopPropagation();
            if (!el || el._xDuzenle) return;
            var id = el.dataset.rid;
            var cur = (el.textContent || '').trim();
            el._xDuzenle = true;
            el.setAttribute('contenteditable', 'true');
            el.classList.add('x-gal-ad-edit');
            el.focus();
            try { var rng = document.createRange(); rng.selectNodeContents(el); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rng); } catch (e) {}
            var _bitti = false;
            function _son(kaydet) {
                if (_bitti) return; _bitti = true;
                el.removeAttribute('contenteditable'); el.classList.remove('x-gal-ad-edit'); el._xDuzenle = false;
                var yeni = (el.textContent || '').trim();
                if (!kaydet || !yeni || yeni === cur) { el.textContent = cur; return; }   // iptal/boş/aynı -> eski ad
                el.textContent = yeni;
                xGalRenameUygula(id, yeni, cur);   // arka planda kalıcılaştır
            }
            el.addEventListener('keydown', function kd(e) {
                if (e.key === 'Enter') { e.preventDefault(); el.removeEventListener('keydown', kd); el.blur(); }
                else if (e.key === 'Escape') { e.preventDefault(); el.removeEventListener('keydown', kd); _son(false); }
            });
            el.addEventListener('blur', function ob() { el.removeEventListener('blur', ob); _son(true); });
        }
        async function xGalRenameUygula(id, yeni, cur) {
            try {
                // KUYRUK: uçuştaki oto-kayıtla META yazma yarışı olmasın.
                var rmeta2 = await xSiraya(function () { return window.XSavedReports.rename(id, yeni); });
                if (window.__openReportName && cur && window.__openReportName === cur) { window.__openReportName = yeni; }
                if (typeof xAktifRaporId === 'function' && xAktifRaporId() === id) { xAktifRaporKur(id, yeni, (rmeta2 && rmeta2.slug) || null, true); }   // aktif raporsa çubuğu + URL'i güncelle
                await renderSavedReports();
            } catch (err) {
                showToast('Yeniden adlandırma hatası: ' + (err && err.message ? err.message : err), 'danger');
                try { await renderSavedReports(); } catch (e) {}
            }
        }
        window.xGalAc = xGalAc; window.xGalIndir = xGalIndir; window.xGalSil = xGalSil; window.xGalRename = xGalRename;
        // --- Seçim eylem çubuğu (alttan belirir): Birleştir / İndir / Sil ---
        function xSecimIdler() {
            var chks = document.querySelectorAll('.x-sr-check:checked'); var ids = [];
            for (var i = 0; i < chks.length; i++) { var r = chks[i].getAttribute('data-rid'); if (r) ids.push(r); }
            return ids;
        }
        function xUpdateMergeBtn() {   // (ad korundu: renderSavedReports + onchange çağırıyor) -> seçim çubuğunu güncelle
            var n = document.querySelectorAll('.x-sr-check:checked').length;
            var bar = document.getElementById('x-secim-bar');
            if (bar) { if (n > 0) { bar.classList.add('acik'); } else { bar.classList.remove('acik'); } }
            var sayi = document.getElementById('x-secim-sayi'); if (sayi) { sayi.textContent = n + ' seçili'; }
            var mb = document.getElementById('x-secim-birlestir'); if (mb) { mb.disabled = (n < 2); mb.title = (n < 2) ? 'Birleştirmek için en az 2 rapor seç' : 'Seçili raporları tek rapora birleştir'; }
        }
        window.xUpdateMergeBtn = xUpdateMergeBtn;
        function xSecimTemizle() {
            var chks = document.querySelectorAll('.x-sr-check:checked');
            for (var i = 0; i < chks.length; i++) { chks[i].checked = false; }
            xUpdateMergeBtn();
        }
        window.xSecimTemizle = xSecimTemizle;
        async function downloadSelectedReports() {
            var ids = xSecimIdler();
            if (!ids.length) { return; }
            for (var i = 0; i < ids.length; i++) { try { await downloadSavedReport(ids[i]); } catch (e) {} await new Promise(function (r) { setTimeout(r, 400); }); }
        }
        window.downloadSelectedReports = downloadSelectedReports;
        async function deleteSelectedReports() {
            var ids = xSecimIdler();
            if (!ids.length) { return; }
            if (!(await xConfirm(ids.length + ' raporu silmek istediğine emin misin? Bu işlem geri alınamaz.', { title: 'Seçilenleri Sil', icon: _XSVG_COP, okText: 'Sil', danger: true }))) return;
            for (var i = 0; i < ids.length; i++) {
                try { await xSiraya((function (rid) { return function () { return _deleteSavedReportImpl(rid); }; })(ids[i])); } catch (e) {}
            }
            showToast(ids.length + ' rapor silindi.', 'success');
            await renderSavedReports();
        }
        window.deleteSelectedReports = deleteSelectedReports;
        async function downloadSavedReport(id) {
            try {
                var rec = await window.XSavedReports.getBlob(id);
                if (!rec || !rec.blob) { showToast('Kayıtlı dosya bulunamadı.', 'danger'); return; }
                var url = window.URL.createObjectURL(rec.blob);
                var a = document.createElement('a');
                a.href = url; a.download = rec.filename || 'GörüntüX.docx';
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(function () { try { window.URL.revokeObjectURL(url); } catch (e) {} }, 4000);
                showToast('İndiriliyor: ' + (rec.filename || ''), 'success');
            } catch (err) {
                showToast('İndirme hatası: ' + (err && err.message ? err.message : err), 'danger');
            }
        }
        async function deleteSavedReport(id) {
            if (!(await xConfirm('Bu kayıtlı raporu silmek istediğine emin misin? Bu işlem geri alınamaz.', { title: 'Raporu Sil', icon: _XSVG_COP, okText: 'Sil', danger: true }))) return;
            return xSiraya(function () { return _deleteSavedReportImpl(id); });   // kuyruk: in-flight oto-kayıt BİTMİŞ olur -> silinen rapor dirilmez
        }
        async function _deleteSavedReportImpl(id) {
            try {
                var _aktifti = (xAktifRaporId() === id);
                await window.XSavedReports.remove(id);
                // Faz 2: silinen rapor AKTİFse çalışma havuzunu da boşalt + aktif bağlamı bırak (dirilme olmasın).
                if (_aktifti) {
                    xAktifRaporTemizle();   // aktif bağlam + URL '/'
                    try { await fetch('/api/manual/clear', { method: 'POST' }); } catch (e) {}
                    window.__xEditorOverlay = { byLink: {}, style: null }; window.__xManualClusters = [];
                    try { if (window.XLocalImages && window.XLocalImages.clear) { await window.XLocalImages.clear(); } } catch (e) {}
                    try { if (window.XEditor) { window.XEditor.belge = { stil: {}, birimler: [] }; window.XEditor._dirty = false; if (window.XEditor.kapat) window.XEditor.kapat(true); } } catch (e) {}
                    window.lastManuelListJson = null; window.__xPoolDirty = false;
                    refreshStatus();
                }
                showToast('Kayıtlı rapor silindi.', 'success');
                await renderSavedReports();
            } catch (err) {
                showToast('Silme hatası: ' + (err && err.message ? err.message : err), 'danger');
            }
        }

        // Faz B: kayitli raporu CALISMA HAVUZUNA geri yukle -> mevcut arayuzle duzenle -> tekrar kaydet.
        // Yeni sunucu ucu YOK: mevcut /api/manual/clear + /api/manual/add (local:true) kullanilir;
        // gorseller X_RAPOR_LOCAL_IMAGE postMessage'iyle XLocalImages'a geri yuklenir (canli havuzun
        // AYNI mekanizmasi). Sira korunur (ogeler SIRAYLA await edilir). baslik_formatla + x_temizle_link
        // idempotent oldugu icin snapshot'i manual_add'e geri gondermek guvenli.
        // Faz 3 (düzeltme): bir raporun URL slug'ını çöz. Kayıtta slug YOKSA (eski/Faz-3-öncesi kayıt)
        // BENZERSİZ bir slug atayıp KALICILAŞTIR (rename aynı adla _uniqueSlug hesaplar) -> aynı adlı iki
        // eski kayıtta adres çubuğu getBySlug ile hep DOĞRU rapora dönsün. Son çare: ad'dan türet.
        async function xRaporSlugCoz(id, rec) {
            if (rec && rec.slug) return rec.slug;
            try { var _hm = await window.XSavedReports.rename(id, (rec && rec.name) || ''); if (_hm && _hm.slug) return _hm.slug; } catch (e) {}
            return (window.XSavedReports && window.XSavedReports.slugify) ? window.XSavedReports.slugify((rec && rec.name) || '') : null;
        }
        function openSavedReport(id, opts) { return xSiraya(function () { return _openSavedReportImpl(id, opts); }); }   // kuyruk: çift-açılış/yarış yok
        window.openSavedReport = openSavedReport;
        async function _openSavedReportImpl(id, opts) {
            opts = opts || {};
            try {
                // Oto-kayıt AÇIK: rapor değiştirmeden/yeniden yüklemeden ÖNCE mevcut havuzu/aktif raporu
                // KALICILAŞTIR (farklı rapor -> eski aktifi kaydet; aynı rapor -> son düzenlemeyi kaydet;
                // aktif yok ama havuz dolu -> oto-oluştur). Zaten kuyruktayız -> impl'i DOĞRUDAN çağır.
                if (xOtoKayitAcik()) { await _xOtoKayitYapImpl(); }
                var rec = await window.XSavedReports.get(id);
                if (!rec) { showToast('Kayıtlı rapor bulunamadı.', 'danger'); return; }   // Faz 2: BOŞ rapor da açılabilir (aktif olur)
                if (!rec.items) { rec.items = []; }
                // Oto-kayıt KAPALIysa (kaçış kapısı) eski "değişiklik kaybolur" uyarısı.
                if (!xOtoKayitAcik()) {
                    var curItems = [];
                    try { curItems = (await fetch('/api/pool/data').then(function (r) { return r.json(); })).items || []; } catch (e) {}
                    if (curItems.length) {
                        if (!(await xConfirm('Havuzda şu an ' + curItems.length + ' içerik var. "' + (rec.name || '') + '" raporunu açmak havuzu bununla DEĞİŞTİRİR (kaydedilmemiş değişiklikler kaybolur). Devam edilsin mi?', { title: 'Raporu Aç', icon: _XSVG_ACAC, okText: 'Aç ve Değiştir', danger: true }))) return;
                    }
                }
                // 1) Havuzu + yerel gorselleri temizle (temiz "acilis" durumu)
                await fetch('/api/manual/clear', { method: 'POST' });
                if (window.XLocalImages && window.XLocalImages.clear) { try { await window.XLocalImages.clear(); } catch (e) {} }
                // 2) Gorselleri XLocalImages'a geri yukle (link'e gore; put yolu = postMessage)
                var imgs = rec.images || {};
                for (var i = 0; i < rec.items.length; i++) {
                    var lk = rec.items[i].link || '';
                    var k = window.XLocalImages ? window.XLocalImages.normLink(lk) : lk;
                    if (imgs[k] && imgs[k].dataUrl) {
                        window.postMessage({ type: 'X_RAPOR_LOCAL_IMAGE', link: lk, dataUrl: imgs[k].dataUrl, mime: imgs[k].mime || '' }, '*');
                    }
                }
                // 3) Ogeleri havuza SIRAYLA geri yaz (sira korunsun; local:true -> gorsel sunucuya gitmez)
                for (var j = 0; j < rec.items.length; j++) {
                    var it = rec.items[j];
                    var body = { title: it.title || '', link: it.link || '', local: true };
                    if (it.is_profile) { body.is_profile = true; }
                    if (it.group_override) { body.group_override = it.group_override; }
                    await fetch('/api/manual/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                }
                // 4b) Faz 5: editör overlay'ini snapshot'tan doldur (parcalar manual_add'den geçmez) + stili geri uygula.
                var _ov2 = { byLink: {}, style: rec.editorStyle || null };
                for (var pi = 0; pi < rec.items.length; pi++) {
                    var _it2 = rec.items[pi];
                    if (_it2 && (_it2.parcalar || _it2.h2_override != null || _it2.group_override != null || _it2.h1_override != null || _it2.h1_ov || _it2.h2_ov)) { _ov2.byLink[xOvKey(_it2.link || '')] = { parcalar: _it2.parcalar || null, h2: (_it2.h2_override != null ? _it2.h2_override : null), grup: (_it2.group_override != null ? _it2.group_override : null), h1over: (_it2.h1_override != null ? _it2.h1_override : null), h1ov: (_it2.h1_ov || null), h2ov: (_it2.h2_ov || null) }; }
                }
                window.__xEditorOverlay = _ov2;
                window.__xManualClusters = (rec.manualClusters || []);   // #2: manuel blokları geri yükle
                try { if (window.XEditor) { window.XEditor.belge = { stil: {}, birimler: [] }; } } catch (e) {}   // bayat belge temizle; sonraki Önizle havuzdan + overlay'den kurar
                if (rec.editorStyle) { xApplyStyleOpts(rec.editorStyle); }
                // 4) Faz 2: açılan rapor AKTİF olur (oto-kayıt bundan sonra buna yazar). Faz 3: URL /<slug>
                // (eski/slug'sız kayıtta benzersiz slug atanıp kalıcılaşır -> getBySlug hep doğru rapora döner).
                xAktifRaporKur(id, rec.name || '', await xRaporSlugCoz(id, rec), !!opts.urlReplace);
                xOtoKayitDurum('kaydedildi');
                refreshStatus();
                await renderSavedReports();
                xHavuzaKaydir();   // havuz bu sekmede acildi -> kullaniciyi ona goturur
                // BOŞ rapor (havuzda içerik yok) -> editörü OTOMATİK aç; aksi halde pool aksiyonları
                // (Önizle=editör) görünmez olduğu için boş rapora bir daha editör açılamıyordu.
                var _bosRapor = !(rec.items && rec.items.length) && !(rec.manualClusters && rec.manualClusters.length);
                if (opts.editorBosAc && _bosRapor) { try { if (window.XEditor && window.XEditor.ac) { window.XEditor.ac({ fresh: true }); } } catch (e) {} }
                showToast('Rapor açıldı: ' + (rec.name || '') + (_bosRapor ? ' — boş (düzenlemeye başla)' : ' — ' + rec.items.length + ' içerik'), 'success');
            } catch (err) {
                console.error('Rapor açma hatası:', err);
                showToast('Rapor açılamadı: ' + (err && err.message ? err.message : err), 'danger');
            }
        }

        // Faz C: SECILI raporlari CALISMA HAVUZUNDA birlestir (openSavedReport'un cok-rapor hali).
        // Havuz bir kez temizlenir, sonra secili raporlar SIRAYLA havuza eklenir. DEDUP: her oge
        // manual_add'e dedup:true ile gider -> sunucu normalize_link_key ile onceki raporlardan geleni
        // atlar (gorsel de yalniz "success"te yuklenir -> atlanan tekrarin gorseli orphan olmaz).
        // Kullanici karari: yukle+gozden gecir; sonlandirma mevcut "Kaydet ve Indir" ile. Kaynaklar KORUNUR.
        async function mergeSelectedReports() {
            var checks = document.querySelectorAll('.x-sr-check:checked');
            var ids = [];
            for (var c = 0; c < checks.length; c++) { var r = checks[c].getAttribute('data-rid'); if (r) { ids.push(r); } }
            if (ids.length < 2) { showToast('Birleştirmek için en az 2 rapor seçin.', 'warning'); return; }
            // Oto-kayıt KAPALIysa (kaçış kapısı) dolu havuzu onaysız değiştirme.
            if (!xOtoKayitAcik()) {
                var _curM = [];
                try { _curM = (await fetch('/api/pool/data').then(function (r) { return r.json(); })).items || []; } catch (e) {}
                if (_curM.length && typeof xConfirm === 'function') {
                    if (!(await xConfirm('Havuzda şu an ' + _curM.length + ' içerik var. Seçili ' + ids.length + ' raporu birleştirmek havuzu bunlarla DEĞİŞTİRİR (kaydedilmemiş değişiklikler kaybolur). Devam edilsin mi?', { title: 'Raporları Birleştir', icon: _XSVG_ZINCIR, okText: 'Birleştir', danger: true }))) return;
                }
            }
            return xSiraya(function () { return _mergeSelectedReportsImpl(ids); });   // kuyruk: yarış/dirilme yok
        }
        async function _mergeSelectedReportsImpl(ids) {
            try {
                // Oto-kayıt AÇIK: mevcut havuzu/aktifi flush (DOĞRUDAN, kuyruktayız) -> KAYBOLMASIN; sonra AYIR
                // (birleşik sonuç tek kaynağa bağlı değil) -> havuz dolunca poll YENİ rapor OTO-OLUŞTURUR.
                if (xOtoKayitAcik()) { await _xOtoKayitYapImpl(); xAktifRaporTemizle(); }
                // Havuzu + yerel gorselleri BIR KEZ temizle
                await fetch('/api/manual/clear', { method: 'POST' });
                if (window.XLocalImages && window.XLocalImages.clear) { try { await window.XLocalImages.clear(); } catch (e) {} }
                var eklenen = 0, atlanan = 0, raporSay = 0;
                var _ovM = { byLink: {}, style: null };   // Faz 5: birleşik raporun editör overlay'i (ilk gelen kazanır)
                var _mcAll = [];   // #2: birleştirilen raporların manuel blokları
                for (var i = 0; i < ids.length; i++) {
                    var rec = await window.XSavedReports.get(ids[i]);
                    if (!rec || !rec.items || !rec.items.length) { continue; }
                    raporSay++;
                    if (rec.manualClusters && rec.manualClusters.length) { _mcAll = _mcAll.concat(rec.manualClusters); }
                    var imgs = rec.images || {};
                    for (var j = 0; j < rec.items.length; j++) {
                        var it = rec.items[j];
                        var lk = it.link || '';
                        var body = { title: it.title || '', link: lk, local: true, dedup: true };
                        if (it.is_profile) { body.is_profile = true; }
                        if (it.group_override) { body.group_override = it.group_override; }
                        var resp = await fetch('/api/manual/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
                            .then(function (r) { return r.json(); }).catch(function () { return {}; });
                        if (resp && resp.status === 'success') {
                            eklenen++;
                            var k = window.XLocalImages ? window.XLocalImages.normLink(lk) : lk;
                            if (imgs[k] && imgs[k].dataUrl) {
                                window.postMessage({ type: 'X_RAPOR_LOCAL_IMAGE', link: lk, dataUrl: imgs[k].dataUrl, mime: imgs[k].mime || '' }, '*');
                            }
                            // Faz 5/6: bu öğenin parçaları/başlık-override'ı varsa overlay'e taşı (dedup'ta başta eklenen korunur).
                            var _mk = xOvKey(lk);
                            if ((it.parcalar || it.h2_override != null || it.group_override != null || it.h1_override != null || it.h1_ov || it.h2_ov) && !_ovM.byLink[_mk]) { _ovM.byLink[_mk] = { parcalar: it.parcalar || null, h2: (it.h2_override != null ? it.h2_override : null), grup: (it.group_override != null ? it.group_override : null), h1over: (it.h1_override != null ? it.h1_override : null), h1ov: (it.h1_ov || null), h2ov: (it.h2_ov || null) }; }
                            if (!_ovM.style && rec.editorStyle) { _ovM.style = rec.editorStyle; }
                        } else if (resp && resp.status === 'duplicate') {
                            atlanan++;
                        }
                    }
                }
                window.__xEditorOverlay = _ovM;   // Faz 5: birleşik overlay'i kur
                window.__xManualClusters = _mcAll;   // #2: birleşik manuel bloklar
                try { if (window.XEditor) { window.XEditor.belge = { stil: {}, birimler: [] }; } } catch (e) {}
                if (_ovM.style) { xApplyStyleOpts(_ovM.style); }   // Faz 6 (Finding 5): ilk kaynağın stilini geri uygula
                window.__openReportName = '';   // birlesik = YENI rapor (tek kaynaga bagli degil)
                refreshStatus();
                await renderSavedReports();
                xHavuzaKaydir();   // birlesik havuz bu sekmede acildi -> kullaniciyi ona goturur
                var msg = raporSay + ' rapor birleştirildi — ' + eklenen + ' içerik havuza yüklendi';
                if (atlanan > 0) { msg += ' (' + atlanan + ' tekrar atlandı)'; }
                msg += xOtoKayitAcik() ? '. Yeni rapor olarak otomatik kaydedildi (üst çubuktan adlandır).' : '. Gözden geçirip "💾 Kaydet" ile kaydedin (İndir ayrı).';
                showToast(msg, 'success');
            } catch (err) {
                console.error('Birleştirme hatası:', err);
                showToast('Birleştirme başarısız: ' + (err && err.message ? err.message : err), 'danger');
            }
        }
        async function renameSavedReport(id) {
            try {
                var metas = await window.XSavedReports.list();
                var m = null; for (var i = 0; i < metas.length; i++) { if (metas[i].id === id) { m = metas[i]; break; } }
                var cur = (m && m.name) || '';
                var yeni = await xPrompt('Yeni rapor adı:', cur, { title: 'Yeniden Adlandır', icon: _XSVG_KALEM, okText: 'Kaydet' });
                if (yeni === null) return;
                yeni = (yeni || '').trim();
                if (!yeni) { showToast('Ad boş olamaz.', 'warning'); return; }
                // KUYRUK: uçuştaki oto-kayıtla META yazma yarışı olmasın.
                var rmeta2 = await xSiraya(function () { return window.XSavedReports.rename(id, yeni); });
                if (window.__openReportName && cur && window.__openReportName === cur) { window.__openReportName = yeni; }
                if (typeof xAktifRaporId === 'function' && xAktifRaporId() === id) { xAktifRaporKur(id, yeni, (rmeta2 && rmeta2.slug) || null, true); }   // Faz 2/3: aktif raporsa çubuğu + URL'i güncelle
                showToast('Yeniden adlandırıldı: ' + yeni, 'success');
                await renderSavedReports();
            } catch (err) {
                showToast('Yeniden adlandırma hatası: ' + (err && err.message ? err.message : err), 'danger');
            }
        }
        // Oturum hatırlatması bandı (kullanıcı isteği): kapatılabilir; kapatılınca localStorage'a
        // yazılır ve bir daha gösterilmez. Yalnız Otomatik sekmesindeki #login-reminder.
        function dismissLoginReminder() {
            try {
                var el = document.getElementById('login-reminder');
                if (el) { el.style.display = 'none'; }
                localStorage.setItem('x_login_reminder_dismissed', '1');
            } catch (e) {}
        }
        function xInitLoginReminder() {
            try {
                if (localStorage.getItem('x_login_reminder_dismissed') === '1') { return; }
                var el = document.getElementById('login-reminder');
                if (el) { el.style.display = 'block'; }
            } catch (e) {}
        }
        function xInitSavedReports() {
            try {
                // [VERİ KAYBI FİX] Yükleme-nöbetçisini EN BAŞTA SENKRON kur (xInitSavedReports, refreshStatus'tan
                // ÖNCE çağrılır: satır ~2910 vs ~2919) -> uzlaştırma overlay'i snapshot'tan geri kurana dek oto-kayıt
                // ERTELENİR, boş overlay sağlam snapshot'ı ezemez (bulgu #3/#15). Bekleyen timer'ı da iptal et.
                if (xRehidrateAcik() && xOtoKayitAcik()) {
                    try { window.__xRaporYukleniyor = true; } catch (e) {}
                    try { if (_xOtoKayitTimer) { clearTimeout(_xOtoKayitTimer); _xOtoKayitTimer = null; } } catch (e) {}
                    // GÜVENLİK AĞI (bulgu #16): nöbetçi hata/olay-gelmeme yolunda takılıp oto-kaydı KALICI
                    // kapatmasın -> en geç 10sn sonra kesin temizle.
                    try { setTimeout(function () { try { window.__xRaporYukleniyor = false; } catch (e) {} }, 10000); } catch (e) {}
                }
                try { xOtoKayitUICiz(); } catch (e) {}   // Faz 2: oto-kayıt açıkken elle "Kaydet" butonunu gizle
                // [SINIRSIZ] Raporlar artık süreyle silinmez (1 hafta TTL kaldırıldı).
                // x-saved-reports.js AYRI <script src> -> DOMContentLoaded'da window.XSavedReports henüz
                // yüklenmemiş olabilir; bu yüzden hem "ready" olayına hem de anlık varlığa bağlan (tek sefer).
                var _basladi = false;
                function _baslat() {
                    if (_basladi || !window.XSavedReports) return;
                    _basladi = true;
                    window.XSavedReports.whenReady()
                        .then(function () { return renderSavedReports(); })
                        .then(function () { return xRaporRouterVeyaBagla(); })   // Faz 3: URL slug'ı varsa onu aç; yoksa Faz 2 uzlaştırma
                        .catch(function () {})
                        .then(function () { try { window.__xRaporYukleniyor = false; } catch (e) {} });   // [VERİ KAYBI FİX] uzlaştırma bitti -> nöbetçiyi KESİN kaldır (başarı + hata)
                }
                window.addEventListener('x-saved-reports-ready', _baslat);
                if (window.XSavedReports) { _baslat(); }
                // Faz 3: geri/ileri (popstate) -> URL slug'ına göre raporu aç.
                window.addEventListener('popstate', function () { try { xPopstateYonet(xUrlSlugOku()); } catch (e) {} });
            } catch (e) {}
        }
        // Faz 2: Sayfa yüklemede aktif raporu SUNUCU havuzuyla uzlaştır (havuz ephemeral; rapor IndexedDB'de).
        //   - havuz DOLU  -> çalışma durumu bu; çubuğu göster (oto-kayıt senkron tutar).
        //   - havuz BOŞ + rapor DOLU -> raporu havuza geri yükle (re-hidrasyon; veri kaybı önlenir).
        //   - havuz BOŞ + rapor boş -> çubuğu göster. Kayıt yoksa -> aktif id'yi temizle.
        async function xAktifRaporYenidenBagla() {
            try {
                if (!xOtoKayitAcik()) { return; }
                var id = xAktifRaporId();
                if (!id) { xAktifRaporCizgiCiz(); return; }
                var rec = null; try { rec = await window.XSavedReports.get(id); } catch (e) {}
                if (!rec) { xAktifRaporTemizle(true); return; }   // kayıt silinmiş -> aktif id'yi bırak (URL '/', replace)
                window.__xActiveReportName = rec.name || '';
                var curItems = [];
                try { var cur = await fetch('/api/pool/data').then(function (r) { return r.json(); }); curItems = (cur && cur.items) || []; } catch (e) {}
                var depoDolu = !!((rec.items && rec.items.length) || (rec.manualClusters && rec.manualClusters.length));
                if (curItems.length) {
                    // [VERİ KAYBI FİX] Havuz canlı/dolu -> KORU; ama overlay'i snapshot'tan geri yükle
                    // (manuel metin/başlık/link/görsel-parça yalnız overlay'deydi, F5'te uçtu). Havuza dokunmaz.
                    if (xRehidrateAcik()) { try { xRaporOverlayGeriYukle(rec); } catch (e) {} }
                    xAktifRaporKur(id, rec.name || '', await xRaporSlugCoz(id, rec), true); xOtoKayitDurum('kaydedildi');
                } else if (depoDolu) {
                    await openSavedReport(id, { urlReplace: true });   // re-hidrasyon (openSavedReport aktif id'yi + URL'i + yükleme nöbetçisini kurar)
                } else {
                    xAktifRaporKur(id, rec.name || '', await xRaporSlugCoz(id, rec), true); xOtoKayitDurum('kaydedildi');
                }
            } catch (e) { console.error('Aktif rapor yeniden bağlama hatası:', e); }
        }
        window.xAktifRaporYenidenBagla = xAktifRaporYenidenBagla;
        // Faz 3: Sayfa yüklemede router. URL /<slug> ise O raporu aç (aktif id'yi geçersiz kılar);
        // slug yoksa (/) Faz 2 uzlaştırma + URL'i aktif rapora göre düzelt. Slug var ama rapor yoksa uyar + uzlaştır.
        async function xRaporRouterVeyaBagla() {
            try {
                var slug = xUrlSlugOku();
                if (slug) {
                    var meta = null; try { meta = await window.XSavedReports.getBySlug(slug); } catch (e) {}
                    if (meta && meta.id) {
                        // Slug ZATEN aktif rapora çözülüyorsa (normal F5): openSavedReport havuzu ezer ve
                        // henüz kaydedilmemiş canlı havuzu kaybedebilir -> bunun yerine uzlaştırma kullan
                        // (dolu havuzu KORUR, yalnız boşsa re-hidre eder). Farklı rapora geçişte aç.
                        if (meta.id === xAktifRaporId()) { await xAktifRaporYenidenBagla(); return; }
                        await openSavedReport(meta.id, { urlReplace: true }); return;
                    }
                    if (window.showToast) showToast('Bu adreste rapor yok; mevcut rapora dönüldü.', 'warning');
                }
                await xAktifRaporYenidenBagla();   // aktif rapor kurulursa URL'i de kendi slug'ına replace eder
            } catch (e) { console.error('Router hatası:', e); }
        }
        window.xRaporRouterVeyaBagla = xRaporRouterVeyaBagla;
        // Faz 3: popstate (geri/ileri). Yeni URL slug'ı mevcut aktif slug'dan farklıysa o raporu aç.
        async function xPopstateYonet(slug) {
            try {
                if (slug) {
                    if (slug === (window.__xActiveReportSlug || '')) return;   // zaten o rapordayız
                    var meta = null; try { meta = await window.XSavedReports.getBySlug(slug); } catch (e) {}
                    if (meta && meta.id) { await openSavedReport(meta.id, { urlReplace: true }); }
                    else if (window.showToast) { showToast('Bu adreste rapor yok.', 'warning'); }
                }
                // slug yoksa ('/') mevcut raporda kal (ileride galeri gösterilebilir).
            } catch (e) { console.error('Popstate hatası:', e); }
        }
        window.xPopstateYonet = xPopstateYonet;

        function xBuildStyleOpts() {
            // Güvenli okuyucular: öğe yoksa varsayılan döner (eski alanlar birebir korunur;
            // m_* / *_align / l_bold / l_italic Faz 1'de EKLENDİ, Faz 2'de çıktıya uygulanacak).
            var gv = function (id, def) { var e = document.getElementById(id); return e ? e.value : def; };
            var gc = function (id, def) { var e = document.getElementById(id); return e ? e.checked : !!def; };
            return {
                b1_font: gv('b1_font', 'Arial'),
                b1_size: gv('b1_size', '18'),
                b1_color: gv('b1_color', '#000000'),
                b1_bold: gc('b1_bold', true),
                b1_italic: gc('b1_italic', false),
                b1_underline: gc('b1_underline', false),
                b1_align: gv('b1_align', 'left'),
                b1_wordstyle: gv('b1_wordstyle', 'Heading1'),
                b_font: gv('b_font', 'Arial'),
                b_size: gv('b_size', '16'),
                b_color: gv('b_color', '#000000'),
                b_numbered: gc('b_numbered', false),
                b_basliksiz: gc('b_basliksiz', false),
                b_bold: gc('b_bold', true),
                b_italic: gc('b_italic', false),
                b_underline: gc('b_underline', false),
                b_align: gv('b_align', 'left'),
                b_wordstyle: gv('b_wordstyle', 'Heading2'),
                b_after: gv('b_after', '6'),   // [BAŞLIK–PARAGRAF] başlık–paragraf boşluğu (pt; Word çıktısı)
                l_font: gv('l_font', 'Arial'),
                l_size: gv('l_size', '12'),
                l_color: gv('l_color', '#1565c0'),
                l_bold: gc('l_bold', false),
                l_italic: gc('l_italic', false),
                l_underline: gc('l_underline', true),
                l_align: gv('l_align', 'left'),
                m_font: gv('m_font', 'Arial'),
                m_size: gv('m_size', '12'),
                m_color: gv('m_color', '#000000'),
                m_bold: gc('m_bold', false),
                m_italic: gc('m_italic', false),
                m_underline: gc('m_underline', false),
                m_align: gv('m_align', 'left'),
                m_line: gv('m_line', '1.0'),              // [SATIR ARALIĞI] metin satır aralığı (Word w:line; çıktı)
                m_space_before: gc('m_space_before', false),   // [SATIR ARALIĞI] paragraftan önce boşluk
                m_space_after: gc('m_space_after', false),     // [SATIR ARALIĞI] paragraftan sonra boşluk
                g_align: gv('g_align', 'left'),   // [GÖRSEL HİZA] genel görsel hizalaması (Sol/Orta/Sağ)
                pn_on: gc('pn_on', false),        // [SAYFA NO] sayfa numarası açık mı (Word çıktısı)
                pn_pos: gv('pn_pos', 'footer'),   // footer(altta)/header(üstte)
                pn_align: gv('pn_align', 'right'),// left/center/right
                pn_fmt: gv('pn_fmt', 'plain')     // plain="1" / sayfa="Sayfa 1" / xofn="1 / N"
            };
        }

        // Faz 5: overlay anahtarı — editördeki ovKey ile AYNI normalizasyon (XLocalImages.normLink).
        function xOvKey(link) {
            try { return (window.XLocalImages && window.XLocalImages.normLink) ? window.XLocalImages.normLink(link || '') : String(link || ''); }
            catch (e) { return String(link || ''); }
        }
        // Faz 5: kaydedilmiş stil snapshot'ını (xBuildStyleOpts çıktısı) genel stil girdilerine geri uygular.
        // Anahtarlar input id'leriyle birebir (b1_font -> #b1_font). Onay kutuları .checked, diğerleri .value.
        function xApplyStyleOpts(o) {
            if (!o) return;
            var checks = { b1_bold:1,b1_italic:1,b1_underline:1, b_bold:1,b_italic:1,b_underline:1,b_numbered:1,b_basliksiz:1, l_bold:1,l_italic:1,l_underline:1, m_bold:1,m_italic:1,m_underline:1, m_space_before:1,m_space_after:1, pn_on:1 };
            Object.keys(o).forEach(function (k) {
                var e = document.getElementById(k); if (!e) return;
                if (checks[k]) { e.checked = !!o[k]; } else { e.value = o[k]; }
            });
            try { if (typeof xSaveStyles === 'function') xSaveStyles(); } catch (e) {}
        }

        // [STANDART STİL] Yeni (sıfırdan) rapor DAİMA bu standart ayarlarla başlar (kullanıcı isteği): en son
        // kullanılan stil yeni rapora SIZMASIN. Düzenleme per-rapor (editörde değiştirince yalnız o raporun
        // editorStyle'ına yazılır; kayıtlı rapor açılınca kendi stili uygulanır). Platform başlığı 18 / içerik 16.
        var STANDART_STIL = {
            b1_font: 'Arial', b1_size: '18', b1_color: '#000000', b1_bold: true, b1_italic: false, b1_underline: false, b1_align: 'left', b1_wordstyle: 'Heading1',
            b_font: 'Arial', b_size: '16', b_color: '#000000', b_numbered: false, b_basliksiz: false, b_bold: true, b_italic: false, b_underline: false, b_align: 'left', b_wordstyle: 'Heading2', b_after: '6',
            l_font: 'Arial', l_size: '12', l_color: '#1565c0', l_bold: false, l_italic: false, l_underline: true, l_align: 'left',   // [LİNK MAVİ] link otonom rengi = satır-içi link mavisi (#1565c0)
            m_font: 'Arial', m_size: '12', m_color: '#000000', m_bold: false, m_italic: false, m_underline: false, m_align: 'left',
            m_line: '1.0', m_space_before: false, m_space_after: false,   // [SATIR ARALIĞI] standart: tek satır, boşluk yok (eski çıktı birebir)
            g_align: 'left',   // [GÖRSEL HİZA] standart: sola (mevcut çıktı birebir korunur)
            pn_on: false, pn_pos: 'footer', pn_align: 'right', pn_fmt: 'plain'   // [SAYFA NO] standart: kapalı (altta sağda "1" açıldığında)
        };
        function xStandartStiliUygula() { try { xApplyStyleOpts(STANDART_STIL); } catch (e) {} }
        window.xStandartStiliUygula = xStandartStiliUygula;
        window.STANDART_STIL = STANDART_STIL;

        // --- Stil ayarları KALICILIĞI (Faz 1). Bugüne dek "Uygula ve Kapat" hiçbir yere
        //     kaydetmiyordu -> sayfa yenilemede HTML varsayılanlarına dönüyordu. Artık her
        //     stil girdisi değişince localStorage'a yazılır, açılışta geri yüklenir. ---
        function xStyleInputIds() {
            return ['b1_font','b1_size','b1_color','b1_bold','b1_italic','b1_underline','b1_align','b1_wordstyle',
                    'b_font','b_size','b_color','b_bold','b_italic','b_underline','b_numbered','b_basliksiz','b_align','b_wordstyle','b_after',
                    'l_font','l_size','l_color','l_bold','l_italic','l_underline','l_align',
                    'm_font','m_size','m_color','m_bold','m_italic','m_underline','m_align',
                    'm_line','m_space_before','m_space_after',
                    'g_align',
                    'pn_on','pn_pos','pn_align','pn_fmt'];
        }
        function xSaveStyles() {
            try {
                var o = {};
                xStyleInputIds().forEach(function (id) {
                    var e = document.getElementById(id); if (!e) return;
                    o[id] = (e.type === 'checkbox') ? e.checked : e.value;
                });
                localStorage.setItem('x_style_opts', JSON.stringify(o));
            } catch (e) {}
        }
        function xInitStyles() {
            try {
                var raw = localStorage.getItem('x_style_opts');
                if (raw) {
                    var o = JSON.parse(raw);
                    xStyleInputIds().forEach(function (id) {
                        var e = document.getElementById(id); if (!e || !(id in o)) return;
                        if (e.type === 'checkbox') e.checked = !!o[id]; else e.value = o[id];
                    });
                }
            } catch (e) {}
            // [WORD DÜZEYİ MIGRATION] Varsayılan Word düzeyi: içerik=Başlık 2, platform=Başlık 1. Eski kayıtlı
            // (kaymış ya da bir önceki sürümün 'oto' değeri) b_wordstyle/b1_wordstyle'ı BİR KEZ gerçek varsayılana
            // çek -> kullanıcı elle düzeltmeden içerik Başlık 2 gelir. Sonra genel "Stil"den değiştirilebilir.
            try {
                if (localStorage.getItem('x_ws_lvl_v3') !== '1') {
                    var bw = document.getElementById('b_wordstyle'); if (bw) bw.value = 'Heading2';
                    var b1w = document.getElementById('b1_wordstyle'); if (b1w) b1w.value = 'Heading1';
                    if (typeof xSaveStyles === 'function') xSaveStyles();
                    localStorage.setItem('x_ws_lvl_v3', '1');
                }
            } catch (e) {}
            try {
                xStyleInputIds().forEach(function (id) {
                    var e = document.getElementById(id); if (!e) return;
                    e.addEventListener('change', xSaveStyles);
                });
            } catch (e) {}
        }
        // v3.87: indirilen cikti dosyasinin adi = INDIRME ANINDAKI tarih-saat (kullanici istegi).
        // Her indirme cagrisinda taze hesaplanir (onizlemeden gec indirilse bile o an). ':' dosya
        // adinda gecersiz -> saat de '-' ile. Bicim: GG-AA-YYYY SS-DD-ss.docx.
        function xIndirmeDosyaAdi() {
            try {
                var d = new Date();
                function _p(n){ return (n < 10 ? '0' : '') + n; }
                return _p(d.getDate()) + '-' + _p(d.getMonth() + 1) + '-' + d.getFullYear() + ' ' +
                       _p(d.getHours()) + '-' + _p(d.getMinutes()) + '-' + _p(d.getSeconds()) + '.docx';
            } catch (e) { return 'GörüntüX.docx'; }
        }

        function xGenerateLocal(previewMode, mode) {
            var filename = (mode === 'auto') ? 'GörüntüX_Otomatik.docx' : 'GörüntüX_Toplu.docx';
            return window.XLocalDocx.generateBlob(xBuildStyleOpts())
                .then(function(blob) {
                    if (previewMode) {
                        // Faz 7: önizleme DAİMA editörde (generateManualWord zaten yönlendiriyor; bu dal savunma amaçlı).
                        window.lastGeneratedBlob = blob;
                        window.lastGeneratedFilename = filename;
                        if (window.XEditor) { window.XEditor.ac({fresh:true}); }
                        refreshStatus();
                        return;
                    }
                    var url = window.URL.createObjectURL(blob);
                    var a = document.createElement('a');
                    a.href = url; a.download = xIndirmeDosyaAdi();
                    document.body.appendChild(a); a.click(); a.remove();
                    showToast('Word raporu (tarayıcıda) indirildi!', 'success');
                    // Sunucu üretim yolundaki gibi havuzu temizle, sonra arayüzü sıfırla.
                    fetch('/api/manual/clear', { method: 'POST' })
                        .then(function() { resetAutomationUIAndBackend(); })
                        .catch(function() { resetAutomationUIAndBackend(); });
                })
                .catch(function(err) {
                    // Faz 4 (tam kaldırma): sunucu-fallback YOK. Hata olursa net mesaj göster.
                    console.error('Word üretimi başarısız:', err);
                    showToast('Word oluşturulamadı: ' + (err && err.message ? err.message : err), 'danger');
                });
        }

        function generateManualWord(previewMode = false, forceServer = false) {
            // Faz 7: ÖNİZLEME artık DAİMA Rapor Editörü'nü açar (eski showDocxPreview emekli).
            //        İNDİRME (previewMode=false) aşağıdaki üretim yolunda kalır.
            if (previewMode && window.XEditor) {
                window.XEditor.ac({fresh:true});
                return;
            }
            if (!forceServer && xLocalGenEnabled() && window.XLocalDocx) {
                return xGenerateLocal(previewMode, 'manual');
            }
            const btns = document.querySelectorAll('button[onclick*="generateManualWord"]');
            btns.forEach(b => {
                b.disabled = true;
                const onclickStr = b.getAttribute('onclick') || '';
                if (onclickStr.includes('true')) {
                    b.innerHTML = "⏳ Önizleniyor...";
                } else {
                    b.innerHTML = "⏳ Üretiliyor...";
                }
            });

            const formData = new FormData();
            formData.append('b_font', document.getElementById('b_font').value);
            formData.append('b_size', document.getElementById('b_size').value);
            formData.append('b_color', document.getElementById('b_color').value);
            formData.append('b_numbered', document.getElementById('b_numbered').checked ? 'true' : 'false');
            formData.append('b_bold', document.getElementById('b_bold').checked ? 'true' : 'false');
            formData.append('b_italic', document.getElementById('b_italic').checked ? 'true' : 'false');
            formData.append('b_underline', document.getElementById('b_underline').checked ? 'true' : 'false');
            formData.append('l_font', document.getElementById('l_font').value);
            formData.append('l_size', document.getElementById('l_size').value);
            formData.append('l_color', document.getElementById('l_color').value);
            formData.append('l_underline', document.getElementById('l_underline').checked ? 'true' : 'false');
            
            // Pass clear parameter so memory is kept on preview
            formData.append('clear', previewMode ? 'false' : 'true');

            fetch('/api/manual/generate', {
                method: 'POST',
                body: formData
            })
            .then(res => {
                if (!res.ok) throw new Error('Word dosyasi uretilemedi');
                return res.blob();
            })
            .then(blob => {
                if (previewMode) {
                    // Faz 7: önizleme DAİMA editörde (bu sunucu-önizleme dalı savunma amaçlı).
                    window.lastGeneratedBlob = blob;
                    window.lastGeneratedFilename = "GörüntüX_Toplu.docx";
                    if (window.XEditor) { window.XEditor.ac({fresh:true}); }
                    refreshStatus();
                } else {
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = xIndirmeDosyaAdi();
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    showToast('Toplu Word raporu indirildi!', 'success');
                    resetAutomationUIAndBackend();
                }
            })
            .catch(err => {
                showToast('Hata: ' + err.message, 'danger');
            })
            .finally(() => {
                btns.forEach(b => {
                    b.disabled = false;
                    const onclickStr = b.getAttribute('onclick') || '';
                    if (onclickStr.includes('true')) {
                        b.innerHTML = "👁️ Önizle";
                    } else {
                        b.innerHTML = "🏁 Word Üret ve İndir";
                    }
                });
            });
        }

        // Automation controls
        let automationTimerInterval = null;
        
        function updateAutomationTimer() {
            if (!window.automationStartTime) return;
            const elapsed = Math.floor((Date.now() - window.automationStartTime) / 1000);
            const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const seconds = String(elapsed % 60).padStart(2, '0');
            const timerEl = document.getElementById('automation-timer');
            if (timerEl) {
                timerEl.innerText = "⏱ " + minutes + ":" + seconds;
            }
        }

        // Eklentinin arka plan servis worker'ını uyandırıp hemen iş yoklaması yaptırır.
        function xWakeExtension() {
            try { window.postMessage({ type: "X_RAPOR_FORCE_POLL" }, "*"); } catch (e) {}
        }
        // Taramayı DOĞRUDAN eklentiye yollar (poll_job beklemeden). Mesaj SW'yi uyandırır ve
        // arka plan hemen sekmeyi açıp taramayı başlatır — F5 gerekmez. (Çalışan referans
        // eklentinin startScan deseni.)
        function xStartWordScan(jobId, links) {
            try {
                window.postMessage({
                    type: "X_RAPOR_START_WORD",
                    job: { job_id: jobId, scrape_mode: "word", tweet_urls: links }
                }, "*");
            } catch (e) {}
        }

        function startAutomation() {
            if (!window.extensionConnected) {
                showToast('Taramayı başlatmak için eklentinin bağlı ve hazır olması gerekmektedir. Lütfen Chrome eklentisini aktif edin!', 'warning');
                return;
            }
            // Eklenti ESKI ise tarama YOK (kullanici istegi 2026-07-17).
            // NEDEN: eski eklenti + yeni sunucu = sessiz yanlis cikti. Bugun tam bunu
            // yasadik (onbellekteki eski uretici yeni sunucuyla calisip eski duzende Word
            // uretti; ikimiz de yanlis yeri konustuk). Hata vermeden yanlis rapor uretmektense
            // BASLATMAMAK dogru.
            // Buton zaten kilitli (refreshStatus) ama ASIL koruma burasi: buton durumu bayat
            // kalabilir, yoklama gecikebilir; kapi tiklamanin kendisinde.
            if (window.extensionOutdated) {
                showToast('Eklenti güncel değil (kurulu v' + (window.extensionInstalledVersion || '?')
                    + ', en güncel v' + (window.extensionLatestVersion || '?')
                    + '). Tarama başlatılamaz — .zip\\'i indirip eklentiyi güncelleyin.', 'danger');
                return;
            }
            processInputLinks();
            window.accumulatedLinks = window.accumulatedLinks || [];
            const links = window.accumulatedLinks;
            if (links.length === 0) {
                showToast('Lutfen en az bir tweet linki girin!', 'danger');
                return;
            }

            // Oturum hatırlatması (kullanıcı isteği): tarama başlarken sağ-altta anlık toast.
            showToast('🔐 Tarayacağınız platformlarda (X, Instagram, Facebook, TikTok) oturumunuzun AÇIK olduğundan emin olun.', 'warning');

            // Faz #1-A / B8 ([1]): unify AÇIKKEN havuz Başlat'ta KORUNUR (biriken manuel/widget öğeler),
            // bu yüzden yerel görselleri de KORU (yoksa biriken öğelerin görseli silinir -> .docx görselsiz).
            // Unify KAPALIYKEN eski davranış: tarama havuzu temizler, yerel görseller de temizlenir.
            try { if (window.XLocalImages && !(window.XEditor && window.XEditor._unifyOn && window.XEditor._unifyOn())) window.XLocalImages.clear(); } catch (e) {}
            // B8 ([2]): Başlat taze bir aktivitedir -> 24h otomatik-temizlik saatini YENİDEN BAŞLAT (yoksa
            // ilk içerikten SABIT sayan saat, biriken + yeni taranan havuzu 24s sonra sessizce silebilir).
            try { localStorage.setItem('x_havuz_ilk_ts', String(Date.now())); } catch (e) {}

            fetch('/api/auto/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls: links })
            })
            .then(res => res.json())
            .then(data => {
                if (data.status === 'success') {
                    showToast('Raporlama gorevi olusturuldu!', 'success');
                    window.automationStartTime = Date.now();
                    if (automationTimerInterval) clearInterval(automationTimerInterval);
                    automationTimerInterval = setInterval(updateAutomationTimer, 1000);
                    // ASIL BAŞLATMA: taramayı doğrudan eklentiye yolla (SW'yi uyandırır, hemen
                    // sekmeyi açıp başlar). poll_job'a bağlı değil, bu yüzden F5 gerekmez.
                    // Görev depolanınca checkServerJobs'un activeJobFound koruması çift-başlatmayı engeller.
                    xStartWordScan(data.job_id, links);
                    refreshStatus();
                } else {
                    showToast('Hata: ' + data.message, 'danger');
                }
            });
        }

        // Reset active job
        function resetJob() {
            fetch('/api/auto/reset', { method: 'POST' })
            .then(res => res.json())
            .then(data => {
                showToast('Gorev sifirlandi.', 'success');
                refreshStatus();
            });
        }

        // v3.66: Tarama bir SEBEPLE durduysa (TikTok captcha / Facebook dogrulama ekrani)
        // eklenti bunu bize bildirir. ONCEDEN: sebep yalnizca Docker loguna yaziliyordu,
        // panel ise normal bitisle iptali ayirt edemedigi icin "is bitti" gibi davraniyordu.
        // Sahada yasandi: TikTok captcha cikti, tarama durdu, kullanici nedenini goremedi.
        // TOAST DEGIL MODAL: toast 3.5 sn sonra kayboluyor; kullanici tarama sirasinda
        // baska yere bakiyor olabilir ve bu mesaj EYLEM gerektiriyor (git bulmacayi coz).
        window.addEventListener('message', function (ev) {
            if (ev.source !== window) return;
            var d = ev.data;
            if (!d || d.type !== 'X_RAPOR_TARAMA_DURDU' || !d.sebep) return;
            try {
                Swal.fire({
                    title: 'Tarama durduruldu',
                    text: String(d.sebep),
                    icon: 'warning',
                    confirmButtonText: 'Anladım',
                    customClass: {
                        popup: 'swal2-dark-theme',
                        title: 'swal2-title',
                        htmlContainer: 'swal2-html-container',
                        confirmButton: 'swal2-confirm'
                    },
                    buttonsStyling: false,
                    iconColor: '#f0883e'
                });
            } catch (e) {
                alert('Tarama durduruldu: ' + d.sebep);
            }
        });

        // Beautiful custom confirm overlay using SweetAlert2
        function stopAutomation() {
            Swal.fire({
                title: 'Taramayı Durdur',
                text: 'Çalışan tarama işlemini durdurmak istediğinize emin misiniz? (Şu ana kadar taranmış tivitler havuzda korunacaktır)',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Tamam',
                cancelButtonText: 'İptal',
                customClass: {
                    popup: 'swal2-dark-theme',
                    title: 'swal2-title',
                    htmlContainer: 'swal2-html-container',
                    confirmButton: 'swal2-confirm',
                    cancelButton: 'swal2-cancel'
                },
                buttonsStyling: false,
                iconColor: '#f85149'
            }).then((result) => {
                if (result.isConfirmed) {
                    resetJob();
                }
            });
        }

        // Global window.alert override using SweetAlert2 to match the theme
        window.alert = function(message) {
            Swal.fire({
                text: message,
                icon: 'info',
                confirmButtonText: 'Tamam',
                customClass: {
                    popup: 'swal2-dark-theme',
                    title: 'swal2-title',
                    htmlContainer: 'swal2-html-container',
                    confirmButton: 'swal2-confirm'
                },
                buttonsStyling: false
            });
        };

        // Generate automatic word
        function generateAutoWord(forceServer = false) {
            if (!forceServer && xLocalGenEnabled() && window.XLocalDocx) {
                return xGenerateLocal(false, 'auto');
            }
            const formData = new FormData();
            formData.append('b_font', document.getElementById('b_font').value);
            formData.append('b_size', document.getElementById('b_size').value);
            formData.append('b_color', document.getElementById('b_color').value);
            formData.append('b_numbered', document.getElementById('b_numbered').checked ? 'true' : 'false');
            formData.append('b_bold', document.getElementById('b_bold').checked ? 'true' : 'false');
            formData.append('b_italic', document.getElementById('b_italic').checked ? 'true' : 'false');
            formData.append('b_underline', document.getElementById('b_underline').checked ? 'true' : 'false');
            formData.append('l_font', document.getElementById('l_font').value);
            formData.append('l_size', document.getElementById('l_size').value);
            formData.append('l_color', document.getElementById('l_color').value);
            formData.append('l_underline', document.getElementById('l_underline').checked ? 'true' : 'false');
            
            fetch('/api/auto/generate', {
                method: 'POST',
                body: formData
            })
            .then(res => {
                if (!res.ok) throw new Error('Word dosyasi uretilemedi');
                return res.blob();
            })
            .then(blob => {
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = xIndirmeDosyaAdi();
                document.body.appendChild(a);
                a.click();
                a.remove();
                showToast('Otomatik Word raporu indirildi!', 'success');
                
                // Girdileri ve sayacı temizle
                window.accumulatedLinks = [];
                var inputEl = document.getElementById('tweet_links_input');
                if (inputEl) {
                    inputEl.value = '';
                    if (typeof updateLinksPreview === 'function') {
                        updateLinksPreview();
                    }
                    autoResizeTextarea(inputEl);
                }
                
                fetch('/api/auto/reset', { method: 'POST' })
                .then(function(r) { return r.json(); })
                .then(function() {
                    refreshStatus();
                });
            })
            .catch(err => {
                showToast('Hata: ' + err.message, 'danger');
            });
        }

        // Dynamic State Poller (Runs every 1.5s)
        // Eklenti surumlerini KIYASLA. a<b ise -1, a>b ise 1, esitse 0.
        //
        // NEDEN ELDE YAZILDI (iki naif yol da YANLIS):
        //   parseFloat  -> "3.40" ile "3.4" AYNI sayidir (3.4) -> 3.40 kuruluyken bile
        //                  "guncel degil" demez ama 3.9 vs 3.40'ta 3.9'u YENI sanir.
        //   metin (<)   -> "3.9" > "3.40" cikar (once '9' vs '4') -> ESKI surumu YENI sanir.
        // Dogrusu Chrome'un kurali: noktayla ayrilmis TAM SAYILAR, parca parca kiyaslanir.
        //   "3.40" -> [3,40] ; "3.39" -> [3,39] ; 40 > 39 -> 3.40 daha yeni.
        // Eksik parca 0 sayilir: "3.4" -> [3,4] ; "3.4.1" -> [3,4,1] -> 3.4.1 daha yeni.
        function xSurumKiyas(a, b) {
            var pa = String(a).trim().split('.');
            var pb = String(b).trim().split('.');
            var n = Math.max(pa.length, pb.length);
            for (var i = 0; i < n; i++) {
                var x = parseInt(pa[i], 10); if (isNaN(x)) x = 0;
                var y = parseInt(pb[i], 10); if (isNaN(y)) y = 0;
                if (x !== y) return (x < y) ? -1 : 1;
            }
            return 0;
        }

        function refreshStatus() {
            fetch('/api/status')
            .then(res => res.json())
            .then(data => {
                // [13]: sunucunun efektif birleşme bayrağı -> unifyOn() bunu okur (localStorage'tan bağımsız).
                if (data && typeof data.unify_manual !== 'undefined') { window.__xUnifyServer = !!data.unify_manual; }
                // Eklenti bağlantı durumu.
                // ÖNCELİKLİ İŞARET: bridge.js, eklenti KURULU olduğu sürece her sayfaya (bu panel dahil)
                // documentElement üzerine data-x-rapor-installed="true" koyar. Bu işaret, MV3 servis
                // worker'ının uykuda/sonlanmış olmasından BAĞIMSIZDIR. Dolayısıyla eklenti bir kez hazır
                // göründükten sonra, tarama sürsün ya da SW uykuya dalsın, panel "bekleniyor"a DÜŞMEZ;
                // yalnızca eklenti chrome://extensions'tan kaldırılıp sayfa yenilenince işaret kaybolur.
                const extInstalled = document.documentElement.getAttribute('data-x-rapor-installed') === 'true';
                // Bir kez "kurulu" gördüysek bu sayfa oturumu boyunca hazır kabul et (asla geri düşmesin).
                if (extInstalled) { window.extReadySticky = true; }
                const connected = window.extReadySticky || extInstalled || !!data.is_connected;
                window.extensionConnected = connected;

                // --- Eklenti surum karsilastirmasi (kurulu vs sunucunun en guncel'i) ---
                // Kurulu surumu bridge.js yaziyor (data-x-rapor-version); en guncel surumu sunucu
                // /api/status -> ext_latest_version ile veriyor. startAutomation + girdi kilidi
                // window.extensionOutdated'e bagli oldugu icin bu globaller AYNEN korunur.
                var kuruluSurum = document.documentElement.getAttribute('data-x-rapor-version') || '';
                var sonSurum = data.ext_latest_version || '';
                var eskiMi = !!(kuruluSurum && sonSurum && xSurumKiyas(kuruluSurum, sonSurum) < 0);
                window.extensionOutdated = eskiMi;
                window.extensionInstalledVersion = kuruluSurum;
                window.extensionLatestVersion = sonSurum;

                // 24 saat otomatik havuz temizligi (local/sabit). Havuz sayisi + tarama durumu burada.
                xHavuz24Kontrol(data);

                // --- Sag-ust UC DURUMLU kutu (Stil Ayarlari'nin saginda) ---
                //   yok/baglanmadi -> KIRMIZI (tiklanabilir: kur)
                //   kurulu + ESKI  -> SARI   (tiklanabilir: guncelle)
                //   kurulu + guncel-> YESIL  (tiklanamaz)
                // Modal (indirme + kilavuz) YALNIZ kirmizi/sari'dan acilir (onExtStatusClick).
                var kutu = document.getElementById('ext-status-box');
                if (kutu) {
                    if (!connected) {
                        kutu.className = 'ext-status-box ext-err';
                        kutu.innerHTML = '<svg viewBox="0 0 10 10" fill="currentColor"><circle cx="5" cy="5" r="4"/></svg> Eklenti yok — kur';
                        window.extBoxClickable = true;
                    } else if (eskiMi) {
                        kutu.className = 'ext-status-box ext-warn';
                        kutu.innerHTML = '<svg viewBox="0 0 10 10" fill="currentColor"><circle cx="5" cy="5" r="4"/></svg> Güncelleme gerekli (v' + kuruluSurum + ' → v' + sonSurum + ')';
                        window.extBoxClickable = true;
                    } else {
                        kutu.className = 'ext-status-box ext-ok';
                        kutu.innerHTML = '<svg viewBox="0 0 10 10" fill="currentColor"><circle cx="5" cy="5" r="4"/></svg> Eklenti bağlandı (Hazır)';
                        window.extBoxClickable = false;
                        // Eklenti (yeni) HAZIR: kırmızı/sarıda açılmış modal artık anlamsız -> otomatik
                        // kapat. (Kullanıcı güncelleyip panele dönünce açık modal takılı kalmasın.)
                        // closeExtModal idempotent -> zaten kapalıysa no-op; kırmızı/sarı dallarına dokunulmaz.
                        closeExtModal();
                    }
                }

                // Update manual list section
                const manualListSec = document.getElementById('manual-list-section');
                const container = document.getElementById('manual-items-container');
                const titleEl = document.getElementById('manual-list-title');
                // Not: Eski üst-sağ "Rapor Editörü" butonu KALDIRILDI. Elle rapor oluşturma artık
                //      Raporlarım'daki "➕ Boş Rapor" kartından (yeni rapor + editör açılır).
                if (data.manuel_count > 0) {
                    window.__xBosPollSayac = 0;   // [VERİ KAYBI FİX — REBUILD] havuz dolu -> beklenmedik-boş sayacını sıfırla (geçici iç-temizleme elendi)
                    if (titleEl) {
                        titleEl.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="4" width="11" height="13" rx="1.5"/><path d="M7.5 4V2.8h5V4"/><path d="M7.5 8.5h5M7.5 11.5h5M7.5 14.5h3"/></svg><span>Havuzda Bekleyen Rapor İçerikleri (' + data.manuel_count + ' Adet)</span>';
                    }
                    // v4.1: Havuz TÜM sekmelerde görünür. Eskiden tab-format'ta gizliydi ("Word Düzenle"
                    // sekmesiydi, havuz alakasızdı); artık "Kayıtlı Raporlar" -> Aç/Birleştir sonrası havuz
                    // BURADA da görünüp işlenebilmeli (kullanıcı isteği).
                    manualListSec.style.display = 'block';
                    
                    // İSTEK 2: havuzu hesap-bloklarına gruplayıp sürükle-bırakla sıralanabilir çiz.
                    // Sürükleme sürerken yeniden çizme (drop'u bozmasın).
                    if (!window.poolDragging) {
                        const currentListJson = JSON.stringify(data.manuel_list);
                        // [EŞLEŞME] Editör overlay'i değiştiğinde (başlık/link/görsel) sunucu listesi AYNI kalır;
                        // yine de havuzu yeniden çiz ki editör düzenlemeleri havuz görünümüne yansısın.
                        if (window.lastManuelListJson !== currentListJson || window.__xPoolDirty) {
                            window.lastManuelListJson = currentListJson;
                            window.__xPoolDirty = false;
                            renderPoolGrouped(container, data.manuel_list);
                            try { xOtoKayitPlanla(); } catch (e) {}   // Faz 2: havuz/editör değişti -> aktif rapora oto-kayıt
                        }
                    }
                } else {
                    // Faz 2: içerik DOLUyken boşaldıysa (silme/sıfırla) aktif rapora boş durumu da yaz.
                    var _vardiMi = (window.lastManuelListJson !== null) || window.__xPoolDirty;
                    var _aktId = (typeof xAktifRaporId === 'function') ? xAktifRaporId() : '';
                    // [VERİ KAYBI FİX — REBUILD] Havuz BEKLENMEDİK boşaldıysa (önceden doluydu + aktif rapor + AÇIK
                    // boşaltma DEĞİL + geri-yükleme uçuşta DEĞİL) muhtemelen sunucu-reset (Docker rebuild). Geçici
                    // iç-temizlemeleri (openSavedReport/merge) elemek için 2 ARDIŞIK boş poll bekle; sonra havuzu
                    // snapshot'tan re-push ile GERİ YÜKLE ve BU ARADA boş/kısmi oto-kaydı YAPMA (snapshot korunur).
                    var _rebuildAday = (xHavuzGeriYukleAcik() && _vardiMi && _aktId && !window.__xPoolRestoreBusy
                        && !window.__xRaporYukleniyor && !(typeof xBosaltIzni === 'function' && xBosaltIzni(_aktId)));
                    if (window.__xPoolRestoreBusy) {
                        // geri-yükleme uçuşta -> bu poll'da HİÇBİR ŞEY yapma (gizleme YOK, boş-kayıt YOK, içeriği KORU).
                    } else if (_rebuildAday) {
                        window.__xBosPollSayac = (window.__xBosPollSayac || 0) + 1;
                        if (window.__xBosPollSayac >= 2) {
                            window.__xPoolRestoreBusy = true;
                            try { window.__xRaporYukleniyor = true; } catch (e) {}   // geri-yükleme boyunca TÜM auto-save BLOKE (boş-ezme olmaz)
                            (function () {
                                var _geri = false;
                                xSiraya(function () { return xHavuzuSnapshottanGeriYukle(_aktId); })
                                    .then(function (ok) { _geri = !!ok; })   // [SESSİZ] geri-yükleme bildirimi kaldırıldı (kullanıcı isteği)
                                    .catch(function (e) { console.error('Havuz geri-yükleme hatası:', e); })
                                    .then(function () {
                                        try { window.__xRaporYukleniyor = false; } catch (e) {}
                                        window.__xPoolRestoreBusy = false;
                                        window.__xBosPollSayac = 0;
                                        if (_geri) { try { refreshStatus(); } catch (e) {} }   // havuz doldu -> hemen yeniden çiz
                                        else { window.lastManuelListJson = null; window.__xPoolDirty = false; }   // snapshot'ta pool öğesi yok -> gerçek boş, bırak
                                    });
                            })();
                        }
                        // sayac < 2 -> bu poll bekle: gizleme/boş-kayıt YAPMA (önceki havuz görünümü KORUNUR).
                    } else {
                        // Kasıtlı boşaltma (Sıfırla/son-öğe-silme) veya gerçek boş -> eski davranış.
                        window.__xBosPollSayac = 0;
                        manualListSec.style.display = 'none';
                        container.innerHTML = '';
                        window.lastManuelListJson = null;
                        window.__xPoolDirty = false;
                        if (_vardiMi) { try { xOtoKayitPlanla(); } catch (e) {} }
                    }
                }

                // CANLI EDİTÖR: editör AÇIKken havuza YENİ içerik düşünce (eklenti/tarama -> öğe sayısı arttı)
                // editörü bozmadan yenile (XE.ac({}) -> scroll korunur, overlay'den düzenlemeler geri yüklenir,
                // "Yükleniyor" flaşı yok) -> yeni içerik editör ekranına da "tık" diye düşsün. Kullanıcı o an
                // editörde bir alana YAZIYORSA bu tur atlanır (yazımı bozma; sayaç güncellenmez -> sonraki
                // poll'da tekrar denenir). Bir XE.ac zaten çalışıyorsa (editörün kendi aksiyonu) atlanır.
                try {
                    var _edM = document.getElementById('editorModal');
                    var _edAcik = !!(_edM && _edM.classList.contains('active') && window.XEditor && window.XEditor.ac);
                    var _simdikiSayi = (data.manuel_count || 0);
                    if (_edAcik && _simdikiSayi > (window.__xSonHavuzSayi || 0) && !window.__xEdAcCalisiyor) {
                        var _ae = document.activeElement;
                        var _yaziyor = !!(_ae && (_ae.isContentEditable || _ae.tagName === 'INPUT' || _ae.tagName === 'TEXTAREA') && _ae.closest && _ae.closest('#editorModal'));
                        if (!_yaziyor) {
                            Promise.resolve(window.XEditor.ac({})).catch(function () {});
                            window.__xSonHavuzSayi = _simdikiSayi;   // yenilendi -> sayacı güncelle
                        }
                        // yazıyorsa sayacı GÜNCELLEME -> içerik kaybolmasın, sonraki poll'da yenilensin
                    } else {
                        window.__xSonHavuzSayi = _simdikiSayi;   // artış yok / editör kapalı -> senkronla
                    }
                } catch (e) {}

                // Update automation progress
                const progressArea = document.getElementById('progress-area');
                const downloadArea = document.getElementById('auto-download-area');
                const actionButtons = document.getElementById('auto-action-buttons');
                
                const lblContainer = document.getElementById('progress-label-container');
                const barContainer = document.getElementById('progress-bar-container');
                const timerEl = document.getElementById('automation-timer');

                if (data.status === 'running') {
                    progressArea.style.display = 'block';
                    if (lblContainer) lblContainer.style.display = 'flex';
                    if (barContainer) barContainer.style.display = 'block';
                    if (downloadArea) downloadArea.style.display = 'none';
                    actionButtons.style.display = 'none';
                    
                    const stopBtn = document.getElementById('stop-button-container');
                    if (stopBtn) stopBtn.style.display = 'block';
                    
                    // Hide the entire links input group during active scan
                    const inputGroup = document.getElementById('links-input-group');
                    if (inputGroup) {
                        inputGroup.style.display = 'none';
                    }
                    
                    // Sayfa yenilenmişse ve otomasyon hala çalışıyorsa sayacı başlat
                    if (!window.automationStartTime && data.start_time) {
                        window.automationStartTime = data.start_time * 1000;
                    } else if (!window.automationStartTime) {
                        window.automationStartTime = Date.now();
                    }
                    if (!automationTimerInterval) {
                        automationTimerInterval = setInterval(updateAutomationTimer, 1000);
                    }
                    
                    const current = data.results_count;
                    const total = data.total_count;
                    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
                    
                    document.getElementById('progress-text').innerText = "İlerleme: " + current + " / " + total + " tweet tamamlandı";
                    document.getElementById('progress-percent').innerText = percent + "%";
                    document.getElementById('progress-fill').style.width = percent + "%";
                } else if (data.status === 'completed') {
                    if (automationTimerInterval) {
                        clearInterval(automationTimerInterval);
                        automationTimerInterval = null;
                    }
                    window.automationStartTime = null;
                    
                    progressArea.style.display = 'block';
                    if (lblContainer) lblContainer.style.display = 'none';
                    if (barContainer) barContainer.style.display = 'none';
                    
                    const stopBtn = document.getElementById('stop-button-container');
                    if (stopBtn) stopBtn.style.display = 'none';
                    
                    // Show and restore links input group
                    const inputGroup = document.getElementById('links-input-group');
                    if (inputGroup) {
                        // .form-group = display:flex; 'block' yapmak flex'i bozup gap:14px'i iptal ederdi
                        // (etiket input'a yapisir, acilista flicker). 'flex' ile boslugu koru.
                        inputGroup.style.display = 'flex';
                    }
                    const inputEl = document.getElementById('tweet_links_input');
                    if (inputEl) {
                        inputEl.disabled = false;
                        inputEl.style.opacity = '1';
                        inputEl.style.cursor = 'text';
                        autoResizeTextarea(inputEl);
                    }
                    
                    // Toplam süreyi hesapla ve göster
                    if (data.start_time && data.end_time) {
                        const elapsed = Math.floor(data.end_time - data.start_time);
                        const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
                        const seconds = String(elapsed % 60).padStart(2, '0');
                        if (timerEl) {
                            timerEl.innerHTML = `🎉 Tarama tamamlandı! <b>Toplam Süre: ${minutes}:${seconds}</b>`;
                        }
                    } else {
                        if (timerEl) timerEl.innerText = "🎉 Tarama tamamlandı!";
                    }

                    if (downloadArea) downloadArea.style.display = 'block';
                    actionButtons.style.display = 'flex';
                } else {
                    if (automationTimerInterval) {
                        clearInterval(automationTimerInterval);
                        automationTimerInterval = null;
                    }
                    window.automationStartTime = null;
                    progressArea.style.display = 'none';
                    
                    const stopBtn = document.getElementById('stop-button-container');
                    if (stopBtn) stopBtn.style.display = 'none';
                    
                    // Show and restore links input group
                    const inputGroup = document.getElementById('links-input-group');
                    if (inputGroup) {
                        // .form-group = display:flex; 'block' yapmak flex'i bozup gap:14px'i iptal ederdi
                        // (etiket input'a yapisir, acilista flicker). 'flex' ile boslugu koru.
                        inputGroup.style.display = 'flex';
                    }
                    const inputEl = document.getElementById('tweet_links_input');
                    if (inputEl) {
                        inputEl.disabled = false;
                        inputEl.style.opacity = '1';
                        inputEl.style.cursor = 'text';
                        autoResizeTextarea(inputEl);
                    }
                    
                    if (downloadArea) downloadArea.style.display = 'none';
                    actionButtons.style.display = 'flex';
                }

                // ===== KILIT: eklenti YOK ya da ESKI ise bu sekmede islem yapilamaz =====
                // Kullanici istegi 2026-07-17: "sadece baslat butonunu kilitlemek yetmez,
                // input alanini da kilitle eklenti yoksa ya da surumu guncel degilse."
                //
                // NEDEN TAM BURADA (isleyicinin EN SONU): yukaridaki durum dallari girdiyi
                // ACIYOR (inputEl.disabled = false, ~2988). Kilidi daha erken uygulasaydik
                // her yoklamada SESSIZCE geri alinirdi -> kilit hic tutmazdi.
                // Tarama SURERKEN links-input-group zaten gizleniyor; oraya karismiyoruz,
                // yalnizca ogelerin disabled durumunu yonetiyoruz.
                try {
                    var kilitli = (!connected) || !!window.extensionOutdated;
                    var kilitSebep = !connected
                        ? 'Eklenti bağlı değil — Chrome eklentisini kurun/aktif edin.'
                        : ('Eklenti güncel değil (kurulu v' + (window.extensionInstalledVersion || '?')
                           + ', en güncel v' + (window.extensionLatestVersion || '?') + ') — önce güncelleyin.');
                    var girdiEl = document.getElementById('tweet_links_input');
                    if (girdiEl) {
                        girdiEl.disabled = kilitli;
                        girdiEl.style.opacity = kilitli ? '0.45' : '1';
                        girdiEl.style.cursor = kilitli ? 'not-allowed' : 'text';
                        girdiEl.title = kilitli ? kilitSebep : '';
                    }
                    var basBtn = document.getElementById('auto-start-btn');
                    if (basBtn) {
                        basBtn.disabled = kilitli;
                        basBtn.style.opacity = kilitli ? '0.45' : '';
                        basBtn.style.cursor = kilitli ? 'not-allowed' : '';
                        basBtn.title = kilitli ? kilitSebep : '';
                    }
                } catch (e) {}
            })
            .catch(err => console.error("Status polling hatası:", err));
        }

        // Start polling loop
        refreshStatus();
        setInterval(refreshStatus, 1500);

        window.accumulatedLinks = window.accumulatedLinks || [];

        // Faz FB-1: FB linkinin GONDERI KODU (onizleme etiketi icin).
        // Kullanici istegi 2026-07-17: butun FB formlari TEK TIP -> "Facebook Gönderi Kodu: <kod>",
        // yani Instagram'daki "Instagram Gönderi Kodu: <kod>" ile ayni bicim.
        // Once form basina AYRI metin uretiliyordu ve ayni listede yan yana boyle gorunuyordu:
        //     Facebook: ntvspor · Gönderi pfbid028EJ4…      <- /posts formu
        //     Facebook: Paylaşım kodu 14jeAjQz7ZP           <- /share formu
        // Sayfa adi (ntvspor) YALNIZCA /posts formunda var; /share linklerinde URL'de ad
        // bulunmuyor -> ad yazmak tek tiplestirmeyi yapisal olarak imkansiz kiliyordu.
        // Bu yuzden ad, grup adi ve "Sayfa <id>" eki atildi; her formdan yalnizca kod alinir.
        // NOT: bu SADECE ekran etiketi. Kimlik/eslestirme XPlat.fbCanonical + xNormLink ile
        // yapiliyor -> etiketin sadelesmesi anahtarlari etkilemez.
        // Faz TT-1: TikTok gonderi kodu (onizleme etiketi icin).
        // FB'deki fbPostCode ile AYNI amac ve AYNI bicim -> "TikTok Gönderi Kodu: <kod>".
        // FB'den FARKI: kimlik YOLDA, tek kalip yeter (FB'de 7 form vardi).
        //   /@kullanici/video/{id}  -> id
        //   /@kullanici/photo/{id}  -> id   (kapsam disi ama link yapistirilirsa dogru etiketlensin)
        //   vm./vt./t/{kod}         -> kod  (kisa link; hedef ancak yonlenmeyle bilinir)
        // Faz YT-1: YouTube icerik kodu (onizleme etiketi).
        // watch?v=ID -> ID (SORGUDAN), /shorts/ID ve /post/ID -> ID (YOLDAN).
        function ytPostCode(url) {
            try {
                var u = new URL(XPlat.ytCanonical(url));
                var p = String(u.pathname || '').replace(/\\/+$/, '');
                if (p.toLowerCase() === '/watch') return u.searchParams.get('v') || '';
                var m = p.match(/^\\/(?:shorts|post)\\/([^/]+)$/i);
                return m ? m[1] : (p.replace(/^\\//, '') || '');
            } catch (e) { return ''; }
        }
        function ttPostCode(url) {
            try {
                var u = new URL(XPlat.ttCanonical(url));
                var p = String(u.pathname || '').replace(/\\/+$/, '');
                var m = p.match(/^\\/@[^/]+\\/(?:video|photo)\\/(\\d+)$/i)
                     || p.match(/^\\/t\\/([^/]+)$/i)
                     || p.match(/^\\/([A-Za-z0-9]+)$/);   // vm./vt. kisa kodu
                return m ? m[1] : (p.replace(/^\\//, '') || '');
            } catch (e) { return ''; }
        }

        function fbPostCode(url) {
            try {
                var u = new URL(XPlat.fbCanonical(url));
                var p = String(u.pathname || '').replace(/\\/+$/, '');
                // Kimligi YOLDA olan formlar. /groups/{g}/posts/{kod} once denenir; zaten
                // /{ad}/posts/{kod} kalibi 4 parcali yola uymaz, cakismazlar.
                var m = p.match(/^\\/groups\\/[^/]+\\/posts\\/([^/]+)$/i)
                     || p.match(/^\\/[^/]+\\/posts\\/([^/]+)$/i)
                     || p.match(/^\\/share\\/[pvr]\\/([^/]+)$/i)
                     || p.match(/^\\/reel\\/([^/]+)$/i);
                if (m) return m[1];
                // Kimligi SORGUDA olan formlar: permalink.php/story.php (story_fbid),
                // photo.php + /photo/ (fbid), /watch/ (v).
                return u.searchParams.get('story_fbid') || u.searchParams.get('fbid')
                    || u.searchParams.get('v') || p.replace(/^\\//, '') || '';
            } catch (e) { return ''; }
        }
        // Faz FB-1: Facebook GONDERI linki mi? (sayfa/profil linkleri KAPSAM DISI —
        // FB'de profil karti yakalama yok, yalnizca gonderi tipleri destekleniyor.)
        // Desteklenen: /{ad}/posts/{id}, permalink.php?story_fbid=..&id=.., /share/{p|v|r}/{kod},
        // /groups/{g}/posts|permalink/{id}, /reel/{id}, /watch/?v=.., photo.php|/photo/?fbid=..
        function isFbPostUrl(url) {
            try {
                if (!window.XPlat || XPlat.platform(url) !== 'fb') return false;
                var s = String(url).trim();
                if (!/^https?:\\/\\//i.test(s)) s = 'https://' + s.replace(/^\\/+/, '');
                var u = new URL(s);
                var p = String(u.pathname || '').replace(/\\/+$/, '');
                var low = p.toLowerCase();
                if (/^\\/groups\\/[^/]+\\/(?:posts|permalink)\\/[^/]+$/i.test(p)) return true;
                if (/^\\/[^/]+\\/posts\\/[^/]+$/i.test(p)) return true;
                if (/^\\/share\\/[pvr]\\/[^/]+$/i.test(p)) return true;
                if (/^\\/reel\\/[^/]+$/i.test(p)) return true;
                if ((low === '/watch' || low === '/video.php') && u.searchParams.get('v')) return true;
                if ((low === '/photo.php' || low === '/photo') && u.searchParams.get('fbid')) return true;
                if ((low === '/permalink.php' || low === '/story.php') && u.searchParams.get('story_fbid')) return true;
                return false;
            } catch (e) { return false; }
        }
        // Faz TT-1: TikTok GONDERI url'i mi (ALIM KAPISI).
        // Bu dal olmazsa TikTok linki panelde SESSIZCE REDDEDILIR ve metin kutusunda kalir
        // (FB'de tam bunu yasadik). background.js'teki xIsTtPostUrl ile AYNI kural.
        // Kapsam kullanici karari: VIDEO gonderileri (+ kisa linkler, hepsi videoya yonlenir).
        // /photo/ kapsam disi ama link yapistirilirsa reddetmek yerine kabul edilir —
        // yakalama Faz 2'de neyi destekledigine karar verir.
        function isTtPostUrl(url) {
            try {
                if (!window.XPlat || XPlat.platform(url) !== 'tt') return false;
                var u = new URL(XPlat.ttCanonical(url));
                var host = String(u.hostname || '').toLowerCase();
                var p = String(u.pathname || '').replace(/\\/+$/, '');
                if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') return /^\\/[A-Za-z0-9]+$/.test(p);
                if (/^\\/@[^/]+\\/(?:video|photo)\\/\\d+$/i.test(p)) return true;
                if (/^\\/t\\/[^/]+$/i.test(p)) return true;
                return false;
            } catch (e) { return false; }
        }
        // Faz YT-1: YouTube ICERIK url'i mi (ALIM KAPISI).
        // Bu dal olmazsa YouTube linki panelde SESSIZCE REDDEDILIR (FB'de yasandi).
        // Kapsam kullanici karari: video + Shorts + topluluk gonderisi.
        function isYtPostUrl(url) {
            try {
                if (!window.XPlat || XPlat.platform(url) !== 'yt') return false;
                var u = new URL(XPlat.ytCanonical(url));
                var p = String(u.pathname || '').replace(/\\/+$/, '');
                if (p.toLowerCase() === '/watch') return !!u.searchParams.get('v');
                if (/^\\/shorts\\/[^/]+$/i.test(p)) return true;
                if (/^\\/post\\/[^/]+$/i.test(p)) return true;
                return false;
            } catch (e) { return false; }
        }
        function isProfileUrl(url) {
            var clean = url.trim().replace(/^https?:\\/\\//, '').replace(/^www\\./, '').split('?')[0].split('#')[0];
            var match = clean.match(/^(x|twitter)\\.com\\/([a-zA-Z0-9_]{1,15})\\/?$/i);
            if (!match) return false;
            var username = match[2].toLowerCase();
            var systemNames = ["home", "explore", "notifications", "messages", "search", "settings", "i", "tos", "privacy", "about", "jobs", "help", "hashtag", "share", "status"];
            return systemNames.indexOf(username) === -1;
        }

        function parseInputLinks() {
            var inputEl = document.getElementById('tweet_links_input');
            if (!inputEl) return [];
            return inputEl.value.split(/\\r?\\n/)
                .map(function(l) { return l.trim(); })
                .filter(function(l) { return l.length > 0; });
        }

        // X/Twitter linklerindeki sorgu (?s=20, ?t=...) ve hash'i atıp kanonik linke çevir.
        // Instagram: reel/reels/tv + izleme parametrelerini (?igsh vb.) atip kanonik /p/CODE'e cevir.
        // (reel tam-ekran oynaticida acilip SS alinamiyordu; /p/ gonderi kartiyla acilir.)
        // Carousel icin ?img_index KORUNUR.
        function xIgCanonical(s) {
            try {
                var u = new URL(s);
                var parts = u.pathname.split('/').filter(function (p) { return p; });
                var kinds = ['p', 'reel', 'reels', 'tv'];
                var code = '';
                for (var i = 0; i < parts.length - 1; i++) {
                    if (kinds.indexOf(parts[i].toLowerCase()) !== -1) { code = parts[i + 1]; break; }
                }
                if (!code) return s.split('#')[0].split('?')[0];
                var out = 'https://www.instagram.com/p/' + code;
                var idx = u.searchParams.get('img_index');
                if (idx) out += '?img_index=' + encodeURIComponent(idx);
                return out;
            } catch (e) { return s; }
        }
        // X/Twitter: sorgu+hash at. Instagram: /p/CODE'e normalize et. Facebook: kanonik forma
        // cevir (kimlik SORGUDA olabilir -> sorgu koruklu beyaz-liste). Digerleri: DOKUNMA.
        // Sunucudaki x_temizle_link'in IKIZI — ikisi ayrisirsa havuz link'i ile goruntu
        // anahtari uyusmaz ve GORSEL KAYBOLUR.
        function xCleanLink(link) {
            try {
                var s = String(link).trim();
                var host = '';
                try { host = new URL(s).hostname.toLowerCase(); } catch (e) { return s; }
                if (host.indexOf('instagram.com') !== -1) return xIgCanonical(s);
                if (window.XPlat && XPlat.platform(s) === 'fb') return XPlat.fbCanonical(s);
                // Faz TT-1: sorgu tamamen atilir (is_from_webapp, web_id = izleme copu).
                if (window.XPlat && XPlat.platform(s) === 'tt') return XPlat.ttCanonical(s);
                // Faz YT-1: ?t= zaman damgasi, ?list= oynatma listesi, ?si=/?pp= izleme copu atilir.
                if (window.XPlat && XPlat.platform(s) === 'yt') return XPlat.ytCanonical(s);
                if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) {
                    return s.split('#')[0].split('?')[0];
                }
                return s;
            } catch (e) { return link; }
        }

        function processInputLinks() {
            var inputEl = document.getElementById('tweet_links_input');
            if (!inputEl) return;
            
            var lines = parseInputLinks();
            var validLinks = [];
            var remainingLines = [];
            
            lines.forEach(function(line) {
                var isStatus = line.includes('/status/');
                var isProfile = isProfileUrl(line);
                var lineLow = line.toLowerCase();
                var isInstagram = lineLow.includes('instagram.com/p/') || lineLow.includes('instagram.com/reel/') || lineLow.includes('instagram.com/reels/') || lineLow.includes('instagram.com/tv/');
                var isFacebook = isFbPostUrl(line);   // Faz FB-1
                var isTiktok = isTtPostUrl(line);     // Faz TT-1
                var isYoutube = isYtPostUrl(line);    // Faz YT-1
                if (isStatus || isProfile || isInstagram || isFacebook || isTiktok || isYoutube) {
                    validLinks.push(line);
                } else {
                    remainingLines.push(line);
                }
            });
            
            if (validLinks.length > 0) {
                window.accumulatedLinks = window.accumulatedLinks || [];
                var eklenenSayisi = 0;
                validLinks.forEach(function(link) {
                    link = xCleanLink(link);
                    if (window.accumulatedLinks.indexOf(link) === -1) {
                        window.accumulatedLinks.push(link);
                        eklenenSayisi++;
                    }
                });
                inputEl.value = remainingLines.join('\\n');
                updateLinksPreview();
                // Link eklenince sağ altta kısa bilgi kutusu (tarama başlatma toast'ı ile aynı).
                if (eklenenSayisi > 0) {
                    showToast(eklenenSayisi + ' link eklendi', 'success');
                }
            }
        }

        // Platform MARKA ikonu (inline SVG, ~15px). Kategori başlıklarında emoji yerine gerçek logo.
        // simple-icons yolları; X/TikTok currentColor (temaya uyar), IG/FB/YT marka rengi.
        function xPlatIkonSvg(hangi) {
            var a = 'width="15" height="15" viewBox="0 0 24 24" style="vertical-align:-3px;"';
            if (hangi === 'ig') return '<svg ' + a + ' fill="#E4405F"><path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z"/></svg>';
            if (hangi === 'fb') return '<svg ' + a + ' fill="#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>';
            if (hangi === 'tt') return '<svg ' + a + ' fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>';
            if (hangi === 'yt') return '<svg ' + a + ' fill="#FF0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>';
            return '<svg ' + a + ' fill="currentColor"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.153h7.594l5.243 6.931ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>';
        }

        function updateLinksPreview() {
            window.accumulatedLinks = window.accumulatedLinks || [];
            var links = window.accumulatedLinks;
            var previewArea = document.getElementById('links-preview-area');
            var previewList = document.getElementById('links-preview-list');
            var previewCount = document.getElementById('links-preview-count');
            
            if (!previewArea || !previewList || !previewCount) return;

            if (links.length === 0) {
                previewArea.style.display = 'none';
                previewList.innerHTML = '';
                return;
            }

            previewArea.style.display = 'block';
            previewCount.innerText = links.length + ' adet';

            // Group links by username
            var groups = {};
            links.forEach(function(link) {
                var isInstagram = link.includes('instagram.com/p/') || link.includes('instagram.com/reel/');
                var isStatus = link.includes('/status/');
                var isFacebook = (window.XPlat && XPlat.platform(link) === 'fb');   // Faz FB-1
                var isTiktok   = (window.XPlat && XPlat.platform(link) === 'tt');   // Faz TT-1
                var isYoutube  = (window.XPlat && XPlat.platform(link) === 'yt');   // Faz YT-1
                if (isInstagram) {
                    var username = "instagram";
                    if (!groups[username]) {
                        groups[username] = { profile_url: null, tweets: [] };
                    }
                    if (groups[username].tweets.indexOf(link) === -1) {
                        groups[username].tweets.push(link);
                    }
                } else if (isFacebook) {
                    // FB dali isStatus/else'ten ONCE gelmeli: aksi halde FB linki en alttaki
                    // X-regex'ine duser, eslesmez ve "bilinmeyen" profil_url'u olarak islenirdi.
                    //
                    // TEK BLOK (kullanici istegi 2026-07-17): butun FB linkleri ayni blokta.
                    // Once sayfa slug'ina gore ayri bloklara bolunuyordu ("ntvspor" bir blok,
                    // paylasim linkleri baska blok) — kullanici "hepsi Facebook, bir tutulsun"
                    // dedi. Zaten panel onizlemesi tarama ONCESI: paylasim linklerinde sayfa
                    // adi HENUZ bilinmiyor (yonlendirme tarama sirasinda olur), yani burada
                    // gruplamak yaniltici da oluyordu.
                    // NOT: Word'deki Baslik 2 gruplamasi ETKILENMEZ — o pool_group_key ile
                    // sunucuda, yakalanan gercek linke gore yapiliyor.
                    var username = 'fb';
                    if (!groups[username]) {
                        groups[username] = { profile_url: null, tweets: [] };
                    }
                    if (groups[username].tweets.indexOf(link) === -1) {
                        groups[username].tweets.push(link);
                    }
                } else if (isYoutube) {
                    // Faz YT-1: FB/TT ile ayni TEK BLOK deseni. Kanal adi kapsamdaki
                    // formlarda URL'de YOK (watch?v=/shorts/post) -> bloklara bolemeyiz.
                    var username = 'yt';
                    if (!groups[username]) { groups[username] = { profile_url: null, tweets: [] }; }
                    if (groups[username].tweets.indexOf(link) === -1) { groups[username].tweets.push(link); }
                } else if (isTiktok) {
                    // Faz TT-1: FB dali gibi, isStatus/else'ten ONCE. TEK BLOK — FB'de
                    // kullanicinin istedigi bicimin aynisi ("hepsi TikTok, bir tutulsun").
                    // Not: TikTok'ta kullanici adi URL'de VAR, yani bloklara bolebilirdik;
                    // ama kisa linklerde (vm./vt.) YOK -> ayni listede iki farkli bicim
                    // olurdu. FB'de tam bu yuzden tek bloga gecmistik.
                    var username = 'tt';
                    if (!groups[username]) {
                        groups[username] = { profile_url: null, tweets: [] };
                    }
                    if (groups[username].tweets.indexOf(link) === -1) {
                        groups[username].tweets.push(link);
                    }
                } else if (isStatus) {
                    var match = link.match(/(?:x|twitter)\\.com\\/([a-zA-Z0-9_]{1,15})\\/status/i);
                    var username = match ? match[1].toLowerCase() : "bilinmeyen";
                    if (!groups[username]) {
                        groups[username] = { profile_url: null, tweets: [] };
                    }
                    if (groups[username].tweets.indexOf(link) === -1) {
                        groups[username].tweets.push(link);
                    }
                } else {
                    var match = link.match(/(?:x|twitter)\\.com\\/([a-zA-Z0-9_]{1,15})/i);
                    var username = match ? match[1].toLowerCase() : "bilinmeyen";
                    if (!groups[username]) {
                        groups[username] = { profile_url: null, tweets: [] };
                    }
                    groups[username].profile_url = link;
                }
            });

            var html = '';
            // İSTEK: X hesapları "X (Twitter)" ŞEMSİYESİ altında toplansın (IG/FB/TT/YT gibi platform
            // düzeyinde tek üst-blok); içinde @hesap alt-blokları kalır. Böylece X hesapları üst düzeyde
            // Instagram/Facebook ile AYNI seviyede durmaz, ayrı sosyal medya aracı gibi görünmez.
            // X hesapları = 4 platform anahtarı DIŞINDAKI tüm anahtarlar (@kullanıcı + 'bilinmeyen').
            var _platKeys = ['instagram', 'fb', 'tt', 'yt'];
            var _xKeys = Object.keys(groups).filter(function (k) { return _platKeys.indexOf(k) === -1; });
            var _pKeys = Object.keys(groups).filter(function (k) { return _platKeys.indexOf(k) !== -1; });
            var _xAcik = false;
            _xKeys.concat(_pKeys).forEach(function(username) {
                var _isXHesap = (_platKeys.indexOf(username) === -1);
                if (_isXHesap && !_xAcik) {
                    html += '<div style="margin-bottom:12px; background:rgba(29,155,240,0.04); border:1px solid rgba(29,155,240,0.18); border-radius:10px; padding:10px;">';
                    html += '<div style="font-weight:bold; font-size:13px; color:var(--twitter-color); margin:0 0 8px 2px;">' + xPlatIkonSvg('x') + ' X (Twitter)</div>';
                    _xAcik = true;
                } else if (!_isXHesap && _xAcik) {
                    html += '</div>';   // X şemsiyesini platform bloklarından ÖNCE kapat
                    _xAcik = false;
                }
                var grp = groups[username];
                html += '<div style="margin-bottom: 12px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); padding: 12px; border-radius: 8px;">';
                
                // Group Header
                html += '<div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; margin-bottom: 10px;">';
                // Faz FB-1 + tek-blok (2026-07-17): butun FB linkleri 'fb' anahtarinda
                // toplaniyor -> tek blok, tek baslik.
                var isFbGroup = (username === 'fb');
                var isTtGroup = (username === 'tt');   // Faz TT-1: FB ile ayni tek-blok deseni
                var isYtGroup = (username === 'yt');   // Faz YT-1
                var groupIcon = xPlatIkonSvg(username === 'instagram' ? 'ig'
                              : (isFbGroup ? 'fb' : (isTtGroup ? 'tt' : (isYtGroup ? 'yt' : 'x'))));
                var displayName = username === 'instagram' ? 'Instagram Gönderileri'
                                : (isFbGroup ? 'Facebook Gönderileri'
                                : (isTtGroup ? 'TikTok Gönderileri'
                                : (isYtGroup ? 'YouTube Videoları'
                                             : '@' + username)));
                html += '  <span style="font-weight:bold; color:var(--twitter-color); font-size: 13px;">' + groupIcon + ' ' + displayName + '</span>';
                // İSTEK 1: X hesapları için "profil kartını da al" AÇ/KAPA butonu (hesap-hesap),
                // başlığın sağında. Gri=kapalı, yeşil=açık. Açıkken tweet linkinden türetilen
                // x.com/<kullanıcı> profil linki listeye eklenir (profil kartı en üste gelir).
                // YALNIZ X: profil kartı yakalama X'e ÖZEL özellik. IG/FB/TikTok/YouTube'da profil YOK
                // ve toggleProfileCardLink 'https://x.com/'+username üretir -> diğer platformlarda anlamsız
                // link olurdu. (Eskiden yalnız IG+FB dışlanıyordu; TT/YT'de düğme YANLIŞLIKLA görünüyordu.)
                if (username !== 'instagram' && username !== 'bilinmeyen' && !isFbGroup && !isTtGroup && !isYtGroup) {
                    var pcOn = !!grp.profile_url;
                    var pcBg = pcOn ? 'rgba(0,186,124,0.15)' : 'rgba(255,255,255,0.06)';
                    var pcColor = pcOn ? '#00ba7c' : 'var(--text-secondary)';
                    var pcBorder = pcOn ? '1px solid rgba(0,186,124,0.45)' : '1px solid var(--border-color)';
                    var pcText = pcOn ? 'Profil Ekran Görüntüsü Alınacak ✓' : 'Profil Ekran Görüntüsünü de Al';
                    html += '  <button type="button" onclick="toggleProfileCardLink(\\\'' + username + '\\\', ' + (!pcOn) + ')" style="font-size:11px; font-weight:600; padding:4px 10px; border-radius:6px; cursor:pointer; background:' + pcBg + '; color:' + pcColor + '; border:' + pcBorder + '; transition: all 0.15s ease;">' + pcText + '</button>';
                }
                html += '</div>';

                // Tweets / Instagram Posts List
                if (grp.tweets.length > 0) {
                    html += '<div style="display:flex; flex-direction:column; gap:8px; margin-left:4px;">';
                    grp.tweets.forEach(function(tweetUrl) {
                        var isInsta = tweetUrl.includes('instagram.com/p/') || tweetUrl.includes('instagram.com/reel/');
                        var isFbLink = (window.XPlat && XPlat.platform(tweetUrl) === 'fb');
                        var label = "";
                        if (isInsta) {
                            var parts = tweetUrl.split('instagram.com/')[1] || "";
                            var code = parts.split('/')[1] || parts.split('/')[0] || "gönderi";
                            label = "&#128279; Instagram Gönderi Kodu: " + code.split('?')[0].split('#')[0];
                        } else if (isFbLink) {
                            // Instagram dalindaki bicimin ayni: "<Platform> Gönderi Kodu: <kod>"
                            var fbKod = fbPostCode(tweetUrl);
                            label = "&#128279; Facebook Gönderi Kodu: " + (fbKod || 'bilinmiyor');
                        } else if (window.XPlat && XPlat.platform(tweetUrl) === 'yt') {
                            label = "&#128279; YouTube Gönderi Kodu: " + (ytPostCode(tweetUrl) || 'bilinmiyor');
                        } else if (window.XPlat && XPlat.platform(tweetUrl) === 'tt') {
                            // Faz TT-1: ayni bicim. Kod = video id (kimlik YOLDA).
                            label = "&#128279; TikTok Gönderi Kodu: " + (ttPostCode(tweetUrl) || 'bilinmiyor');
                        } else if (tweetUrl.indexOf('/status/') !== -1) {
                            var tweetId = tweetUrl.split('/status/')[1].split('?')[0].split('#')[0];
                            label = "&#128279; Tweet ID'si: " + tweetId;
                        } else {
                            // Savunma: /status/ icermeyen ve taninmayan link buraya duserse
                            // eskiden split('/status/')[1] undefined olup TypeError atardi.
                            label = "&#128279; " + tweetUrl;
                        }
                        html += '  <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px;">';
                        html += "    <a href='" + tweetUrl + "' target='_blank' style='color:var(--text-secondary); text-decoration:none; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:80%;'>" + label + "</a>";
                        html += '    <button type="button" onclick="removeLinkFromList(\\\'' + tweetUrl + '\\\')" style="background:none; border:none; color:var(--danger-color); cursor:pointer; font-weight:bold; font-size:12px; padding: 2px 6px;">❌</button>';
                        html += '  </div>';
                    });
                    html += '</div>';
                } else {
                    html += '  <div style="font-size:12px; color:var(--text-secondary); margin-left:4px; font-style:italic;">Henüz tivit/gönderi eklenmedi.</div>';
                }

                html += '</div>';
            });
            if (_xAcik) { html += '</div>'; }   // X hepsi sonda (platform bloğu yok) ise şemsiyeyi kapat

            previewList.innerHTML = html;
        }

        function removeLinkFromList(linkToRemove) {
            window.accumulatedLinks = window.accumulatedLinks || [];
            var index = window.accumulatedLinks.indexOf(linkToRemove);
            if (index !== -1) {
                window.accumulatedLinks.splice(index, 1);
                updateLinksPreview();
            }
        }

        // ===== İSTEK 2: Havuzu hesap-bloklarına gruplayıp sürükle-bırakla sıralama =====
        function poolEscapeHtml(s) {
            return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
        // [MANUEL HAVUZ] Manuel (xmanual://) tespiti XPlat'tan BAĞIMSIZ (yükleme yarışı: XPlat henüz
        // yüklenmeden havuz render edilirse manuel ham link olarak sızıyordu -> "Tekil öğe" + xmanual://).
        function poolIsManual(link) { return !!link && String(link).toLowerCase().indexOf('xmanual://') === 0; }
        // [EŞLEŞME] Editör overlay'i (window.__xEditorOverlay) -> havuz görünümü: düzenlenen başlık/link/görsel
        // havuz listesinde de görünsün (editör ile birebir eşleşme). Ham title/link'e YAZILMAZ (yalnız gösterim).
        function poolOverlayFor(link) { try { var ov = (window.__xEditorOverlay && window.__xEditorOverlay.byLink) || {}; return ov[xOvKey(link || '')] || null; } catch (e) { return null; } }
        function poolEffLink(x) { var ov = poolOverlayFor(x.link); if (ov && ov.parcalar) { for (var i = 0; i < ov.parcalar.length; i++) { var p = ov.parcalar[i]; if (p && p.tur === 'link' && p.url != null && p.url !== '') return p.url; } } return x.link || ''; }
        function poolEffThumb(x) { var ov = poolOverlayFor(x.link); if (ov && ov.parcalar) { for (var i = 0; i < ov.parcalar.length; i++) { var p = ov.parcalar[i]; if (p && p.tur === 'gorsel' && p.b64) return 'data:' + (p.mime || 'image/jpeg') + ';base64,' + p.b64; } } return null; }
        // [MANUEL HAVUZ] Manuel bölümün efektif başlığı: editör overlay başlığı (h2) -> yoksa ham title -> yoksa ''. "Manuel bölüm" sabiti YOK.
        function poolEffTitle(x) { var ov = poolOverlayFor(x.link); if (ov && ov.h2 != null && String(ov.h2).trim() !== '') return String(ov.h2).trim(); return (x.title || '').trim(); }
        // [MANUEL HAVUZ] Manuel metninden birkaç cümlelik önizleme (overlay parcalar 'metin' -> HTML temizle -> kırp). Metin yoksa ''.
        function poolEffMetin(x, maxLen) {
            maxLen = maxLen || 120;
            var ov = poolOverlayFor(x.link); if (!ov || !ov.parcalar) return '';
            var t = '';
            for (var i = 0; i < ov.parcalar.length; i++) { var p = ov.parcalar[i];
                if (p && p.tur === 'metin' && p.metin) {
                    var s = String(p.metin).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
                    if (s) t += (t ? ' ' : '') + s;
                }
                if (t.length >= maxLen) break;
            }
            if (t.length > maxLen) t = t.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
            return t;
        }
        function poolBlockLabel(items, group) {
            // [EŞLEŞME] editörde düzenlenen bölüm başlığı (overlay h2) varsa havuz blok başlığı da onu göster.
            if (items) { for (var _k = 0; _k < items.length; _k++) { var _ov = poolOverlayFor(items[_k].link); if (_ov && _ov.h2 != null && String(_ov.h2).trim() !== '') return String(_ov.h2); } }
            var t = '';
            for (var i = 0; i < items.length; i++) {
                var x = (items[i].title || '').trim();
                if (!x) continue;
                if (!t) t = x;
                if (x.indexOf('(') !== -1) { t = x; break; }
            }
            if (t) return t;
            // [MANUEL HAVUZ] Mavi grup başlığı DAİMA başlıktır: başlık (overlay h2 / title) yoksa BOŞ kalır.
            // (Metin önizlemesi YALNIZ kartın alt satırında; grup başlığına metin/"Manuel bölüm" KOYMA.)
            if (items && items[0] && poolIsManual(items[0].link)) return '';
            // Faz FB-1: FB anahtarlari 'fb:' onekli -> XPlat onegi soyar/etiketler.
            // X/IG icin ifade BIREBIR ayni kalir (XPlat yoksa eski davranisa duser).
            if (group) return (window.XPlat ? XPlat.groupFallbackTitle(group)
                                            : (group.charAt(0) === '@' ? group : '@' + group));
            return 'Tekil öğe';
        }
        function ensurePoolStyles() {
            if (document.getElementById('pool-dnd-style')) return;
            var s = document.createElement('style');
            s.id = 'pool-dnd-style';
            s.textContent =
                '.pool-hint{font-size:11px;color:var(--text-secondary);margin-bottom:14px;}' +
                // Platform bolumu = Word'deki BASLIK 1. Bloklar kendi bolumunde durur;
                // boylece siralama platform sinirini ASAMAZ (kullanici istegi 2026-07-17).
                '.pool-section{border:1px dashed var(--border-color);border-radius:12px;padding:10px;margin-bottom:20px;}' +
                '.pool-section-head{display:flex;align-items:center;gap:8px;padding:4px 6px 12px;font-weight:700;font-size:15px;color:var(--text-primary);}' +
                '.pool-section-count{margin-left:auto;font-size:11px;color:var(--text-secondary);font-weight:500;}' +
                '.pool-section .pool-block:last-child{margin-bottom:0;}' +
                '.pool-block{border:1px solid var(--border-color);border-radius:10px;margin-bottom:18px;background:rgba(255,255,255,0.02);}' +
                '.pool-block-head{display:flex;align-items:center;gap:8px;padding:13px 16px;border-bottom:1px solid var(--border-color);font-weight:600;font-size:14px;color:var(--accent-color);}' +
                '.pool-block-count{margin-left:auto;font-size:11px;color:var(--text-secondary);font-weight:500;}' +
                '.pool-block-moves{display:flex;gap:4px;}' +
                '.pool-move-btn{background:var(--bg-btn-secondary);border:1px solid var(--border-color);color:var(--text-primary);border-radius:4px;width:26px;height:24px;cursor:pointer;font-size:11px;line-height:1;padding:0;}' +
                '.pool-move-btn:hover:not(:disabled){border-color:var(--accent-color);}' +
                '.pool-move-btn:disabled{opacity:0.3;cursor:default;}' +
                '.pool-block-items{padding:12px;display:flex;flex-direction:column;gap:10px;}' +
                '.pool-item{display:flex;align-items:center;gap:12px;padding:11px 12px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-input);cursor:grab;user-select:none;-webkit-user-select:none;}' +
                '.pool-item:active{cursor:grabbing;}' +
                '.pool-item.dragging{opacity:0.45;}' +
                '.pool-item.drop-target{border-color:var(--accent-color);border-style:dashed;}' +
                '.pool-grip{color:var(--text-secondary);font-size:18px;user-select:none;padding:0 4px;}' +
                '.pool-item .item-thumb{width:56px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0;}' +
                '.pool-noimg{display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text-secondary);background:rgba(255,255,255,0.03);}' +
                '.pool-item .item-text{flex:1;min-width:0;}' +
                '.pool-item .item-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px;}' +
                '.pool-item .item-link{font-size:12px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
                '.pool-badge{font-size:9px;background:var(--accent-glow);color:var(--accent-color);padding:1px 5px;border-radius:4px;font-weight:600;margin-left:4px;}';
            document.head.appendChild(s);
        }
        function renderPoolGrouped(container, list) {
            ensurePoolStyles();
            // [bitişik-dizi] Manuel öğe VARSA bloklar ARDIŞIK diziyle kurulur -> aynı hesabın havuzda yan
            // yana içerikleri birleşir ama araya manuel/başka hesap girince O NOKTADA bölünür (editör/Word ile
            // aynı). Manuel yoksa eski tam-birleşme (hash) davranışı korunur.
            var _poolHasManual = false;
            for (var _ph = 0; _ph < list.length; _ph++) { if (list[_ph] && poolIsManual(list[_ph].link)) { _poolHasManual = true; break; } }
            var blocks = [], byKey = {};
            if (_poolHasManual) {
                var _prevG = null, _curBlk = null;
                for (var i = 0; i < list.length; i++) {
                    var it = list[i];
                    var g = it.group || '';
                    if (g && g === _prevG && _curBlk) { _curBlk.items.push(it); }
                    else { _curBlk = { key: (g ? ('g:' + g + ':' + i) : ('solo:' + it.index)), group: (g || null), items: [it] }; blocks.push(_curBlk); }
                    _prevG = g || null;   // solo (manuel/linksiz) -> ardışık diziyi kırar
                }
            } else {
                for (var i2 = 0; i2 < list.length; i2++) {
                    var it2 = list[i2];
                    var key = it2.group ? ('g:' + it2.group) : ('solo:' + it2.index);
                    if (!byKey[key]) { byKey[key] = { key: key, group: it2.group, items: [] }; blocks.push(byKey[key]); }
                    byKey[key].items.push(it2);
                }
            }
            // --- PLATFORM BOLUMLERI (= Word'deki Baslik 1) ---
            // Kullanici istegi (2026-07-17): siralama Baslik 1 ICINDE kalsin — X'ler kendi
            // arasinda, IG'ler kendi arasinda, FB'ler kendi arasinda. Bloklari bolumlere
            // koyunca movePoolBlock (parentNode icinde calisiyor) platform sinirini
            // KENDILIGINDEN asamaz; savePoolOrderFromDom da DOM sirasini okudugu icin
            // bolum sirasi dogrudan havuz sirasina, oradan da Word'deki Baslik 1 sirasina
            // yansir. Bolum sirasi: havuzda ILK gorunen platform once (Word ile AYNI kural).
            var PLAT_ETIKET = { x: 'X (Twitter)', ig: 'Instagram', fb: 'Facebook', tt: 'TikTok', yt: 'YouTube', manual: 'Manuel Bölümler' };
            // [manuel havuz sırası]: Manuel öğe VARSA (ya da tek taranmış platform) -> platform bölümlerine
            // AYIRMA; TEK bölümde HAVUZ SIRASINDA göster. Böylece manuel ekleme koyulduğu yerde kalır ve
            // başlık ("Manuel Bölümler" / "X (Twitter)") basılmaz (editör/docx davranışıyla aynı; sections=1 -> başlık gizli).
            var _hasManual = false, _scraped = {};
            for (var _pi2 = 0; _pi2 < blocks.length; _pi2++) { var _pp = poolPlatformOf(blocks[_pi2].items[0]); if (_pp === 'manual') _hasManual = true; else _scraped[_pp] = 1; }
            var _platformGrupla = !_hasManual && (Object.keys(_scraped).length > 1);
            var sections = [], bySec = {};
            if (_platformGrupla) {
                for (var si = 0; si < blocks.length; si++) {
                    var sPlat = poolPlatformOf(blocks[si].items[0]);
                    if (!bySec[sPlat]) { bySec[sPlat] = { plat: sPlat, blocks: [] }; sections.push(bySec[sPlat]); }
                    bySec[sPlat].blocks.push(blocks[si]);
                }
            } else {
                sections = [{ plat: (blocks[0] ? poolPlatformOf(blocks[0].items[0]) : 'x'), blocks: blocks }];   // TEK bölüm = havuz sırası, başlık yok
            }

            var html = '';
            for (var s = 0; s < sections.length; s++) {
              var sec = sections[s];
              var secUpDis = (s === 0) ? ' disabled' : '';
              var secDownDis = (s === sections.length - 1) ? ' disabled' : '';
              html += '<div class="pool-section" data-plat="' + poolEscapeHtml(sec.plat) + '">';
              // Bolum basligi YALNIZCA birden fazla platform varsa: tek platformda Word'de
              // Baslik 1 BASILMIYOR, havuzda gostermek yaniltici olurdu.
              if (sections.length > 1) {
                var toplamOge = 0;
                for (var ci = 0; ci < sec.blocks.length; ci++) toplamOge += sec.blocks[ci].items.length;
                html += '<div class="pool-section-head">' +
                        '<span>' + poolEscapeHtml(PLAT_ETIKET[sec.plat] || sec.plat) + '</span>' +
                        '<span class="pool-section-count">' + toplamOge + ' öğe</span>' +
                        '<span class="pool-block-moves">' +
                        '<button type="button" class="pool-move-btn" title="Bölümü yukarı taşı"' + secUpDis + ' onclick="movePoolSection(this,\\\'up\\\')">&#9650;</button>' +
                        '<button type="button" class="pool-move-btn" title="Bölümü aşağı taşı"' + secDownDis + ' onclick="movePoolSection(this,\\\'down\\\')">&#9660;</button>' +
                        '</span></div>';
              }
              for (var b = 0; b < sec.blocks.length; b++) {
                var blk = sec.blocks[b];
                var upDis = (b === 0) ? ' disabled' : '';
                var downDis = (b === sec.blocks.length - 1) ? ' disabled' : '';
                html += '<div class="pool-block" data-blockkey="' + poolEscapeHtml(blk.key) + '">';
                html += '<div class="pool-block-head">' +
                        '<span class="pool-block-title">' + poolEscapeHtml(poolBlockLabel(blk.items, blk.group)) + '</span>' +
                        '<span class="pool-block-count">' + blk.items.length + ' öğe</span>' +
                        '<span class="pool-block-moves">' +
                        '<button type="button" class="pool-move-btn" title="Yukarı taşı"' + upDis + ' onclick="movePoolBlock(this,\\\'up\\\')">&#9650;</button>' +
                        '<button type="button" class="pool-move-btn" title="Aşağı taşı"' + downDis + ' onclick="movePoolBlock(this,\\\'down\\\')">&#9660;</button>' +
                        '</span></div>';
                html += '<div class="pool-block-items">';
                // v3.77: PROFIL KARTI grubun EN USTUNDE (Word ile AYNI kural). data-pool-index
                // gercek havuz indeksini tasidigi icin display sirasini degistirmek surukleme/
                // sil/reorder'i BOZMAZ (islemler indekse gore, ekran sirasina gore DEGIL).
                var _bp=[], _br=[];
                for (var _bi=0;_bi<blk.items.length;_bi++){ (blk.items[_bi].is_profile?_bp:_br).push(blk.items[_bi]); }
                var _blkItems=_bp.concat(_br);
                for (var j = 0; j < _blkItems.length; j++) {
                    var x = _blkItems[j];
                    var poolIdx = x.index - 1;
                    var thumb;
                    var _ovThumb = poolEffThumb(x);   // [EŞLEŞME] editörde eklenen/değişen görsel havuzda da görünsün
                    var _effLink = poolEffLink(x);    // [EŞLEŞME] editörde değişen link
                    if (_ovThumb) {
                        thumb = '<img draggable="false" src="' + _ovThumb + '" class="item-thumb" alt="Görsel">';
                    } else if (xLocalImagesEnabled() && window.XLocalImages && window.XLocalImages.hasImage(x.link)) {
                        // Yerel modda goruntu sunucuda degil; tarayicidaki IndexedDB'den (link'e gore).
                        thumb = '<img draggable="false" src="' + window.XLocalImages.getImageUrl(x.link) + '" class="item-thumb" alt="Görsel">';
                    } else if (x.has_image) {
                        thumb = '<img draggable="false" src="/api/manual/image/' + x.index + '?client_id=' + localStorage.getItem('x_client_id') + '&t=' + new Date().getTime() + '" class="item-thumb" alt="Görsel">';
                    } else {
                        thumb = '<div class="item-thumb pool-noimg">Görsel yok</div>';
                    }
                    // [MANUEL HAVUZ] Manuel bölüm kartı artık GERÇEK içeriğini gösterir: başlık (varsa) + metin önizlemesi (alt satır) + ilk görsel (thumb).
                    var _isMan = poolIsManual(x.link);
                    var _manMetin = _isMan ? poolEffMetin(x, 120) : '';
                    var _linkHtml = (x.link && x.link.indexOf('rt:') === 0) ? 'RT gönderisi — bağlantı yok'
                        : _isMan ? (_manMetin ? poolEscapeHtml(_manMetin) : ((_effLink && _effLink !== x.link) ? poolEscapeHtml(_effLink) : ''))
                        : poolEscapeHtml(_effLink || 'Link yok');
                    html += '<div class="pool-item" draggable="false" data-pool-index="' + poolIdx + '" data-blockkey="' + poolEscapeHtml(blk.key) + '">' +
                            '<span class="pool-grip">⠿</span>' +
                            thumb +
                            '<div class="item-text"><div class="item-title">' + poolEscapeHtml(_isMan ? poolEffTitle(x) : (x.title || '')) + (x.is_profile ? '<span class="pool-badge">profil</span>' : '') + '</div>' +
                            '<div class="item-link">' + _linkHtml + '</div></div>' +
                            '<button class="btn btn-danger-action btn-sm" draggable="false" onclick="deleteManualItem(' + x.index + ')" style="background: rgba(224, 36, 94, 0.1); border: 1px solid rgba(224, 36, 94, 0.2); color: var(--danger-color); padding: 6px 10px; border-radius: 6px; cursor: pointer;">Sil</button>' +
                            '</div>';
                }
                html += '</div></div>';
              }
              html += '</div>';   // .pool-section
            }
            container.innerHTML = html;
            attachItemDnd(container);
        }
        // Bir havuz ogesinin platformu ('x' | 'ig' | 'fb') — bolumleme icin.
        // XPlat yoksa 'x'e duser (eski davranis: tek bolum, gorunum bozulmaz).
        function poolPlatformOf(item) {
            try {
                if (poolIsManual(item && item.link)) return 'manual';   // XPlat yüklü olmasa da manuel doğru bölümlenir
                if (window.XPlat && item && item.link) return XPlat.platform(item.link);
            } catch (e) {}
            return 'x';
        }
        // Platform BOLUMUNU ▲▼ ile taşır = Word'deki Baslik 1 sirasi.
        // savePoolOrderFromDom DOM sirasini okudugu icin bolum tasimasi dogrudan havuz
        // sirasina, oradan da Baslik 1 sirasina yansir.
        function movePoolSection(btn, dir) {
            var container = document.getElementById('manual-items-container');
            var sec = btn.closest('.pool-section');
            if (!container || !sec) return;
            window.poolDragging = true;
            if (dir === 'up') {
                var prevS = sec.previousElementSibling;
                while (prevS && !prevS.classList.contains('pool-section')) prevS = prevS.previousElementSibling;
                if (prevS) sec.parentNode.insertBefore(sec, prevS);
            } else {
                var nextS = sec.nextElementSibling;
                while (nextS && !nextS.classList.contains('pool-section')) nextS = nextS.nextElementSibling;
                if (nextS) sec.parentNode.insertBefore(nextS, sec);
            }
            savePoolOrderFromDom(container);
        }
        // Hesap bloğunu ▲▼ ile yukarı/aşağı taşır (AYNI BOLUM icinde: parentNode artik
        // .pool-section, yani platform sinirini KENDILIGINDEN asamaz).
        function movePoolBlock(btn, dir) {
            var container = document.getElementById('manual-items-container');
            var block = btn.closest('.pool-block');
            if (!container || !block) return;
            // Sıra kaydedilene kadar araya giren yeniden-çizmeyi engelle (görsel geri almasın).
            window.poolDragging = true;
            if (dir === 'up') {
                var prev = block.previousElementSibling;
                while (prev && !prev.classList.contains('pool-block')) prev = prev.previousElementSibling;
                if (prev) block.parentNode.insertBefore(block, prev);
            } else {
                var next = block.nextElementSibling;
                while (next && !next.classList.contains('pool-block')) next = next.nextElementSibling;
                if (next) block.parentNode.insertBefore(next, block);
            }
            savePoolOrderFromDom(container);
        }
        // Sürüklenen öğenin Y konumuna göre ÖNÜNE geleceği öğeyi bulur (canlı yeniden dizme).
        function poolGetDragAfter(list, y) {
            var items = Array.prototype.slice.call(list.querySelectorAll('.pool-item:not(.dragging)'));
            var closest = { offset: Number.NEGATIVE_INFINITY, element: null };
            for (var i = 0; i < items.length; i++) {
                var box = items[i].getBoundingClientRect();
                var offset = y - box.top - box.height / 2;
                if (offset < 0 && offset > closest.offset) { closest = { offset: offset, element: items[i] }; }
            }
            return closest.element;
        }
        // Bir hesabın görselleri arasında FARE ile sürükle-bırak (HTML5 DnD'ye bağlı DEĞİL — bazı
        // ortamlarda o sessizce çalışmıyordu). Yalnızca aynı hesap listesi içinde canlı yeniden dizer.
        function xPoolDragMove(e) {
            var d = window.__poolDrag;
            if (!d || !d.item || !d.list) return;
            d.moved = true;
            var after = poolGetDragAfter(d.list, e.clientY);
            if (after == null) { d.list.appendChild(d.item); }
            else if (after !== d.item) { d.list.insertBefore(d.item, after); }
        }
        function xPoolDragUp() {
            var d = window.__poolDrag;
            if (!d || !d.item) { return; }
            var moved = d.moved, container = d.container, item = d.item;
            window.__poolDrag = null;
            if (item && item.classList) { item.classList.remove('dragging'); }
            try { document.body.style.userSelect = ''; } catch (e) {}
            if (moved && container) { savePoolOrderFromDom(container); }
            else {
                window.poolDragging = false;
                // v3.82 (Feature 2): HAREKET YOK -> TIK. Onizlemeyi ac ve TIKLANAN ogeye kaydir.
                // Onizleme mammoth ile .docx->HTML uretiliyor; K'inci <img> = gruplu siradaki
                // K'inci oge. Havuz DOM'u da ayni sirada (renderPoolGrouped + .docx AYNI gruplama/
                // profil-once) -> tiklanan .pool-item'in DOM indexi = onizlemedeki img indexi.
                try {
                    if (item && container) {
                        var _tumOgeler = Array.prototype.slice.call(container.querySelectorAll('.pool-item'));
                        var _k = _tumOgeler.indexOf(item);
                        if (_k >= 0) {
                            // Faz 7: havuz kartına tıklama -> editörü aç + o karta kaydır.
                            if (window.XEditor) { window.XEditor.ac({ scrollIndex: _k, fresh: true }); }
                        }
                    }
                } catch (e) {}
            }
        }
        function attachItemDnd(container) {
            // Belge seviyesindeki dinleyicileri yalnızca BİR KEZ bağla.
            if (!window.__poolDocDnd) {
                window.__poolDocDnd = true;
                document.addEventListener('mousemove', xPoolDragMove);
                document.addEventListener('mouseup', xPoolDragUp);
            }
            container.querySelectorAll('.pool-item').forEach(function(item) {
                item.addEventListener('mousedown', function(e) {
                    if (e.button !== 0) return;               // yalnızca sol tık
                    if (e.target.closest('button')) return;   // Sil butonu sürüklemeyi başlatmasın
                    window.__poolDrag = { item: item, list: item.closest('.pool-block-items'), moved: false, container: container };
                    window.poolDragging = true;
                    item.classList.add('dragging');
                    try { document.body.style.userSelect = 'none'; } catch (ex) {}
                    e.preventDefault();
                });
            });
        }
        function savePoolOrderFromDom(container) {
            var order = [];
            container.querySelectorAll('.pool-item').forEach(function(it) {
                order.push(parseInt(it.getAttribute('data-pool-index'), 10));
            });
            fetch('/api/manual/reorder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order: order })
            })
            .then(function(r) { return r.json(); })
            .then(function(res) {
                if (res.status !== 'success') { showToast('Sıralama kaydedilemedi: ' + (res.message || ''), 'danger'); }
                window.poolDragging = false;
                window.lastManuelListJson = null;
                refreshStatus();
            })
            .catch(function() {
                window.poolDragging = false;
                window.lastManuelListJson = null;
                refreshStatus();
            });
        }

        // İSTEK 1: Bir X hesabının profil kartını listeye ekler/çıkarır (hesap-hesap onay kutusu).
        // İşaretliyse x.com/<kullanıcı> profil linkini ekler; kaldırılırsa o hesabın profil linkini siler.
        function toggleProfileCardLink(username, checked) {
            window.accumulatedLinks = window.accumulatedLinks || [];
            var profileUrl = 'https://x.com/' + username;
            var existingIdx = -1;
            for (var i = 0; i < window.accumulatedLinks.length; i++) {
                var l = window.accumulatedLinks[i];
                if (l.indexOf('instagram.com') !== -1) continue;
                if (l.indexOf('/status/') !== -1) continue;
                var m = l.match(/(?:x|twitter)\\.com\\/([a-zA-Z0-9_]{1,15})/i);
                if (m && m[1].toLowerCase() === username) { existingIdx = i; break; }
            }
            if (checked) {
                if (existingIdx === -1) window.accumulatedLinks.push(profileUrl);
            } else {
                if (existingIdx !== -1) window.accumulatedLinks.splice(existingIdx, 1);
            }
            updateLinksPreview();
        }

        function clearInputLinks() {
            window.accumulatedLinks = [];
            var inputEl = document.getElementById('tweet_links_input');
            if (inputEl) {
                inputEl.value = '';
            }
            updateLinksPreview();
        }

        function initTweetAutomation() {
            try {
                var inputEl = document.getElementById('tweet_links_input');
                if (inputEl) {
                    inputEl.addEventListener('input', function() {
                        try {
                            processInputLinks();
                        } catch(e) { console.error(e); }
                    });
                    inputEl.addEventListener('paste', function() {
                        try {
                            setTimeout(processInputLinks, 50);
                        } catch(e) { console.error(e); }
                    });
                    inputEl.addEventListener('change', function() {
                        try {
                            processInputLinks();
                        } catch(e) { console.error(e); }
                    });
                    inputEl.addEventListener('keyup', function(e) {
                        try {
                            if (e.key === 'Enter') {
                                processInputLinks();
                            }
                        } catch(e) { console.error(e); }
                    });
                    updateLinksPreview();
                    autoResizeTextarea(inputEl);
                }

                // Global event delegation for live X (Twitter) tweet preview
                document.body.addEventListener('mouseover', function(e) {
                    try {
                        var target = e.target;
                        
                        // Check if we are hovering a preview list item, manual item link, or any anchor pointing to status
                        var item = target.closest('[data-tweet-id]');
                        var tweetId = null;
                        var tweetUrl = null;
                        var anchorEl = null;

                        if (item && item.dataset.tweetId) {
                            tweetId = item.dataset.tweetId;
                            tweetUrl = item.dataset.tweetUrl;
                            anchorEl = item;
                        } else {
                            var anchor = target.closest('a[href*="/status/"]');
                            if (anchor) {
                                var href = anchor.getAttribute('href');
                                var match = href.match(/\\/([^\\/]+)\\/status\\/(\\d+)/);
                                if (match && /^\\d+$/.test(match[2])) {
                                    tweetId = match[2];
                                    tweetUrl = href;
                                    anchorEl = anchor;
                                }
                            } else {
                                var linkTextEl = target.closest('.item-link');
                                if (linkTextEl) {
                                    var text = linkTextEl.innerText.trim();
                                    if (text.includes('/status/')) {
                                        var match = text.match(/\\/([^\\/]+)\\/status\\/(\\d+)/);
                                        if (match && /^\\d+$/.test(match[2])) {
                                            tweetId = match[2];
                                            tweetUrl = text;
                                            anchorEl = linkTextEl;
                                        }
                                    }
                                }
                            }
                        }

                        if (tweetId && tweetUrl && anchorEl) {
                            if (window.activeTweetAnchor !== anchorEl) {
                                var related = e.relatedTarget;
                                if (!related || !anchorEl.contains(related)) {
                                    window.activeTweetAnchor = anchorEl;
                                    window.activeTweetAnchor.dataset.tweetUrl = tweetUrl;
                                    showTweetPreview(tweetId, window.activeTweetAnchor);
                                }
                            }
                        }
                    } catch(err) {
                        console.error("Global mouseover error:", err);
                    }
                });

                document.body.addEventListener('mouseout', function(e) {
                    try {
                        if (window.activeTweetAnchor) {
                            var related = e.relatedTarget;
                            if (!related || (!window.activeTweetAnchor.contains(related) && window.activeTweetAnchor !== related)) {
                                window.activeTweetAnchor = null;
                                hideTweetPreview();
                            }
                        }
                    } catch(err) {
                        console.error("Global mouseout error:", err);
                    }
                });
            } catch(err) {
                console.error("Textarea init error:", err);
            }
        }

        if (document.readyState === 'loading') {
            document.addEventListener("DOMContentLoaded", initTweetAutomation);
        } else {
            initTweetAutomation();
        }

        // Word Document Preview Modal Controls
        window.lastGeneratedBlob = null;
        window.lastGeneratedFilename = "";

        // Twitter (X) Live Preview Popover Controls
        function showTweetPreview(tweetId, anchorEl) {
            try {
                const popover = document.getElementById('tweet-preview-popover');
                const loading = document.getElementById('tweet-preview-loading');
                const content = document.getElementById('tweet-preview-content');
                if (!popover || !loading || !content) return;

                // Clear previous preview
                content.innerHTML = '';
                loading.style.display = 'flex';
                loading.innerText = '⏳ Yükleniyor...';

                // Position popover relative to the hovered item with smart boundary checking
                const rect = anchorEl.getBoundingClientRect();
                const popoverWidth = 350;
                const gap = 15;
                let leftPosition = rect.right + window.scrollX + gap;
                if (rect.right + popoverWidth + gap > window.innerWidth) {
                    leftPosition = rect.left + window.scrollX - popoverWidth - gap;
                }
                popover.style.top = (rect.top + window.scrollY - 10) + 'px';
                popover.style.left = leftPosition + 'px';
                popover.style.display = 'block';
                
                // Allow browser to render display:block before transitioning opacity
                setTimeout(() => {
                    popover.classList.add('active');
                }, 20);

                const tweetUrl = decodeURIComponent(anchorEl.dataset.tweetUrl);
                const isLightTheme = document.body.classList.contains('light-theme');
                const theme = isLightTheme ? 'light' : 'dark';
                const cacheKey = tweetUrl + '_' + theme;

                window.oembedCache = window.oembedCache || {};

                function renderOembed(html) {
                    loading.style.display = 'none';
                    content.innerHTML = html;
                    
                    if (window.twttr && typeof window.twttr.ready === 'function') {
                        window.twttr.ready(function(twttrInstance) {
                            if (twttrInstance && twttrInstance.widgets) {
                                try {
                                    twttrInstance.widgets.load(content);
                                } catch(e) {
                                    console.error("Widgets load failed:", e);
                                }
                            }
                        });
                    }
                }

                if (window.oembedCache[cacheKey]) {
                    renderOembed(window.oembedCache[cacheKey]);
                } else {
                    fetch('/api/tweet/oembed?url=' + encodeURIComponent(tweetUrl) + '&theme=' + theme)
                    .then(res => {
                        if (!res.ok) throw new Error("Status " + res.status);
                        return res.json();
                    })
                    .then(data => {
                        window.oembedCache[cacheKey] = data.html;
                        renderOembed(data.html);
                    })
                    .catch(err => {
                        loading.style.display = 'flex';
                        loading.innerText = 'Önizleme yüklenemedi.';
                        console.error("oEmbed load error:", err);
                    });
                }
            } catch (err) {
                console.error("showTweetPreview error:", err);
            }
        }

        function hideTweetPreview() {
            try {
                const popover = document.getElementById('tweet-preview-popover');
                if (popover) {
                    popover.classList.remove('active');
                    // Short timeout to allow CSS fade-out animation to complete
                    setTimeout(() => {
                        if (!popover.classList.contains('active')) {
                            popover.style.display = 'none';
                            const content = document.getElementById('tweet-preview-content');
                            if (content) content.innerHTML = '';
                        }
                    }, 200);
                }
            } catch (err) {
                console.error("hideTweetPreview error:", err);
            }
        }

        function autoResizeTextarea(el) {
            try {
                if (!el) return;
                
                // Reset style height and width to prevent visual jumps
                el.style.width = ''; // Keep width 100% as defined in CSS
                el.style.height = 'auto';
                
                // Calculate height using scrollHeight (taking borders into account)
                const borderHeight = el.offsetHeight - el.clientHeight;
                let newHeight = el.scrollHeight + borderHeight;
                if (newHeight > 160) {
                    newHeight = 160;
                }
                el.style.height = newHeight + 'px';
            } catch(e) {
                console.error("autoResizeTextarea error:", e);
            }
        }

        function resetAutomationUIAndBackend() {
            // Faz #1-A: yerel goruntu deposunu da temizle (sunucu havuzu sifirlaniyor).
            try { if (window.XLocalImages) window.XLocalImages.clear(); } catch (e) {}
            window.accumulatedLinks = [];
            var inputEl = document.getElementById('tweet_links_input');
            if (inputEl) {
                inputEl.value = '';
                if (typeof updateLinksPreview === 'function') {
                    updateLinksPreview();
                }
                autoResizeTextarea(inputEl);
            }
            fetch('/api/auto/reset', { method: 'POST' })
            .then(function(r) { return r.json(); })
            .then(function() {
                refreshStatus();
            });
        }

        // YALNIZCA HAVUZ temizleme (24 saat otomatik temizlik icin). resetAutomationUIAndBackend'den
        // farki: GIRDI KUTUSUNA / yazili linklere DOKUNMAZ. Sunucu havuzu (/api/manual/clear ->
        // pool.clear + gecici gorseller) + yerel gorseller (XLocalImages) temizlenir.
        function xHavuzYalnizTemizle() {
            try { if (window.XLocalImages) window.XLocalImages.clear(); } catch (e) {}
            fetch('/api/manual/clear', { method: 'POST' })
                .then(function () { if (typeof refreshStatus === 'function') refreshStatus(); })
                .catch(function () { if (typeof refreshStatus === 'function') refreshStatus(); });
        }

        // 24 SAAT OTOMATIK HAVUZ TEMIZLIGI (LOCAL / tarayici bazli, SABIT sure).
        // Kullanici surekli "Rapora Ekle" ile havuza atip yalnizca panoyu kullanabilir; havuz
        // gereksiz uzamasin diye: havuzda icerik VARSA ve "Kaydet ve Indir" YAPILMADIYSA, ilk
        // icerigin gorulmesinden 24 saat sonra havuz otomatik temizlenir.
        //  - Zaman damgasi localStorage'da (x_havuz_ilk_ts): ilk icerikte kurulur, SABIT (yeni
        //    eklemede sifirlanmaz), havuz bosalinca (kaydet/temizle/ac) silinir. Panel kapaliyken
        //    de sure isler; tekrar acilinca 24 saat dolduysa temizler.
        //  - Aktif tarama sirasinda (status running) temizlemez.
        function xHavuz24Kontrol(data) {
            try {
                var KEY = 'x_havuz_ilk_ts';
                var n = (data && data.manuel_count) || 0;
                if (n <= 0) { localStorage.removeItem(KEY); return; }   // havuz bos -> zamanlayici sifir
                var ts = parseInt(localStorage.getItem(KEY) || '0', 10);
                if (!ts) { localStorage.setItem(KEY, String(Date.now())); return; }   // SABIT: ilk icerikte basla
                var running = (data && data.status === 'running');
                if (!running && (Date.now() - ts) >= 24 * 60 * 60 * 1000 && !window._havuzTemizleniyor) {
                    window._havuzTemizleniyor = true;
                    localStorage.removeItem(KEY);
                    xHavuzYalnizTemizle();
                    if (typeof showToast === 'function') showToast('Havuz 24 saattir kaydedilmedi; otomatik temizlendi.', 'warning');
                    setTimeout(function () { window._havuzTemizleniyor = false; }, 8000);
                }
            } catch (e) {}
        }

    </script>

    <!-- Rapor Editörü modalı (Faz 7: VARSAYILAN önizleme, tam sayfa). Önizle girişleri burayı açar;
         içeriği /x-editor.js doldurur. preview-modal-content/preview-body CSS'ini yeniden kullanır. -->
    <div id="editorModal" class="modal">
        <div class="preview-modal-content">
            <div class="modal-header">
                <div style="display: flex; gap: 10px; align-items: center;">
                    <h2 class="x-shead" style="margin:0;"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5l3 3-9 9H4.5v-3z"/><path d="M11.5 5.5l3 3"/></svg>Rapor Editörü</h2>
                    <div style="display:inline-flex; gap:2px;">
                        <button id="ed-geri" class="ed-ikon-btn ed-ik-nav" onclick="window.XEditor &amp;&amp; window.XEditor.geriAl()" title="Geri al (Ctrl+Z)" disabled><svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7.5h7a4 4 0 1 1 0 8H8.5"/><path d="M7.5 4.5l-3 3 3 3"/></svg></button>
                        <button id="ed-ileri" class="ed-ikon-btn ed-ik-nav" onclick="window.XEditor &amp;&amp; window.XEditor.ileriAl()" title="İleri al (Ctrl+Y)" disabled><svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 7.5h-7a4 4 0 1 0 0 8h3"/><path d="M12.5 4.5l3 3-3 3"/></svg></button>
                    </div>
                </div>
                <div style="display: flex; gap: 2px; align-items: center;">
                    <input id="ed-rapor-adi" class="ed-rapor-adi" type="text" autocomplete="off" spellcheck="false" placeholder="Rapor adı" title="Rapor adını düzenle — Enter'a bas ya da başka yere tıkla; arka planda ve URL'de de güncellenir">
                    <button class="ed-ikon-btn ed-ik-galeri" onclick="window.XEditor &amp;&amp; window.XEditor.galeriToggle()" title="Galeri / Sırala: bölümleri kart ızgarasında sürükleyip sırala"><svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="11" y="3" width="6" height="6" rx="1"/><rect x="3" y="11" width="6" height="6" rx="1"/><rect x="11" y="11" width="6" height="6" rx="1"/></svg></button>
                    <button id="ed-ik-tamekran-btn" class="ed-ikon-btn ed-ik-tamekran" onclick="window.XEditor &amp;&amp; window.XEditor.tamEkran()" title="Tam ekran"><svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 3.5H3.5V7.5"/><path d="M12.5 3.5H16.5V7.5"/><path d="M7.5 16.5H3.5V12.5"/><path d="M12.5 16.5H16.5V12.5"/></svg></button>
                    <button class="ed-ikon-btn ed-ik-indir" onclick="window.XEditor &amp;&amp; window.XEditor.indir()" title="İndir (.docx; kaydetmez)"><svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5v9"/><path d="M6 9l4 3.5 4-3.5"/><path d="M4.5 16.5h11"/></svg></button>
                    <button class="ed-ikon-btn ed-ik-kapat" onclick="window.XEditor &amp;&amp; window.XEditor.kapat()" title="Kapat"><svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5.5 5.5l9 9"/><path d="M14.5 5.5l-9 9"/></svg></button>
                </div>
            </div>
            <div class="preview-body">
                <div id="editor-serit" class="ed-serit"></div>
                <div id="editor-root"></div>
            </div>
        </div>
    </div>
    <!-- Platform tespiti + FB kanoniklestirme (ORTAK). Digerlerinden ONCE yuklenmeli:
         xNormLink (x-local-images.js) ve entryPlatform (x-local-docx.js) window.XPlat'i kullanir. -->
    <script src="/x-platform.js"></script>
    <!-- İstemci-taraflı (tarayıcıda) Word üretimi — sadece "Deneysel" anahtar açıkken kullanılır -->
    <script src="/x-local-docx.js"></script>
    <script src="/x-local-images.js"></script>
    <!-- Kayıtlı Raporlar (yerel, çoklu, 1 hafta): "Kaydet ve İndir" + yeniden aç/indir/sil -->
    <script src="/x-saved-reports.js"></script>
    <!-- YENİ: Rapor Editörü (metin-editörü önizleme mimarisi, Faz 0+). BAYRAK KORUMALI (xEditorEnabled). -->
    <script src="/x-editor.js"></script>
</body>
</html>
"""

# ----------------- ORTAK PLATFORM MODULU (Faz FB-1) -----------------
# app.py'deki detect_platform / fb_canonical_link / fb_page_slug fonksiyonlarinin
# JS IKIZI. Panel tarafinda UC yerden kullanilir (HTML_TEMPLATE inline, LOCAL_DOCX_JS,
# LOCAL_IMAGES_JS) — ayri ayri kopyalanmasin diye tek dosya olarak sunulur.
#
# background.js (MV3 service worker) uzaktan kod yukleyemedigi icin TEK kacinilmaz
# kopyayi o tutar (xPlatformOf).
#
# !!! BU DOSYA app.py'deki Python ikizleriyle AYNI SONUCU vermek ZORUNDA. Ayrisirlarsa
# havuz ogeleri ile IndexedDB goruntuleri farkli anahtar alir ve GORSELLER KAYBOLUR/KARISIR
# (bkz. xNormLink yorumu — gecmiste tam olarak bu yasandi).
X_PLATFORM_JS = r'''
(function(){
  // --- host yardimcilari (Python: _is_fb_host / _url_host) ---
  function isFbHost(h){
    h = String(h||'').toLowerCase();
    return h === 'facebook.com' || /\.facebook\.com$/.test(h);
  }
  function isTtHost(h){   // Faz TT-1 (Python: _is_tt_host)
    h = String(h||'').toLowerCase();
    return h === 'tiktok.com' || /\.tiktok\.com$/.test(h);
  }
  function isYtHost(h){   // Faz YT-1 (Python: _is_yt_host)
    h = String(h||'').toLowerCase();
    // youtu.be AYRI alan adi (youtube.com altinda DEGIL) -> ayrica yazilmali.
    return h === 'youtube.com' || /\.youtube\.com$/.test(h)
        || h === 'youtu.be'    || /\.youtu\.be$/.test(h);
  }
  function urlOf(link){
    // Python _url_host ile ayni: protokol yoksa https:// ekle.
    var s = String(link==null?'':link).trim();
    if(!s) return null;
    if(!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/,'');
    try { return new URL(s); } catch(e){ return null; }
  }
  function hostOf(link){ var u = urlOf(link); return u ? String(u.hostname||'').toLowerCase() : ''; }

  // --- platform tespiti (Python: detect_platform) ---
  // 'x' | 'ig' | 'fb' | 'tt'. BILINMEYEN -> 'x' (mevcut davranis KORUNUR).
  // Python detect_platform ile SIRA DAHIL birebir ayni olmali.
  function isManual(link){   // Python is_manual_link ikizi
    return !!link && String(link).toLowerCase().indexOf('xmanual://') === 0;
  }
  function platform(link){
    var low = String(link==null?'':link).toLowerCase();
    if(isManual(link)) return 'manual';                    // B9: editor-manuel bolum (Python detect_platform ikizi)
    if(low.indexOf('instagram.com') !== -1) return 'ig';   // MEVCUT KURAL — DEGISTIRILMEDI
    var h = hostOf(link);
    if(isFbHost(h)) return 'fb';                           // host-hassas
    if(isTtHost(h)) return 'tt';                           // Faz TT-1
    if(isYtHost(h)) return 'yt';                           // Faz YT-1
    return 'x';                                            // MEVCUT VARSAYILAN
  }

  // --- TikTok kanonik link (Python: tt_canonical_link) ---
  // Kimlik YOLDA -> sorgu TAMAMEN atilir (is_from_webapp, web_id = izleme copu).
  // IDEMPOTENT olmak ZORUNDA: gorsel anahtari HAM linkten, havuz linki KANONIK linkten.
  // vm./vt. KISA link alan adlari KORUNUR (ayri gonderi uzayi; www'ye cevirmek yanlis
  // sayfaya isaret ederdi).
  var TT_KISA_HOSTLAR = ['vm.tiktok.com','vt.tiktok.com'];
  function ttCanonical(link){
    try {
      var u = urlOf(link);
      if(!u || !isTtHost(u.hostname)) return link;   // TikTok DEGIL -> DOKUNMA
      var host = String(u.hostname).toLowerCase();
      var path = String(u.pathname || '/').replace(/\/+$/, '');
      if(TT_KISA_HOSTLAR.indexOf(host) !== -1) return 'https://' + host + (path || '/');
      return 'https://www.tiktok.com' + (path || '/');
    } catch(e){ return link; }
  }

  // --- YouTube kanonik link (Python: yt_canonical_link) ---
  // UC kimlik yeri: /watch?v=ID SORGUDA, /shorts/ID ve /post/ID YOLDA.
  // youtu.be/live/embed -> watch?v=ID (ayni video, ayni yerlesim). Shorts AYRI kalir
  // (yerlesim farkli). Yalnizca 'v' korunur -> bilinmeyen parametreler kendiliginden atilir.
  var YT_KISA_HOSTLAR = ['youtu.be','www.youtu.be'];
  function ytVid(x){ return /^[A-Za-z0-9_-]{5,20}$/.test(x||'') ? x : null; }
  function ytCanonical(link){
    try {
      var u = urlOf(link);
      if(!u || !isYtHost(u.hostname)) return link;   // YouTube DEGIL -> DOKUNMA
      var host = String(u.hostname).toLowerCase();
      var path = String(u.pathname || '/').replace(/\/+$/, '');
      var m;
      if(YT_KISA_HOSTLAR.indexOf(host) !== -1){
        m = path.match(/^\/([^/]+)$/);
        var v0 = m ? ytVid(m[1]) : null;
        return v0 ? ('https://www.youtube.com/watch?v=' + v0) : ('https://www.youtube.com' + (path || '/'));
      }
      if(path.toLowerCase() === '/watch'){
        var v1 = ytVid(u.searchParams.get('v'));
        return v1 ? ('https://www.youtube.com/watch?v=' + v1) : 'https://www.youtube.com/watch';
      }
      m = path.match(/^\/(?:live|embed|v)\/([^/]+)$/i);
      if(m){ var v2 = ytVid(m[1]); if(v2) return 'https://www.youtube.com/watch?v=' + v2; }
      m = path.match(/^\/shorts\/([^/]+)$/i);
      if(m){ var v3 = ytVid(m[1]); if(v3) return 'https://www.youtube.com/shorts/' + v3; }
      m = path.match(/^\/post\/([^/]+)$/i);
      if(m) return 'https://www.youtube.com/post/' + m[1];
      return 'https://www.youtube.com' + (path || '/');
    } catch(e){ return link; }
  }
  // Kanal adi YALNIZCA /@kanal/... formunda URL'de vardir; kapsamdaki formlarda YOK -> null.
  function ytChannel(link){
    try {
      if(platform(link) !== 'yt') return null;
      var u = urlOf(ytCanonical(link));
      if(!u) return null;
      var m = String(u.pathname||'').match(/^\/@([^/]+)/i);
      return m ? m[1].toLowerCase() : null;
    } catch(e){ return null; }
  }

  // --- TikTok kullanici adi (Python: tt_kullanici_adi_oku) ---
  // FB'nin aksine HER kanonik gonderi linkinde VAR -> gruplama yakalama olmadan calisir.
  function ttUsername(link){
    try {
      if(platform(link) !== 'tt') return null;
      var u = urlOf(ttCanonical(link));
      if(!u) return null;
      var m = String(u.pathname||'').match(/^\/@([^/]+)\/(?:video|photo)\/\d+/i);
      return m ? m[1].toLowerCase() : null;
    } catch(e){ return null; }
  }

  var FB_ID_PARAMS = ['story_fbid','id','fbid','v'];   // SIRA ONEMLI (Python _FB_ID_PARAMS)

  // --- FB kanoniklestirme (Python: fb_canonical_link) ---
  // IDEMPOTENT olmak ZORUNDA: kendi ciktisina tekrar uygulandiginda AYNI sonuc.
  function fbCanonical(link){
    try{
      var s = String(link==null?'':link).trim();
      if(!s) return link;
      var u = urlOf(s);
      if(!u || !isFbHost(u.hostname)) return link;    // FB DEGIL -> DOKUNMA
      var path = String(u.pathname||'/').replace(/\/+$/,'');
      var low = path.toLowerCase();
      function g(k){ var v = u.searchParams.get(k); return (v === null || v === '') ? null : v; }
      var base = 'https://www.facebook.com';          // m./web./mbasic. -> www.
      var m;
      // 1) /groups/{g}/posts/{id}  (permalink/{id} varyanti AYNI gonderi)
      m = path.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/([^/]+)$/i);
      if(m) return base + '/groups/' + m[1] + '/posts/' + m[2];
      // 2) /{ad}/posts/{id}
      m = path.match(/^\/([^/]+)\/posts\/([^/]+)$/i);
      if(m) return base + '/' + m[1] + '/posts/' + m[2];
      // 3) /share/{p|v|r}/{kod}
      m = path.match(/^\/share\/([pvr])\/([^/]+)$/i);
      if(m) return base + '/share/' + m[1].toLowerCase() + '/' + m[2];
      // 4) /reel/{id}
      m = path.match(/^\/reel\/([^/]+)$/i);
      if(m) return base + '/reel/' + m[1];
      // 5) /watch/?v={id}
      if(low === '/watch' || low === '/video.php'){
        var v = g('v');
        return v ? (base + '/watch/?v=' + v) : (base + low);
      }
      // 6) photo.php?fbid= ve /photo/?fbid= AYNI fotograf (fbid kuresel tekil) -> TEK form.
      if(low === '/photo.php' || low === '/photo'){
        var fbid = g('fbid');
        return fbid ? (base + '/photo/?fbid=' + fbid) : (base + low);
      }
      // 7) permalink.php / story.php (story.php BILEREK birlestirilmedi — Faz 3)
      if(low === '/permalink.php' || low === '/story.php'){
        var sf = g('story_fbid'), pid = g('id');
        var out = base + low;
        if(sf){ out += '?story_fbid=' + sf; if(pid) out += '&id=' + pid; }
        return out;
      }
      // 8) Taninmayan FB formu: host normalize + YALNIZ beyaz-liste parametreleri.
      var keep = [];
      for(var i=0;i<FB_ID_PARAMS.length;i++){
        var kv = g(FB_ID_PARAMS[i]);
        if(kv) keep.push(FB_ID_PARAMS[i] + '=' + kv);
      }
      var o = base + path;
      if(keep.length) o += '?' + keep.join('&');
      return o;
    } catch(e){ return link; }
  }

  // --- FB sayfa/grup kimligi, SADECE URL'den (Python: fb_page_slug) ---
  function fbPageSlug(link){
    try{
      var c = fbCanonical(link);
      var u = urlOf(c);
      if(!u || !isFbHost(u.hostname)) return null;
      var path = String(u.pathname||'').replace(/\/+$/,'');
      var m = path.match(/^\/groups\/([^/]+)\/posts\//i);
      if(m) return 'group:' + m[1].toLowerCase();
      m = path.match(/^\/([^/]+)\/posts\//i);
      if(m) return m[1].toLowerCase();
      var low = path.toLowerCase();
      if(low === '/permalink.php' || low === '/story.php'){
        var v = u.searchParams.get('id');
        return v ? v.toLowerCase() : null;
      }
      return null;   // /share/p, /reel, /watch, /photo -> URL'de isim YOK
    } catch(e){ return null; }
  }

  // --- genel/yer tutucu baslik (Python: is_generic_title / _GENERIC_TITLES) ---
  // Gercek bir ad geldiginde uzerine yazilabilir kabul edilen basliklar.
  var GENERIC_TITLES = ['@instagram_user','instagram_user','instagram gönderisi','instagram gonderisi',
                        '@facebook_user','facebook_user','facebook gönderisi','facebook gonderisi',
                        '@tiktok_user','tiktok_user','tiktok gönderisi','tiktok gonderisi',
                        '@youtube_user','youtube_user','youtube videosu','youtube gönderisi','youtube gonderisi'];
  function isGenericTitle(t){
    if(!t) return true;
    return GENERIC_TITLES.indexOf(String(t).trim().toLowerCase()) !== -1;
  }

  // --- Grup anahtarindan yedek baslik ---
  // X/IG icin BUGUNKU ifade birebir korunur. FB anahtarlari 'fb:' onekli
  // (ayni adli X hesabiyla CAKISMASIN) -> onek soyulur.
  function groupFallbackTitle(val){
    var v = String(val==null?'':val);
    // B/C: manuel/ayri-kume sentetik anahtarlari (mc-..., xmanual://..., \x01run\x01 bitisik-dizi)
    // BASLIK DEGILDIR -> overlay basligi eksikse rastgele anahtar basliga sizmasin (bos don).
    if(v.indexOf('mc-') === 0 || v.indexOf('xmanual') === 0 || v.indexOf('\u0001run\u0001') === 0) return '';
    if(v.indexOf('fb:') === 0){
      var rest = v.slice(3);
      if(rest.indexOf('group:') === 0) return 'Facebook Grubu: ' + rest.slice(6);
      if(!rest || rest === '@facebook_user') return 'Facebook Gönderileri';
      return rest;
    }
    // Faz TT-1: 'tt:' oneki de soyulur. TikTok'ta ekranda kullanici adi '@' ile
    // gosterilir (@rtedijital) -> X/IG ifadesiyle ayni bicime dusuyoruz.
    if(v.indexOf('yt:') === 0){
      var r3 = v.slice(3);
      if(!r3 || r3 === '@youtube_user') return 'YouTube Videoları';
      return r3;   // kanal adi (yakalamadan gelir) — X/IG'deki gibi '@' EKLENMEZ
    }
    if(v.indexOf('tt:') === 0){
      var r2 = v.slice(3);
      if(!r2 || r2 === '@tiktok_user') return 'TikTok Gönderileri';
      return (r2.charAt(0) === '@') ? r2 : '@' + r2;
    }
    return (v.charAt(0) === '@') ? v : '@' + v;   // MEVCUT — birebir
  }

  window.XPlat = {
    platform: platform,
    fbCanonical: fbCanonical,
    fbPageSlug: fbPageSlug,
    ttCanonical: ttCanonical,
    ttUsername: ttUsername,
    ytCanonical: ytCanonical,
    ytChannel: ytChannel,
    groupFallbackTitle: groupFallbackTitle,
    isManual: isManual,
    isGenericTitle: isGenericTitle,
    isFbHost: isFbHost,
    isTtHost: isTtHost,
    isYtHost: isYtHost
  };
})();
'''


def _js_yanit(kaynak):
    """Panele gomulu uretilen JS'i ONBELLEKSIZ sun.

    NEDEN (2026-07-17, sahada isirdi): bu dosyalar <script src="/x-local-docx.js">
    gibi SURUM EKI OLMADAN cagriliyor ve rota hicbir onbellek basligi koymuyordu.
    Word ARTIK TARAYICIDA uretiliyor (LOCAL_DOCX_JS) -> tarayici eski kopyayi
    tutunca `docker compose up -d --build` yapilsa bile ESKI uretici calisiyor ve
    sunucudaki degisiklik kullaniciya hic ulasmiyor. Sessiz: panel yeni, ciktı eski.
    Kullanici "sabit sayfa sonu kalkti" denen surumde hala sayfa sonu davranisi
    gordu; teshis bu oldu.

    Dosyalar kucuk (~25KB) ve panel yerel agda -> no-store'un bedeli yok sayilir,
    karsiliginda "hangi kod calisiyor" belirsizligi tamamen kalkar.
    """
    from flask import Response
    r = Response(kaynak, mimetype='application/javascript')
    r.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    r.headers['Pragma'] = 'no-cache'
    r.headers['Expires'] = '0'
    return r


@app.route('/x-platform.js', methods=['GET'])
def x_platform_js():
    return _js_yanit(X_PLATFORM_JS)

# ----------------- CLIENT-SIDE (BROWSER) DOCX GENERATOR (FAZ 1, ANAHTARLI) -----------------
# Bu JS, panelde (istemci tarayıcısında) .docx üretir. Sunucu tarafı üretim (python-docx)
# olduğu gibi durur; bu yalnızca "Word'ü tarayıcıda üret" anahtarı AÇIK olduğunda kullanılır.
# Jinja brace çakışmasını önlemek için şablona gömülmeyip ayrı bir statik dosya olarak sunulur.
LOCAL_DOCX_JS = r'''
(function(){
  var EMU = 914400;
  var enc = new TextEncoder();
  function xmlEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }

  var CRC_TABLE = (function(){ var c,t=[],n,k; for(n=0;n<256;n++){ c=n; for(k=0;k<8;k++){ c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);} t[n]=c>>>0;} return t; })();
  function crc32(buf){ var c=0xFFFFFFFF,i; for(i=0;i<buf.length;i++){ c=CRC_TABLE[(c^buf[i])&0xFF]^(c>>>8);} return (c^0xFFFFFFFF)>>>0; }

  function zipStore(files){
    var chunks=[], central=[], offset=0, i;
    function u16(n){ return [n&0xFF,(n>>8)&0xFF]; }
    function u32(n){ return [n&0xFF,(n>>8)&0xFF,(n>>16)&0xFF,(n>>24)&0xFF]; }
    for(i=0;i<files.length;i++){
      var f=files[i];
      var nameBytes=enc.encode(f.name);
      var crc=crc32(f.data);
      var size=f.data.length;
      var local=[].concat(u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(size),u32(size),u16(nameBytes.length),u16(0));
      chunks.push(new Uint8Array(local)); chunks.push(nameBytes); chunks.push(f.data);
      var cen=[].concat(u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(size),u32(size),u16(nameBytes.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset));
      central.push(new Uint8Array(cen)); central.push(nameBytes);
      offset += local.length + nameBytes.length + size;
    }
    var cenSize=0; central.forEach(function(c){ cenSize+=c.length; });
    var cenOffset=offset;
    var end=[].concat(u32(0x06054b50),u16(0),u16(0),u16(files.length),u16(files.length),u32(cenSize),u32(cenOffset),u16(0));
    var all=chunks.concat(central,[new Uint8Array(end)]);
    var total=0; all.forEach(function(a){ total+=a.length; });
    var out=new Uint8Array(total), p=0, j;
    for(j=0;j<all.length;j++){ out.set(all[j],p); p+=all[j].length; }
    return out;
  }

  function baslikFormatla(s){ return String(s==null?'':s).replace(/\s+/g,' ').trim(); }

  function tweetKullaniciAdiOku(link){
    if(!link) return null;
    // İlk yol parçası kullanıcı adıdır; sondaki /media, /with_replies, /status/<id> vb. ekleri yok say.
    var m = link.match(/(?:x|twitter)\.com\/([^/?#]+)/i);
    if(m){
      var u=m[1].toLowerCase();
      var reserved=['home','explore','notifications','messages','search','i','settings','compose','hashtag','login','logout','signup','share','intent','tos','privacy','about','download'];
      if(u && reserved.indexOf(u)===-1) return u;
    }
    return null;
  }

  function b64ToBytes(b64){
    var bin=atob(b64), len=bin.length, bytes=new Uint8Array(len), i;
    for(i=0;i<len;i++){ bytes[i]=bin.charCodeAt(i); }
    return bytes;
  }

  function loadImageSize(dataUrl){
    return new Promise(function(resolve){
      var img=new Image();
      img.onload=function(){ resolve({w: img.naturalWidth||img.width, h: img.naturalHeight||img.height}); };
      img.onerror=function(){ resolve({w:0,h:0}); };
      img.src=dataUrl;
    });
  }

  // [ÇOKLU GÖRSEL] Bir öğenin GÖRSEL parçalarını efektif görselleriyle sırayla döndür.
  // Her 'gorsel' parçası kendi b64/mime'ını taşıyabilir (bölüm başına çok görsel); taşımıyorsa
  // [SORUN 2] (x-editor.js ikizi) Yeni eklenen link alanı BOŞ -> item.link'e düşme YALNIZ ASIL link parçasına.
  function yeniLinkBosAcik(){ try{ return localStorage.getItem('x_yeni_link_bos')!=='0'; }catch(e){ return true; } }
  // ASIL link = kullanıcının EKLEMEDİĞİ (_ekLink işaretsiz) İLK link parçasının indeksi; -1 yoksa. KONUMDAN
  // BAĞIMSIZ (görsel üstüne eklenen boş link asıl linki etkilemez -> docx'te tweet linki yer değiştirmez/çiftlenmez).
  function _asilLinkIdx(pc){ if(!pc) return -1; for(var _z=0;_z<pc.length;_z++){ if(pc[_z] && pc[_z].tur==='link' && !pc[_z]._ekLink) return _z; } return -1; }
  // YALNIZ İLK görsel parçası öğenin birincil image_b64'üne düşer (kazıma/eski tek-görsel uyumu).
  // Bayrak x_coklu_gorsel='0' -> part.b64 yok sayılır (eski davranış: yalnız birincil görsel).
  // Dönen: [{k:parçaIndeksi, b64, mime}] — b64 boş olabilir (henüz doldurulmamış kutu).
  function birimGorselleri(item){
    var out=[], usedPrimary=false, pc=(item&&item.parcalar)||[], k, hasGorselPart=false;
    var coklu=true; try{ coklu=(localStorage.getItem('x_coklu_gorsel')!=='0'); }catch(e){}
    // Birincil görsel bir parçaya PİNLİ ise (part.b64===image_b64) fallback'i TEKRAR uygulama (edGorselHarita ikizi).
    if(coklu && item && item.image_b64){ for(k=0;k<pc.length;k++){ if(pc[k] && pc[k].tur==='gorsel' && pc[k].b64===item.image_b64){ usedPrimary=true; break; } } }
    for(k=0;k<pc.length;k++){ if(!pc[k] || pc[k].tur!=='gorsel') continue; hasGorselPart=true;
      var b64=(coklu && pc[k].b64)?pc[k].b64:'', mime=(coklu && pc[k].mime)?pc[k].mime:'';
      if(!b64 && !usedPrimary && item.image_b64){ b64=item.image_b64; mime=item.image_mime||'image/jpeg'; usedPrimary=true; }
      out.push({k:k, b64:b64, mime:mime||'image/jpeg', align:(pc[k].align||'')});   // [GÖRSEL HİZA] parça-bazlı hizalama
    }
    // Parçasız (eski/doğrudan) öğe: 'gorsel' parçası yoksa birincil görsel k=-1 birimi (else dalı için).
    if(!hasGorselPart && item && item.image_b64){ out.push({k:-1, b64:item.image_b64, mime:item.image_mime||'image/jpeg', align:''}); }
    return out;
  }

  // [BAŞLIK OVERRIDE] Her başlık (platform h1 / içerik h2) tekil olarak biçimlenebilir: item.h1_ov / item.h2_ov
  // = yalnız override edilen özellikleri taşıyan nesne {font,size,color,bold,italic,underline,align,word}.
  // Efektif biçim = rol varsayılanı (b1/b global stil) ÜZERİNE override. Bayrak x_h_ov='0' -> override YOK
  // (başlık DAİMA rol varsayılanı; eski davranış birebir).
  function hOvAcik(){ try{ return localStorage.getItem('x_h_ov')!=='0'; }catch(e){ return true; } }
  // [WORD DÜZEYİ] Geçerli Word stilleri. Genel "Stil" ayarı bunlardan biriyse O kullanılır; DEĞİLSE ('oto'/
  // boş = OTOMATİK) role göre otonom varsayılan: platform->Başlık 1, içerik->Başlık 2. Tekil override: ov.word.
  var WORD_GECERLI={Normal:1,Heading1:1,Heading2:1,Heading3:1,Heading4:1};

  async function generateBlob(opts, providedItems){
    var items;
    if (providedItems) {
      // Word Duzenle (client-side, v3.99): ogeler DISARIDAN gelir (mammoth ile ayristirilmis,
      // image_b64 gomulu). Havuz fetch'i + XLocalImages enjeksiyonu ATLANIR. Grup+render AYNI.
      items = providedItems;
    } else {
      var res = await fetch('/api/pool/data');
      var data = await res.json();
      items = (data && data.items) || [];

      // Faz #1-A: Yerel modda goruntuler sunucuda YOK (image_b64 bos gelir);
      // tarayicidaki IndexedDB'den link'e gore enjekte et.
      try {
        if (window.XLocalImages && window.XLocalImages.isEnabled()) {
          // IndexedDB->_cache yuklemesi bitene kadar bekle (taze panel yenilemesinde goruntusuz .docx olmasin).
          if (window.XLocalImages.whenReady) { try { await window.XLocalImages.whenReady(); } catch(e){} }
          for (var _i=0; _i<items.length; _i++){
            var _lk = items[_i].link || '';
            if (window.XLocalImages.hasImage(_lk)) {
              items[_i].image_b64 = window.XLocalImages.getBase64(_lk);
              items[_i].image_mime = window.XLocalImages.getMime(_lk);
            }
          }
        }
      } catch(e){}
      // [AYIR / KÜME TAŞIMA KALICILIĞI] group_override GRUPLAMAYI plan ANINDA belirler; overlay'de saklanır
      // ama sunucu havuzunda YOKTUR. Reopen'da ham havuz çekilince "kendi başlığına ayır"/küme taşıma
      // kaybolurdu (restore plan SONRASI item'a yazdığı için geç kalır). Çözüm: plan ÖNCESİ overlay'den enjekte.
      try {
        var _ovB = (window.__xEditorOverlay && window.__xEditorOverlay.byLink) || {};
        var _nk = (window.XLocalImages && window.XLocalImages.normLink) ? window.XLocalImages.normLink : function(x){ return String(x||''); };
        for (var _gi=0; _gi<items.length; _gi++){
          var _oe = _ovB[ _nk(items[_gi].link||'') ];
          if (_oe){
            if (_oe.grup != null) items[_gi].group_override = _oe.grup;
            if (_oe.h2 != null) items[_gi].h2_override = _oe.h2;   // başlık (açık boş '' dahil) -> plan derivation'a aynen gider (ayır boş başlık + düzenlenen başlık docx'e yansır)
          }
        }
      } catch(e){}
    }

    // [bitişik-dizi gruplama]: Manuel bölüm VARSA (belge-oluşturucu modu) otomatik hesap gruplaması
    // ARDIŞIK diziye iner -> aynı hesabın havuzda yan yana içerikleri birleşir, araya manuel/başka
    // hesap girince grup O NOKTADA bölünür (A1, manuel, A2 mümkün). ELLE taşıma (group_override) ve
    // saf tarama (manuel yok) HER ZAMAN tam-birleşir (eski davranış birebir).
    var _hasManual=false; for(var _hm=0;_hm<items.length;_hm++){ if(items[_hm] && xIsManualLink(items[_hm].link||'')){ _hasManual=true; break; } }
    // [bitişik-dizi: OTO group_override dahil] Bayrak (geri alınabilir): manuel VARKEN otomatik @handle
    // group_override'lı öğeler de ardışık-diziye girsin (araya manuel koyunca hesap O NOKTADA bölünür).
    // '0' -> eski davranış (herhangi group_override her zaman tam birleşir). ELLE taşıma ('mc-'/run-key)
    // bu bayraktan BAĞIMSIZ her zaman tam birleşir.
    var _manualSplitsAuto=true; try{ _manualSplitsAuto = (localStorage.getItem('x_manual_splits_auto')!=='0'); }catch(e){}
    var groups={}, order=[], idx, _prevAutoUser=null, _runFirst='';
    for(idx=0; idx<items.length; idx++){
      var item=items[idx];
      var link=item.link||'';
      // v3.75: group_override EN YUKSEK oncelik — sunucudaki pool_group_key'in IKIZI.
      // RT'li tweet "Rapora Ekle" ile RT YAPANIN altinda gruplanir (widget socialContext'ten
      // @kullanici gonderir). Word TARAYICIDA uretildigi icin Baslik 2 gruplamasini belirleyen
      // yer BURASI; yalniz Python'u degistirmek yetmez (FB/TT/YT yorumlarindaki uyari).
      var _go = ((item.group_override||'')+'').trim().replace(/^@+/, '').toLowerCase();
      // #2: YERLI küme anahtarı (group_override YOK sayılarak) -> başlık türetmesi, kümeye elle
      // TAŞINAN yabancı öğenin başlığını kullanmasın (sadece yerli üyeler başlığı belirler).
      var _native = tweetKullaniciAdiOku(link);
      if(!_native && link && link.toLowerCase().indexOf('instagram.com')!==-1){
        var t0=(item.title||'').trim();
        _native = t0 ? t0.toLowerCase() : '@instagram_user';
      }
      // Faz FB-1: sunucudaki pool_group_key ile AYNI kural. IKISINI BIRDEN degistir.
      if(!_native && link && window.XPlat && XPlat.platform(link)==='fb'){
        var slug = XPlat.fbPageSlug(link);
        if(slug){ _native = 'fb:' + slug; }
        else {
          var tf=(item.title||'').trim();
          _native = (tf && !XPlat.isGenericTitle(tf)) ? ('fb:' + tf.toLowerCase()) : 'fb:@facebook_user';
        }
      }
      // Faz TT-1: sunucudaki pool_group_key 'tt:' dalinin IKIZI.
      // BU DAL FAZ 1'DE ATLANDI -> username null kaliyor -> her gonderi 'standalone'
      // oluyor ve KENDI Baslik 2'sini aliyordu. Kullanici bildirdi: "ayni kullanicinin
      // bircok TikTok linkini verdim, her ss icin ayri baslik yapti."
      // Word TARAYICIDA uretiliyor -> Baslik 2 gruplamasini belirleyen yer BURASI;
      // sunucudaki pool_group_key'i duzeltmek TEK BASINA yetmiyor. (Ustteki FB yorumu
      // "IKISINI BIRDEN degistir" diye uyariyordu; tam o tuzaga dustum.)
      if(!_native && link && window.XPlat && XPlat.platform(link)==='tt'){
        var ttSlug = XPlat.ttUsername(link);
        if(ttSlug){ _native = 'tt:' + ttSlug; }
        else {
          // Kisa link (vm./vt./t/) -> URL'de isim YOK; gercek ad yakalamadan gelir.
          var tt2=(item.title||'').trim();
          _native = (tt2 && !XPlat.isGenericTitle(tt2)) ? ('tt:' + tt2.toLowerCase()) : 'tt:@tiktok_user';
        }
      }
      // Faz YT-1: sunucudaki pool_group_key 'yt:' dalinin IKIZI.
      // (TikTok'ta bu ikizi ATLAMISTIM -> Word'de her gonderi AYRI Baslik 2 almisti.
      //  Ayni hatayi tekrarlamamak icin bu sefer AYNI commit'te.)
      if(!_native && link && window.XPlat && XPlat.platform(link)==='yt'){
        var ytK = XPlat.ytChannel(link);
        if(ytK){ _native = 'yt:' + ytK; }
        else {
          // watch?v= / shorts / post -> kanal URL'de YOK; gercek ad yakalamadan gelir.
          var yt2=(item.title||'').trim();
          _native = (yt2 && !XPlat.isGenericTitle(yt2)) ? ('yt:' + yt2.toLowerCase()) : 'yt:@youtube_user';
        }
      }
      item.__native = _native || '';     // başlık türetmesi için yerli anahtar
      var username = _go ? _go : _native;
      if(username){
        var gkey;
        // ELLE grup anahtarı mı? 'mc-' = "kendi başlığı/ayır" + küme-birleştir; '\u0001' = run-key'e taşıma.
        // Bunları kullanıcı BİLEREK grupladı -> _hasManual olsa da HER ZAMAN tam birleş. OTO @handle
        // group_override (Word Düzenle başlığı / RT yapan / kayıttan geri yüklenen) ELLE DEĞİL -> manuel
        // varken ardışık-diziye girer ki araya konan manuel bölüm hesabı O NOKTADA bölebilsin. (KÖK NEDEN:
        // eski "if(_go) her zaman tam birleş" dalı, group_override'lı A1/A2 arasına manuel giremiyordu.)
        var _goElle = _go && (_go.indexOf('mc-')===0 || _go.indexOf('\u0001')!==-1);
        if(_go && (_goElle || !_manualSplitsAuto || !_hasManual)){ gkey=username; _prevAutoUser=null; }   // ELLE grup / bayrak-kapalı / manuel-yok -> tam birleş (eski)
        else if(_hasManual){                                          // belge modu: ardışık-dizi (OTO group_override DAHİL araya manuel girince böl)
          if(username!==_prevAutoUser){ _runFirst = link || ('oge'+idx); }   // yeni run -> ilk öğenin linki (KARARLI: planlar arası aynı -> menüden taşıma yapışır)
          gkey='\u0001run\u0001'+username+'\u0001'+_runFirst;
          _prevAutoUser=username;
        } else { gkey=username; _prevAutoUser=username; }             // saf tarama -> tam birleş (eski)
        if(!groups[gkey]){ groups[gkey]={items:[]}; order.push(['group',gkey]); }
        groups[gkey].items.push(item);
      } else {
        order.push(['standalone', item]);
        _prevAutoUser=null;                                           // standalone (manuel dahil) ardışık diziyi kırar
      }
    }

    var rels=[], media=[], ridCounter=0, docPrId=1;
    function addImageRaw(b64, mime){
      if(!b64) return null;
      mime=mime||'image/jpeg';
      var ext=(mime.indexOf('png')!==-1)?'png':'jpeg';
      var name='image'+(media.length+1)+'.'+ext;
      media.push({name:'word/media/'+name, data:b64ToBytes(b64)});
      ridCounter++; var rid='rIdImg'+ridCounter;
      rels.push({id:rid, type:'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target:'media/'+name});
      return rid;
    }
    function addImage(item){ return item ? addImageRaw(item.image_b64, item.image_mime) : null; }
    function addHyperlink(url){
      ridCounter++; var rid='rIdLnk'+ridCounter;
      rels.push({id:rid, type:'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', target:url, mode:'External'});
      return rid;
    }

    var bColor=(opts.b_color||'#000000').replace('#','');
    var lColor=(opts.l_color||'#1DA1F2').replace('#','');
    var bSz=(parseInt(opts.b_size,10)||14)*2;
    var lSz=(parseInt(opts.l_size,10)||10)*2;
    var b1Color=(opts.b1_color||'#000000').replace('#','');
    var b1Sz=(parseInt(opts.b1_size,10)||18)*2;
    var b1Font=opts.b1_font||opts.b_font||'Arial';
    // Faz 2: Eklenen Metin stili + hizalama. Metin rengi/boyutu/fontu (bColor/bSz deseni).
    var mColor=(opts.m_color||'#000000').replace('#','');
    var mSz=(parseInt(opts.m_size,10)||11)*2;
    var mFont=opts.m_font||opts.b_font||'Calibri';
    // Hizalama (w:jc): stil ayarindaki *_align -> docx. Varsayilan 'left' = Word varsayilani ->
    // eski cikti BIREBIR ayni (jc eklenmemis gibi render edilir). Gecerli: left/center/right/both.
    function jc(align){
      var a=(align||'left'); if(a!=='center'&&a!=='right'&&a!=='both') a='left';
      return '<w:jc w:val="'+a+'"/>';
    }

    // [BAŞLIK OVERRIDE] rol varsayılanı (b/b1) ÜZERİNE başlık-başına override (ov) birleştir. ov yoksa/bayrak
    // kapalıysa eski çıktı BİREBİR (rol global stili). ov alanları: font,size(pt),color(#hex),bold,italic,
    // underline,align,word(Heading1..4/Normal). keepNext: başlık sonraki paragrafla aynı sayfada kalır.
    function headingXml(text, ov){
      ov = (hOvAcik() && ov) ? ov : {};
      var font=ov.font||opts.b_font;
      var color=(ov.color?String(ov.color).replace('#',''):bColor);
      var sz=(ov.size!=null?(parseInt(ov.size,10)||14)*2:bSz);
      var bold=(ov.bold!=null?ov.bold:opts.b_bold), ital=(ov.italic!=null?ov.italic:opts.b_italic), und=(ov.underline!=null?ov.underline:opts.b_underline);
      var align=ov.align||opts.b_align;
      var word=WORD_GECERLI[ov.word]?ov.word:(WORD_GECERLI[opts.b_wordstyle]?opts.b_wordstyle:'Heading2');   // tekil override -> genel Stil -> OTOMATİK (Başlık 2)
      var rPr='<w:rFonts w:ascii="'+xmlEsc(font)+'" w:hAnsi="'+xmlEsc(font)+'"/>';
      if(bold) rPr+='<w:b/>';
      if(ital) rPr+='<w:i/>';
      if(und) rPr+='<w:u w:val="single"/>';
      rPr+='<w:color w:val="'+color+'"/><w:sz w:val="'+sz+'"/><w:szCs w:val="'+sz+'"/>';
      // [BAŞLIK–PARAGRAF] başlık ile altındaki paragraf arası boşluk = b_after (pt -> twip ×20). Varsayılan 6pt=120 (eski birebir).
      var _bAfterPt=parseInt(opts.b_after,10); if(isNaN(_bAfterPt)||_bAfterPt<0) _bAfterPt=6;
      return '<w:p><w:pPr><w:pStyle w:val="'+word+'"/><w:keepNext/><w:keepLines/>'+jc(align)+'<w:spacing w:after="'+(_bAfterPt*20)+'"/></w:pPr><w:r><w:rPr>'+rPr+'</w:rPr><w:t xml:space="preserve">'+xmlEsc(text)+'</w:t></w:r></w:p>';
    }
    function heading1Xml(text, ov){
      ov = (hOvAcik() && ov) ? ov : {};
      var font=ov.font||b1Font;
      var color=(ov.color?String(ov.color).replace('#',''):b1Color);
      var sz=(ov.size!=null?(parseInt(ov.size,10)||18)*2:b1Sz);
      var bold=(ov.bold!=null?ov.bold:opts.b1_bold), ital=(ov.italic!=null?ov.italic:opts.b1_italic), und=(ov.underline!=null?ov.underline:opts.b1_underline);
      var align=ov.align||opts.b1_align;
      var word=WORD_GECERLI[ov.word]?ov.word:(WORD_GECERLI[opts.b1_wordstyle]?opts.b1_wordstyle:'Heading1');   // tekil override -> genel Stil -> OTOMATİK (Başlık 1)
      var rPr='<w:rFonts w:ascii="'+xmlEsc(font)+'" w:hAnsi="'+xmlEsc(font)+'"/>';
      if(bold) rPr+='<w:b/>';
      if(ital) rPr+='<w:i/>';
      if(und) rPr+='<w:u w:val="single"/>';
      rPr+='<w:color w:val="'+color+'"/><w:sz w:val="'+sz+'"/><w:szCs w:val="'+sz+'"/>';
      return '<w:p><w:pPr><w:pStyle w:val="'+word+'"/>'+jc(align)+'<w:spacing w:before="240" w:after="120"/></w:pPr><w:r><w:rPr>'+rPr+'</w:rPr><w:t xml:space="preserve">'+xmlEsc(text)+'</w:t></w:r></w:p>';
    }
    // Olcuyu ARTIK SECMIYOR, verileni cizer. Boyut karari sayfa planlamasinda
    // (xSayfalaVeBoyutla) verilir cunku ortak genislik "ayni sayfada kim var"a bagli.
    function imageXmlRaw(b64, mime, wIn, hIn, align){
      var rid=addImageRaw(b64, mime);
      if(!rid) return '';
      return _imageXmlFromRid(rid, wIn, hIn, align);
    }
    function imageXml(item, wIn, hIn, align){
      var rid=addImage(item);
      if(!rid) return '';
      return _imageXmlFromRid(rid, wIn, hIn, align);
    }
    // [GÖRSEL HİZA] efektif hizalama = parça override -> yoksa genel g_align -> yoksa left.
    // Bayrak x_gorsel_hiza='0' -> daima left (eski çıktı birebir). Görselde 'both' anlamsız -> jc coerce eder.
    function _gorselJc(align){
      var al=align||(opts.g_align||'left');
      try{ if(localStorage.getItem('x_gorsel_hiza')==='0') al='left'; }catch(_){}
      if(al==='both') al='left';
      return jc(al);
    }
    function _imageXmlFromRid(rid, wIn, hIn, align){
      var cx=Math.round(wIn*EMU), cy=Math.round(hIn*EMU), id=docPrId++;
      // keepNext: gorsel kendi linkinden AYRI sayfaya dusmesin (sayfa sinirini artik
      // Word belirliyor; sabit sayfa sonu 2026-07-17'de kaldirildi).
      return '<w:p><w:pPr><w:keepNext/>'+_gorselJc(align)+'<w:spacing w:after="120"/></w:pPr><w:r><w:drawing>'
        + '<wp:inline distT="0" distB="0" distL="0" distR="0">'
        + '<wp:extent cx="'+cx+'" cy="'+cy+'"/>'
        + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
        + '<wp:docPr id="'+id+'" name="Picture '+id+'"/>'
        + '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>'
        + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        + '<pic:nvPicPr><pic:cNvPr id="'+id+'" name="Picture '+id+'"/><pic:cNvPicPr/></pic:nvPicPr>'
        + '<pic:blipFill><a:blip r:embed="'+rid+'"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="'+cx+'" cy="'+cy+'"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    }
    function linkXml(url, afterTwips, withBorder){
      var pPr=jc(opts.l_align)+'<w:spacing w:after="'+afterTwips+'"/>';
      if(withBorder) pPr+='<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="auto"/></w:pBdr>';
      var inner='';
      if(url){
        var rid=addHyperlink(url);
        var rPr='<w:color w:val="'+lColor+'"/><w:sz w:val="'+lSz+'"/><w:szCs w:val="'+lSz+'"/><w:rFonts w:ascii="'+xmlEsc(opts.l_font)+'" w:hAnsi="'+xmlEsc(opts.l_font)+'"/>';
        if(opts.l_bold) rPr+='<w:b/>';
        if(opts.l_italic) rPr+='<w:i/>';
        if(opts.l_underline) rPr+='<w:u w:val="single"/>';
        inner='<w:hyperlink r:id="'+rid+'"><w:r><w:rPr>'+rPr+'</w:rPr><w:t xml:space="preserve">'+xmlEsc(url)+'</w:t></w:r></w:hyperlink>';
      }
      return '<w:p><w:pPr>'+pPr+'</w:pPr>'+inner+'</w:p>';
    }
    // Faz 2: Eklenen serbest metin paragrafi (görselin altına/üstüne). m_ stili + hizalama.
    // keepNext: metin kendinden onceki gorsele/baslaga bagli kalir. xmlEsc ZORUNLU.
    // Zengin metin: editör metin bloğu HTML (b/i/u/br) tutabilir -> satır-içi biçimli PARÇALARA ayır.
    // Düz metin (eski) -> tek parça. Her parçada temel m-stil + satır-içi (seçime özel) biçim birleşir.
    // [FAZ B] Satır-içi <span style>'tan font-family/color/font-size de toplanır (iç içe span'de iç olan kazanır).
    function _hex6(c){ c=String(c==null?'':c).trim(); var m;
      if(/^#[0-9a-f]{6}$/i.test(c)) return c.slice(1).toLowerCase();
      if(/^#[0-9a-f]{3}$/i.test(c)){ return (c[1]+c[1]+c[2]+c[2]+c[3]+c[3]).toLowerCase(); }
      if((m=c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i))){ function h(n){ n=Math.max(0,Math.min(255,parseInt(n,10)||0)).toString(16); return n.length<2?'0'+n:n; } return (h(m[1])+h(m[2])+h(m[3])).toLowerCase(); }
      return null;
    }
    function _font1(f){ f=String(f==null?'':f).split(',')[0].trim().replace(/^['"]|['"]$/g,'').trim(); return f||null; }
    function textRuns(html){
      var runs=[];
      try{
        var box=document.createElement('div'); box.innerHTML=String(html==null?'':html);
        (function walk(node, fmt){
          for(var c=node.firstChild;c;c=c.nextSibling){
            if(c.nodeType===3){ var t=c.nodeValue; if(t) runs.push({text:t,b:fmt.b,i:fmt.i,u:fmt.u,f:fmt.f,c:fmt.c,sz:fmt.sz,link:fmt.link}); }
            else if(c.nodeType===1){
              var tag=c.tagName.toLowerCase();
              if(tag==='br'){ runs.push({br:true}); continue; }
              var nf={b:fmt.b,i:fmt.i,u:fmt.u,f:fmt.f,c:fmt.c,sz:fmt.sz,link:fmt.link};
              if(tag==='a'){ var _ah=(c.getAttribute&&c.getAttribute('href'))||''; if(_ah) nf.link=_ah; }   // [SATIR-İÇİ LİNK]
              if(tag==='b'||tag==='strong') nf.b=true;
              if(tag==='i'||tag==='em') nf.i=true;
              if(tag==='u'||tag==='ins') nf.u=true;
              var st=(c.getAttribute&&c.getAttribute('style'))||'', m;
              if(/font-weight\s*:\s*(bold|[6-9]00)/i.test(st)) nf.b=true;
              if(/font-style\s*:\s*italic/i.test(st)) nf.i=true;
              if(/text-decoration[^;"']*underline/i.test(st)) nf.u=true;
              if((m=st.match(/font-family\s*:\s*([^;]+)/i))){ var f1=_font1(m[1]); if(f1) nf.f=f1; }
              if((m=st.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i))){ var c1=_hex6(m[1]); if(c1) nf.c=c1; }
              if((m=st.match(/font-size\s*:\s*([\d.]+)pt/i))){ var z=parseFloat(m[1]); if(z) nf.sz=Math.round(z*2); }
              walk(c, nf);
            }
          }
        })(box, {b:false,i:false,u:false,f:null,c:null,sz:null,link:null});
      }catch(e){ runs=[{text:String(html==null?'':html),b:false,i:false,u:false}]; }
      if(!runs.length) runs=[{text:'',b:false,i:false,u:false}];
      return runs;
    }
    function textXml(metin){
      var runs=textRuns(metin), body='';
      var _hlAcik=false, _hlUrl=null;   // [SATIR-İÇİ LİNK] açık <w:hyperlink> grubu
      function _hlKapat(){ if(_hlAcik){ body+='</w:hyperlink>'; _hlAcik=false; _hlUrl=null; } }
      for(var r=0;r<runs.length;r++){ var run=runs[r];
        if(run.br){ _hlKapat(); body+='<w:r><w:br/></w:r>'; continue; }
        if(run.text==null || run.text==='') continue;
        // [SATIR-İÇİ LİNK] link'li ardışık run'ları TEK <w:hyperlink> altında topla; link'siz run grubu kapatır.
        if(run.link){ if(!_hlAcik || _hlUrl!==run.link){ _hlKapat(); body+='<w:hyperlink r:id="'+addHyperlink(run.link)+'">'; _hlAcik=true; _hlUrl=run.link; } }
        else { _hlKapat(); }
        var rF=run.f||mFont, rC=run.c||(run.link?lColor:mColor), rSz=run.sz||mSz;   // link'li run (kendi rengi yoksa) link rengi
        var rPr='<w:rFonts w:ascii="'+xmlEsc(rF)+'" w:hAnsi="'+xmlEsc(rF)+'"/>';
        if(opts.m_bold || run.b) rPr+='<w:b/>';
        if(opts.m_italic || run.i) rPr+='<w:i/>';
        if(opts.m_underline || run.u || run.link) rPr+='<w:u w:val="single"/>';   // link -> altçizgi
        rPr+='<w:color w:val="'+rC+'"/><w:sz w:val="'+rSz+'"/><w:szCs w:val="'+rSz+'"/>';
        body+='<w:r><w:rPr>'+rPr+'</w:rPr><w:t xml:space="preserve">'+xmlEsc(run.text)+'</w:t></w:r>';
      }
      _hlKapat();
      if(!body) body='<w:r><w:rPr><w:rFonts w:ascii="'+xmlEsc(mFont)+'" w:hAnsi="'+xmlEsc(mFont)+'"/><w:color w:val="'+mColor+'"/><w:sz w:val="'+mSz+'"/><w:szCs w:val="'+mSz+'"/></w:rPr><w:t xml:space="preserve"></w:t></w:r>';
      // [SATIR ARALIĞI] metin paragrafı: satır aralığı (w:line) + paragraftan önce/sonra boşluk (w:before/after).
      // YALNIZ Word çıktısı; editör görünümü değişmez. Varsayılan (1.0 + kapalı) -> <w:spacing w:after="120"/> (eski birebir).
      // Bölümler arası boşluk OTONOM (bu ayara bağlı değil). Bayrak x_satir_aralik='0' -> eski davranış.
      var _saOn=true; try{ _saOn=(localStorage.getItem('x_satir_aralik')!=='0'); }catch(_){}
      var _mMult=_saOn?(parseFloat(opts.m_line||'1.0')||1.0):1.0;
      var _mBefore=(_saOn && opts.m_space_before)?'200':null;
      var _mAfter=(_saOn && opts.m_space_after)?'240':'120';
      var _mLine=(_mMult && Math.abs(_mMult-1.0)>0.001)?(' w:line="'+Math.round(240*_mMult)+'" w:lineRule="auto"'):'';
      var _mSp='<w:spacing'+(_mBefore!=null?(' w:before="'+_mBefore+'"'):'')+' w:after="'+_mAfter+'"'+_mLine+'/>';
      return '<w:p><w:pPr><w:keepNext/>'+jc(opts.m_align)+_mSp+'</w:pPr>'+body+'</w:p>';
    }
    // Faz 4b: grup-sonu ayraç çizgisi (parçalar modunda link'ten AYRI boş sınır paragrafı).
    // Eskiden link paragrafının alt-sınırıydı; parça sırası serbest olunca link en altta olmayabilir.
    function grupSonuXml(){
      return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="auto"/></w:pBdr><w:spacing w:after="360"/></w:pPr></w:p>';
    }

    // v3.75: RT'li ogenin linki SENTETIK ic anahtardir ("rt:{rt_yapan}:{tweet_id}") -> raporda
    // GOSTERILMEZ (kullanici karari: RT'de link koymaya gerek yok). Anahtar yalnizca gorsel
    // eslesmesi + dedup icin var; RT'nin kendine ait gercek bir URL'si zaten yok. entryPlatform
    // GERCEK item.link'i kullandigi icin ('rt:...' -> XPlat.platform -> 'x') X bolumu etkilenmez.
    function xIsManualLink(lk){ return !!lk && String(lk).toLowerCase().indexOf('xmanual://') === 0; }
    // [#1 PLATFORM BAŞLIĞI DÜZENLE] Platform adı başlığının (h1) kullanıcı düzenlemesi: ilk öğenin
    // h1_override'ı -> PLAT_LABEL yerine o metin basılır. Yalnız h1 ZATEN basılıyorsa (platform değişimi) geçerli.
    function ovH1(it){ return (it && it.h1_override!=null && String(it.h1_override).trim()!=='') ? String(it.h1_override) : null; }
    function xRaporLinkGoster(it){
      var lk = (it && it.link) || '';
      // rt: sentetik RT anahtari VE xmanual:// editor-manuel anahtari raporda GOSTERILMEZ.
      return (String(lk).indexOf('rt:') === 0 || xIsManualLink(lk)) ? '' : lk;
    }

    // Platform tespiti: bir order girisinin (grup/standalone) platformu, ilk ogesinin linkinden.
    // Faz FB-1: kural artik UCLU ve XPlat'a (sunucudaki detect_platform ikizi) delege edilir.
    // Eskiden 'instagram.com degilse X' idi -> Facebook linki SESSIZCE X sayilirdi.
    var PLAT_LABEL = { x:'X (Twitter)', ig:'Instagram', fb:'Facebook', tt:'TikTok', yt:'YouTube', manual:'Manuel Bölümler' };
    function entryPlatform(entry){
      var it = (entry[0]==='group') ? groups[entry[1]].items[0] : entry[1];
      var lk = ((it && it.link)||'');
      if(window.XPlat) return XPlat.platform(lk);
      return (lk.toLowerCase().indexOf('instagram.com')!==-1) ? 'ig' : 'x';  // XPlat yoksa eski davranis
    }
    // Platformlarin ILK GORUNME sirasi (havuz sirasina gore).
    var platSeen={}, platOrder=[], _pi;
    for(_pi=0; _pi<order.length; _pi++){
      var _p=entryPlatform(order[_pi]);
      if(!platSeen[_p]){ platSeen[_p]=true; platOrder.push(_p); }
    }
    // Faz FB-1: ikili '&&' yerine "birden fazla platform var mi". Tek platformda
    // Baslik 1 BASILMAZ (mevcut davranis birebir korunur).
    // [manuel araya girsin]: multiPlatform SAYIMINDA 'manual' SAYILMAZ -> "manuel + tek
    // taranmis platform" (veya yalniz manuel) tek-platform yoluna duser = HAVUZ SIRASI emisyonu
    // -> manuel bolumler eklendikleri yerde, bolumler ARASINDA kalir (ayri "Manuel Bolumler"
    // kumesi/basligi OLUSMAZ). Saf cok-platform taramada (>=2 taranmis) eski gruplama korunur.
    var multiPlatform = platOrder.filter(function(p){ return p!=='manual'; }).length > 1;

    // ================= SAYFA BAZLI YERLESIM (kullanici karari 2026-07-17) =================
    // Istek: "genislik/yukseklik oranini bozmadan oyle ayarla ki, gorselin yuksekligi
    // cok uzun degilse bir sayfada en az 2 gorsel olsun (Baslik2-Gorsel-Link x2); o
    // sayfadaki 2 gorselin genislikleri ayni olacak kadar yakin olsun; bu sekillendirme
    // SAYFA BAZLI olsun."
    //
    // Bunun icin sayfalamayi Word'den DEVRALIYORUZ (kendi sayfa sonumuzu koyuyoruz):
    // "ayni sayfada kim var" bilinmeden ortak genislik hesaplanamaz, dolayisiyla
    // sayfalamayi Word'e birakip ayni anda sayfa bazli boyutlama yapmak imkansiz.
    //
    // MATEMATIK: iki gorsel de W genisse yukseklikleri W/ar1 ve W/ar2 olur (oran
    // KORUNUR, esneme yok). Sayfaya sigma sarti:
    //     W*(1/ar1 + 1/ar2) + paylar <= SAYFA_H
    //     W = min(METIN_W, (SAYFA_H - paylar) / (1/ar1 + 1/ar2))
    // W esigin altina duserse gorseller "cok uzun" demektir -> cift bozulur, gorsel
    // TEK BASINA sayfaya gider ve orada W = min(METIN_W, (SAYFA_H - pay) * ar) olur.
    // Ornek (olculdu): iki IG/FB gonderi karti (oran 0.44) ayni sayfaya ancak 1.81"
    // ile sigiyor -> esigin altinda -> her biri tek basina 4.03" x 9.0".
    var SAYFA_H = 10.0;       // 15840 - 720 - 720 twip
    var METIN_W = 7.0;        // 12240 - 1080 - 1080 twip
    var ESIK_W  = 2.5;        // kullanici karari: ortak genislik bunun altina duserse cift bozulur
    var GUVENLIK_PAY = 0.25;  // Word'un satir yuksekligini birebir bilemeyiz -> temkinli pay

    var b1Pt=(parseInt(opts.b1_size,10)||18), bPt=(parseInt(opts.b_size,10)||14), lPt=(parseInt(opts.l_size,10)||10), mPt=(parseInt(opts.m_size,10)||11);

    // Metin yuksekligi tahmini. Link metni URL'nin TAMAMI ve FB pfbid linkleri ~120
    // karakter -> 7"lik satira sigmaz, 2 satira kayar. AZ tahmin edersek sayfa TASAR
    // ve Word kendi sayfa sonunu atar (tam kacindigimiz sey) -> karakter genisligi
    // ve satir yuksekligi bilerek BOL tutuldu; fazla tahmin yalnizca gorseli bir
    // miktar kucultur, bicimi bozmaz.
    function satirSayisi(metin, puntoPt, genislikIn){
      var karGenPt = 0.55 * puntoPt;                 // Calibri ~0.5; temkinli
      var satirBasiKar = Math.max(1, Math.floor((genislikIn*72) / karGenPt));
      return Math.max(1, Math.ceil(String(metin||'').length / satirBasiKar));
    }
    function metinY(metin, puntoPt, genislikIn, afterTwip){
      return satirSayisi(metin, puntoPt, genislikIn) * (1.2*puntoPt)/72 + (afterTwip/1440);
    }
    // Bir birimin gorsel DISI dikey maliyeti (baslik + link + araliklar)
    function birimPay(b){
      var p=0;
      if(b.h1) p += 240/1440 + metinY(b.h1, b1Pt, METIN_W, 120);  // Baslik1: before 240
      if(b.h2){ var _h2pt=bPt; if(hOvAcik() && b.h2ov && b.h2ov.size!=null){ _h2pt=parseInt(b.h2ov.size,10)||bPt; } p += metinY(b.h2, _h2pt, METIN_W, 120); }   // Baslik2 (override boyutu varsa onunla)
      // Faz 2/4b KRITIK: eklenen metinlerin dikey maliyeti. KATILMAZSA sayfa tasar ve Word KENDI
      // sayfa sonunu atar (tarihsel bug). Sira onemsiz (toplam ayni) -> parcalar VEYA metin_bloklari.
      var _mt=[], _k;
      if(b.item && b.item.parcalar){ for(_k=0;_k<b.item.parcalar.length;_k++){ if(b.item.parcalar[_k].tur==='metin') _mt.push(b.item.parcalar[_k].metin); } }
      else { var _mb=(b.item && b.item.metin_bloklari)||[]; for(_k=0;_k<_mb.length;_k++){ _mt.push(_mb[_k]&&_mb[_k].metin); } }
      for(_k=0;_k<_mt.length;_k++){ var _t=String(_mt[_k]||'').trim(); if(_t) p += metinY(_t, mPt, METIN_W, 120); }
      if(b.item.image_b64) p += 120/1440;                          // gorsel paragrafi after
      p += metinY(b.link||'', lPt, METIN_W, b.son?360:240);        // link
      return p;
    }
    // Bir sayfadaki TUM gorsellere verilecek ORTAK genislik
    function ortakGenislik(grup, extraPay){
      var pay=(extraPay||0), tersToplam=0, i;   // extraPay: çiftin ARASINDAKİ metin-only (manuel) birimlerin yüksekliği
      for(i=0;i<grup.length;i++){ pay += birimPay(grup[i]); if(grup[i].ar) tersToplam += 1/grup[i].ar; }
      var kalan = SAYFA_H - pay - GUVENLIK_PAY;
      if(kalan<=0) return 0;
      if(tersToplam<=0) return METIN_W;   // sayfada hic gorsel yok -> genislik onemsiz
      return Math.min(METIN_W, kalan/tersToplam);
    }

    // ---- 1. GECIS: birimleri topla (henuz XML yok). Birim = 1 gorsel + linki;
    //      onune dusen Baslik1/Baslik2 birimle birlikte tasinir.
    //      NOT: Baslik2 GRUP basina bir kez basilir (mevcut yapi) -> bir hesabin 3
    //      gonderisi varsa yapi H2 + (gorsel+link)x3 olur; sayfa sonu grubun ortasina
    //      denk gelirse Baslik2 TEKRARLANMAZ. Word'un bugunku davranisiyla ayni.
    var birimler=[], headerIndex=0;
    // [tekrar eden hesap başlığı]: bitişik-dizi grubu aynı hesabı birden çok run'a böldüğünde (araya
    // manuel girince) YALNIZ İLK run'ın OTOMATİK başlığı basılır; sonraki run'larda başlık BOŞ bırakılır
    // (null değil -> alan durur, kullanıcı isterse elle yazar; boşsa Word'e basılmaz). Kullanıcının elle
    // verdiği başlık (h2_override) her run'da gösterilir.
    var _seenUser={};
    function toplaEntry(entry, h1){
      var type=entry[0], val=entry[1];
      if(type==='group'){
        var group=groups[val];
        // v3.77: PROFIL KARTI HER ZAMAN grubun EN USTUNDE (kullanici istegi). Havuz surukleme
        // sirasi ne olursa olsun profil kartlari basa alinir; geri kalanlar havuz sirasinda.
        // Kararli bolme (sort degil) -> profiller ve digerleri kendi ic sirasini korur.
        // h2 (hesap basligi) zaten k===0'a konuyor -> profil kartinin uzerine oturur, dogru.
        // Faz 6: ordered'i baslik hesabindan ONCE kur -> baslik override'i ordered[0]'da aranir.
        var _prof=[], _rest=[];
        for(var _gi=0;_gi<group.items.length;_gi++){ (group.items[_gi].is_profile?_prof:_rest).push(group.items[_gi]); }
        var ordered=_prof.concat(_rest);
        headerIndex++;   // her grup bir baslik indeksi tuketir (eski ile ayni zamanlama)
        // Faz 6: editorde grubun basligi duzenlendiyse (ordered[0].h2_override) NIHAI baslik ODUR —
        // verbatim (kullanicinin gordugu gibi, numara dahil). item.title DEGISMEZ -> gruplama anahtari
        // ve '(' sezgisi bozulmaz (IG bolunmesi + kardes-ezme kök nedeni giderilir). Override YOKSA
        // ESKI davranis birebir: '(' sezgisi + fallback + numara.
        // [AYIR/BOŞ BAŞLIK] h2_override AÇIKÇA BOŞ ('' ) ise başlığı HESAP ADINDAN TÜRETME -> boş kalsın
        // (kullanıcı "kendi başlığına ayır"da yeni bölüm boş başlasın; elle temizlenen başlık da boş kalır).
        // null = hiç düzenlenmemiş -> eski türetme; dolu = verbatim.
        var _ovr=(ordered[0] && ordered[0].h2_override!=null) ? String(ordered[0].h2_override) : null;
        var baslik='';
        if(_ovr!=null && String(_ovr).trim()===''){ baslik=''; }   // açık boş -> başlıksız kalır (türetme yok)
        else if(_ovr!=null){ baslik=_ovr; }
        else {
          // #2: YERLI üye (grup anahtarıyla eşleşen __native) başlığı önce gelir; kümeye elle TAŞINAN
          // yabancı öğenin başlığı kümeyi EZMEZ. Yerli yoksa eski davranış ('(' tercihi, sonra ilk).
          var gi, _first='', _anyParan='', _nativeB='', _nbParen=false;
          for(gi=0; gi<group.items.length; gi++){
            var _gIt=group.items[gi], tt=(_gIt.title||'').trim();
            if(!tt) continue;
            if(!_first) _first=tt;
            if(!_anyParan && tt.indexOf('(')!==-1) _anyParan=tt;
            if(_gIt.__native===val){
              if(!_nativeB){ _nativeB=tt; _nbParen=(tt.indexOf('(')!==-1); }
              else if(!_nbParen && tt.indexOf('(')!==-1){ _nativeB=tt; _nbParen=true; }
            }
          }
          baslik = _nativeB || _anyParan || _first;
          // Faz FB-1: FB anahtarlari 'fb:' onekli -> XPlat onegi soyar/etiketler. X/IG BIREBIR ayni.
          if(!baslik) baslik = window.XPlat ? XPlat.groupFallbackTitle(val)
                                            : ((val.charAt(0)==='@') ? val : '@'+val);
          if(opts.b_numbered && baslik) baslik = headerIndex+'. '+baslik;   // [8]: boş başlığa (tümü-boş manuel/birleşik küme) "N." basma -> stray başlık olmasın
        }
        // Aynı hesabın TEKRAR eden (bitişik-dizi) run'ında otomatik başlığı bastırma (boş bırak).
        var _isRun=(String(val).indexOf('\u0001run\u0001')===0);
        var _acctUser=_isRun ? String(val).split('\u0001')[2] : null;
        var _suppress=false;
        if(_isRun){
          if(_ovr!==null){ _seenUser[_acctUser]=true; }          // elle override -> göster + işaretle
          else if(_seenUser[_acctUser]){ _suppress=true; }       // oto başlık TEKRARI -> boş
          else { _seenUser[_acctUser]=true; }                    // ilk oto başlık -> göster + işaretle
        }
        var k;
        for(k=0;k<ordered.length;k++){
          // h2 YALNIZCA grubun ILK gonderisinde. _suppress ise boş '' (null DEĞİL) -> alan durur, Word'e basılmaz.
          var _h2 = opts.b_basliksiz ? null : (k===0 ? (_suppress ? '' : baslikFormatla(baslik)) : null);
          birimler.push({ h1:((k===0 && h1) ? (ovH1(ordered[0])||h1) : null), h2:_h2,
                          h1ov:((k===0 && ordered[0])?(ordered[0].h1_ov||null):null), h2ov:((ordered[0])?(ordered[0].h2_ov||null):null),   // [BAŞLIK OVERRIDE] platform/içerik başlığı tekil biçim (ordered[0] taşır)
                          item:ordered[k], link:xRaporLinkGoster(ordered[k]), son:(k===ordered.length-1),
                          grup:val, grupBaslik:baslik });   // #2: küme anahtarı + başlığı (öğeyi farklı kümeye taşıma UI'si için)
        }
      } else {
        var item2=val;
        // Faz 6: standalone baslik override'i varsa verbatim; yoksa title + (varsa) numara.
        var _ovr2=(item2.h2_override!=null && String(item2.h2_override).trim()!=='') ? String(item2.h2_override) : null;
        var b2;
        if(_ovr2!=null){ headerIndex++; b2=_ovr2; }
        else { b2=(item2.title||'').trim(); if(b2){ headerIndex++; if(opts.b_numbered) b2=headerIndex+'. '+b2; } }
        // B5: editor-manuel standalone -> baslik satiri HER ZAMAN duzenlenebilir olsun diye h2 '' (null DEGIL);
        // bos kalirsa docx'te baslik BASILMAZ (if(u.h2)). Overlay geri-yukleme de b.h2!=null ister.
        var _man2 = xIsManualLink(item2.link);
        birimler.push({ h1:(h1!=null ? (ovH1(item2)||h1) : null), h2:(opts.b_basliksiz?null:(b2?baslikFormatla(b2):(_man2?'':null))),
                        h1ov:(item2.h1_ov||null), h2ov:(item2.h2_ov||null),   // [BAŞLIK OVERRIDE] standalone başlık tekil biçim
                        item:item2, link:xRaporLinkGoster(item2), son:true,
                        grup:null, grupBaslik:b2 });   // standalone = kendi kümesi (grup anahtarı yok)
      }
    }
    if(multiPlatform){
      // [HAVUZ SIRASI + manuel araya girsin + "Manuel Bölümler" grubu YOK]: Çok platform olsa DA çıktı HAVUZ
      // SIRASINI izler; platform başlığı (Baslik 1) yalnız taranmış platform DEĞİŞİNCE basılır; manuel ('manual')
      // öğe BAŞLIKSIZ, bulunduğu yerde kalır (kullanıcı: "istediğim bölüm arasına dümdüz bölüm eklenebilsin").
      // Bayrak (geri alınabilir): localStorage x_mp_poolorder='0' -> eski platform-gruplama (Manuel Bölümler grubu).
      var _mpPool=true; try{ _mpPool=(localStorage.getItem('x_mp_poolorder')!=='0'); }catch(e){}
      if(_mpPool){
        var oiP, _lastPlat=null;
        for(oiP=0; oiP<order.length; oiP++){
          var _ep=entryPlatform(order[oiP]);
          if(_ep==='manual'){ toplaEntry(order[oiP], null); }                 // dümdüz: başlık yok, havuz konumunda
          else { toplaEntry(order[oiP], (_ep!==_lastPlat) ? (PLAT_LABEL[_ep] || 'X (Twitter)') : null); _lastPlat=_ep; }
        }
      } else {
        // Eski davranış: platforma göre grupla (ilk görünen platform önce; 'manual' -> "Manuel Bölümler").
        var pj, oi;
        for(pj=0; pj<platOrder.length; pj++){
          var plat=platOrder[pj], ilk=true;
          for(oi=0; oi<order.length; oi++){
            if(entryPlatform(order[oi])===plat){ toplaEntry(order[oi], ilk ? (PLAT_LABEL[plat] || 'X (Twitter)') : null); ilk=false; }
          }
        }
      }
    } else {
      // Tek platform -> Baslik 1 yok (mevcut davranis).
      var oi2;
      for(oi2=0; oi2<order.length; oi2++){ toplaEntry(order[oi2], null); }
    }

    // #2 (doküman-oluşturucu): editör, GÖRÜNÜMÜNÜ (manuel bloklar + küme taşımalar dahil) birebir
    // docx'e aktarmak için kendi hazır belge.birimler'ini verebilir -> gruplama/sıra EZİLİR, birebir o çizilir.
    if (opts && opts.__birimler && opts.__birimler.length) { birimler = opts.__birimler; }

    // AYRAÇ ÇİZGİSİ (cizgi): grup-sonu (son) birimde çizilir AMA (a) manuel/hesapsız birimden SONRA
    // çizilmez, (b) AYNI hesap ileride (arada yalnız manuel/hesapsız birim varken) DEVAM ediyorsa
    // çizilmez. Böylece "A1, manuel, A2" dizisinde yalnız A2 sonrası ayraç olur; A1 ve manuel sonrası
    // uzun çizgi OLMAZ (kullanıcı isteği). Saf taramada her grup ayrı hesap -> eski davranış birebir.
    function _acctOf(bb){ return (bb && bb.item && bb.item.__native) ? String(bb.item.__native) : ''; }
    for(var _ci=0; _ci<birimler.length; _ci++){
      var _bb=birimler[_ci]; _bb.cizgi = !!_bb.son;
      if(!_bb.cizgi) continue;
      var _ac=_acctOf(_bb);
      if(!_ac){ _bb.cizgi=false; continue; }   // manuel/hesapsız -> ardından çizgi yok
      for(var _cj=_ci+1; _cj<birimler.length; _cj++){
        var _na=_acctOf(birimler[_cj]);
        if(_na==='') continue;                 // manuel -> şeffaf, atla
        if(_na===_ac) _bb.cizgi=false;          // aynı hesap devam -> çizgi çizme
        break;                                  // farklı hesap -> çizgiyi koru
      }
    }

    // Faz 3 (Rapor Editörü): editör GÖRÜNÜMÜ çıktıyla BİREBİR eşleşsin diye aynı gruplama/birim
    // planını paylaşır. __planOnly -> docx üretmeden (media/rels kurulmadan) render planını döndür.
    // Normal docx yolu etkilenmez (yalnız bu bayrakla erken döner).
    if (opts && opts.__planOnly) {
      return { birimler: birimler, multiPlatform: multiPlatform, platOrder: platOrder, groups: groups };
    }


    // ---- 2. GECIS: GÖRSEL BİRİMLERİ (parça bazında) topla + en-boy oranlarını oku.
    // [ÇOKLU GÖRSEL] Bir birimde birden çok 'gorsel' parçası olabilir; her biri ayrı GÖRSEL BİRİMİ
    // ('_imgUnits') -> çiftleme/boyutlama bunların üzerinden yürür. Tek-görsel belgede her birim 1 birim
    // üretir (unitPay==birimPay) -> eski per-birim boyutlamayla BİREBİR aynı. Görsel boşsa (kutu) atlanır.
    var bi2, _imgUnits=[];
    for(bi2=0; bi2<birimler.length; bi2++){
      var bu=birimler[bi2];
      bu._imgUnits=[];
      var _gs=birimGorselleri(bu.item);
      for(var _gg=0; _gg<_gs.length; _gg++){
        if(!_gs[_gg].b64) continue;
        var _u={bi:bi2, k:_gs[_gg].k, b64:_gs[_gg].b64, mime:_gs[_gg].mime, align:(_gs[_gg].align||''), ar:null, w:0, h:0};
        var _sz=await loadImageSize('data:'+(_u.mime||'image/jpeg')+';base64,'+_u.b64);
        _u.ar=(_sz.w>0 && _sz.h>0)?(_sz.w/_sz.h):(4.5/3.8);   // bozuk veri -> eski yedek oran
        bu._imgUnits.push(_u); _imgUnits.push(_u);
      }
    }

    // Bir görsel-biriminin GÖRSELSİZ dikey maliyeti: her görselin alt boşluğu (120) + (birimin İLK
    // görseliyse) başlık+metin+link bir kez. Tek-görselde unitPay(ilk)==birimPay (uyum).
    function unitPay(u, isFirst){
      if(!isFirst) return 120/1440;           // ek görsel: yalnız alt boşluk
      var bu=birimler[u.bi], p=birimPay(bu);   // başlık+metin(parcalar VEYA metin_bloklari)+link (+item.image_b64 varsa 120)
      if(!(bu.item && bu.item.image_b64)) p += 120/1440;   // parça-görsel birincili: birimPay 120 eklemedi -> ilk görsel için ekle
      return p;
    }
    function _ilkMi(u){ var iu=birimler[u.bi]._imgUnits; return !!(iu && iu.length && iu[0]===u); }
    function araMetinPay(uA, uB){ var p=0; for(var bb=uA.bi+1; bb<uB.bi; bb++){ var bx=birimler[bb]; if(!(bx._imgUnits && bx._imgUnits.length)) p += birimPay(bx); } return p; }   // aradaki GÖRSELSİZ (metin-only) birimler
    function ortakGenislikU(uA, uB){
      var pay=unitPay(uA,_ilkMi(uA))+unitPay(uB,_ilkMi(uB))+araMetinPay(uA,uB);
      var ters=0; if(uA.ar) ters+=1/uA.ar; if(uB.ar) ters+=1/uB.ar;
      var kalan=SAYFA_H-pay-GUVENLIK_PAY;
      if(kalan<=0) return 0; if(ters<=0) return METIN_W; return Math.min(METIN_W, kalan/ters);
    }

    // ---- 3. GECIS: GÖRSEL BİRİMLERİNİ çiftle (2 görsel/sayfa, ORTAK genişlik). Birim=görsel-parçası.
    var sayfalar=[];
    var _pz=0;
    while(_pz < _imgUnits.length){
      var _a=_imgUnits[_pz], _b=(_pz+1<_imgUnits.length)?_imgUnits[_pz+1]:null;
      var ciftKuruldu=false;
      if(_b){
        var W2=ortakGenislikU(_a,_b);
        if(W2 >= ESIK_W){ _a.w=W2; _a.h=_a.ar?(W2/_a.ar):0; _b.w=W2; _b.h=_b.ar?(W2/_b.ar):0; _pz+=2; ciftKuruldu=true; }
      }
      if(!ciftKuruldu){
        var kalan1=SAYFA_H - unitPay(_a,_ilkMi(_a)) - GUVENLIK_PAY;   // tek başına sayfa (tüm yükseklik ona)
        var W1=_a.ar?Math.min(METIN_W, Math.max(0.1, kalan1)*_a.ar):METIN_W;
        _a.w=W1; _a.h=_a.ar?(W1/_a.ar):0; _pz+=1;
      }
    }
    // Emisyon sırası = plan/havuz sırası (serbest akış); boyutlar görsel-birimlerine kondu.
    for(var _z2=0;_z2<birimler.length;_z2++){ sayfalar.push([birimler[_z2]]); }

    // ---- 4. GECIS: XML uret. SABIT SAYFA SONU YOK (kullanici istegi 2026-07-17).
    //
    // Once buraya acik sayfa sonu (<w:br w:type="page"/>) konuyordu. Kullanici bildirdi:
    // "wordu hazirlayip ciktiyi aldiktan sonra bir sayfada 1 gorseli silince olmasi
    // gereken otomatik kayma sayfa sonu yuzunden olmuyor." Dogru teshis - ve mekanizma
    // TEK: sabit sayfa sonu hem yerlesimi civiliyor hem de kaymayi engelliyordu.
    //
    // Cakismayi cozen olcum: yerlesimi saglayan sey sayfa sonu DEGIL, BOYUTLAMA.
    // 3. gecis gorselleri zaten "cift sayfaya sigacak" sekilde boyutluyor; ustelik
    // ucuncu bir giris sayfaya sigmiyor (en kisa uc giris 10.98" > 10"). Bu yuzden
    // sayfa sonlari kaldirilinca Word'un kendi akisi PLANIN AYNISINI uretiyor
    // (simule edildi: s1[kisa,kisa] s2[uzun] s3[uzun] s4[orta,kisa] - birebir ayni).
    // Sayfalar 'sayfalar' dizisinde planlandigi gibi olusur ama artik SERBEST akar:
    // kullanici bir gorseli silince sonrasi kendiliginden yukari kayar.
    //
    // Yerlesimi kopmalara karsi keepNext koruyor (headingXml + imageXml): baslik
    // gorselinden, gorsel de linkinden ayri sayfaya dusmez.
    var body=[], si, bj;
    for(si=0; si<sayfalar.length; si++){
      for(bj=0; bj<sayfalar[si].length; bj++){
        var u=sayfalar[si][bj];
        if(u.h1) body.push(heading1Xml(u.h1, u.h1ov));   // platform başlığı (b1) + tekil override
        if(u.h2) body.push(headingXml(u.h2, u.h2ov));   // içerik başlığı (b) + tekil override
        // Faz 4b: SIRALANABILIR PARÇALAR. item.parcalar varsa kullanıcının düzenlediği serbest
        // sıra (gorsel/metin/link). Yoksa ESKI yol (metin_bloklari konum alt/ust) -> cikti birebir.
        var _pc=(u.item && u.item.parcalar) ? u.item.parcalar : null;
        if(_pc){
          // [ÇOKLU GÖRSEL] parça-indeksi -> görsel-birimi (b64+boyut) haritası
          var _um={}; if(u._imgUnits){ for(var _uu=0;_uu<u._imgUnits.length;_uu++){ if(u._imgUnits[_uu].b64) _um[u._imgUnits[_uu].k]=u._imgUnits[_uu]; } }
          // Grup-sonu ayraç çizgisi: son BASILAN parça link ise çizgiyi O linkin alt-kenarlığı yap
          // (eski davranış) -> link ile çizgi arasında FAZLADAN BOŞ SATIR olmaz. Link son değilse
          // (ör. "link üstte"de görsel altta) ayrı grupSonuXml paragrafı kullan.
          var _lastEmit=-1;
          var _asilL=_asilLinkIdx(_pc);   // [SORUN 2] asıl link indeksi (işaretsiz ilk link) -> yalnız o item.link'e düşer
          for(var _q=0;_q<_pc.length;_q++){ var _pq=_pc[_q];
            if(_pq.tur==='gorsel'){ if(_um[_q]) _lastEmit=_q; }
            else if(_pq.tur==='metin'){ if(String(_pq.metin||'').replace(/<[^>]*>/g,'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').trim()) _lastEmit=_q; }
            else if(_pq.tur==='link'){ var _lq=(_pq.url!=null && String(_pq.url).trim()!=='')?String(_pq.url).trim():((yeniLinkBosAcik() && _q!==_asilL)?'':u.link); if(_lq) _lastEmit=_q; }
          }
          var _cizgiKondu=false;
          for(var _pi=0; _pi<_pc.length; _pi++){
            var _p=_pc[_pi];
            if(_p.tur==='gorsel'){ var _iu=_um[_pi]; if(_iu) body.push(imageXmlRaw(_iu.b64, _iu.mime, _iu.w, _iu.h, _iu.align)); }
            else if(_p.tur==='metin'){ var _mh=String(_p.metin||''); var _mtxt=_mh.replace(/<[^>]*>/g,'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').trim(); if(_mtxt) body.push(textXml(_mh)); }
            else if(_p.tur==='link'){ var _lu=(_p.url!=null && String(_p.url).trim()!=='')?String(_p.url).trim():((yeniLinkBosAcik() && _pi!==_asilL)?'':u.link);
              if(_lu){ var _bord=(u.cizgi && _pi===_lastEmit); body.push(linkXml(_lu, _bord?360:240, _bord)); if(_bord) _cizgiKondu=true; } }
          }
          if(u.cizgi && !_cizgiKondu) body.push(grupSonuXml());   // link son değilse: ayrı ayraç (parça sırası serbest)
        } else {
          var _mb=(u.item && u.item.metin_bloklari)||[];
          _mb.forEach(function(mb){ if(mb && mb.konum==='ust' && String(mb.metin||'').trim()) body.push(textXml(mb.metin)); });
          var _pu0=(u._imgUnits && u._imgUnits[0]); if(_pu0 && _pu0.b64) body.push(imageXmlRaw(_pu0.b64, _pu0.mime, _pu0.w, _pu0.h, _pu0.align));   // parçasız öğe: birincil görsel birimi (k=-1)
          _mb.forEach(function(mb){ if(mb && mb.konum!=='ust' && String(mb.metin||'').trim()) body.push(textXml(mb.metin)); });
          body.push(linkXml(u.link, u.cizgi?360:240, u.cizgi));
        }
      }
    }

    // [SAYFA NO] opts.pn_on -> altbilgi/üstbilgi parçası ( PAGE alanı ) + sectPr referansı + rels + content-type.
    // Varsayılan kapalı -> hiçbir şey eklenmez (eski çıktı birebir). Konum footer/header, hizalama, biçim seçilir.
    var _pnRef='', _pnPart=null, _pnRel='', _pnCT='';
    if(opts.pn_on){
      var _pnHeader=(opts.pn_pos==='header');
      var _pnAl=(opts.pn_align==='left'||opts.pn_align==='center')?opts.pn_align:'right';
      var _pnFmt=opts.pn_fmt||'plain';
      var _pnTag=_pnHeader?'w:hdr':'w:ftr';
      var _pnFile=_pnHeader?'header1.xml':'footer1.xml';
      var _pnRefTag=_pnHeader?'w:headerReference':'w:footerReference';
      var _pnRelType=_pnHeader?'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header':'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
      var _pnCTType=_pnHeader?'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml':'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';
      var _pnId='rIdPageNo';
      function _pnFld(instr){ return '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> '+instr+' </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'; }
      function _pnTxt(t){ return '<w:r><w:t xml:space="preserve">'+xmlEsc(t)+'</w:t></w:r>'; }
      var _pnInner=(_pnFmt==='sayfa') ? (_pnTxt('Sayfa ')+_pnFld('PAGE'))
                 : (_pnFmt==='xofn') ? (_pnFld('PAGE')+_pnTxt(' / ')+_pnFld('NUMPAGES'))
                 : _pnFld('PAGE');
      var _pnXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        +'<'+_pnTag+' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        +'<w:p><w:pPr><w:jc w:val="'+_pnAl+'"/></w:pPr>'+_pnInner+'</w:p>'
        +'</'+_pnTag+'>';
      _pnRef='<'+_pnRefTag+' w:type="default" r:id="'+_pnId+'"/>';
      _pnPart={name:'word/'+_pnFile, data:enc.encode(_pnXml)};
      _pnRel='<Relationship Id="'+_pnId+'" Type="'+_pnRelType+'" Target="'+_pnFile+'"/>';
      _pnCT='<Override PartName="/word/'+_pnFile+'" ContentType="'+_pnCTType+'"/>';
    }
    // sectPr öğe sırası: (header/footer)Reference -> pgSz -> pgMar (şema sırası).
    var sectPr='<w:sectPr>'+_pnRef+'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="1080" w:bottom="720" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
    var documentXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
      + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + '<w:body>'+body.join('')+sectPr+'</w:body></w:document>';

    var relsXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
    var ri;
    for(ri=0; ri<rels.length; ri++){
      var r=rels[ri];
      relsXml += '<Relationship Id="'+r.id+'" Type="'+r.type+'" Target="'+xmlEsc(r.target)+'"'+(r.mode?(' TargetMode="'+r.mode+'"'):'')+'/>';
    }
    relsXml += _pnRel;   // [SAYFA NO] footer/header ilişkisi (varsa)
    relsXml += '</Relationships>';

    var stylesXml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="3"/></w:pPr></w:style>'
      + '</w:styles>';

    var contentTypes='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Default Extension="png" ContentType="image/png"/>'
      + '<Default Extension="jpeg" ContentType="image/jpeg"/>'
      + '<Default Extension="jpg" ContentType="image/jpeg"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
      + _pnCT   // [SAYFA NO] footer/header content-type (varsa)
      + '</Types>';

    var rootRels='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>';

    var files=[
      {name:'[Content_Types].xml', data:enc.encode(contentTypes)},
      {name:'_rels/.rels', data:enc.encode(rootRels)},
      {name:'word/document.xml', data:enc.encode(documentXml)},
      {name:'word/styles.xml', data:enc.encode(stylesXml)},
      {name:'word/_rels/document.xml.rels', data:enc.encode(relsXml)}
    ];
    if(_pnPart) files.push(_pnPart);   // [SAYFA NO] footer/header parçası (varsa)
    var mi;
    for(mi=0; mi<media.length; mi++){ files.push(media[mi]); }
    var zipBytes=zipStore(files);
    return new Blob([zipBytes], {type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
  }

  // SURUM DAMGASI: Word tarayicida uretiliyor; bu dosyanin eski kopyasi onbellekte
  // kalirsa sunucu guncellense bile ESKI uretici calisir ve fark sessizce gizlenir
  // (sahada tam bunu yasadik -> rota artik no-store, bkz. _js_yanit). Konsolda hangi
  // surumun calistigi GORULEBILIR olsun diye basiliyor.
  console.log('[GörüntüX] x-local-docx.js — sayfa bazli yerlesim, sabit sayfa sonu YOK (2026-07-17)');
  // ---- Word Duzenle (client-side, v3.99): yuklenen .docx'i mammoth ile oku -> ogeler -> generateBlob ----
  // Dosya sunucuya GITMEZ. mammoth (CDN, onizlemede zaten yuklu) .docx->HTML verir: h2 baslik,
  // <p><img data-uri>, <p><a href>. Rapor yapisini (h2, img, link, img, link) ogelere ceviririz.
  // Bu blok HAM r-string icinde -> regex ters-bolu kacislari guvenli (HTML_TEMPLATE tuzagi yok).
  function xParseReportHtml(html){
    // v4.7: her ogeye baslikdaki @handle'i group_override yap. Sebep: RT (repost) ekran goruntusunun
    // docx'te LINKI GIZLI (xRaporLinkGoster rt:'yi bosaltir) -> linksiz oge generateBlob'da username
    // turetemeyip STANDALONE oluyor ve AYRI baslik aliyordu (kullanici: MAH'a 2 baslik kondu). Baslik
    // "Ad (@handle)" -> @handle grup anahtari. generateBlob group_override'i EN yuksek oncelikle
    // kullanir -> kaynak raporun basligina gore gruplanir (RT dahil dogru birlesir). Normal ogede
    // title@handle == link-username (davranis ayni); RT'de title@handle = repost yapan -> duzelir.
    function _grup(baslik){
      var m = String(baslik || '').match(/@([A-Za-z0-9_]+)/);
      return m ? m[1].toLowerCase() : '';
    }
    function _oge(title, link, img, mime, parcalar){
      var o = { title: title, link: link, image_b64: img, image_mime: mime };
      var g = _grup(title);
      if (g) { o.group_override = g; }
      // v4.28: kaynak rapordaki link/gorsel sirasini KORU (asagida saptanan duzene gore).
      // parcaKur bu parcalar doluysa dokunmaz -> editor/docx kaynak sirayi aynen gosterir.
      if (parcalar && parcalar.length) { o.parcalar = parcalar; }
      return o;
    }
    var items = [];
    try {
      var doc = new DOMParser().parseFromString(html || '', 'text/html');
      var blocks = (doc && doc.body) ? doc.body.children : [];
      // v4.28: once bloklari DUZ bir belirtec akisina indir (h / img / link). Boylece
      // "link gorselin ustunde mi altinda mi" GLOBAL olarak saptanabilir (kullanici istegi).
      var toks = [];
      for (var i = 0; i < blocks.length; i++){
        var el = blocks[i];
        var tag = (el.tagName || '').toLowerCase();
        if (/^h[1-6]$/.test(tag)) { toks.push({ t: 'h', text: (el.textContent || '').trim() }); continue; }
        var a = el.querySelector ? el.querySelector('a[href]') : null;
        var img = el.querySelector ? el.querySelector('img') : null;
        if (a) {
          toks.push({ t: 'link', href: (a.getAttribute('href') || '') });
        } else if (img) {
          var src = img.getAttribute('src') || '';
          var ci = src.indexOf(',');
          if (src.indexOf('data:') === 0 && ci > 0) {
            var meta = src.slice(5, ci);            // "image/png;base64"
            toks.push({ t: 'img', mime: (meta.split(';')[0] || 'image/jpeg'), b64: src.slice(ci + 1) });
          }
        }
      }
      // v4.28: DUZEN SAPTAMA — ilk link, ilk gorselden ONCE mi geliyor? (basliklar sayilmaz)
      // Kullanici: "ilk linkin gorselin altinda mi ustunde mi oldugunu cozerek bolumle".
      var firstImg = -1, firstLink = -1;
      for (var t = 0; t < toks.length; t++){
        if (firstImg < 0 && toks[t].t === 'img') firstImg = t;
        if (firstLink < 0 && toks[t].t === 'link') firstLink = t;
      }
      var linkUst = (firstLink >= 0 && (firstImg < 0 || firstLink < firstImg));
      var curBaslik = '';
      if (!linkUst) {
        // GORSEL-USTTE (varsayilan; eski davranisla BIREBIR eslesir): [gorsel?][link] -> oge.
        var curImg = null, curMime = '';
        for (var j = 0; j < toks.length; j++){
          var tk = toks[j];
          if (tk.t === 'h') {
            if (curImg) { items.push(_oge(curBaslik, '', curImg, curMime, [{tur:'gorsel'}])); curImg = null; curMime = ''; }
            curBaslik = tk.text; continue;
          }
          if (tk.t === 'link') {
            items.push(_oge(curBaslik, tk.href, curImg, curMime, curImg ? [{tur:'gorsel'},{tur:'link'}] : [{tur:'link'}]));
            curImg = null; curMime = '';
          } else if (tk.t === 'img') {
            if (curImg) { items.push(_oge(curBaslik, '', curImg, curMime, [{tur:'gorsel'}])); }  // bekleyen LINKSIZ gorsel (RT vb.)
            curImg = tk.b64; curMime = tk.mime;
          }
        }
        if (curImg) { items.push(_oge(curBaslik, '', curImg, curMime, [{tur:'gorsel'}])); }
      } else {
        // LINK-USTTE: [link][gorsel?] -> oge (link gorselin ustunde). Linksiz gorsel kendi ogesi.
        var curLink = null;
        for (var j2 = 0; j2 < toks.length; j2++){
          var tk2 = toks[j2];
          if (tk2.t === 'h') {
            if (curLink != null) { items.push(_oge(curBaslik, curLink, null, '', [{tur:'link'}])); curLink = null; }
            curBaslik = tk2.text; continue;
          }
          if (tk2.t === 'link') {
            if (curLink != null) { items.push(_oge(curBaslik, curLink, null, '', [{tur:'link'}])); }  // ard arda iki link -> ilki linksiz-gorsel-siz oge
            curLink = tk2.href;
          } else if (tk2.t === 'img') {
            if (curLink != null) { items.push(_oge(curBaslik, curLink, tk2.b64, tk2.mime, [{tur:'link'},{tur:'gorsel'}])); curLink = null; }
            else { items.push(_oge(curBaslik, '', tk2.b64, tk2.mime, [{tur:'gorsel'}])); }
          }
        }
        if (curLink != null) { items.push(_oge(curBaslik, curLink, null, '', [{tur:'link'}])); }
      }
    } catch (e) {}
    return items;
  }
  function _wdNaturalKey(s){
    return String(s == null ? '' : s).split(/(\d+)/).map(function(t){
      return /^\d+$/.test(t) ? parseInt(t, 10) : t.toLowerCase();
    });
  }
  function _wdNaturalCmp(a, b){
    var ka = _wdNaturalKey(a), kb = _wdNaturalKey(b), n = Math.max(ka.length, kb.length);
    for (var i = 0; i < n; i++){
      var x = ka[i], y = kb[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x - y; }
      else { var xs = String(x), ys = String(y); if (xs !== ys) return xs < ys ? -1 : 1; }
    }
    return 0;
  }
  function _wdNormLink(link){
    // Sunucu upload_format dedup ikizi: link.strip().lower().split('?')[0].rstrip('/')
    return String(link == null ? '' : link).trim().toLowerCase().split('?')[0].replace(/\/+$/, '');
  }
  async function clientWordDuzenle(files, opts){
    var arr = Array.prototype.slice.call(files || []).filter(function(f){ return f && f.name; });
    arr.sort(function(a, b){ return _wdNaturalCmp(a.name || '', b.name || ''); });
    var allItems = [], fileStats = [], totalLinks = 0;
    for (var i = 0; i < arr.length; i++){
      var f = arr[i], items = [];
      try {
        var buf = await f.arrayBuffer();
        // mammoth CDN'den yuklu; erisilemezse hang etmesin diye timeout (onizleme de mammoth'a bagli).
        var mres = await Promise.race([
          mammoth.convertToHtml({ arrayBuffer: buf }),
          new Promise(function (_r, rej) { setTimeout(function () { rej(new Error('Word okuma zaman asimi')); }, 20000); })
        ]);
        items = xParseReportHtml((mres || {}).value || '');
      } catch (e) { items = []; }
      var lc = 0;
      for (var j = 0; j < items.length; j++){ if (items[j].link) lc++; }
      totalLinks += lc;
      fileStats.push({ filename: f.name, link_count: lc });
      allItems = allItems.concat(items);
    }
    if (allItems.length === 0) {
      throw new Error('Yuklenen dosyalardan icerik okunamadi (Word bicimi taninmadi veya bos).');
    }
    var seen = {}, deduped = [];
    for (var k = 0; k < allItems.length; k++){
      var it = allItems[k];
      if (it.link) { var nk = _wdNormLink(it.link); if (seen[nk]) continue; seen[nk] = true; }
      deduped.push(it);
    }
    var outputLinks = 0; for (var s in seen) { if (seen.hasOwnProperty(s)) outputLinks++; }
    var blob = await generateBlob(opts, deduped);
    // items: Kayitli Rapor olarak kaydetmek icin (submitMod1 'Kaydet ve Indir' yolu).
    return { blob: blob, items: deduped, totalLinks: totalLinks, outputLinks: outputLinks, fileStats: fileStats };
  }

  window.XLocalDocx = { generateBlob: generateBlob, clientWordDuzenle: clientWordDuzenle, parseReportHtml: xParseReportHtml };
})();
'''

@app.route('/x-local-docx.js', methods=['GET'])
def x_local_docx_js():
    return _js_yanit(LOCAL_DOCX_JS)

# ----------------- YEREL GORUNTU DEPOSU (Faz #1-A) -----------------
# Ekran goruntuleri, "local_images" bayragi acikken sunucuya gitmez; eklenti bunlari
# guvenilir panel_tab_id uzerinden dogrudan panele iletir ve panel tarayicida IndexedDB'de tutar.
# Sunucu havuzu yalnizca metadata (baslik, link, sira) tasir; goruntu baytlari YERELDE kalir.
# Bayrak KAPALIYKEN bu modul pasiftir; her sey bugunkuyle ayni (sunucu) calisir.
LOCAL_IMAGES_JS = r'''
(function(){
  'use strict';
  var DB_NAME='goruntux_local_images', STORE='images';
  var _db=null, _cache={}, _ready=false, _readyPromise=null;

  function xNormLink(link){
    // Sunucu normalize_link_key ile AYNI alt-kume: ?/# soy, trailing /embed, trailing /, lowercase.
    // twitter->x ve orta-string /embed/ collapse YAPILMAZ; aksi halde sunucunun AYRI tuttugu
    // (or. twitter.com vs x.com) iki havuz ogesini istemci tek anahtara birlestirip goruntuleri karistiriyordu.
    // Faz FB-1: Facebook'ta KIMLIK SORGUDA (permalink.php?story_fbid=..&id=..) -> '?' ile kesilemez.
    // XPlat.fbCanonical, Python fb_canonical_link ile AYNI kurali uygular (ikizler test edildi).
    // Sunucu normalize_link_key ile BIRLIKTE degistirilmeli; ayrisirsa goruntuler kaybolur/karisir.
    if(!link) return '';
    if(window.XPlat && XPlat.platform(link)==='fb'){
      // Python: fb_canonical_link(link).split("#")[0].rstrip("/").lower()
      // rstrip('/') TUM sondaki slash'lari atar -> JS'te /\/+$/ (tek slash soyan .slice(0,-1) DEGIL).
      return XPlat.fbCanonical(link).split('#')[0].replace(/\/+$/,'').toLowerCase();
    }
    // Faz TT-1: TikTok'ta kimlik YOLDA, yani asagidaki varsayilan dal sorguyu zaten atardi.
    // AMA delege ediyoruz cunku ttCanonical HOST'u da normalize ediyor (m./çıplak -> www).
    // Varsayilan dala biraksaydik m.tiktok.com/... ile www.tiktok.com/... AYRI anahtar olur,
    // havuz linki kanonik (www) uretildigi icin gorsel HAM linkin anahtarina yazilir ve
    // ayrisirlardi -> gorsel SESSIZCE kaybolurdu. Python normalize_link_key ile AYNI.
    if(window.XPlat && XPlat.platform(link)==='tt'){
      return XPlat.ttCanonical(link).split('#')[0].replace(/\/+$/,'').toLowerCase();
    }
    // Faz YT-1: /watch?v=ID kimligi SORGUDA -> '?' ile KESMEK YASAK (FB tuzagi).
    // ytCanonical youtu.be/live/embed'i de watch?v=ID'ye indiriyor -> ayni video hangi
    // bicimde gelirse gelsin TEK anahtar. Python normalize_link_key ile AYNI.
    if(window.XPlat && XPlat.platform(link)==='yt'){
      return XPlat.ytCanonical(link).split('#')[0].replace(/\/+$/,'').toLowerCase();
    }
    var s=String(link).split('#')[0].split('?')[0].trim().toLowerCase();
    s=s.replace(/\/embed$/,'');
    if(s.length>1 && s.charAt(s.length-1)==='/') s=s.slice(0,-1);
    return s;
  }
  function openDb(){
    return new Promise(function(resolve){
      try{
        var req=indexedDB.open(DB_NAME,1);
        req.onupgradeneeded=function(e){ var db=e.target.result; if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE,{keyPath:'k'}); };
        req.onsuccess=function(e){ resolve(e.target.result); };
        req.onerror=function(){ resolve(null); };
      }catch(err){ resolve(null); }
    });
  }
  function loadAll(){
    return new Promise(function(resolve){
      if(!_db){ resolve(); return; }
      try{
        var req=_db.transaction(STORE,'readonly').objectStore(STORE).getAll();
        req.onsuccess=function(){ var arr=req.result||[]; for(var i=0;i<arr.length;i++) _cache[arr[i].k]={dataUrl:arr[i].dataUrl,mime:arr[i].mime}; resolve(); };
        req.onerror=function(){ resolve(); };
      }catch(e){ resolve(); }
    });
  }
  function putItem(k,dataUrl,mime){
    _cache[k]={dataUrl:dataUrl,mime:mime};
    if(!_db) return;
    try{ _db.transaction(STORE,'readwrite').objectStore(STORE).put({k:k,dataUrl:dataUrl,mime:mime}); }catch(e){}
  }
  function clearAll(){
    _cache={};
    if(!_db) return Promise.resolve();
    return new Promise(function(resolve){
      try{ var tx=_db.transaction(STORE,'readwrite'); tx.objectStore(STORE).clear(); tx.oncomplete=function(){resolve();}; tx.onerror=function(){resolve();}; }catch(e){ resolve(); }
    });
  }
  // B6: tek görseli sil (editor-manuel öğe silinince IndexedDB'de yetim kalmasın).
  function removeItem(k){
    delete _cache[k];
    if(!_db) return;
    try{ _db.transaction(STORE,'readwrite').objectStore(STORE).delete(k); }catch(e){}
  }
  // Faz #1-D (tam kaldirma): gorseller HER ZAMAN yerel; sunucuya asla gitmez.
  function isEnabled(){ return true; }
  function setEnabled(v){ try{ localStorage.setItem('x_local_images', v?'1':'0'); }catch(e){} }
  function mimeFromDataUrl(u){ var m=/^data:([^;,]+)/.exec(u||''); return (m&&m[1])?m[1]:'image/jpeg'; }
  function base64FromDataUrl(u){ var i=(u||'').indexOf(','); return i>=0?u.slice(i+1):''; }

  window.XLocalImages={
    isEnabled:isEnabled, setEnabled:setEnabled, normLink:xNormLink,
    hasImage:function(link){ return !!_cache[xNormLink(link)]; },
    getImageUrl:function(link){ var e=_cache[xNormLink(link)]; return e?e.dataUrl:''; },
    getBase64:function(link){ var e=_cache[xNormLink(link)]; return e?base64FromDataUrl(e.dataUrl):''; },
    getMime:function(link){ var e=_cache[xNormLink(link)]; return e?(e.mime||mimeFromDataUrl(e.dataUrl)):''; },
    clear:function(){ return clearAll(); },
    // B2/FIX-IMG-RACE: senkron yazım — postMessage'ın async işlenmesini beklemeden _cache'e koyar
    // (ardından gelen fetch-yolu yeniden-plan/kaydet görseli KAÇIRMASIN). IndexedDB'ye de yazar.
    put:function(link,dataUrl,mime){ if(!link||!dataUrl) return; putItem(xNormLink(link), dataUrl, mime||mimeFromDataUrl(dataUrl)); },
    remove:function(link){ removeItem(xNormLink(link)); },   // B6
    count:function(){ return Object.keys(_cache).length; },
    whenReady:function(){ return _readyPromise||Promise.resolve(); }
  };

  // Eklentiden (bridge -> panel postMessage) gelen goruntuleri depola.
  window.addEventListener('message', function(ev){
    if(ev.source!==window) return;
    var d=ev.data;
    if(!d || d.type!=='X_RAPOR_LOCAL_IMAGE') return;
    if(!d.link || !d.dataUrl) return;
    putItem(xNormLink(d.link), d.dataUrl, d.mime||mimeFromDataUrl(d.dataUrl));
    try{ window.dispatchEvent(new CustomEvent('x-local-image-added',{detail:{link:d.link}})); }catch(e){}
  });

  _readyPromise = openDb().then(function(db){ _db=db; return loadAll(); }).then(function(){ _ready=true; try{ window.dispatchEvent(new CustomEvent('x-local-images-ready')); }catch(e){} });
})();
'''

@app.route('/x-local-images.js', methods=['GET'])
def x_local_images_js():
    return _js_yanit(LOCAL_IMAGES_JS)


# ----------------- KAYITLI RAPORLAR (yerel, coklu, 1 hafta) -----------------
# Kullanici istegi: "Kaydet ve Indir" ile uretilen rapor hem PC'ye iner HEM de panelde
# yerel olarak saklanir; 24 saat->1 hafta sonra otomatik silinir; tekrar acilip duzenlenebilir.
# XLocalImages ile AYNI felsefe: gorseller sunucuya ASLA gitmez. Her rapor KENDI KENDINE YETEN
# bir anlik goruntudur (items + images KOPYASI + .docx blob) -> canli havuz degisse/temizlense
# de kayitli rapor bozulmaz. AYRI DB (goruntux_saved_reports) -> mevcut goruntu deposu (images)
# hic etkilenmez, surum bumplamak gerekmez (sifir risk). Iki store: 'meta' (hafif, liste icin)
# + 'data' (agir: items/images/blob). id ile baglanir; liste yalniz meta okur (hizli).
X_SAVED_REPORTS_JS = r'''
(function(){
  var DB_NAME='goruntux_saved_reports', META='meta', DATA='data', VER=1;
  var _db=null, _readyPromise=null;

  function openDb(){
    return new Promise(function(resolve){
      try{
        var req=indexedDB.open(DB_NAME, VER);
        req.onupgradeneeded=function(e){
          var db=e.target.result;
          if(!db.objectStoreNames.contains(META)) db.createObjectStore(META,{keyPath:'id'});
          if(!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA,{keyPath:'id'});
        };
        req.onsuccess=function(e){ resolve(e.target.result); };
        req.onerror=function(){ resolve(null); };
      }catch(err){ resolve(null); }
    });
  }
  function _tx(stores, mode){ return _db.transaction(stores, mode); }
  function _reqP(req){ return new Promise(function(res,rej){ req.onsuccess=function(){res(req.result);}; req.onerror=function(){rej(req.error);}; }); }
  function _now(){ try{ return Date.now(); }catch(e){ return 0; } }
  function genId(){
    try{ if(window.crypto && crypto.randomUUID) return crypto.randomUUID(); }catch(e){}
    return 'r_' + _now() + '_' + Math.floor(Math.random()*1e9).toString(36);
  }
  function _norm(s){ return (s==null?'':s).toString().trim().toLowerCase(); }

  function list(){
    return new Promise(function(resolve){
      if(!_db){ resolve([]); return; }
      try{
        var req=_tx(META,'readonly').objectStore(META).getAll();
        req.onsuccess=function(){
          var arr=(req.result||[]).slice();
          arr.sort(function(a,b){ return (b.updatedAt||0)-(a.updatedAt||0); });
          resolve(arr);
        };
        req.onerror=function(){ resolve([]); };
      }catch(e){ resolve([]); }
    });
  }
  function _findByName(name){
    return list().then(function(metas){
      var n=_norm(name);
      for(var i=0;i<metas.length;i++){ if(_norm(metas[i].name)===n) return metas[i]; }
      return null;
    });
  }
  // o = {name, items, images, blob, filename}. Ayni isim varsa GUNCELLER (id+createdAt korunur,
  // updatedAt tazelenir) -> tekrar kaydetme cop kayit uretmez. Yoksa yeni kayit.
  function _getMeta(id){ try{ return _reqP(_tx(META,'readonly').objectStore(META).get(id)).catch(function(){return null;}); }catch(e){ return Promise.resolve(null); } }
  // Kart önizlemesi: öğelerden SIRAYLA başlık + GÖRSEL (küçük thumbnail) + metin satırları çıkar
  // (Google-Docs tarzı küçük sayfa). META'ya yazılır (blob OKUNMADAN galeri çizilir).
  // [{t:'h'|'img'|'p', s:'...'}]. Görsel: images[normLink(link)].dataUrl'den küçük JPEG thumbnail
  // (canvas) üretilir ve normLink'e göre önbelleklenir (her kayıtta tekrar üretilmesin). ASYNC.
  var _onizThumbCache = {};
  function _onizThumb(key, dataUrl){
    if(_onizThumbCache[key]) return Promise.resolve(_onizThumbCache[key]);
    return new Promise(function(resolve){
      try{
        var img=new Image();
        img.onload=function(){ try{
          var maxW=150, iw=img.width||maxW, ih=img.height||maxW, s=Math.min(1, maxW/iw);
          var cw=Math.max(1,Math.round(iw*s)), ch=Math.max(1,Math.round(ih*s));
          var c=document.createElement('canvas'); c.width=cw; c.height=ch;
          c.getContext('2d').drawImage(img,0,0,cw,ch);
          var t=c.toDataURL('image/jpeg',0.62); _onizThumbCache[key]=t; resolve(t);
        }catch(e){ resolve(null); } };
        img.onerror=function(){ resolve(null); };
        img.src=dataUrl;
      }catch(e){ resolve(null); }
    });
  }
  async function _buildPreview(o){
    o = o || {};
    var items = o.items||[]; var images = o.images||{}; var lines=[];
    if(!items.length) return lines;
    var nk = (window.XLocalImages && window.XLocalImages.normLink) ? window.XLocalImages.normLink : function(x){ return (x==null?'':''+x); };
    for(var i=0;i<items.length && lines.length<8;i++){
      var it=items[i]||{};
      if(it.h1_override!=null && (''+it.h1_override).trim()!==''){ lines.push({t:'h', s:(''+it.h1_override).trim().slice(0,70)}); }
      var h=(it.h2_override!=null && (''+it.h2_override).trim()!=='') ? (''+it.h2_override) : (it.title||'');
      if(h && h.trim() && lines.length<8){ lines.push({t:'h', s:h.trim().slice(0,70)}); }
      // GÖRSEL (rapordaki sırasına göre): images[normLink] varsa küçük thumbnail
      try{ var ik=nk(it.link||''); var im=images[ik]; if(im && im.dataUrl && lines.length<8){ var th=await _onizThumb(ik, im.dataUrl); if(th){ lines.push({t:'img', s:th}); } } }catch(e){}
      if(it.parcalar){ for(var p=0;p<it.parcalar.length && lines.length<8;p++){ var pc=it.parcalar[p]; if(pc && pc.tur==='metin' && pc.metin){ var tx=(''+pc.metin).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim(); if(tx){ lines.push({t:'p', s:tx.slice(0,90)}); } } } }
    }
    return lines;
  }
  function saveReport(o){
    if(!_db) return Promise.reject(new Error('Yerel depo açılamadı'));
    var now=_now();
    // Faz 2: o.id verilirse O id'ye upsert (ad değişse de aynı kayıt — aktif rapor/oto-kayıt);
    // yoksa eski davranış (ada göre bul-güncelle). Geriye tam uyumlu.
    var _hasId = (o.id!=null && o.id!=='');
    var _lookup = _hasId ? _getMeta(o.id) : _findByName(o.name);
    return _lookup.then(function(existing){
      var id = _hasId ? o.id : (existing ? existing.id : genId());
      var createdAt = existing ? (existing.createdAt||now) : now;
      // Ad: açıkça verildiyse onu kullan; verilmediyse (null) mevcut adı KORU (oto-kayıt ad göndermez).
      var _ad = (o.name!=null) ? o.name.toString().trim() : (existing ? (existing.name||'') : '');
      // Faz 3: slug (URL /<slug>). Ad değişmediyse mevcut slug korunur; benzersizleştir (başka rapor aynı slug'ı kullanıyorsa -2,-3...).
      return _uniqueSlug(_slugify(_ad||'rapor'), id).then(function(_slug){
       return _buildPreview(o).then(function(_prev){
        var meta = { id:id, name:_ad, slug:_slug, createdAt:createdAt,
                     updatedAt:now, itemCount:((o.items&&o.items.length)||0), preview:_prev };
        var data = { id:id, items:o.items||[], images:o.images||{}, blob:o.blob||null, filename:o.filename||'', editorStyle:o.editorStyle||null, manualClusters:o.manualClusters||[] };
        return new Promise(function(resolve,reject){
          try{
            var tx=_tx([META,DATA],'readwrite');
            tx.objectStore(META).put(meta);
            tx.objectStore(DATA).put(data);
            tx.oncomplete=function(){ resolve(meta); };
            tx.onerror=function(){ reject(tx.error||new Error('kaydetme hatası')); };
            tx.onabort=function(){ reject(tx.error||new Error('kaydetme iptal (kota?)')); };
          }catch(e){ reject(e); }
        });
       });
      });
    });
  }
  // Faz 3: ad -> URL-güvenli slug (Türkçe harf çevirisi + aksan temizliği).
  function _slugify(s){
    s=(s==null?'':s).toString().trim().toLowerCase();
    var m={'ç':'c','ğ':'g','ı':'i','ö':'o','ş':'s','ü':'u','â':'a','î':'i','û':'u'};
    s=s.replace(/[çğıöşüâîû]/g,function(c){return m[c]||c;});
    try{ s=s.normalize('NFKD').replace(/[̀-ͯ]/g,''); }catch(e){}
    s=s.replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
    return s||'rapor';
  }
  // base slug'ı diğer raporlara karşı benzersizleştir (self hariç).
  function _uniqueSlug(base, selfId){
    return list().then(function(metas){
      var used={};
      metas.forEach(function(mm){ if(mm.id!==selfId){ var sl=mm.slug||_slugify(mm.name); if(sl) used[sl]=true; } });
      if(!used[base]) return base;
      var i=2; while(used[base+'-'+i]) i++;
      return base+'-'+i;
    });
  }
  // slug -> meta (eski kayıtlarda slug yoksa ad'dan türet). Bulunamazsa null.
  function getBySlug(slug){
    var want=_slugify(slug);
    return list().then(function(metas){
      for(var i=0;i<metas.length;i++){ var sl=metas[i].slug||_slugify(metas[i].name); if(sl===want) return metas[i]; }
      return null;
    });
  }
  function get(id){
    if(!_db) return Promise.resolve(null);
    return Promise.all([
      _reqP(_tx(META,'readonly').objectStore(META).get(id)),
      _reqP(_tx(DATA,'readonly').objectStore(DATA).get(id))
    ]).then(function(r){
      if(!r[0] && !r[1]) return null;
      return Object.assign({}, r[0]||{}, r[1]||{});
    }).catch(function(){ return null; });
  }
  function getBlob(id){
    if(!_db) return Promise.resolve(null);
    return _reqP(_tx(DATA,'readonly').objectStore(DATA).get(id))
      .then(function(d){ return (d && d.blob) ? {blob:d.blob, filename:d.filename||''} : null; })
      .catch(function(){ return null; });
  }
  function remove(id){
    if(!_db) return Promise.resolve();
    return new Promise(function(resolve){
      try{
        var tx=_tx([META,DATA],'readwrite');
        tx.objectStore(META).delete(id); tx.objectStore(DATA).delete(id);
        tx.oncomplete=function(){ resolve(); }; tx.onerror=function(){ resolve(); };
      }catch(e){ resolve(); }
    });
  }
  function rename(id, newName){
    if(!_db) return Promise.resolve();
    return _reqP(_tx(META,'readonly').objectStore(META).get(id)).then(function(meta){
      if(!meta) return;
      meta.name=(newName==null?'':newName).toString().trim(); meta.updatedAt=_now();
      // Faz 3: ad değişti -> slug'ı da güncelle (URL ada uyar).
      return _uniqueSlug(_slugify(meta.name||'rapor'), id).then(function(sl){
        meta.slug=sl;
        return new Promise(function(resolve){
          var tx=_tx(META,'readwrite'); tx.objectStore(META).put(meta);
          tx.oncomplete=function(){resolve(meta);}; tx.onerror=function(){resolve(meta);};
        });
      });
    }).catch(function(){});
  }
  // updatedAt (SON kayit) esas alinir -> uzerinde calisip tekrar kaydettikce yasar.
  function purgeExpired(ttlMs){
    if(!_db) return Promise.resolve(0);
    var cutoff=_now()-ttlMs;
    return list().then(function(metas){
      var dead=metas.filter(function(m){ return (m.updatedAt||0) < cutoff; }).map(function(m){ return m.id; });
      if(!dead.length) return 0;
      return new Promise(function(resolve){
        try{
          var tx=_tx([META,DATA],'readwrite');
          dead.forEach(function(id){ tx.objectStore(META).delete(id); tx.objectStore(DATA).delete(id); });
          tx.oncomplete=function(){ resolve(dead.length); }; tx.onerror=function(){ resolve(0); };
        }catch(e){ resolve(0); }
      });
    });
  }

  window.XSavedReports={
    whenReady:function(){ return _readyPromise||Promise.resolve(); },
    save:saveReport, list:list, get:get, getBlob:getBlob,
    remove:remove, rename:rename, purgeExpired:purgeExpired,
    getBySlug:getBySlug, slugify:_slugify, buildPreview:_buildPreview
  };
  _readyPromise = openDb().then(function(db){ _db=db; try{ window.dispatchEvent(new CustomEvent('x-saved-reports-ready')); }catch(e){} });
})();
'''

@app.route('/x-saved-reports.js', methods=['GET'])
def x_saved_reports_js():
    return _js_yanit(X_SAVED_REPORTS_JS)


# ----------------- RAPOR EDİTÖRÜ (metin-editörü önizleme mimarisi) -----------------
# Faz 0 İSKELETİ. BAYRAK KORUMALI (xEditorEnabled, varsayılan KAPALI) -> bu dosya yüklense
# bile hiçbir davranışı değiştirmez; yalnız window.XEditor isim-uzayını + boş modal kancalarını
# tanımlar. Gerçek editör (belge modeli, düzenlenebilir kartlar, görsel-altı metin, stil şeridi)
# Faz 3+'te buraya gelecek. HAM r''' rota: escape-tuzağı yok (ters-bölü/regex güvenli).
X_EDITOR_JS = r'''
/* GörüntüX — Rapor Editörü (Faz 4c: sürükle-bırak parça sıralama + görünür Metin Ekle + stil şeridi).
   Parçalar (gorsel/metin/link) tutamaktan (⠿) SÜRÜKLENEREK yer değiştirir. "+ Metin Ekle" kartın
   üstünde; yeni metin en alta eklenir + oraya kaydırılır. TEK-KAYNAK: plan generateBlob(__planOnly). */
(function () {
  "use strict";
  var XE = (window.XEditor = window.XEditor || {});
  XE.VERSION = "4c-suruk";
  XE.belge = { stil: {}, birimler: [] };
  var _drag = null;
  var _savedScroll = null;   // [scroll zıplamasını önle]: re-render'da preview-body scroll'u korunur
  // Faz 7: sürükleme sırasında editör gövdesinin kenarına yaklaşınca OTOMATİK KAYDIRMA
  // (uzun kart/liste içinde parçayı yukarı/aşağı sürüklerken scroll kolaylaşsın).
  var _dragY = 0, _dragRaf = 0;
  function _autoScrollTick(){
    if(!_drag){ _dragRaf = 0; return; }
    var sc = document.querySelector('#editorModal .preview-body');
    if(sc){
      var r = sc.getBoundingClientRect(), EDGE = 80, SPEED = 16;
      if(_dragY < r.top + EDGE && sc.scrollTop > 0) sc.scrollTop -= SPEED;
      else if(_dragY > r.bottom - EDGE) sc.scrollTop += SPEED;
    }
    _dragRaf = requestAnimationFrame(_autoScrollTick);
  }
  function _dragScrollKur(){
    var sc = document.querySelector('#editorModal .preview-body');
    if(!sc || sc._dragScrollBound) return;
    sc._dragScrollBound = true;
    sc.addEventListener('dragover', function(e){ if(_drag){ _dragY = e.clientY; } });
  }

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  // [FAZ B] Satır-içi biçimde izin verilen span stil özellikleri: font-family, color, font-size.
  // Diğer tüm stil/öznitelik atılır. px -> pt'ye çevrilir (docx pt bazlı).
  function _temizStil(st){
    st=String(st||''); var out='', m;
    if((m=st.match(/font-family\s*:\s*([^;]+)/i))){ var f=m[1].split(',')[0].replace(/['"]/g,'').trim(); if(f) out+="font-family:'"+f+"',sans-serif;"; }
    if((m=st.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i))){ var c=m[1].trim(); if(c) out+='color:'+c+';'; }
    if((m=st.match(/font-size\s*:\s*([\d.]+)(pt|px)/i))){ var num=parseFloat(m[1]); var pt=(m[2].toLowerCase()==='px')?Math.round(num/1.3333):num; if(pt) out+='font-size:'+pt+'pt;'; }
    return out;
  }
  // [SATIR-İÇİ LİNK] Güvenli URL: javascript:/data: (XSS) düşer; şemasızsa https:// eklenir (www./nokta içeren).
  function _temizUrl(u){ u=String(u==null?'':u).trim(); if(!u) return '';
    if(/^\s*(javascript|data|vbscript)\s*:/i.test(u)) return '';
    if(!/^[a-z][a-z0-9+.\-]*:\/\//i.test(u) && !/^(mailto:|tel:|#|\/)/i.test(u)){ if(/\./.test(u)) u='https://'+u; }   // şema yoksa + nokta varsa https://
    return u;
  }
  // [YAPIŞTIRMA SATIR SONU] Blok elemanları (<div>/<p>/...) SATIR SINIRIDIR. Eskiden sanitizeMetin bunları
  // açıp atıyordu -> çok-satırlı/boşluklu yapıştırma kapat-aç'ta BİRLEŞİYORDU. Blokları <br>'ye çevir:
  // her bloğun önüne (önceki içerik varsa) sınır <br>; boş-blok placeholder <br>'ini KALDIR (çift sayma yok).
  // İç içe bloklar önce düzlenir; inline biçim (b/i/u/span) sonraki walk'ta korunur.
  var _BLOK_ET={div:1,p:1,li:1,ul:1,ol:1,section:1,article:1,header:1,footer:1,main:1,aside:1,nav:1,h1:1,h2:1,h3:1,h4:1,h5:1,h6:1,blockquote:1,pre:1,figure:1,figcaption:1,table:1,thead:1,tbody:1,tr:1,dl:1,dt:1,dd:1};
  function _oncekiIcerikVar(c){ var p=c.previousSibling; while(p){ if(p.nodeType===1) return true; if(p.nodeType===3 && String(p.nodeValue).replace(/\s+/g,'')!=='') return true; p=p.previousSibling; } return false; }
  function _blokDuzle(node){
    var kids=Array.prototype.slice.call(node.childNodes);
    kids.forEach(function(c){
      if(c.nodeType!==1) return;
      var tag=c.tagName.toLowerCase();
      if(_BLOK_ET[tag]){
        _blokDuzle(c);   // önce iç içe blokları düzle
        if(c.childNodes.length===1 && c.firstChild.nodeType===1 && c.firstChild.tagName && c.firstChild.tagName.toLowerCase()==='br'){ c.removeChild(c.firstChild); }   // boş-blok placeholder <br>'i
        if(_oncekiIcerikVar(c)){ node.insertBefore(document.createElement('br'), c); }   // satır sınırı
        while(c.firstChild) node.insertBefore(c.firstChild, c);   // bloğu aç
        node.removeChild(c);
      } else { _blokDuzle(c); }   // inline içinde iç içe blok (nadir)
    });
  }
  // Zengin metin: b/strong/i/em/u/br + font/renk/boyut taşıyan span'ler korunur (seçime özel biçim).
  // Diğer etiketler açılır (içerik kalır); stil-tabanlı kalın/eğik/altçizgi b/i/u'ya sarılır.
  function sanitizeMetin(html){
    try{ var d=document.createElement('div'); d.innerHTML=String(html==null?'':html);
      _blokDuzle(d);   // [YAPIŞTIRMA SATIR SONU] blokları <br>'ye çevir (inline walk'tan ÖNCE)
      (function walk(n){ var kids=Array.prototype.slice.call(n.childNodes);
        kids.forEach(function(c){
          if(c.nodeType===1){ var tag=c.tagName.toLowerCase();
            var st=(c.getAttribute&&c.getAttribute('style'))||'';
            if(tag==='a'){   // [SATIR-İÇİ LİNK] <a href>'i KORU (yalnız güvenli href); geçersizse aç
              var _ah=_temizUrl((c.getAttribute&&c.getAttribute('href'))||'');
              while(c.attributes && c.attributes.length) c.removeAttribute(c.attributes[0].name);
              if(_ah){ c.setAttribute('href', _ah); walk(c); }
              else { while(c.firstChild) n.insertBefore(c.firstChild,c); n.removeChild(c); }
              return;
            }
            if(['b','strong','i','em','u','br'].indexOf(tag)!==-1){
              while(c.attributes && c.attributes.length) c.removeAttribute(c.attributes[0].name); if(tag!=='br') walk(c);
            } else {
              var isB=/font-weight\s*:\s*(bold|[6-9]00)/i.test(st), isI=/font-style\s*:\s*italic/i.test(st), isU=/text-decoration[^;"']*underline/i.test(st);
              var clean=_temizStil(st);
              if(clean){
                var span=document.createElement('span'); span.setAttribute('style', clean);
                while(c.firstChild) span.appendChild(c.firstChild);
                var top=span;
                if(isU){ var wu=document.createElement('u'); wu.appendChild(top); top=wu; }
                if(isI){ var wi=document.createElement('i'); wi.appendChild(top); top=wi; }
                if(isB){ var wb=document.createElement('b'); wb.appendChild(top); top=wb; }
                n.replaceChild(top,c); walk(span);
              } else if(isB||isI||isU){
                var wrap=isB?'b':(isI?'i':'u'); var w=document.createElement(wrap); while(c.firstChild) w.appendChild(c.firstChild); n.replaceChild(w,c); walk(w);
              } else { while(c.firstChild) n.insertBefore(c.firstChild,c); n.removeChild(c); }
            }
          } else if(c.nodeType!==3){ n.removeChild(c); }
        });
      })(d);
      return d.innerHTML;
    }catch(e){ return esc(String(html==null?'':html)); }
  }
  function renderMetin(m){ m=String(m==null?'':m); return /<(b|strong|i|em|u|br|span|a)[ >\/]/i.test(m) ? m : esc(m); }
  // B (havuz birlesmesi): editor-manuel bolum sentetik anahtari (xmanual://<uid>) -> HEM havuz
  // kimligi HEM overlay HEM yerel gorsel anahtari (tek anahtar; gorsel/parca desenkron imkansiz).
  function edManual(lk){ return !!lk && String(lk).toLowerCase().indexOf('xmanual://')===0; }
  // [13]: SUNUCU bayrağı (X_UNIFY_MANUAL, /api/status -> window.__xUnifyServer) KAPALIYSA özellik tümden
  // kapanır (istemci localStorage'tan bağımsız); böylece sunucu-tarafı geri alma airtight. Aksi halde
  // per-tarayıcı localStorage x_unify_manual (varsayılan AÇIK).
  function unifyOn(){ try{ if(window.__xUnifyServer===false) return false; return localStorage.getItem('x_unify_manual')!=='0'; }catch(e){ return true; } }
  XE._unifyOn = unifyOn;   // panel kodu (startAutomation vb.) için
  XE._dirty = false;   // E1: kaydedilmemis degisiklik -> kapanista sorulur
  var _manSeq = 0;     // monotonik sayac: ayni ms uid cakismasini onler
  function linkGoster(it){ var lk=(it&&it.link)||''; return (String(lk).indexOf('rt:')===0 || edManual(lk)) ? '' : lk; }
  // [SORUN 2] Yeni eklenen link alanı BOŞ gelsin (eklenti tweet linki otomatik dolmasın). Boş url -> item.link
  // düşmesi YALNIZ bölümün ASIL link parçasına uygulanır. Bayrak kapalı ('0') -> eski davranış (hep düşer).
  function yeniLinkBosAcik(){ try{ return localStorage.getItem('x_yeni_link_bos')!=='0'; }catch(e){ return true; } }
  // ASIL link = kullanıcının EKLEMEDİĞİ (_ekLink işaretsiz) İLK link parçasının indeksi; -1 yoksa. KONUMDAN
  // BAĞIMSIZ: görselin üstüne eklenen boş link (işaretli) asıl linki ETKİLEMEZ -> görünüm/sıra takası OLMAZ.
  function _asilLinkIdx(pc){ if(!pc) return -1; for(var _z=0;_z<pc.length;_z++){ if(pc[_z] && pc[_z].tur==='link' && !pc[_z]._ekLink) return _z; } return -1; }
  function stilOku(){ try { return (typeof window.xBuildStyleOpts==='function') ? window.xBuildStyleOpts() : {}; } catch(e){ return {}; } }
  function yeniId(){ return 'm'+Date.now()+Math.floor(Math.random()*100000); }

  // ====== GERİ AL / İLERİ AL (editör geçmişi) ======
  // Tam durum anlık-görüntüsü: havuz öğe listesi (sıra+meta) + overlay + manuel bloklar + açık-rapor adı + stil.
  // Geri-yüklemede havuz YALNIZ üyelik/sıra değişmişse yeniden kurulur (içerik/başlık/taşıma/stil değişiklikleri
  // havuza dokunmaz = hızlı). Silinen öğenin görseli oturum-içi _imgStore'dan geri gelir (B6 görseli temizlense bile).
  XE._undoStack = []; XE._redoStack = []; XE._imgStore = {};
  XE._externalMode = false;   // [1] Word Düzenle (providedItems, .index YOK) -> snapshot havuz yerine belge item'larını tutar
  var _UNDO_MAX = 50;
  var _pendingSnap = null;   // metin/başlık/link alanına odaklanınca alınır; ilk girişte yığına atılır
  var _restoring = false;    // geri-yükleme sırasında yeni snapshot ALMA (programatik stil olayları tetiklenebilir)
  var _busy = false;         // [5] async yapısal işlem (sil/ekle/restore) uçuştayken geri/ileri REDDET (yarış önler)
  function _imgStoreTopla(){
    try{ (XE.belge.birimler||[]).forEach(function(b){ if(b&&b.item&&b.item.link&&b.item.image_b64){ XE._imgStore[b.item.link]={ dataUrl:'data:'+(b.item.image_mime||'image/jpeg')+';base64,'+b.item.image_b64, mime:(b.item.image_mime||'image/jpeg') }; } }); }catch(e){}
  }
  function _poolSnap(){
    var arr=(XE.belge.birimler||[]).filter(function(b){ return b&&b.item&&b.item.index!=null; }).map(function(b){ return b.item; });
    arr.sort(function(a,b){ return (a.index||0)-(b.index||0); });
    return arr.map(function(it){ return { link:it.link||'', title:it.title||'', group_override:(it.group_override||''), is_profile:!!it.is_profile }; });
  }
  XE._snap = function(){
    _imgStoreTopla();
    var base = { overlay: JSON.parse(JSON.stringify(window.__xEditorOverlay||{byLink:{},style:null})),
      manual: JSON.parse(JSON.stringify(window.__xManualClusters||[])),
      openName: window.__openReportName||'',
      style: (typeof window.xBuildStyleOpts==='function'? window.xBuildStyleOpts():{}) };
    if(XE._externalMode){
      // [1]: Word Düzenle (dış öğeler, havuz YOK) -> belge item'larının TAM kopyası; restore ac({items}) ile replay.
      base.external=true;
      base.items=(XE.belge.birimler||[]).map(function(b){ return JSON.parse(JSON.stringify(b.item||{})); });
    } else { base.pool=_poolSnap(); }
    return base;
  };
  function _geriBtnGuncelle(){ try{ var g=document.getElementById('ed-geri'), i=document.getElementById('ed-ileri'); if(g) g.disabled=!XE._undoStack.length; if(i) i.disabled=!XE._redoStack.length; }catch(e){} }
  XE._pushUndo = function(){
    if(_restoring) return;
    try{ XE._undoStack.push(XE._snap()); if(XE._undoStack.length>_UNDO_MAX) XE._undoStack.shift(); XE._redoStack=[]; _geriBtnGuncelle(); }catch(e){}
  };
  function _linkSig(items){ return (items||[]).map(function(p){ return p.link||''; }).join('\n'); }
  XE._restore = async function(snap){
    if(!snap) return;
    _restoring=true; _busy=true;
    try{
      window.__xEditorOverlay = JSON.parse(JSON.stringify(snap.overlay||{byLink:{},style:null}));
      window.__xManualClusters = JSON.parse(JSON.stringify(snap.manual||[]));
      window.__openReportName = snap.openName||'';
      if(snap.style && typeof window.xApplyStyleOpts==='function'){ try{ window.xApplyStyleOpts(snap.style); }catch(e){} }
      if(snap.external){
        // [1]: Word Düzenle -> dış öğeleri replay et; sunucu havuzuna DOKUNMA.
        XE._dirty=true;
        await XE.ac({ items: JSON.parse(JSON.stringify(snap.items||[])) });
        return;
      }
      // Havuz modu: canlı havuzu + iş durumunu çek. [2] Fetch başarısızsa ya da [7] tarama SÜRÜYORSA
      // yıkıcı yeniden-kurma YAPMA (yalnız overlay/stil'i yeniden çiz); yoksa sadece üyelik/sıra değiştiyse kur.
      var st=null; try{ st=await fetch('/api/status').then(function(r){return r.json();}); }catch(e){ st=null; }
      if(st===null){ XE._dirty=true; await XE.ac({}); return; }                                 // [2]: fetch hatası -> havuzu YIKMA
      if(st.status==='running'){ if(window.showToast) showToast('Tarama sürerken havuz yeniden kurulamaz; içerik/stil geri alındı.','warning'); XE._dirty=true; await XE.ac({}); return; }  // [7]: çalışan işi EZME
      var cur=(st.manuel_list)||[];
      if(_linkSig(cur) !== _linkSig(snap.pool)){
        try{ await fetch('/api/manual/clear',{method:'POST'}); }catch(e){}
        if(window.XLocalImages && window.XLocalImages.clear){ try{ await window.XLocalImages.clear(); }catch(e){} }
        for(var k=0;k<snap.pool.length;k++){ var p=snap.pool[k];
          var im=XE._imgStore[p.link];
          if(im && window.XLocalImages && window.XLocalImages.put){ try{ window.XLocalImages.put(p.link, im.dataUrl, im.mime); }catch(e){} }
          var body={ title:p.title||'', link:p.link||'', local:true };
          if(p.is_profile) body.is_profile=true;
          if(p.group_override) body.group_override=p.group_override;
          try{ await fetch('/api/manual/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }catch(e){}
        }
      }
      XE._dirty=true;
      await XE.ac({});   // non-fresh -> yığınları sıfırlamaz; taze havuz+overlay'den çizer
    } finally { _restoring=false; _busy=false; _geriBtnGuncelle(); }
  };
  XE.geriAl = async function(){
    if(_restoring || _busy) return;   // [5] işlem uçuştayken reddet
    if(!XE._undoStack.length){ if(window.showToast) showToast('Geri alınacak bir şey yok.','info'); return; }
    XE._redoStack.push(XE._snap()); if(XE._redoStack.length>_UNDO_MAX) XE._redoStack.shift();
    await XE._restore(XE._undoStack.pop());
  };
  XE.ileriAl = async function(){
    if(_restoring || _busy) return;
    if(!XE._redoStack.length){ if(window.showToast) showToast('İleri alınacak bir şey yok.','info'); return; }
    XE._undoStack.push(XE._snap()); if(XE._undoStack.length>_UNDO_MAX) XE._undoStack.shift();
    await XE._restore(XE._redoStack.pop());
  };
  XE._geriSifirla = function(){ XE._undoStack=[]; XE._redoStack=[]; _pendingSnap=null; XE._imgStore={}; _geriBtnGuncelle(); };
  // metin/başlık/link alanı: odak->ön-anlık al, İLK giriş->yığına at (alan başına TEK undo adımı).
  XE._alanOdak = function(){ if(_restoring) return; _pendingSnap = XE._snap(); };
  XE._alanGiris = function(){ if(_restoring || !_pendingSnap) return; XE._undoStack.push(_pendingSnap); if(XE._undoStack.length>_UNDO_MAX) XE._undoStack.shift(); XE._redoStack=[]; _pendingSnap=null; _geriBtnGuncelle(); };
  XE._alanBlur = function(){ _pendingSnap=null; };
  // Klavye: editör açıkken Ctrl/Cmd+Z geri, Ctrl/Cmd+Y veya Ctrl/Cmd+Shift+Z ileri. Metin alanı
  // İÇİNDEYKEN native undo'yu bırak (karakter-karakter); alan DIŞINDA editör-geçmişi. Butonlar her zaman editör-geçmişi.
  function _klavyeKur(){
    if(window.__edKlavye) return; window.__edKlavye=true;
    document.addEventListener('keydown', function(e){
      var m=document.getElementById('editorModal'); if(!m || !m.classList.contains('active')) return;
      if(!(e.ctrlKey || e.metaKey)) return;
      var ae=document.activeElement; var inEditable = !!(ae && (ae.isContentEditable || ae.tagName==='INPUT' || ae.tagName==='TEXTAREA'));
      if(inEditable) return;   // alan içinde -> native undo/redo
      var key=(e.key||'').toLowerCase();
      if(key==='z' && !e.shiftKey){ e.preventDefault(); XE.geriAl(); }
      else if(key==='y' || (key==='z' && e.shiftKey)){ e.preventDefault(); XE.ileriAl(); }
    });
  }
  // [RAPOR ADI] Üst çubuktaki inline rapor adı alanı: Enter/blur -> kaydet (ana script window.xEdRaporAdiKaydet),
  // Escape -> iptal. Dinleyiciler bir kez; her açılışta mevcut adla doldurulur (xEdRaporAdiDoldur).
  function _raporAdiKur(){
    var inp=document.getElementById('ed-rapor-adi'); if(!inp) return;
    if(!inp._xKur){ inp._xKur=true;
      inp.addEventListener('keydown', function(e){
        if(e.key==='Enter'){ e.preventDefault(); inp.blur(); }                 // Enter -> blur -> kaydet
        else if(e.key==='Escape'){ e.preventDefault(); try{ if(window.xEdRaporAdiDoldur) window.xEdRaporAdiDoldur(); }catch(_){ } inp.blur(); }   // iptal: eski ada dön
      });
      inp.addEventListener('blur', function(){ try{ if(window.xEdRaporAdiKaydet) window.xEdRaporAdiKaydet(inp.value); }catch(_){ } });
    }
    try{ if(window.xEdRaporAdiDoldur) window.xEdRaporAdiDoldur(); }catch(_){ }   // açılışta mevcut adla doldur
  }
  // [TOOLTIP] Temaya uygun özel tooltip: native 'title' yerine tek yüzen #ed-tip. Delegasyon -> tüm
  // butonlar/etiketler otomatik kapsanır (dinamik render dahil). title -> data-tip'e taşınır (native sustur).
  var _tipEl=null, _tipTmr=null;
  function _edAktifMi(){ var m=document.getElementById('editorModal'); return !!(m && m.classList.contains('active')); }
  function _tipHedef(t){ return (t && t.closest) ? t.closest('[title],[data-tip]') : null; }
  function _tipMetin(el){ var t=el.getAttribute('data-tip'); if(t==null){ t=el.getAttribute('title'); if(t!=null){ el.setAttribute('data-tip', t); el.removeAttribute('title'); } } return t||''; }
  function _tipGoster(el, text){
    var tip=document.getElementById('ed-tip'); if(!tip) return;
    tip.textContent=text; tip.style.display='block'; tip.style.visibility='hidden'; tip.style.left='0px'; tip.style.top='0px'; tip.style.removeProperty('--ok');
    var r=el.getBoundingClientRect(); var tw=tip.offsetWidth, th=tip.offsetHeight;
    var cx=r.left + r.width/2;
    var left=cx - tw/2; if(left<6) left=6; if(left+tw>window.innerWidth-6) left=window.innerWidth-tw-6;
    var top=r.bottom + 9, pos='alt';
    if(top+th>window.innerHeight-6){ top=r.top - th - 9; pos='ust'; }   // yer yoksa üstüne
    var ok=cx-left; if(ok<12) ok=12; if(ok>tw-12) ok=tw-12;             // ok öğenin ortasına baksın
    tip.style.left=Math.round(left)+'px'; tip.style.top=Math.round(top)+'px';
    tip.setAttribute('data-pos', pos); tip.style.setProperty('--ok', Math.round(ok)+'px');
    tip.style.visibility='visible';
  }
  function _tipGizle(){ var tip=document.getElementById('ed-tip'); if(tip) tip.style.display='none'; }
  function _tooltipKur(){
    if(window.__edTipKur) return; window.__edTipKur=true;
    var tip=document.createElement('div'); tip.id='ed-tip'; tip.style.display='none'; (document.body||document.documentElement).appendChild(tip);
    document.addEventListener('mouseover', function(e){
      if(!_edAktifMi()) return;
      var el=_tipHedef(e.target); if(!el || !_edAktifMi() || !document.getElementById('editorModal').contains(el)) return;
      if(el===_tipEl) return; _tipEl=el;
      var t=_tipMetin(el); clearTimeout(_tipTmr); _tipGizle();
      if(!t) return;
      _tipTmr=setTimeout(function(){ if(_tipEl===el) _tipGoster(el, t); }, 350);
    });
    document.addEventListener('mouseout', function(e){
      var el=_tipHedef(e.target); if(!el) return;
      if(e.relatedTarget && el.contains(e.relatedTarget)) return;   // çocuğa geçiş -> gizleme
      if(el===_tipEl) _tipEl=null;
      clearTimeout(_tipTmr); _tipGizle();
    });
    document.addEventListener('mousedown', function(){ clearTimeout(_tipTmr); _tipGizle(); _tipEl=null; }, true);
    window.addEventListener('scroll', function(){ clearTimeout(_tipTmr); _tipGizle(); }, true);
  }
  // [LIGHTBOX] Görsele çift tık -> tam ekran görüntüleyici: görsel ekran sınırlarına SIĞDIRILIR (contain),
  // boşluklar aynı görselin BLUR'lu dolgusu; X ya da ESC ile çıkış (arka plana tıklama da kapatır).
  function _lightboxKur(){
    if(window.__edLbKur) return; window.__edLbKur=true;
    document.addEventListener('dblclick', function(e){
      var m=document.getElementById('editorModal'); if(!m || !m.classList.contains('active')) return;
      var img=(e.target && e.target.closest) ? e.target.closest('.ed-img') : null;
      if(img && img.getAttribute('src')){ e.preventDefault(); _lightboxAc(img.getAttribute('src')); }
    });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ var lb=document.getElementById('ed-lightbox'); if(lb && lb.classList.contains('acik')){ e.preventDefault(); _lightboxKapat(); } } });
  }
  function _lightboxAc(src){
    var lb=document.getElementById('ed-lightbox');
    if(!lb){ lb=document.createElement('div'); lb.id='ed-lightbox'; (document.body||document.documentElement).appendChild(lb);
      lb.addEventListener('click', function(e){ if(!(e.target && e.target.closest && e.target.closest('.ed-lb-img'))) _lightboxKapat(); });   // görsel dışına tıkla -> kapat
    }
    var bg=document.createElement('img'); bg.className='ed-lb-bg'; bg.setAttribute('aria-hidden','true'); bg.src=src;
    var im=document.createElement('img'); im.className='ed-lb-img'; im.src=src;
    var btn=document.createElement('button'); btn.className='ed-lb-kapat'; btn.type='button'; btn.title='Kapat (ESC)'; btn.innerHTML='&#10005;';
    btn.addEventListener('click', function(e){ e.stopPropagation(); _lightboxKapat(); });
    lb.innerHTML=''; lb.appendChild(bg); lb.appendChild(im); lb.appendChild(btn);
    lb.classList.add('acik');
  }
  function _lightboxKapat(){ var lb=document.getElementById('ed-lightbox'); if(lb){ lb.classList.remove('acik'); lb.innerHTML=''; } }
  // [TAM EKRAN] Üst çubuk butonu -> tarayıcı tam ekranı (editör/panel ekranını kaplar). Tekrar/ESC ile çıkılır.
  XE.tamEkran = function(){
    try{
      var fs=document.fullscreenElement||document.webkitFullscreenElement;
      if(!fs){ var de=document.documentElement; (de.requestFullscreen||de.webkitRequestFullscreen||function(){}).call(de); }
      else { (document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document); }
    }catch(e){}
  };
  function _tamEkranIkonGuncelle(){
    var b=document.getElementById('ed-ik-tamekran-btn'); if(!b) return;
    var fs=!!(document.fullscreenElement||document.webkitFullscreenElement);
    b.title=fs?'Tam ekrandan çık (ESC)':'Tam ekran';
    b.innerHTML=fs
      ? '<svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5H7.5V3.5"/><path d="M16.5 7.5H12.5V3.5"/><path d="M3.5 12.5H7.5V16.5"/><path d="M16.5 12.5H12.5V16.5"/></svg>'
      : '<svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 3.5H3.5V7.5"/><path d="M12.5 3.5H16.5V7.5"/><path d="M7.5 16.5H3.5V12.5"/><path d="M12.5 16.5H16.5V12.5"/></svg>';
  }
  function _tamEkranKur(){
    if(!window.__edFsKur){ window.__edFsKur=true;
      document.addEventListener('fullscreenchange', _tamEkranIkonGuncelle);
      document.addEventListener('webkitfullscreenchange', _tamEkranIkonGuncelle);
    }
    _tamEkranIkonGuncelle();   // açılışta mevcut duruma göre ikon
  }
  // [SAYFA NO] Şeritteki "Sayfa no" menüsünü doldurur (butona tıklayınca açılır; bağlama _panelCiz post-render'da).
  // Değerler gizli backing input'lara (pn_on/pn_pos/pn_align/pn_fmt) yazılır -> xBuildStyleOpts -> docx. Yalnız Word çıktısı.
  function _sayfaNoMenuCiz(){
    var m=document.getElementById('ed-sayfano-menu'); if(!m) return;
    function g(id,d){ var e=document.getElementById(id); return e?(e.type==='checkbox'?e.checked:e.value):d; }
    var on=!!g('pn_on',false), pos=g('pn_pos','footer'), al=g('pn_align','right'), fmt=g('pn_fmt','plain');
    function grp(baslik, key, cur, secs){ var s='<div class="ed-sn-grp'+(on?'':' pasif')+'"><div class="ed-sn-lbl">'+baslik+'</div><div class="ed-sn-opts">'; for(var i=0;i<secs.length;i++){ s+='<button type="button" class="ed-sn-opt'+(cur===secs[i][0]?' aktif':'')+'" data-k="'+key+'" data-v="'+secs[i][0]+'">'+secs[i][1]+'</button>'; } return s+'</div></div>'; }
    var h='';
    h+='<label class="ed-sn-on-row"><input type="checkbox" class="ed-sn-on"'+(on?' checked':'')+'> Sayfa numarası (Word çıktısı)</label>';
    h+='<div class="ed-sn-sep"></div>';
    h+=grp('Konum','pos',pos,[['footer','Altta'],['header','Üstte']]);
    h+=grp('Hizalama','align',al,[['left','Sol'],['center','Orta'],['right','Sağ']]);
    h+=grp('Biçim','fmt',fmt,[['plain','1'],['sayfa','Sayfa 1'],['xofn','1 / N']]);
    m.innerHTML=h;
    var cb=m.querySelector('.ed-sn-on'); if(cb) cb.addEventListener('change', function(){ XE._sayfaNoUygula('on', cb.checked); });
    m.querySelectorAll('.ed-sn-opt').forEach(function(b){ b.addEventListener('click', function(e){ e.stopPropagation(); XE._sayfaNoUygula(b.getAttribute('data-k'), b.getAttribute('data-v')); }); });
  }
  XE._sayfaNoUygula = function(prop, v){
    XE._pushUndo();
    var map={on:'pn_on', pos:'pn_pos', align:'pn_align', fmt:'pn_fmt'}, id=map[prop]; if(!id) return;
    var el=document.getElementById(id); if(el){ if(el.type==='checkbox') el.checked=!!v; else el.value=v; }
    if(typeof window.xSaveStyles==='function'){ try{ window.xSaveStyles(); }catch(_){} }
    try{ window.__xPoolDirty=true; }catch(_){}
    XE._dirty=true;
    _sayfaNoMenuCiz();   // menüyü tazele (aktif durum + pasif/aktif)
  };

  var CSS = `
#editorModal.modal{align-items:stretch;justify-content:stretch;background:#fff;backdrop-filter:none;padding:0;}
#editorModal .preview-modal-content{width:100%;max-width:none;height:100vh;border:0;border-radius:0;box-shadow:none;animation:none;}
#editorModal .preview-body{display:block;overflow-y:auto;overflow-x:hidden;overscroll-behavior:none;scroll-padding-top:118px;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:#b6c0cb #eef1f4;}
/* GÖRÜNÜR/KALICI scroll çubuğu (editör uzun; overlay-scrollbar gizli kalıyordu -> kullanıcı kaydırabildiğini görmüyordu) */
#editorModal .preview-body::-webkit-scrollbar{width:13px;height:13px;}
#editorModal .preview-body::-webkit-scrollbar-track{background:#eef1f4;}
#editorModal .preview-body::-webkit-scrollbar-thumb{background:#b6c0cb;border-radius:8px;border:3px solid #eef1f4;background-clip:padding-box;min-height:40px;}
#editorModal .preview-body::-webkit-scrollbar-thumb:hover{background:#8a94a0;background-clip:padding-box;border:3px solid #eef1f4;}
#editorModal .ed-serit{position:sticky;top:0;z-index:5;background:linear-gradient(#ffffff,#f2f5f9);border-bottom:1px solid #d0d7de;padding:10px 16px;box-shadow:0 1px 4px rgba(16,24,40,0.05);}
#editorModal .ed-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}
#editorModal .ed-tab{border:1px solid #d7dde3;background:#fff;color:#3a4654;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:background .12s,border-color .12s;}
#editorModal .ed-tab:hover{background:#eef5ff;border-color:#9ec5f0;}
#editorModal .ed-tab.aktif{background:#1565c0;color:#fff;border-color:#1565c0;box-shadow:0 1px 3px rgba(21,101,192,0.35);}
#editorModal .ed-panel{display:flex;gap:9px;flex-wrap:wrap;align-items:center;}
/* [ŞERİT GRUPLARI] Word gibi ayraçlı gruplar: her grup kendi içinde sıkı, gruplar arası dikey çizgi. */
#editorModal .ed-grp{display:inline-flex;align-items:center;gap:7px;padding-right:12px;border-right:1px solid #bcc6d1;min-height:30px;}
#editorModal .ed-grp:last-child{border-right:none;padding-right:0;}
/* [TOOLTIP] Temaya uygun özel tooltip (native 'title' yerine). Koyu, oklu, yumuşak giriş; body'ye eklenir. */
#ed-tip{position:fixed;z-index:3000;background:#1f2a37;color:#f2f6f9;font-size:12px;font-weight:600;line-height:1.38;padding:7px 11px;border-radius:9px;max-width:270px;box-shadow:0 8px 22px rgba(10,16,24,0.34);pointer-events:none;letter-spacing:.1px;white-space:normal;animation:edTipIn .12s ease;}
#ed-tip::after{content:'';position:absolute;left:var(--ok,50%);transform:translateX(-50%);border:6px solid transparent;}
#ed-tip[data-pos="alt"]::after{bottom:100%;border-bottom-color:#1f2a37;}
#ed-tip[data-pos="ust"]::after{top:100%;border-top-color:#1f2a37;}
@keyframes edTipIn{from{opacity:0;transform:translateY(-2px);}to{opacity:1;transform:translateY(0);}}
#editorModal .ed-panel label{display:flex;align-items:center;gap:5px;font-size:11px;color:#57606a;font-weight:600;}
#editorModal .ed-panel select,#editorModal .ed-panel input[type=number]{font-size:12px;padding:4px 6px;border:1px solid #d0d7de;border-radius:7px;color:#15202b;background:#fff;height:30px;box-sizing:border-box;}
#editorModal .ed-panel select:focus,#editorModal .ed-panel input:focus{outline:none;border-color:#1565c0;box-shadow:0 0 0 2px rgba(21,101,192,0.15);}
/* [SATIR ARALIĞI] Word benzeri açılır menü (sayılar + altında paragraf önce/sonra boşluk). */
#editorModal .ed-ls{position:relative;display:inline-flex;}
#editorModal .ed-ls-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:1px solid #d0d7de;border-radius:7px;background:#fff;color:#3a4654;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;}
#editorModal .ed-ls-btn:hover{background:#eef5ff;border-color:#9ec5f0;}
#editorModal .ed-ls-btn b{color:#15202b;}
#editorModal .ed-ls-ok{color:#8a94a0;font-size:10px;}
#editorModal .ed-ls-menu{position:absolute;top:34px;left:0;z-index:30;min-width:230px;background:#fff;border:1px solid #d0d7de;border-radius:10px;box-shadow:0 8px 24px rgba(16,24,40,0.16);padding:5px;}
#editorModal .ed-ls-opt{display:flex;align-items:center;gap:7px;width:100%;text-align:left;border:none;background:transparent;color:#334;font-size:12px;font-weight:600;padding:7px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;box-sizing:border-box;}
#editorModal .ed-ls-opt:hover{background:#eef5ff;}
#editorModal .ed-ls-tik{display:inline-flex;width:14px;justify-content:center;color:#1565c0;font-weight:800;}
#editorModal .ed-ls-sep{height:1px;background:#e3e8ee;margin:5px 4px;}
/* [SAYFA NO] Üst çubuk "Sayfa no" açılır menüsü (aç/kapa + konum + hizalama + biçim). */
#editorModal .ed-sn{position:relative;display:inline-flex;}
#editorModal .ed-sn-menu{position:absolute;top:36px;left:0;z-index:40;min-width:236px;background:#fff;border:1px solid #d0d7de;border-radius:11px;box-shadow:0 10px 30px rgba(16,24,40,0.2);padding:11px 12px;color:#15202b;text-align:left;}
#editorModal .ed-sn-on-row{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;color:#15202b;cursor:pointer;}
#editorModal .ed-sn-on-row input{width:15px;height:15px;cursor:pointer;}
#editorModal .ed-sn-sep{height:1px;background:#e3e8ee;margin:9px 0;}
#editorModal .ed-sn-grp{margin:9px 0;}
#editorModal .ed-sn-lbl{font-size:10px;font-weight:700;color:#8a94a0;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;}
#editorModal .ed-sn-opts{display:flex;gap:5px;flex-wrap:wrap;}
#editorModal .ed-sn-opt{border:1px solid #d7dde3;background:#fff;color:#3a4654;border-radius:7px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;transition:background .1s,border-color .1s;}
#editorModal .ed-sn-opt:hover{background:#eef5ff;border-color:#9ec5f0;}
#editorModal .ed-sn-opt.aktif{background:#1565c0;color:#fff;border-color:#1565c0;}
#editorModal .ed-sn-grp.pasif{opacity:.4;}
#editorModal .ed-panel input[type=color]{width:30px;height:30px;padding:0;border:1px solid #d0d7de;border-radius:7px;background:#fff;cursor:pointer;}
/* [BAĞLAM] Font'un solunda "şu an düzenlenen öğe" göstergesi (etiket) / başlık türü açılır menüsü. */
/* [ŞERİT SABİT HİZA] Etiket metni (Başlık/Link/Metin/Platform Adı) farklı genişlikte -> şerit kayıyordu.
   Sabit genişlik + ORTALI metin -> "Font" ve sonrası DAİMA aynı yatay konumda kalır, yalnız etiket değişir. */
#editorModal .ed-ctx{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;box-sizing:border-box;width:106px;flex:none;padding:0 10px;margin-right:4px;border:1px solid #cfe0f5;background:#eef5ff;border-radius:7px;font-size:13px;font-weight:700;color:#1565c0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#editorModal .ed-ctx-sel{font-weight:600;}
#editorModal .ed-ctx-sel .ed-ctx-ad{color:#57606a;font-weight:700;}
#editorModal .ed-ctx select{height:24px;padding:2px 4px;border:1px solid #cfe0f5;border-radius:6px;background:#fff;color:#15202b;font-size:12px;font-weight:600;cursor:pointer;}
#editorModal .ed-ctx select:focus{outline:none;border-color:#1565c0;box-shadow:0 0 0 2px rgba(21,101,192,0.15);}
#editorModal .ed-biu{display:inline-flex;gap:3px;padding:2px;background:#eaeef3;border-radius:8px;}
#editorModal .ed-tgl{position:relative;display:inline-flex;align-items:center;justify-content:center;width:30px;height:28px;border-radius:6px;cursor:pointer;color:#3a4654;transition:background .1s;}
#editorModal .ed-tgl input{position:absolute;opacity:0;width:0;height:0;margin:0;}
#editorModal .ed-tgl span{font-size:14px;line-height:1;}
#editorModal .ed-tgl-b span{font-weight:800;}
#editorModal .ed-tgl-i span{font-style:italic;font-family:Georgia,'Times New Roman',serif;}
#editorModal .ed-tgl-u span{text-decoration:underline;}
#editorModal .ed-tgl:hover{background:#d9e2ec;}
#editorModal .ed-tgl:has(input:checked){background:#1565c0;color:#fff;box-shadow:0 1px 2px rgba(21,101,192,0.4);}
/* İkon+METİN toggle (Link üstte / Başlıksız): numaralandırma gibi aç/kapa buton ama metinli. */
#editorModal .ed-tgl-metinli{width:auto;padding:0 11px;gap:6px;border:1px solid #d7dde3;background:#f6f8fa;}
#editorModal .ed-tgl-metinli span{font-size:11px;font-weight:600;line-height:1;}
#editorModal .ed-tgl-metinli:hover:not(:has(input:checked)){background:#eef5ff;}
#editorModal .ed-tgl-metinli:has(input:checked){background:#1565c0;border-color:#1565c0;color:#fff;}
#editorModal .ed-chk{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#57606a;font-weight:600;padding:5px 8px;border:1px solid #d7dde3;border-radius:7px;background:#fff;cursor:pointer;}
#editorModal .ed-chk:has(input:checked){background:#eef5ff;border-color:#9ec5f0;color:#1565c0;}
#editorModal .ed-chk input{cursor:pointer;}
#editorModal .ed-hiza{display:inline-flex;gap:3px;padding:2px;background:#eaeef3;border-radius:8px;}
#editorModal .ed-hb{display:inline-flex;align-items:center;justify-content:center;width:30px;height:28px;border:none;background:transparent;color:#3a4654;border-radius:6px;cursor:pointer;padding:0;transition:background .1s;}
#editorModal .ed-hb:hover{background:#d9e2ec;}
#editorModal .ed-hb.aktif{background:#1565c0;color:#fff;box-shadow:0 1px 2px rgba(21,101,192,0.4);}
#editorModal .ed-tgl-num svg,#editorModal .ed-hb svg,#editorModal .ed-tut svg,#editorModal .ed-kume-kalem svg{display:block;}
#editorModal .ed-root{padding:12px 18px 28px;color:#15202b;}
#editorModal .ed-plat{border-bottom:2px solid #d0d7de;padding-bottom:5px;margin:20px 0 10px;scroll-margin-top:118px;cursor:pointer;border-radius:5px;transition:background .1s;}
#editorModal .ed-plat:hover{background:rgba(21,101,192,0.06);}
#editorModal .ed-plat:first-child{margin-top:4px;}
#editorModal .ed-card{position:relative;background:#f6f8fa;border:1px solid #d0d7de;border-radius:12px;padding:14px 16px;margin:0 0 12px;scroll-margin-top:118px;}
/* [BÖLÜM SIRALA] kart sağ-üst kümesi: [▲ sıra-no ▼] + ✕ Sil */
#editorModal .ed-kart-ust{position:absolute;top:9px;right:12px;z-index:2;display:flex;align-items:center;gap:7px;}
#editorModal .ed-sira{display:inline-flex;align-items:center;gap:2px;background:#eef1f4;border:1px solid #dfe4ea;border-radius:8px;padding:2px;opacity:.22;transition:opacity .12s;}
#editorModal .ed-card:hover .ed-sira{opacity:.5;}
#editorModal .ed-sira:hover,#editorModal .ed-sira:focus-within{opacity:1;}
#editorModal .ed-sira-btn{width:20px;height:22px;border:none;background:transparent;color:#3a4654;border-radius:5px;cursor:pointer;font-size:9px;line-height:1;padding:0;display:inline-flex;align-items:center;justify-content:center;}
#editorModal .ed-sira-btn:hover:not([disabled]){background:#d9e2ec;}
#editorModal .ed-sira-btn[disabled]{opacity:.3;cursor:default;}
#editorModal .ed-sira-no{width:34px;height:22px;border:1px solid #cfd7df;border-radius:5px;text-align:center;font-size:12px;font-weight:600;color:#15202b;background:#fff;padding:0 2px;box-sizing:border-box;-moz-appearance:textfield;}
#editorModal .ed-sira-no::-webkit-outer-spin-button,#editorModal .ed-sira-no::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
#editorModal .ed-del{background:#e0245e;color:#fff;border:none;border-radius:7px;padding:4px 10px;font-size:12px;font-weight:600;cursor:pointer;}
#editorModal .ed-del:hover{background:#c81e4f;}
/* Başlık satırı: SOL OLUKTA kalem (+/⠿ ile aynı 26px sütun) + sağında başlık. Kalem başlıkla DİKEY
   ORTALI (align-items:center); başlık alt-boşluğu SATIRA taşındı (ed-h2 margin:0) -> kalem metnin tam
   ortasında (metin+margin değil). x-sütunu korunur (align-items yalnız dikey). */
#editorModal .ed-h2-row{display:flex;align-items:center;gap:8px;margin:0 0 6px;}
#editorModal .ed-kume-gutter{flex:none;width:26px;display:inline-flex;justify-content:center;}
#editorModal .ed-h2-sar{flex:1;min-width:0;display:flex;align-items:center;padding-right:160px;}   /* sağ-üst küme ([▲ no ▼] + ✕ Sil) yer */
#editorModal .ed-h2{display:inline-block;outline:none;border:1px dashed transparent;border-radius:6px;padding:2px 6px;margin:0;min-width:120px;flex:0 0 auto;max-width:100%;}
#editorModal .ed-h2:empty:before{content:"Başlık";color:#9aa3ad;font-weight:normal;}
#editorModal .ed-h2:hover{border-color:#c0c7cf;}
#editorModal .ed-h2:focus{border-color:#1DA1F2;background:rgba(29,161,242,0.08);}
#editorModal .ed-metin-ekle{display:block;width:fit-content;background:#fff;border:1px dashed #9ab;color:#1565c0;border-radius:7px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;margin:0 0 10px;}
#editorModal .ed-metin-ekle:hover{background:#eef5ff;}
#editorModal .ed-parca{display:flex;gap:8px;align-items:flex-start;margin:0 0 3px;border-top:2px solid transparent;border-bottom:2px solid transparent;}
#editorModal .ed-parca.ed-ust{border-top-color:#1DA1F2;}
#editorModal .ed-parca.ed-alt{border-bottom-color:#1DA1F2;}
#editorModal .ed-parca.ed-suruk{opacity:.45;}
/* [titreme önleme] Taşıma tutamağı (⠿) da "+" gibi: hep yerinde, soluk; kart üstüne hafif, üstüne gelince opak. */
#editorModal .ed-tut{flex:none;width:26px;padding:4px 0;display:inline-flex;align-items:center;justify-content:center;cursor:grab;user-select:none;color:#8a94a0;font-size:15px;line-height:1;border:1px solid transparent;border-radius:6px;background:transparent;opacity:.3;transition:opacity .12s,background .12s,color .12s,border-color .12s;}   /* sabit 26px sütun -> "+" ile hizalı */
#editorModal .ed-card:hover .ed-tut{opacity:.6;}
#editorModal .ed-card:hover .ed-tut:hover,#editorModal .ed-tut:active{opacity:1;}
#editorModal .ed-tut:hover{opacity:1;background:#eef5ff;color:#1565c0;border-color:#9ec5f0;}
#editorModal .ed-tut:active{cursor:grabbing;}
#editorModal .ed-parca-ic{flex:1;min-width:0;}
#editorModal .ed-parca-bos{color:#9aa3ad;font-size:12px;font-style:italic;padding:4px 0;}
/* Başlık ikon butonları (✕/Kaydet/İndir/Geri/İleri): dinlenmede TEK gri renk, hover'da semantik renk
   CANLANIR, pasif (geri/ileri alınacak yokken) SİLİK. SVG currentColor ile renk alır. */
#editorModal .ed-ikon-btn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:none;background:transparent;color:#9aa4b0;border-radius:8px;cursor:pointer;transition:color .12s,background .12s,opacity .12s;}
#editorModal .ed-ikon-btn:hover:not(:disabled){background:#eef2f6;}
#editorModal .ed-ikon-btn:disabled{opacity:.3;cursor:default;}
/* [RAPOR ADI] Üst çubukta (galeri butonunun solunda) tek-tıkla düzenlenen rapor adı. Koyu başlıkta açık metin. */
#editorModal .ed-rapor-adi{background:transparent;border:1px solid transparent;border-radius:8px;color:var(--text-primary,#e7edf3);font-size:14px;font-weight:600;text-align:right;padding:6px 10px;min-width:150px;max-width:300px;margin-right:8px;outline:none;transition:background .12s,border-color .12s;box-sizing:border-box;}
#editorModal .ed-rapor-adi::placeholder{color:var(--text-secondary,#8899a6);font-weight:500;}
#editorModal .ed-rapor-adi:hover{background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.14);}
#editorModal .ed-rapor-adi:focus{background:rgba(255,255,255,0.11);border-color:#1d9bf0;}
#editorModal .ed-ik-nav:hover:not(:disabled),#editorModal .ed-ik-indir:hover:not(:disabled){color:#1565c0;}
#editorModal .ed-ik-galeri:hover:not(:disabled){color:#1565c0;}
#editorModal .ed-ik-galeri.aktif{color:#1d9bf0;background:#e8f4fd;}
/* Galeri / Sırala görünümü — bölüm kartları ızgarası + sürükle-bırak (araya ekle / üste bırak=yer değiştir) */
#editorModal .ed-gal-ipucu{font-size:12px;color:#5b6b7b;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:9px 13px;margin:0 0 16px;line-height:1.5;}
#editorModal .ed-gal-ipucu b{color:#1d4a6b;}
#editorModal .ed-gal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:16px;padding-bottom:24px;}
#editorModal .ed-gal-card{position:relative;background:#fff;border:1px solid #dfe4ea;border-radius:11px;padding:11px;padding-top:36px;cursor:grab;transition:box-shadow .12s,border-color .12s,transform .12s;user-select:none;}
#editorModal .ed-gal-card:hover{box-shadow:0 4px 14px rgba(0,0,0,.10);transform:translateY(-1px);}
#editorModal .ed-gal-card:active{cursor:grabbing;}
#editorModal .ed-gal-card.suruklenen{opacity:.35;}
#editorModal .ed-gal-card.swap-hedef{border-color:#f7931e;box-shadow:0 0 0 2px #f7931e;}
#editorModal .ed-gal-card.ekle-sol::before,#editorModal .ed-gal-card.ekle-sag::after{content:'';position:absolute;top:4px;bottom:4px;width:4px;border-radius:3px;background:#1d9bf0;box-shadow:0 0 6px rgba(29,155,240,.6);}
#editorModal .ed-gal-card.ekle-sol::before{left:-10px;}
#editorModal .ed-gal-card.ekle-sag::after{right:-10px;}
#editorModal .ed-gal-no{position:absolute;top:9px;left:9px;min-width:21px;height:21px;padding:0 6px;border-radius:11px;background:#1d9bf0;color:#fff;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;z-index:2;box-shadow:0 1px 3px rgba(0,0,0,.2);}
#editorModal .ed-gal-bas{font-weight:700;font-size:12px;line-height:1.3;color:#15202b;margin:0 0 9px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
#editorModal .ed-gal-bassiz{color:#94a3b8;font-weight:500;font-style:italic;}
#editorModal .ed-gal-img{border-radius:7px;overflow:hidden;border:1px solid #eef1f4;background:#f8fafc;}
#editorModal .ed-gal-img img{display:block;width:100%;max-height:130px;object-fit:cover;pointer-events:none;}
#editorModal .ed-gal-imgyok{height:58px;display:flex;align-items:center;justify-content:center;color:#b6c0cb;font-size:11px;border-style:dashed;}
#editorModal .ed-gal-metin{font-size:11px;color:#64748b;line-height:1.5;margin-top:7px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
#editorModal .ed-ik-kapat:hover:not(:disabled){color:#e0245e;}
#editorModal .ed-img-pano{min-height:90px;border:2px dashed #9ab;border-radius:10px;display:flex;align-items:center;justify-content:center;text-align:center;color:#57606a;font-size:13px;background:#f7fafd;cursor:text;outline:none;padding:12px;}
#editorModal .ed-img-pano:focus{border-color:#1565c0;background:#eef5ff;}
#editorModal .ed-img-pano .ed-img-pcsec{display:inline-flex;align-items:center;gap:4px;margin-left:12px;background:#1565c0;color:#fff;border:none;border-radius:7px;padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap;}
#editorModal .ed-img-pano .ed-img-pcsec:hover{background:#0d47a1;}
#editorModal .ed-img{max-width:100%;max-height:380px;border-radius:8px;display:block;object-fit:contain;}
#editorModal .ed-metin{outline:none;border:1px dashed #d0d7de;border-radius:6px;padding:5px 8px;min-height:20px;background:#fff;}
#editorModal .ed-metin:empty:before{content:"Metin yazın…";color:#9aa3ad;}
#editorModal .ed-metin:focus{border-color:#1DA1F2;border-style:solid;background:rgba(29,161,242,0.04);}
#editorModal .ed-metin a{color:#1565c0;text-decoration:underline;cursor:text;}   /* [SATIR-İÇİ LİNK] editörde link görünümü; düzenleme için cursor text */
#editorModal .ed-tur{flex:none;display:none;align-self:flex-start;font-size:11px;padding:3px 5px;border:1px solid #d0d7de;border-radius:6px;background:#fff;color:#334;cursor:pointer;}
#editorModal .ed-parca:hover .ed-tur{display:inline-block;}
/* "Başka bölüme taşı": büyük açılır kutu yerine başlığın sağında KALEM ikonu + açılır menü. */
#editorModal .ed-kume-wrap{vertical-align:middle;}
/* [titreme önleme] kalem hep yerinde, soluk; kart üstüne gelince hafif, buton üstünde tam opak. Küçültüldü. */
#editorModal .ed-kume-kalem{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:1px solid transparent;background:transparent;color:#8a94a0;border-radius:6px;cursor:pointer;padding:0;opacity:.3;transition:opacity .12s,color .12s,background .12s,border-color .12s;}
#editorModal .ed-card:hover .ed-kume-kalem{opacity:.6;}
#editorModal .ed-card:hover .ed-kume-kalem:hover,#editorModal .ed-pz-wrap.acik .ed-kume-kalem{opacity:1;}
#editorModal .ed-kume-kalem:hover,#editorModal .ed-pz-wrap.acik .ed-kume-kalem{color:#1565c0;background:#eef5ff;border-color:#9ec5f0;}
#editorModal .ed-kume-satir{margin:0 0 8px;}
#editorModal .ed-kume-menu{min-width:180px;max-height:300px;overflow:auto;}
#editorModal .ed-kume-opt{text-align:left;font-size:12px;font-weight:600;color:#334;background:transparent;border:none;border-radius:6px;padding:7px 10px;cursor:pointer;width:100%;white-space:nowrap;}
#editorModal .ed-kume-opt:hover{background:#eef5ff;color:#1565c0;}
#editorModal .ed-metin-sil{flex:none;width:26px;height:26px;border:1px solid #d0d7de;background:#fff;color:#e0245e;border-radius:6px;font-size:16px;line-height:1;cursor:pointer;}
#editorModal .ed-metin-sil:hover{background:#ffeef0;}
#editorModal .ed-link{display:block;font-size:12px;color:#1565c0;word-break:break-all;text-decoration:none;}
#editorModal .ed-link:hover{text-decoration:underline;}
#editorModal .ed-link-edit{outline:none;border:1px dashed #d0d7de;border-radius:6px;padding:4px 8px;min-height:18px;background:#fff;cursor:text;}
#editorModal .ed-link-edit:empty:before{content:"Bağlantı URL'si…";color:#9aa3ad;}
#editorModal .ed-link-edit:focus{border-color:#1565c0;border-style:solid;background:rgba(21,101,192,0.05);}
#editorModal .ed-ustswap{margin-left:6px;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#334;cursor:pointer;user-select:none;padding:2px 8px;border:1px solid #d0d7de;border-radius:16px;background:#f6f8fa;}
#editorModal .ed-ustswap input{width:16px;height:16px;cursor:pointer;accent-color:#1DA1F2;}
#editorModal .ed-line{border:0;border-top:2px solid #d0d7de;margin:2px 0 18px;}
#editorModal .ed-ekle-zon{display:flex;justify-content:flex-start;align-items:center;min-height:18px;margin:0 0 4px;}
/* [titreme önleme] "+ Bölüm" hep yerinde + çok saydam; bölge üstüne gelince hafif, buton üstünde tam opak. */
#editorModal .ed-bolum-ekle{display:inline-block;font-size:11px;font-weight:700;color:#1565c0;background:#eef5ff;border:1px dashed #9ab;border-radius:13px;padding:3px 10px;cursor:pointer;opacity:.2;transition:opacity .12s,background .12s,color .12s;}
#editorModal .ed-ekle-zon:hover .ed-bolum-ekle{opacity:.55;}
#editorModal .ed-ekle-zon:hover .ed-bolum-ekle:hover,#editorModal .ed-ekle-zon.hep .ed-bolum-ekle{opacity:1;}
#editorModal .ed-ekle-zon.hep{justify-content:center;margin:10px 0;}
#editorModal .ed-ekle-zon.hep .ed-bolum-ekle{font-size:13px;padding:8px 22px;opacity:1;}
#editorModal .ed-bolum-ekle:hover{background:#1565c0;color:#fff;}
#editorModal .ed-pe-wrap{position:relative;display:inline-block;margin:0 0 10px;}
#editorModal .ed-pe-btn{font-size:12px;font-weight:600;color:#1565c0;background:#fff;border:1px dashed #9ab;border-radius:7px;padding:5px 12px;cursor:pointer;}
#editorModal .ed-pe-wrap:hover .ed-pe-btn{background:#eef5ff;}
#editorModal .ed-pe-menu{display:none;position:absolute;top:100%;left:0;z-index:6;background:#fff;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,0.14);padding:4px;flex-direction:column;min-width:130px;}
#editorModal .ed-pe-wrap:hover .ed-pe-menu{display:flex;}
#editorModal .ed-pe{text-align:left;font-size:12px;font-weight:600;color:#334;background:transparent;border:none;border-radius:6px;padding:7px 10px;cursor:pointer;}
#editorModal .ed-pe:hover{background:#eef5ff;color:#1565c0;}
#editorModal .ed-pz{display:flex;justify-content:flex-start;min-height:2px;margin:-1px 0;}   /* öğeler arası boşluğu daralt */
#editorModal .ed-pz-wrap{position:relative;display:inline-flex;}
#editorModal .ed-pz>.ed-pz-wrap{width:26px;justify-content:center;}   /* "+" sabit 26px sol sütun -> ⠿ ile aynı merkez (hizalı) */
/* [titreme önleme] display yerine OPACITY: işaret HEP yerinde durur (yerleşim kaymaz) -> mouse gezince
   titremez. Varsayılan çok saydam; bölge üstüne gelince hafif, butonun üstüne gelince tam opak. Küçültüldü. */
#editorModal .ed-pz-art{display:inline-flex;width:15px;height:15px;border-radius:50%;border:1px solid #9ab;background:#eef5ff;color:#1565c0;font-size:11px;font-weight:700;line-height:1;cursor:pointer;padding:0;align-items:center;justify-content:center;opacity:.18;transition:opacity .12s,background .12s,color .12s;}
#editorModal .ed-pz:hover .ed-pz-art{opacity:.5;}
#editorModal .ed-pz:hover .ed-pz-art:hover,#editorModal .ed-pz-wrap.acik .ed-pz-art{opacity:1;}
#editorModal .ed-pz-wrap.acik .ed-pz-art{background:#1565c0;color:#fff;}
#editorModal .ed-pz-menu{display:none;position:absolute;top:100%;left:0;margin-top:2px;z-index:7;background:#fff;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,0.16);padding:4px;flex-direction:column;min-width:130px;}
#editorModal .ed-pz-wrap.acik .ed-pz-menu{display:flex;}
#editorModal .ed-ekle-zon.ed-drop{min-height:30px;background:#eef5ff;border:2px dashed #1565c0;border-radius:8px;margin:4px 0;}
#editorModal .ed-card-man{border-style:dashed;}
#editorModal .ed-kltut{display:inline-block;margin:0 0 8px;font-size:11px;font-weight:600;color:#1565c0;background:#eef5ff;border:1px solid #c0c7cf;border-radius:12px;padding:3px 9px;cursor:grab;user-select:none;}
#editorModal .ed-kltut:active{cursor:grabbing;}
/* [SAĞ-TIK BİÇİM PANELİ] başlık (tüm başlık) + metin seçimi (satır-içi). */
#ed-rt-panel{position:fixed;display:none;z-index:3200;min-width:230px;background:#fff;border:1px solid #cfd7df;border-radius:10px;padding:8px;box-shadow:0 8px 28px rgba(16,24,40,0.22);font-size:12px;color:#1f2b38;}
#ed-rt-panel .rt-title{font-size:11px;font-weight:700;color:#1565c0;margin:0 2px 7px;padding-bottom:5px;border-bottom:1px solid #eef1f4;}
#ed-rt-panel .rt-row{display:flex;align-items:center;gap:7px;margin:5px 2px;font-size:11px;color:#57606a;font-weight:600;}
#ed-rt-panel label.rt-row,#ed-rt-panel .rt-row label{display:flex;align-items:center;gap:5px;}
#ed-rt-panel select,#ed-rt-panel input[type=number]{font-size:12px;padding:3px 5px;border:1px solid #d0d7de;border-radius:6px;color:#15202b;background:#fff;height:28px;box-sizing:border-box;}
#ed-rt-panel select{max-width:150px;}
#ed-rt-panel input[type=color]{width:28px;height:28px;padding:0;border:1px solid #d0d7de;border-radius:6px;background:#fff;cursor:pointer;}
#ed-rt-panel .rt-biu,#ed-rt-panel .rt-hiza{gap:3px;background:#eef1f4;border-radius:7px;padding:3px;display:inline-flex;}
#ed-rt-panel .rt-tgl,#ed-rt-panel .rt-hb{width:30px;height:27px;border:none;background:transparent;color:#3a4654;border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:14px;line-height:1;padding:0;}
#ed-rt-panel .rt-tgl:hover,#ed-rt-panel .rt-hb:hover{background:#d9e2ec;}
#ed-rt-panel .rt-tgl.aktif,#ed-rt-panel .rt-hb.aktif{background:#1565c0;color:#fff;}
#ed-rt-panel .rt-tgl b{font-weight:800;} #ed-rt-panel .rt-tgl i{font-style:italic;font-family:Georgia,serif;} #ed-rt-panel .rt-tgl u{text-decoration:underline;}
#ed-rt-panel .rt-reset{width:100%;border:1px solid #d7dde3;background:#f6f8fa;color:#3a4654;border-radius:7px;padding:6px 8px;font-size:11px;font-weight:600;cursor:pointer;}
#ed-rt-panel .rt-reset:hover{background:#fdecef;border-color:#f3b6c4;color:#c81e4f;}
#ed-rt-panel .rt-reset:disabled{opacity:.45;cursor:default;}
#ed-rt-panel .rt-reset:disabled:hover{background:#f6f8fa;border-color:#d7dde3;color:#3a4654;}
#ed-rt-panel .rt-reset.rt-linksil{display:inline-flex;align-items:center;justify-content:center;gap:6px;color:#1565c0;}
#ed-rt-panel .rt-reset.rt-linksil:hover{background:#fdecef;border-color:#f3b6c4;color:#c81e4f;}
#ed-rt-panel .rt-linkrow{display:flex;align-items:center;gap:6px;}
#ed-rt-panel .rt-linkurl{flex:1;min-width:0;font-size:12px;padding:5px 7px;border:1px solid #d0d7de;border-radius:6px;color:#15202b;background:#fff;height:28px;box-sizing:border-box;}
#ed-rt-panel .rt-linkyap{flex:none;width:34px;height:28px;border:1px solid #cfe0f5;background:#eef5ff;color:#1565c0;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;}
#ed-rt-panel .rt-linkyap:hover{background:#1565c0;color:#fff;border-color:#1565c0;}
#editorModal .ed-bos{padding:28px;text-align:center;color:#57606a;font-size:14px;}
/* [LIGHTBOX] Görsele çift tık -> tam ekran: görsel contain (ekrana sığar), boşluklar aynı görselin blur dolgusu. X/ESC/arka-plan kapatır. */
#ed-lightbox{position:fixed;inset:0;z-index:5000;display:none;align-items:center;justify-content:center;overflow:hidden;background:#05070b;cursor:zoom-out;}
#ed-lightbox.acik{display:flex;animation:edLbIn .16s ease;}
#ed-lightbox .ed-lb-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(30px) brightness(.5);transform:scale(1.12);pointer-events:none;}
#ed-lightbox .ed-lb-img{position:relative;max-width:94vw;max-height:92vh;object-fit:contain;border-radius:8px;box-shadow:0 14px 50px rgba(0,0,0,0.6);cursor:default;}
#ed-lightbox .ed-lb-kapat{position:fixed;top:16px;right:18px;z-index:2;width:40px;height:40px;border:none;border-radius:50%;background:rgba(0,0,0,0.5);color:#fff;font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);transition:background .12s;}
#ed-lightbox .ed-lb-kapat:hover{background:rgba(0,0,0,0.78);}
@keyframes edLbIn{from{opacity:0;}to{opacity:1;}}

/* ================= [DARK TEMA] Editör karanlık tema (app dark iken; body.light-theme'de orijinal açık CSS kalır) ================= */
body:not(.light-theme) #editorModal.modal{background:#0f1621;}
body:not(.light-theme) #editorModal .preview-body{background:#0f1621;scrollbar-color:#3a4a5c #17212e;}
body:not(.light-theme) #editorModal .preview-body::-webkit-scrollbar-track{background:#17212e;}
body:not(.light-theme) #editorModal .preview-body::-webkit-scrollbar-thumb{background:#3a4a5c;border-color:#17212e;}
body:not(.light-theme) #editorModal .preview-body::-webkit-scrollbar-thumb:hover{background:#4a5c70;border-color:#17212e;}
body:not(.light-theme) #editorModal .ed-serit{background:linear-gradient(#17212e,#141d28);border-bottom-color:#2c3a4a;box-shadow:0 1px 4px rgba(0,0,0,0.3);}
body:not(.light-theme) #editorModal .ed-root{color:#e7e9ea;}
body:not(.light-theme) #editorModal .ed-panel label{color:#9aa6b2;}
body:not(.light-theme) #editorModal .ed-panel select,body:not(.light-theme) #editorModal .ed-panel input[type=number],body:not(.light-theme) #editorModal .ed-panel input[type=color],body:not(.light-theme) #editorModal .ed-ctx select,body:not(.light-theme) #editorModal .ed-sira-no,body:not(.light-theme) #editorModal .ed-metin-sil,body:not(.light-theme) #editorModal .ed-tur{background:#1b2735;color:#e7e9ea;border-color:#2c3a4a;}
body:not(.light-theme) #editorModal .ed-ls-btn,body:not(.light-theme) #editorModal .ed-sn-opt,body:not(.light-theme) #editorModal .ed-tab{background:#1b2735;color:#c5cfda;border-color:#2c3a4a;}
body:not(.light-theme) #editorModal .ed-ls-btn b{color:#e7e9ea;}
body:not(.light-theme) #editorModal .ed-ls-menu,body:not(.light-theme) #editorModal .ed-sn-menu,body:not(.light-theme) #editorModal .ed-pz-menu,body:not(.light-theme) #editorModal .ed-pe-menu,body:not(.light-theme) #ed-rt-panel{background:#17212e;border-color:#2c3a4a;color:#e7e9ea;box-shadow:0 10px 30px rgba(0,0,0,0.55);}
body:not(.light-theme) #editorModal .ed-ls-opt,body:not(.light-theme) #editorModal .ed-pe,body:not(.light-theme) #editorModal .ed-kume-opt{color:#c5cfda;}
body:not(.light-theme) #editorModal .ed-ls-opt:hover,body:not(.light-theme) #editorModal .ed-pe:hover,body:not(.light-theme) #editorModal .ed-kume-opt:hover,body:not(.light-theme) #editorModal .ed-sn-opt:hover,body:not(.light-theme) #editorModal .ed-ls-btn:hover,body:not(.light-theme) #editorModal .ed-tab:hover{background:#1e3650;border-color:#2f5f8a;color:#e7e9ea;}
body:not(.light-theme) #editorModal .ed-ls-sep,body:not(.light-theme) #editorModal .ed-sn-sep{background:#2c3a4a;}
body:not(.light-theme) #editorModal .ed-sn-lbl,body:not(.light-theme) #editorModal .ed-ls-ok{color:#8a97a5;}
body:not(.light-theme) #editorModal .ed-biu,body:not(.light-theme) #editorModal .ed-hiza{background:#222d3a;}
body:not(.light-theme) #editorModal .ed-tgl,body:not(.light-theme) #editorModal .ed-hb,body:not(.light-theme) #editorModal .ed-sira-btn{color:#c5cfda;}
body:not(.light-theme) #editorModal .ed-tgl:hover,body:not(.light-theme) #editorModal .ed-hb:hover,body:not(.light-theme) #editorModal .ed-sira-btn:hover:not([disabled]){background:#2f3e4e;}
body:not(.light-theme) #editorModal .ed-tgl-metinli,body:not(.light-theme) #editorModal .ed-chk,body:not(.light-theme) #editorModal .ed-ustswap{background:#1b2735;border-color:#2c3a4a;color:#c5cfda;}
body:not(.light-theme) #editorModal .ed-tgl-metinli:hover:not(:has(input:checked)){background:#1e3650;}
body:not(.light-theme) #editorModal .ed-sira{background:#222d3a;border-color:#2c3a4a;}
body:not(.light-theme) #editorModal .ed-ctx{background:#14314a;border-color:#2f5f8a;color:#6fb4ef;}
body:not(.light-theme) #editorModal .ed-ctx select{background:#1b2735;color:#e7e9ea;border-color:#2f5f8a;}
body:not(.light-theme) #editorModal .ed-grp{border-right-color:#2c3a4a;}
body:not(.light-theme) #editorModal .ed-card{background:#17212e;border-color:#2c3a4a;}
body:not(.light-theme) #editorModal .ed-plat{border-bottom-color:#2c3a4a;}
body:not(.light-theme) #editorModal .ed-plat:hover{background:rgba(29,155,240,0.1);}
body:not(.light-theme) #editorModal .ed-metin,body:not(.light-theme) #editorModal .ed-link-edit{background:#121b26;border-color:#2c3a4a;color:#e7e9ea;}
body:not(.light-theme) #editorModal .ed-metin:focus,body:not(.light-theme) #editorModal .ed-link-edit:focus{background:rgba(29,161,242,0.08);border-color:#1d9bf0;}
body:not(.light-theme) #editorModal .ed-metin a,body:not(.light-theme) #editorModal .ed-link{color:#4ea3ec;}
/* [DARK METİN RENGİ] Dark editörde SİYAH seçilen metin OKUNUR (açık) görünsün; Word ÇIKTISI gerçek rengi (siyah) kullanır
   -> yalnız EKRAN. İnline renk (stilCss color:#000000 + color picker rgb(0,0,0)) CSS'i yener; bu yüzden !important + siyah hedefli. */
body:not(.light-theme) #editorModal .ed-root [style*="color:#000000"],
body:not(.light-theme) #editorModal .ed-root [style*="color: rgb(0, 0, 0)"],
body:not(.light-theme) #editorModal .ed-root [style*="color:rgb(0, 0, 0)"],
body:not(.light-theme) #editorModal .ed-root [style*="color:rgb(0,0,0)"],
body:not(.light-theme) #editorModal .ed-root [style*="color: black"],
body:not(.light-theme) #editorModal .ed-root [style*="color:black"]{color:#e7e9ea !important;}
body:not(.light-theme) #editorModal .ed-h2:hover{border-color:#3a4a5c;}
body:not(.light-theme) #editorModal .ed-h2:focus{background:rgba(29,161,242,0.1);}
body:not(.light-theme) #editorModal .ed-h2:empty:before,body:not(.light-theme) #editorModal .ed-metin:empty:before,body:not(.light-theme) #editorModal .ed-link-edit:empty:before,body:not(.light-theme) #editorModal .ed-parca-bos{color:#6b7785;}
body:not(.light-theme) #editorModal .ed-img-pano{background:#15202d;border-color:#3a4a5c;color:#9aa6b2;}
body:not(.light-theme) #editorModal .ed-img-pano:focus{background:#1e3650;border-color:#1d9bf0;}
body:not(.light-theme) #editorModal .ed-metin-ekle,body:not(.light-theme) #editorModal .ed-pe-btn{background:#1b2735;color:#4ea3ec;border-color:#3a4a5c;}
body:not(.light-theme) #editorModal .ed-metin-ekle:hover,body:not(.light-theme) #editorModal .ed-pe-wrap:hover .ed-pe-btn{background:#1e3650;}
body:not(.light-theme) #editorModal .ed-metin-sil:hover{background:#3a1f28;}
body:not(.light-theme) #editorModal .ed-line{border-top-color:#2c3a4a;}
body:not(.light-theme) #editorModal .ed-ikon-btn:hover:not(:disabled){background:#222d3a;}
body:not(.light-theme) #editorModal .ed-tut:hover{background:#1e3650;color:#6fb4ef;border-color:#2f5f8a;}
body:not(.light-theme) #editorModal .ed-kume-kalem:hover,body:not(.light-theme) #editorModal .ed-pz-wrap.acik .ed-kume-kalem{color:#6fb4ef;background:#1e3650;border-color:#2f5f8a;}
body:not(.light-theme) #editorModal .ed-bolum-ekle,body:not(.light-theme) #editorModal .ed-pz-art,body:not(.light-theme) #editorModal .ed-kltut{background:#17314a;color:#6fb4ef;border-color:#2f5f8a;}
body:not(.light-theme) #editorModal .ed-ekle-zon.ed-drop{background:#17314a;border-color:#1d9bf0;}
body:not(.light-theme) #editorModal .ed-gal-card{background:#17212e;border-color:#2c3a4a;}
body:not(.light-theme) #editorModal .ed-gal-card:hover{box-shadow:0 4px 14px rgba(0,0,0,.4);}
body:not(.light-theme) #editorModal .ed-gal-bas{color:#e7e9ea;}
body:not(.light-theme) #editorModal .ed-gal-metin{color:#9aa6b2;}
body:not(.light-theme) #editorModal .ed-gal-img{background:#15202d;border-color:#2c3a4a;}
body:not(.light-theme) #editorModal .ed-gal-ipucu{background:#15202d;border-color:#2c3a4a;color:#9aa6b2;}
body:not(.light-theme) #editorModal .ed-gal-ipucu b{color:#6fb4ef;}
body:not(.light-theme) #editorModal .ed-ik-galeri.aktif{background:#15314a;}
body:not(.light-theme) #editorModal .ed-bos{color:#9aa6b2;}
body:not(.light-theme) #ed-rt-panel .rt-row{color:#9aa6b2;}
body:not(.light-theme) #ed-rt-panel .rt-title{border-bottom-color:#2c3a4a;}
body:not(.light-theme) #ed-rt-panel select,body:not(.light-theme) #ed-rt-panel input[type=number],body:not(.light-theme) #ed-rt-panel input[type=color],body:not(.light-theme) #ed-rt-panel .rt-linkurl{background:#1b2735;color:#e7e9ea;border-color:#2c3a4a;}
body:not(.light-theme) #ed-rt-panel .rt-biu,body:not(.light-theme) #ed-rt-panel .rt-hiza{background:#222d3a;}
body:not(.light-theme) #ed-rt-panel .rt-tgl,body:not(.light-theme) #ed-rt-panel .rt-hb{color:#c5cfda;}
body:not(.light-theme) #ed-rt-panel .rt-tgl:hover,body:not(.light-theme) #ed-rt-panel .rt-hb:hover{background:#2f3e4e;}
body:not(.light-theme) #ed-rt-panel .rt-reset{background:#1b2735;color:#c5cfda;border-color:#2c3a4a;}
body:not(.light-theme) #ed-rt-panel .rt-reset:hover{background:#3a1f28;border-color:#7a3a4a;color:#f08ca0;}
body:not(.light-theme) #ed-rt-panel .rt-linkyap{background:#17314a;border-color:#2f5f8a;color:#6fb4ef;}
`;
  function stilEnjekte(){ if(document.getElementById('x-editor-style')) return; var st=document.createElement('style'); st.id='x-editor-style'; st.textContent=CSS; (document.head||document.documentElement).appendChild(st); }

  function stilCss(o, pre){
    var f=o[pre+'_font']||'', s=o[pre+'_size']||'', c=o[pre+'_color']||'', al=o[pre+'_align']||'left';
    var css="";
    if(f) css+="font-family:'"+f+"',sans-serif;";
    if(s) css+="font-size:"+(parseInt(s,10)||12)+"pt;";
    if(c) css+="color:"+c+";";
    css+="font-weight:"+(o[pre+'_bold']?'700':'400')+";";
    css+="font-style:"+(o[pre+'_italic']?'italic':'normal')+";";
    css+="text-decoration:"+(o[pre+'_underline']?'underline':'none')+";";
    var jc={left:'left',center:'center',right:'right',both:'justify'}[al]||'left';
    css+="text-align:"+jc+";";
    return css;
  }
  // [BAŞLIK OVERRIDE] Bayrak x_h_ov='0' -> başlık-başına override kapalı (rol varsayılanı; eski davranış).
  function hOvAcik(){ try{ return localStorage.getItem('x_h_ov')!=='0'; }catch(e){ return true; } }
  var WORD_GECERLI_ED={Normal:1,Heading1:1,Heading2:1,Heading3:1,Heading4:1};
  // Rol varsayılan stili (b/b1 global) ÜZERİNE başlık-başına override (ov) birleşmiş CSS döndürür.
  // ov alanları: font,size(pt),color(#hex),bold,italic,underline,align. Yoksa stilCss ile birebir aynı.
  function stilCssOv(o, pre, ov){
    if(!hOvAcik() || !ov) return stilCss(o, pre);
    var f=(ov.font!=null?ov.font:o[pre+'_font'])||'', s=(ov.size!=null?ov.size:o[pre+'_size'])||'';
    var c=(ov.color!=null?ov.color:o[pre+'_color'])||'', al=(ov.align!=null?ov.align:o[pre+'_align'])||'left';
    var bold=(ov.bold!=null?ov.bold:o[pre+'_bold']), ital=(ov.italic!=null?ov.italic:o[pre+'_italic']), und=(ov.underline!=null?ov.underline:o[pre+'_underline']);
    var css="";
    if(f) css+="font-family:'"+f+"',sans-serif;";
    if(s) css+="font-size:"+(parseInt(s,10)||12)+"pt;";
    if(c) css+="color:"+c+";";
    css+="font-weight:"+(bold?'700':'400')+";";
    css+="font-style:"+(ital?'italic':'normal')+";";
    css+="text-decoration:"+(und?'underline':'none')+";";
    var jc={left:'left',center:'center',right:'right',both:'justify'}[al]||'left';
    css+="text-align:"+jc+";";
    return css;
  }

  // Faz 6: genel "link üstte" tercihi (localStorage). Kapalı: görsel üstte/link altta (varsayılan).
  function linkUstteFlag(){ try{ return localStorage.getItem('x_link_ustte')==='1'; }catch(e){ return false; } }
  function linkUstteSet(v){ try{ localStorage.setItem('x_link_ustte', v?'1':'0'); }catch(e){} }
  function parcaKur(item){
    if(item.parcalar && item.parcalar.length) return;
    var linkUst=linkUstteFlag();
    var pc=[]; var mb=item.metin_bloklari||[];
    mb.forEach(function(m){ if(m && m.konum==='ust') pc.push({tur:'metin', id:yeniId(), metin:m.metin||''}); });
    if(linkUst && linkGoster(item)) pc.push({tur:'link'});   // tik açık: link görselin üstünde
    if(item.image_b64) pc.push({tur:'gorsel'});
    mb.forEach(function(m){ if(m && m.konum!=='ust') pc.push({tur:'metin', id:yeniId(), metin:m.metin||''}); });
    if(!linkUst && linkGoster(item)) pc.push({tur:'link'});  // normal: link görselin altında
    item.parcalar=pc;
  }
  // [ÇOKLU GÖRSEL] Editör karşılığı (x-local-docx.js'teki birimGorselleri ikizi): her 'gorsel' parçasının
  // efektif görseli. Parçanın kendi b64'ü yoksa YALNIZ ilk görsel parçası öğenin birincil image_b64'üne düşer.
  // Bayrak x_coklu_gorsel='0' -> part.b64 yok sayılır (eski tek-görsel). Dönen: {parçaIndeksi: {b64,mime}}.
  function cokluGorselAcik(){ try{ return localStorage.getItem('x_coklu_gorsel')!=='0'; }catch(e){ return true; } }
  // [GÖRSEL HİZA] görsel hizalama özelliği açık mı (global g_align + görsel-başına sağ-tık). '0' -> kapalı (daima sola).
  function gorselHizaAcik(){ try{ return localStorage.getItem('x_gorsel_hiza')!=='0'; }catch(e){ return true; } }
  // [GÖRSEL HİZA] bir görsel parçasının efektif hizalaması: parça override -> genel g_align -> left. Bayrak kapalı -> left.
  function gorselEfHiza(pAlign, o){ if(!gorselHizaAcik()) return 'left'; var a=pAlign||((o&&o.g_align)||'left'); return (a==='center'||a==='right')?a:'left'; }
  function grupAd(key){ for(var _gi=0;_gi<GRUPLAR.length;_gi++){ if(GRUPLAR[_gi].key===key) return GRUPLAR[_gi].ad; } return ''; }
  function edGorselHarita(item){
    var map={}, usedPrimary=false, pc=(item&&item.parcalar)||[], k, coklu=cokluGorselAcik();
    // Birincil görsel (item.image_b64) bir parçaya PİNLİ ise (part.b64===image_b64) fallback'i TEKRAR
    // uygulama (yoksa üste eklenen boş kutu birincili "çalar"). bkz. gorselSlot pinleme.
    if(coklu && item && item.image_b64){ for(k=0;k<pc.length;k++){ if(pc[k] && pc[k].tur==='gorsel' && pc[k].b64===item.image_b64){ usedPrimary=true; break; } } }
    for(k=0;k<pc.length;k++){ if(!pc[k] || pc[k].tur!=='gorsel') continue;
      var b64=(coklu && pc[k].b64)?pc[k].b64:'', mime=(coklu && pc[k].mime)?pc[k].mime:'';
      if(!b64 && !usedPrimary && item.image_b64){ b64=item.image_b64; mime=item.image_mime||'image/jpeg'; usedPrimary=true; }
      map[k]={b64:b64, mime:mime||'image/jpeg', align:(pc[k].align||'')};   // [GÖRSEL HİZA]
    }
    return map;
  }
  // Faz 6: tik değişince TÜM kartlarda görsel/link parçalarının yerini tercihe göre takasla (metinler yerinde kalır).
  XE._linkUstteUygula = function(on){
    XE._pushUndo();
    XE._dirty=true;   // [4]: "Link üstte" tercihi de kirletir
    // Yalnız LİNK parçasını taşı: üstte->en başa, altta->en sona. Görsel ve ARADAKİ METİN kendi
    // sıralarını KORUR (eski "görsel<->link takası" metni de yukarı atıyordu -> kullanıcı: saçma).
    (XE.belge.birimler||[]).forEach(function(b, bi){
      if(!b || !b.item || !b.item.parcalar) return;
      var pc=b.item.parcalar, gi=-1, li=-1, x;
      for(x=0;x<pc.length;x++){ if(pc[x].tur==='gorsel' && gi<0) gi=x; else if(pc[x].tur==='link' && li<0) li=x; }
      if(li<0) return;                              // link yoksa dokunma
      if(gi>=0){                                    // görselli bölüm: link'i görsele göre konumla (eski davranış)
        var linkOnce=(li<gi);
        if(on && !linkOnce){ var el=pc.splice(li,1)[0]; pc.unshift(el); XE._ovSet(bi); }       // link üstte: en başa
        else if(!on && linkOnce){ var el2=pc.splice(li,1)[0]; pc.push(el2); XE._ovSet(bi); }    // link altta: en sona
      } else {                                      // görsel YOK (manuel/boş bölüm): link'i doğrudan başa/sona taşı
        if(on && li!==0){ var el3=pc.splice(li,1)[0]; pc.unshift(el3); XE._ovSet(bi); }         // link üstte: en başa
        else if(!on && li!==pc.length-1){ var el4=pc.splice(li,1)[0]; pc.push(el4); XE._ovSet(bi); }   // link altta: en sona
      }
    });
    XE._ciz();
  };

  // Faz 5: editör çalışma durumu (parcalar + düzenlenen başlık) panel-düzeyi bir overlay'de yaşar.
  // manual_add yalnız 5 alan taşıdığı için parcalar havuzdan geçmez; overlay bu köprüdür:
  // editör her değişiklikte YAZAR, açılışta OKUR, panel kaydet/aç bunu snapshot'a taşır/geri yükler.
  function ovKey(link){ try{ return (window.XLocalImages && window.XLocalImages.normLink) ? window.XLocalImages.normLink(link||'') : String(link||''); }catch(e){ return String(link||''); } }
  function ovStore(){ window.__xEditorOverlay = window.__xEditorOverlay || { byLink:{}, style:null }; if(!window.__xEditorOverlay.byLink) window.__xEditorOverlay.byLink={}; return window.__xEditorOverlay; }
  XE._ovSet = function(bi){ var b=XE.belge.birimler[bi]; if(!b||!b.item) return; XE._dirty=true; try{ window.__xPoolDirty=true; }catch(e){}  /* [EŞLEŞME] havuz görünümü bir sonraki poll'da yeniden çizilsin (editör düzenlemesi yansısın) */ if(b.item.manual && !edManual(b.item.link)) return;  /* YALNIZ eski (link='') manuel bloklar overlay dışı; birleşik xmanual:// öğeler overlay'e YAZILIR (B3) */ try{ ovStore().byLink[ovKey(b.item.link)] = { parcalar: JSON.parse(JSON.stringify(b.item.parcalar||[])), h2:(b.item.h2_override!=null?String(b.item.h2_override):null), grup:(b.item.group_override!=null?String(b.item.group_override):null), h1over:(b.item.h1_override!=null?String(b.item.h1_override):null), h1ov:(b.item.h1_ov?JSON.parse(JSON.stringify(b.item.h1_ov)):null), h2ov:(b.item.h2_ov?JSON.parse(JSON.stringify(b.item.h2_ov)):null) }; }catch(e){} };

  var GRUPLAR=[
    {key:'b1', ad:'Platform Adı', ids:{font:'b1_font',size:'b1_size',color:'b1_color',bold:'b1_bold',italic:'b1_italic',underline:'b1_underline',align:'b1_align',wordstyle:'b1_wordstyle'}},
    {key:'b',  ad:'Başlık', ids:{font:'b_font',size:'b_size',color:'b_color',bold:'b_bold',italic:'b_italic',underline:'b_underline',align:'b_align',numbered:'b_numbered',basliksiz:'b_basliksiz',wordstyle:'b_wordstyle'}},
    {key:'l',  ad:'Link',     ids:{font:'l_font',size:'l_size',color:'l_color',bold:'l_bold',italic:'l_italic',underline:'l_underline',align:'l_align'}},
    {key:'m',  ad:'Metin',    ids:{font:'m_font',size:'m_size',color:'m_color',bold:'m_bold',italic:'m_italic',underline:'m_underline',align:'m_align'}}
  ];
  var _rt=null;
  function canliCiz(){ if(_rt) clearTimeout(_rt); _rt=setTimeout(function(){ XE._ciz(); }, 160); }

  XE.planGetir = async function(items, stil){
    if(!window.XLocalDocx || !window.XLocalDocx.generateBlob) throw new Error('x-local-docx.js yüklü değil');
    var opts = Object.assign({ __planOnly: true }, stil||{});
    return await window.XLocalDocx.generateBlob(opts, items||null);
  };

  XE.ac = async function(opts){
    opts = opts||{};
    try{ window.__xEdAcCalisiyor = true; }catch(e){}   // poll canlı-yenilemesi bununla çakışmasın
    stilEnjekte();
    var m=document.getElementById('editorModal'); if(m) m.classList.add('active');
    _dragScrollKur();   // Faz 7: sürükleme kenar-otomatik-kaydırmasını bağla (bir kez)
    _sagTikKur();       // SAĞ-TIK biçim paneli: başlık (tüm başlık) + metin seçimi (satır-içi) (bir kez)
    _klavyeKur();       // geri/ileri klavye kısayolları (bir kez)
    _raporAdiKur();     // [RAPOR ADI] üst çubuk inline ad alanı: dinleyiciler (bir kez) + mevcut adla doldur
    _tooltipKur();      // [TOOLTIP] temaya uygun özel tooltip sistemi (bir kez)
    _lightboxKur();     // [LIGHTBOX] görsele çift tık -> tam ekran görüntüleyici (bir kez)
    _tamEkranKur();     // [TAM EKRAN] fullscreen dinleyici + ikon durumu
    // [scroll zıplamasını önle]: taze açılış DEĞİLSE (ekle/sil/taşı/yeniden-plan) mevcut scroll'u sakla
    // -> _ciz re-render sonrası geri koyar (araya bölüm ekleyince "en üste atma" hissi gitsin).
    if(!opts.fresh){ var _pb0=document.querySelector('#editorModal .preview-body'); _savedScroll = _pb0 ? _pb0.scrollTop : null; }
    else { _savedScroll = null; }
    // [titreme/refresh önleme] "Yükleniyor…" boş flaşını YALNIZ taze açılışta (veya içerik boşken) göster.
    // Ekle/sil/taşı/yeniden-plan'da eski içerik EKRANDA KALSIN; _ciz hazır olunca tek seferde değiştirir ->
    // sunucu re-fetch'i sürerken ekran boşalmaz, "refresh" hissi gitmez.
    var root=document.getElementById('editor-root'); if(root && (opts.fresh || !root.querySelector('.ed-root'))) root.innerHTML='<div class="ed-bos">Yükleniyor…</div>';
    try {
      var stil=stilOku();
      var plan=await XE.planGetir(opts.items||null, stil);
      XE.belge={ stil:stil, birimler:(plan&&plan.birimler)||[], multiPlatform:!!(plan&&plan.multiPlatform) };
      XE.belge.birimler.forEach(function(b,i){
        if(!b.item) return;
        if(!b.item.uid) b.item.uid=((b.item.link||'oge'))+'#'+i;
        parcaKur(b.item);
        // Faz 5/6: overlay'de bu link için parçalar/başlık-override varsa geri yükle.
        // Başlık override YALNIZ başlık taşıyan birime (b.h2!=null) uygulanır -> ikincil gönderilere
        // sahte başlık basılmaz ve plandaki numara/sezgi değeri ham title ile EZİLMEZ (Faz 5 gerilemesi).
        var ov=ovStore().byLink[ovKey(b.item.link)];
        if(ov){ if(ov.parcalar && ov.parcalar.length) b.item.parcalar=JSON.parse(JSON.stringify(ov.parcalar)); if(ov.h2!=null && b.h2!=null){ b.item.h2_override=ov.h2; b.h2=ov.h2; } if(ov.grup!=null){ b.item.group_override=ov.grup; } if(ov.h1over!=null){ b.item.h1_override=ov.h1over; if(b.h1!=null) b.h1=ov.h1over; } if(ov.h1ov){ b.item.h1_ov=ov.h1ov; b.h1ov=ov.h1ov; } if(ov.h2ov){ b.item.h2_ov=ov.h2ov; b.h2ov=ov.h2ov; } }   // [9]: küme taşıma + [PLATFORM BAŞLIĞI METNİ] h1over + [BAŞLIK STİL OVERRIDE] h1ov/h2ov geri yükle
      });
      XE._manuelEkle();   // #2: manuel blokları (kümeler arası eklenen) konumlarına enjekte et
      // [1]: DIŞ MOD tespiti — hiçbir öğe .index taşımıyorsa (Word Düzenle providedItems) havuz-tabanlı
      // snapshot işe yaramaz; snapshot belge item'larını tutar, restore ac({items}) ile replay eder.
      XE._externalMode = ((XE.belge.birimler||[]).length>0) && !(XE.belge.birimler||[]).some(function(b){ return b.item && b.item.index!=null; });
      XE._seritKur();
      if(opts.fresh){ XE._galeriModu=false; }   // taze açılış -> normal (düzenleme) modda başla (galeri'de takılı kalma)
      // GÖRÜNÜM DAĞITIMI: galeri modundaysa kart ızgarası, değilse normal editör. Şerit galeri modunda gizli.
      var _serit=document.getElementById('editor-serit'); if(_serit){ _serit.style.display = XE._galeriModu ? 'none' : ''; }
      var _gbtn=document.querySelector('#editorModal .ed-ik-galeri'); if(_gbtn){ if(XE._galeriModu){ _gbtn.classList.add('aktif'); } else { _gbtn.classList.remove('aktif'); } }
      if(XE._galeriModu && XE._galeriCiz){ XE._galeriCiz(); } else { XE._ciz(); }
      if(opts.fresh){ XE._dirty=false; XE._geriSifirla(); }   // FIX-DIRTY + geçmiş: yalnız GERÇEK taze açılışta sıfırla (yeniden-plan/ekle/sil/geri-al DEĞİL)
      _geriBtnGuncelle();
      if(opts.scrollIndex!=null) setTimeout(function(){ XE._kaydir(opts.scrollIndex); }, 60);
    } catch(e){ if(root) root.innerHTML='<div class="ed-bos" style="color:#e0245e">Editör yüklenemedi: '+esc(e&&e.message||e)+'</div>'; }
    finally { try{ window.__xEdAcCalisiyor = false; }catch(e){} }
  };

  // ✕ ile kapat: SORMADAN kapat (kullanıcı isteği). Havuz "Kaydet" artık temizlemediği için çıkınca
  // hiçbir şey kaybolmaz (havuz + overlay panelde durur); kaydetmek isteyen "💾 Kaydet"i kullanır.
  XE.kapat = function(){ var m=document.getElementById('editorModal'); if(m) m.classList.remove('active'); XE._dirty=false; };
  // D3: editör "💾 Kaydet" -> panel snapshot rutinini (havuz+overlay) çağırır; indirmez. Başarıda kapatır.
  XE.kaydet = async function(){
    try{
      // Faz 2: oto-kayıt AÇIKsa editör "Kaydet" = anında flush (ad sorMA, havuz temizleME, kapatMA).
      var _otoAcik = (typeof window.xOtoKayitAcik==='function') ? window.xOtoKayitAcik()
                   : (function(){ try{ return localStorage.getItem('x_oto_kayit')!=='0'; }catch(e){ return true; } })();
      if(_otoAcik){
        XE._dirty=false;
        if(typeof window.xOtoKayitFlush==='function'){ await window.xOtoKayitFlush(); }
        else if(typeof window.xOtoKayitYap==='function'){ await window.xOtoKayitYap(); }
        if(window.showToast) window.showToast('Kaydedildi (otomatik).','success');
        return true;
      }
      // --- Eski model (oto-kayıt KAPALI): ad sor -> snapshot -> havuz sıfırla -> kapat ---
      if(typeof window.xSnapshotReport!=='function'){ if(window.showToast) window.showToast('Kaydetme kullanılamıyor.','danger'); return false; }
      var def = (window.__openReportName && String(window.__openReportName).trim()) ? window.__openReportName
              : ((typeof window.xTarihSaatDamgasi==='function') ? window.xTarihSaatDamgasi() : 'Rapor');
      var name = (typeof window.xPrompt==='function')
               ? await window.xPrompt('Rapor için bir ad girin:', def, { title:'💾 Kaydet', okText:'Kaydet' })
               : def;
      if(name===null) return false;                  // iptal
      name=(String(name||'').trim())||def;
      var ok = await window.xSnapshotReport(name);
      if(ok){ XE._dirty=false; XE.kapat(); if(window.showToast) window.showToast('Kaydedildi: '+name+' (havuz sıfırlandı)','success'); }   // [Kaydet = COMMIT] havuz sıfırlandı → editör kapanır
      return ok;
    }catch(e){ if(window.showToast) window.showToast('Kaydedilemedi: '+(e&&e.message||e),'danger'); return false; }
  };

  XE._seritKur = function(){
    var host=document.getElementById('editor-serit'); if(!host) return;
    // [sekmeler GİZLİ] Stil sekmeleri (Platform Adı/İçerik Başlığı/Link/Metin) kaldırıldı; şerit artık
    // editörde TIKLANAN öğeye göre otomatik ilgili grubun kontrollerini gösterir (_seritSekme:
    // platform->b1, başlık->b, metin->m, link->l). "Link üstte" aşağıya, kontrollerin yanına ikon-toggle
    // olarak taşındı (_panelCiz). Etiketsiz sade.
    host.innerHTML='<div class="ed-panel" id="ed-panel"></div>';
    if(!XE._aktifGrup) XE._aktifGrup='b';
    XE._panelCiz(XE._aktifGrup);
  };
  // Düzenlenen ögeye göre şerit otomatik geçsin (platform->b1, başlık->b, metin->m, link->l). Sekme YOK.
  XE._seritSekme = function(key){ XE._seritSekmeCtx(key, null); };
  // [BAĞLAM] Şeridi değiştir + "hangi öğe" bağlamını güncelle (Font solundaki gösterge/başlık-türü menüsü için).
  // ctx: {kind:'h2'|'plat'|'metin'|'link', bi:<birim indeksi>}. Grup aynı olsa bile bağlam (ör. farklı başlık)
  // değişebilir -> paneli yine çiz (hafif; yalnız şerit DOM'u, editör gövdesi/odağı etkilenmez).
  XE._seritSekmeCtx = function(key, ctx){
    XE._aktifBaglam = ctx || null;
    XE._aktifGrup = key; XE._panelCiz(key);
  };
  // [BAŞLIK OVERRIDE] Bir başlığa (rol: 'h1'=platform / 'h2'=içerik) tekil biçim uygula. prop: font/size/
  // color/bold/italic/underline/align/word. val boş -> o özelliğin override'ı kalkar; nesne boşalırsa override
  // tümden silinir (rol varsayılanına döner). Canlı önizleme YERİNDE yapılır (full _ciz YOK -> popover kararlı).
  XE._hOvSec = function(bi, rol, prop, val){
    if(!hOvAcik()) return;   // bayrak kapalı -> override YAZMA (snapshot'a sızmasın; airtight geri alma)
    var b=XE.belge.birimler[bi]; if(!b||!b.item) return;
    XE._pushUndo();
    var ik=(rol==='h1')?'h1_ov':'h2_ov', bk=(rol==='h1')?'h1ov':'h2ov';
    var ov=b.item[ik]?JSON.parse(JSON.stringify(b.item[ik])):{};
    if(val==null || val===''){ delete ov[prop]; } else { ov[prop]=val; }
    var bos=true,k; for(k in ov){ if(ov.hasOwnProperty(k)){ bos=false; break; } }
    if(bos){ try{ delete b.item[ik]; }catch(e){ b.item[ik]=null; } b[bk]=null; } else { b.item[ik]=ov; b[bk]=ov; }
    XE._ovSet(bi); XE._dirty=true;
    _hBaslikStilYansit(bi, rol);   // başlık öğesinin stilini yerinde güncelle (word hariç görünür)
  };
  // Bir başlığın TÜM override'ını temizle (rol varsayılanına dön).
  XE._hOvSifirla = function(bi, rol){
    if(!hOvAcik()) return;
    var b=XE.belge.birimler[bi]; if(!b||!b.item) return;
    XE._pushUndo();
    try{ delete b.item[rol==='h1'?'h1_ov':'h2_ov']; }catch(e){ b.item[rol==='h1'?'h1_ov':'h2_ov']=null; }
    b[rol==='h1'?'h1ov':'h2ov']=null;
    XE._ovSet(bi); XE._dirty=true; _hBaslikStilYansit(bi, rol);
  };
  // Başlık öğesinin inline stilini efektif (rol varsayılanı + override) değere set et (canlı önizleme).
  function _hBaslikStilYansit(bi, rol){
    var b=XE.belge.birimler[bi]; if(!b) return; var o=stilOku();
    var sel=(rol==='h1')?'.ed-plat[data-i="'+bi+'"]':'.ed-h2[data-i="'+bi+'"]';
    var el=document.querySelector('#editor-root '+sel); if(!el) return;
    el.setAttribute('style', stilCssOv(o, (rol==='h1'?'b1':'b'), (rol==='h1'?b.h1ov:b.h2ov)));
    if(rol==='h2'){ var sar=el.closest('.ed-h2-sar'); if(sar){ var al=((b.h2ov&&b.h2ov.align)||o.b_align); sar.style.justifyContent=({left:'flex-start',center:'center',right:'flex-end',both:'flex-start'}[al]||'flex-start'); } }
  }
  XE._panelCiz = function(key){
    var g=null,i; for(i=0;i<GRUPLAR.length;i++){ if(GRUPLAR[i].key===key){ g=GRUPLAR[i]; break; } }
    var panel=document.getElementById('ed-panel'); if(!g||!panel) return;
    var ids=g.ids;
    function val(id){ var e=document.getElementById(id); return e?(e.type==='checkbox'?e.checked:e.value):''; }
    function nhex(c){ c=(c||'').trim(); return /^#[0-9a-fA-F]{6}$/.test(c)?c:'#000000'; }
    // [#2 ŞERİT SENKRONU] Başlık odaklıysa kontrollerin GÖSTERİM değeri = o başlığın EFEKTİF stili (genel +
    // o başlığa özel sağ-tık override'ı). Düzenleme YİNE GENEL'e yazar (o türdeki tüm başlıklar; override'lar
    // korunur) -> hval YALNIZ gösterim. Metin/Link'te (başlık değil) genel değere düşer.
    var _ctxB=XE._aktifBaglam||{};
    var _hBi=((_ctxB.kind==='h2'||_ctxB.kind==='plat') && _ctxB.bi!=null && XE.belge.birimler[_ctxB.bi]) ? _ctxB.bi : null;
    var _hRol=(_ctxB.kind==='plat')?'h1':'h2';
    function hval(prop, id){ if(_hBi!=null){ try{ return _rtEff(_hBi,_hRol,prop); }catch(e){} } return val(id); }
    var fontOpts=(document.getElementById('b_font')||{}).innerHTML||'';
    var h='';
    // [BAĞLAM] Font'un solunda "şu an hangi öğe düzenleniyor" göstergesi (okunur etiket; tür seçtirmez).
    // Tekil (o başlığa özel) biçim için başlığa SAĞ TIKLANIR -> _hOvPanel.
    var _ctx=XE._aktifBaglam||{};
    var _ctxAd=(_ctx.kind==='plat')?'Platform Adı':(_ctx.kind==='metin')?'Metin':(_ctx.kind==='link')?'Link':(_ctx.kind==='h2')?'Başlık':grupAd(key);
    // [ŞERİT GRUPLARI] Word gibi: Bağlam (ctx) ayrı; sonra Yazı Tipi | Paragraf | Başlık | Belge grupları ayraçlı (.ed-grp).
    var _gBaglam='<span class="ed-ctx" title="Şu an düzenlenen öğenin genel ayarları. Tek bir başlığı ayrı biçimlemek için başlığa sağ tıkla.">'+esc(_ctxAd)+'</span>';
    // --- Yazı Tipi: Font + Boyut + Renk + B/I/U ---
    var _gYazi='';
    _gYazi+='<label>Font <select data-t="'+ids.font+'">'+fontOpts+'</select></label>';
    _gYazi+='<label>Boyut <input type="number" data-t="'+ids.size+'" min="6" max="48" value="'+esc(hval('size',ids.size))+'" style="width:52px"></label>';
    _gYazi+='<label>Renk <input type="color" data-t="'+ids.color+'" value="'+nhex(hval('color',ids.color))+'"></label>';
    _gYazi+='<span class="ed-biu">';
    _gYazi+='<label class="ed-tgl ed-tgl-b" title="Kalın"><input type="checkbox" data-t="'+ids.bold+'" '+(hval('bold',ids.bold)?'checked':'')+'><span>B</span></label>';
    _gYazi+='<label class="ed-tgl ed-tgl-i" title="Eğik"><input type="checkbox" data-t="'+ids.italic+'" '+(hval('italic',ids.italic)?'checked':'')+'><span>I</span></label>';
    _gYazi+='<label class="ed-tgl ed-tgl-u" title="Altı çizili"><input type="checkbox" data-t="'+ids.underline+'" '+(hval('underline',ids.underline)?'checked':'')+'><span>U</span></label>';
    _gYazi+='</span>';
    // --- Paragraf: hizalama + (metin: satır aralığı) + (başlık: numaralandırma) ---
    var _hv=hval('align',ids.align)||'left';
    var _gPar='<span class="ed-hiza">';
    _gPar+='<button class="ed-hb'+(_hv==='left'?' aktif':'')+'" data-a="'+ids.align+'" data-v="left" title="Sola"><svg viewBox="0 0 16 16" width="14" height="14"><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"><path d="M2 4h12"/><path d="M2 8h8"/><path d="M2 12h10"/></g></svg></button>';
    _gPar+='<button class="ed-hb'+(_hv==='center'?' aktif':'')+'" data-a="'+ids.align+'" data-v="center" title="Ortaya"><svg viewBox="0 0 16 16" width="14" height="14"><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"><path d="M2 4h12"/><path d="M4 8h8"/><path d="M3 12h10"/></g></svg></button>';
    _gPar+='<button class="ed-hb'+(_hv==='right'?' aktif':'')+'" data-a="'+ids.align+'" data-v="right" title="Sağa"><svg viewBox="0 0 16 16" width="14" height="14"><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"><path d="M2 4h12"/><path d="M6 8h8"/><path d="M4 12h10"/></g></svg></button>';
    _gPar+='<button class="ed-hb'+(_hv==='both'?' aktif':'')+'" data-a="'+ids.align+'" data-v="both" title="İki yana"><svg viewBox="0 0 16 16" width="14" height="14"><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"><path d="M2 4h12"/><path d="M2 8h12"/><path d="M2 12h12"/></g></svg></button>';
    _gPar+='</span>';
    // [SATIR ARALIĞI] YALNIZ Metin grubunda: satır aralığı + paragraf önce/sonra boşluk (Word çıktısı). Bayrak x_satir_aralik='0' gizler.
    var _saAcikEd=true; try{ _saAcikEd=(localStorage.getItem('x_satir_aralik')!=='0'); }catch(e){}
    if(key==='m' && _saAcikEd){
      var _mL=val('m_line')||'1.0', _mB=!!val('m_space_before'), _mA=!!val('m_space_after');
      var _lsEt={'1.0':'1,0','1.15':'1,15','1.5':'1,5','2.0':'2,0','2.5':'2,5','3.0':'3,0'};
      var _lsIco='<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 4h3"/><path d="M2 8h3"/><path d="M2 12h3"/><path d="M8 3.5h6"/><path d="M8 7h6"/><path d="M8 10.5h6"/></svg>';
      _gPar+='<div class="ed-ls">';
      _gPar+='<button type="button" class="ed-ls-btn" title="Satır aralığı ve paragraf boşluğu (yalnız Word çıktısı)">'+_lsIco+' Satır aralığı: <b>'+(_lsEt[_mL]||_mL)+'</b> <span class="ed-ls-ok">▾</span></button>';
      _gPar+='<div class="ed-ls-menu" style="display:none">';
      ['1.0','1.15','1.5','2.0','2.5','3.0'].forEach(function(v){ _gPar+='<button type="button" class="ed-ls-opt" data-ls="'+v+'"><span class="ed-ls-tik">'+(v===_mL?'✓':'')+'</span>'+_lsEt[v]+'</button>'; });
      _gPar+='<div class="ed-ls-sep"></div>';
      _gPar+='<button type="button" class="ed-ls-opt" data-tgl="before"><span class="ed-ls-tik">'+(_mB?'✓':'')+'</span>Paragraftan önce boşluk ekle</button>';
      _gPar+='<button type="button" class="ed-ls-opt" data-tgl="after"><span class="ed-ls-tik">'+(_mA?'✓':'')+'</span>Paragraftan sonra boşluk ekle</button>';
      _gPar+='</div></div>';
    }
    if(ids.numbered) _gPar+='<label class="ed-tgl ed-tgl-num" title="Otomatik numaralandır (1. 2. 3.)"><input type="checkbox" data-t="'+ids.numbered+'" '+(val(ids.numbered)?'checked':'')+'><svg viewBox="0 0 16 16" width="15" height="15"><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6.5 4h8"/><path d="M6.5 8.5h8"/><path d="M6.5 13h8"/></g><g fill="currentColor" font-size="4.6" font-family="sans-serif"><text x="0.5" y="5.6">1</text><text x="0.5" y="10.1">2</text><text x="0.5" y="14.6">3</text></g></svg></label>';
    // --- Başlık: (içerik başlığı: Alt boşluk) + Stil(düzey) + Başlıksız ---
    var _gBaslik='';
    if(key==='b') _gBaslik+='<label title="Başlık ile altındaki paragraf arası boşluk (pt; yalnız Word çıktısı)">Alt boşluk <input type="number" data-t="b_after" min="0" max="72" value="'+esc(val('b_after')||'6')+'" style="width:50px">pt</label>';
    if(ids.wordstyle) _gBaslik+='<label title="Word başlık düzeyi (bu türdeki tüm başlıklar). Tek başlık için başlığa sağ tıkla.">Stil <select data-t="'+ids.wordstyle+'"><option value="Heading1">Başlık 1</option><option value="Heading2">Başlık 2</option><option value="Heading3">Başlık 3</option><option value="Heading4">Başlık 4</option><option value="Normal">Normal</option></select></label>';
    if(ids.basliksiz) _gBaslik+='<label class="ed-tgl ed-tgl-metinli" title="İşaretliyse bu grubun içerik başlığı Word çıktısında basılmaz."><input type="checkbox" data-t="'+ids.basliksiz+'" '+(val(ids.basliksiz)?'checked':'')+'><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 4.5h7"/><path d="M2.5 8h5"/><path d="M12.8 3.3l-9.5 9.5"/></svg><span>Başlıksız</span></label>';
    // --- Belge (çıktı): Link üstte + Sayfa no ---
    var _gBelge='';
    _gBelge+='<label class="ed-tgl ed-tgl-metinli" title="Link üstte: link görselin ÜSTÜNDE (kapalı: görsel üstte, link altta)"><input type="checkbox" id="ed-link-ust" '+(linkUstteFlag()?'checked':'')+'><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 3.6h11" stroke-linecap="round"/><rect x="2.5" y="6.2" width="11" height="7" rx="1.3"/></svg><span>Link üstte</span></label>';
    _gBelge+='<div class="ed-sn"><button type="button" id="ed-sayfano-btn" class="ed-ls-btn" title="Sayfa numarası (yalnız Word çıktısı)"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 2.5L4.7 13.5"/><path d="M11.8 2.5L10.5 13.5"/><path d="M3.3 6h10"/><path d="M2.5 10h10"/></svg> Sayfa no <span class="ed-ls-ok">▾</span></button><div id="ed-sayfano-menu" class="ed-sn-menu" style="display:none"></div></div>';
    function _grp(inner){ return inner ? ('<span class="ed-grp">'+inner+'</span>') : ''; }
    h += _gBaglam + _grp(_gYazi) + _grp(_gPar) + _grp(_gBaslik) + _grp(_gBelge);
    panel.innerHTML=h;
    var fs=panel.querySelector('select[data-t="'+ids.font+'"]'); if(fs) fs.value=hval('font',ids.font);
    var _lsel=panel.querySelector('select[data-t="m_line"]'); if(_lsel) _lsel.value=val('m_line')||'1.0';   // [SATIR ARALIĞI] mevcut değeri göster
    if(ids.wordstyle){ var ws=panel.querySelector('select[data-t="'+ids.wordstyle+'"]'); if(ws){ var _wv=hval('word',ids.wordstyle); ws.value=WORD_GECERLI_ED[_wv]?_wv:(key==='b1'?'Heading1':'Heading2'); } }   // başlık odaklıysa efektif düzey; değilse genel
    panel.querySelectorAll('[data-t]').forEach(function(ctrl){
      var ev=(ctrl.tagName==='SELECT'||ctrl.type==='checkbox')?'change':'input';   // [RENK ANLIK] color da 'input' -> seçerken uygulanır
      // [4]: stil kontrolüne ODAKLANINCA ön-anlık al, değişince TEK adım işle (sayı girişinde her tuşta
      // yığını taşırma). Eski çift 'input' bağlaması (number) KALDIRILDI (ev zaten 'input').
      ctrl.addEventListener('focus', function(){ XE._alanOdak(); });
      ctrl.addEventListener(ev, function(){ XE._stilUygula(ctrl); });
    });
    // Hizalama ikon butonları (Word gibi): tıklanınca ilgili hiza girdisini set eder + canlı yansıtır.
    panel.querySelectorAll('.ed-hb').forEach(function(btn){
      btn.addEventListener('click', function(){ XE._hizaSec(btn.getAttribute('data-a'), btn.getAttribute('data-v')); });
    });
    // "Link üstte" ikon-toggle (global): değişince tüm kartlarda link konumunu uygular.
    var _lu=panel.querySelector('#ed-link-ust'); if(_lu) _lu.addEventListener('change', function(){ linkUstteSet(_lu.checked); XE._linkUstteUygula(_lu.checked); });
    // [SAYFA NO] Şeritteki "Sayfa no" butonu: tıkla aç/kapa (menü _sayfaNoMenuCiz ile dolar). Her grup render'ında yeniden bağlanır.
    var _snBtn=panel.querySelector('#ed-sayfano-btn');
    if(_snBtn){ _snBtn.addEventListener('click', function(e){ e.stopPropagation(); var m=document.getElementById('ed-sayfano-menu'); if(!m) return; if(m.style.display!=='block'){ _sayfaNoMenuCiz(); m.style.display='block'; } else { m.style.display='none'; } }); }
    if(!window.__edSnClose){ window.__edSnClose=true; document.addEventListener('mousedown', function(e){ var m=document.getElementById('ed-sayfano-menu'); if(m && m.style.display==='block' && !(e.target.closest && e.target.closest('.ed-sn'))) m.style.display='none'; }); }
    // [SATIR ARALIĞI] Word-benzeri açılır menü: butona tıkla aç/kapa; seçenekler satır aralığı / paragraf boşluğu.
    var _lsWrap=panel.querySelector('.ed-ls');
    if(_lsWrap){
      var _lsBtn=_lsWrap.querySelector('.ed-ls-btn'), _lsMenu=_lsWrap.querySelector('.ed-ls-menu');
      _lsBtn.addEventListener('click', function(e){ e.stopPropagation(); _lsMenu.style.display=(_lsMenu.style.display==='none')?'block':'none'; });
      _lsWrap.querySelectorAll('.ed-ls-opt').forEach(function(b){ b.addEventListener('click', function(e){ e.stopPropagation();
        if(b.hasAttribute('data-ls')) XE._satirAralikUygula('line', b.getAttribute('data-ls'));
        else XE._satirAralikUygula(b.getAttribute('data-tgl'), null);
      }); });
    }
    // dışarı tıklayınca menüyü kapat (bir kez bağla)
    if(!window.__edLsCloseKur){ window.__edLsCloseKur=true; document.addEventListener('mousedown', function(e){ var o=document.querySelector('#editorModal .ed-ls-menu'); if(o && o.style.display!=='none' && !(e.target.closest && e.target.closest('.ed-ls'))) o.style.display='none'; }); }
  };
  // [SATIR ARALIĞI] Menüden satır aralığı/paragraf boşluğu uygula (gizli backing input + kaydet + per-rapor). Panel tazelenir (etiket/tik).
  XE._satirAralikUygula = function(prop, v){
    XE._pushUndo();
    if(prop==='line'){ var el=document.getElementById('m_line'); if(el) el.value=v; }
    else { var id=(prop==='before')?'m_space_before':'m_space_after'; var el2=document.getElementById(id); if(el2) el2.checked=!el2.checked; }
    if(typeof window.xSaveStyles==='function'){ try{ window.xSaveStyles(); }catch(_){} }
    try{ window.__xPoolDirty=true; }catch(_){}
    XE._dirty=true;
    XE._panelCiz(XE._aktifGrup);   // etiket + ✓ tazele (menü kapanır — Word gibi)
  };
  XE._hizaSec = function(inputId, v){
    XE._pushUndo();
    var el=document.getElementById(inputId); if(el){ el.value=v; }
    if(typeof window.xSaveStyles==='function') try{ window.xSaveStyles(); }catch(e){}
    var grp=document.querySelector('.ed-hiza'); if(grp){ grp.querySelectorAll('.ed-hb').forEach(function(b){ b.classList.toggle('aktif', b.getAttribute('data-v')===v); }); }
    XE._dirty=true;   // [4]: biçim değişikliği de kirletir -> kapanışta sorulur
    canliCiz();
  };
  // Yapısal stiller (numara/başlıksız/başlık-türü) h2'yi PLAN anında belirler -> canlı yansısın diye
  // YENİDEN PLANLA; CSS stilleri (font/renk/hiza) hızlı _ciz yolunda kalır.
  var STRUKT_STIL = { b_numbered:1, b_basliksiz:1 };
  XE._stilUygula = function(ctrl){
    var id=ctrl.getAttribute('data-t'); var tgt=document.getElementById(id); if(!tgt) return;
    XE._alanGiris();   // [4]: odakta alınan ön-anlığı TEK sefer işle (her tuşta yığını taşırma)
    if(tgt.type==='checkbox') tgt.checked=ctrl.checked; else tgt.value=ctrl.value;
    if(typeof window.xSaveStyles==='function') try { window.xSaveStyles(); } catch(e){}
    XE._dirty=true;   // [4]: stil/yapısal (font/renk/Başlıksız/Numara) değişikliği de kirletir
    try{ window.__xPoolDirty=true; }catch(e){}   // [STANDART STİL] stil değişimi oto-kayıtı tetikler -> raporun editorStyle'ına yazılır (per-rapor)
    if(STRUKT_STIL[id]){ XE._yenidenPlanla(); } else { canliCiz(); }
  };
  // Mevcut belge öğeleriyle planı yeniden kur (havuzu YENİDEN ÇEKMEZ; parçalar/override overlay'den korunur).
  XE._yenidenPlanla = function(){ try { XE.ac({ items: XE.toItems() }); } catch(e){} };
  // #4: Bir parçanın TÜRÜNÜ değiştir (Metin <-> Link; veya "Başlık yap").
  XE._turDegistir = function(i, pk, tur){
    var b=XE.belge.birimler[i]; if(!b||!b.item||!b.item.parcalar) return;
    var p=b.item.parcalar[pk]; if(!p) return;
    XE._pushUndo();
    var metin=(p.tur==='metin') ? (p.metin||'') : (p.tur==='link') ? ((p.url!=null&&p.url!=='')?p.url:(b.item.link||'')) : '';
    if(tur==='metin'){ b.item.parcalar[pk]={tur:'metin', id:yeniId(), metin:metin}; XE._ovSet(i); XE._ciz(); }
    else if(tur==='link'){ b.item.parcalar[pk]={tur:'link', url:metin}; XE._ovSet(i); XE._ciz(); }
    else if(tur==='baslik'){
      var _byOn=false; try{ _byOn=(localStorage.getItem('x_baslik_yap')==='1'); }catch(e){}
      if(!_byOn) return;   // [BAŞLIK YALNIZ BÖLÜM BAŞINDA] içerik metni başlık yapılamaz
      b.item.h2_override=metin; b.item.parcalar.splice(pk,1); b.h2=metin;
      // Öğe bir kümenin ORTASINDAYSA (b.h2 yoktu) başlık görünmez -> KENDİ kümesine al.
      if(b.grup!=null){ b.item.group_override='mc-'+(b.item.uid||Date.now())+'-'+Math.floor(Math.random()*1e6); }
      XE._ovSet(i); XE._yenidenPlanla();   // group değişebilir -> yeniden planla
    }
  };
  // #2: Öğeyi farklı kümeye taşı (group_override ile). grupKey: mevcut küme anahtarı, '' (kendi), '__yeni'.
  XE._kumeTasi = function(i, grupKey){
    var b=XE.belge.birimler[i]; if(!b||!b.item) return;
    // [6] no-op: mevcut küme anahtarıyla aynı hedef seçildiyse (özel komut değilse) atla.
    if(grupKey!=='__yeni' && (grupKey||'').indexOf('__solo:')!==0 && (b.item.group_override||'')===(grupKey||'')){ return; }
    XE._pushUndo();
    if(grupKey==='__yeni'){ b.item.group_override='mc-'+(b.item.uid||Date.now())+'-'+Math.floor(Math.random()*1e6);
      b.item.h2_override=''; b.h2='';   // [AYIR -> BOŞ BAŞLIK] ayrılan bölüm hesap adını KOPYALAMASIN; boş başlasın, kullanıcı adlandırsın
    }
    else if(grupKey && grupKey.indexOf('__solo:')===0){
      // C3: tek-başına bir bölümle BİRLEŞTİR — hedef ile taşınan öğeye ORTAK bir küme anahtarı ver.
      var tuid=grupKey.slice(7), tgt=null, ti=-1, B=XE.belge.birimler||[];
      for(var j=0;j<B.length;j++){ if(B[j].item && B[j].item.uid===tuid){ tgt=B[j]; ti=j; break; } }
      if(!tgt) return;
      var shared = (tgt.item.group_override && String(tgt.item.group_override)) || ('mc-'+(tgt.item.uid||Date.now())+'-'+Math.floor(Math.random()*1e6));
      tgt.item.group_override = shared; b.item.group_override = shared;
      // [10]: "B'yi T'ye taşı" -> T'nin başlığı kalsın. Küme başlığı ordered[0].h2_override'dan türer ve
      // ordered[0] havuz-sırası-ilk öğedir (T olmayabilir). İKİSİNE de T'nin başlığını yazarak hangisi
      // ilk olursa olsun T'nin başlığı görünür; diğeri zaten ikincil olduğu için başlık basmaz.
      var _tbaslik = (tgt.item.h2_override!=null && String(tgt.item.h2_override).trim()!=='') ? String(tgt.item.h2_override)
                   : (tgt.h2!=null && String(tgt.h2).trim()!=='') ? String(tgt.h2)
                   : (String(tgt.item.title||'').trim());
      if(_tbaslik){ tgt.item.h2_override=_tbaslik; b.item.h2_override=_tbaslik; }
      XE._ovSet(ti);   // hedef biriminin overlay'i de ortak anahtar + başlıkla güncellensin
    }
    else { b.item.group_override = grupKey || ''; }
    XE._ovSet(i); XE._yenidenPlanla();
  };

  // #2: MANUEL bloklar (havuza bağlı OLMAYAN, kümeler arası eklenen içerik) panel-global listede yaşar.
  function manuelStore(){ window.__xManualClusters = window.__xManualClusters || []; return window.__xManualClusters; }
  function yeniManId(){ return 'man'+Date.now()+'x'+(_manSeq++)+'x'+Math.floor(Math.random()*1e6); }
  // belge.birimler kurulduktan SONRA manuel blokları afterUid konumlarına yerleştir (kendi kümeleri).
  XE._manuelEkle = function(){
    var mc=manuelStore(); if(!mc.length) return;
    var B=XE.belge.birimler;
    mc.forEach(function(entry){
      var it=entry.item;
      // Manuel bölümde başlık alanı HEP görünür (boşken de düzenlenebilir); boşsa Word'e basılmaz.
      var birim={ h1:null, h2:String(it.h2_override!=null ? it.h2_override : ''),
                  item:it, link:'', son:true, manual:true, grup:'m-'+it.uid, grupBaslik:(it.h2_override||'') };
      var pos=B.length;
      if(entry.afterUid===''){ pos=0; }
      else { for(var i=0;i<B.length;i++){ if(B[i].item && B[i].item.uid===entry.afterUid){ pos=i+1; break; } } }
      B.splice(pos, 0, birim);
    });
  };
  // Yeni bölüm (manuel) — ŞABLONLU gelir: başlık + metin + link slotları (boş). Doldurulmayan
  // slotlar indirilen Word'de BASILMAZ (hizalama ona göre akar). İstenirse + ile parça eklenir.
  // B1 (havuz birlesmesi): "+" artik GERCEK sunucu havuzu ogesi tohumlar (sentetik xmanual:// link).
  // Boylece havuz bosken editorden eklenince havuz OLUSUR; eklenti/Baslat ayni havuza biner; Kaydet'e
  // kadar her sey havuzda birikir. Zengin iskelet (baslik+metin+link) overlay'de sentetik anahtarla yasar.
  XE._bolumEkle = async function(afterUid){
    XE._pushUndo();
    if(!unifyOn()){ return XE._bolumEkleLegacy(afterUid); }
    var uid=yeniManId(), link='xmanual://'+uid;
    // [GÖRSEL-SIRA normalizasyonu — commit sonrası] Havuz sırası, editörün gösterdiği GRUPLU GÖRSEL
    // sıradan AYRI olabilir: iç içe eklenen çok-hesaplı havuzda (örn. havuz [A1,B1,A2] -> editör görsel
    // [A1,A2,B1]) "+" ile A1-A2 arasına eklemek, manueli A1'in HAM havuz-konumuna (B1'den önce) sokup
    // A2'yi alta düşürüyordu. Çözüm: eklemeden ÖNCE havuzu GÖRSEL sıraya diz, sonra tıklanan öğenin
    // GÖRSEL konumunun ardına ekle. Bayrak (geri alınabilir): localStorage x_bolum_gorsel_sira='0' ->
    // eski ham-indeks davranışı.
    var _gorselSiraAcik=true; try{ _gorselSiraAcik=(localStorage.getItem('x_bolum_gorsel_sira')!=='0'); }catch(e){}
    var B=XE.belge.birimler||[];
    var afterIndex=null, _gorselKullan=false;
    if(_gorselSiraAcik){
      var poolB=[]; for(var i=0;i<B.length;i++){ if(B[i].item && B[i].item.index!=null) poolB.push(B[i]); }
      var yeniSira=poolB.map(function(b){ return b.item.index-1; });   // GÖRSEL sıradaki 0-tabanlı havuz konumları
      var _perm=(yeniSira.length>0), _srt=yeniSira.slice().sort(function(a,b){ return a-b; });   // tam permütasyon mu? (reorder bunu şart koşar)
      for(var s=0;s<_srt.length && _perm;s++){ if(_srt[s]!==s) _perm=false; }
      if(_perm){
        var afterPos=-1;
        if(afterUid){ for(var j=0;j<poolB.length;j++){ if(poolB[j].item.uid===afterUid){ afterPos=j; break; } } }
        if(afterUid==='' || afterPos>=0){
          var _farkli=false; for(var k=0;k<yeniSira.length;k++){ if(yeniSira[k]!==k){ _farkli=true; break; } }
          if(_farkli){ try{ await fetch('/api/manual/reorder', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({order:yeniSira})}); }catch(e){} }
          afterIndex=(afterUid==='')?0:(afterPos+1);   // normalize sonrası havuz=görsel sıra -> görsel konumun ardı
          _gorselKullan=true;
        }
      }
    }
    if(!_gorselKullan){   // eski yol: afterUid biriminin HAM havuz pozisyonu (1-tabanli) / en üst / bulunamazsa sona
      if(afterUid){ for(var i2=0;i2<B.length;i2++){ if(B[i2].item && B[i2].item.uid===afterUid && B[i2].item.index!=null){ afterIndex=B[i2].item.index; break; } } }
      else if(afterUid==='') afterIndex=0;
    }
    // Overlay'e ŞABLON tohumu -> "+" hemen başlık+metin+link iskeleti doğursun ve havuz yeniden-fetch'inde yaşasın.
    // [Link üstte] açıksa link kutusu metnin ÜSTÜNDE tohumlanır (kullanıcı isteği); kapalıysa metin üstte.
    var _luSeed = linkUstteFlag()
      ? [{tur:'link', url:''},{tur:'metin', id:yeniId(), metin:''}]
      : [{tur:'metin', id:yeniId(), metin:''},{tur:'link', url:''}];
    try{ ovStore().byLink[ovKey(link)] = { parcalar:_luSeed, h2:'', grup:null }; }catch(e){}
    var body={ title:'', link:link, local:true };
    if(afterIndex!=null) body.after_index=afterIndex;       // GÖRSEL konumun ardına (normalize edildi) ya da eski ham-indeks
    XE._dirty=true;
    _busy=true;   // [5] uçuştayken geri/ileri reddedilsin
    try{
      try{ await fetch('/api/manual/add', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}); }catch(e){}
      await XE.ac({});   // havuzdan yeniden kur -> yeni öğe gerçek .index + görsel-enjeksiyon yolu
    } finally { _busy=false; }
  };
  XE._bolumEkleLegacy = function(afterUid){
    var it={ manual:true, uid:yeniManId(), link:'', h2_override:'', parcalar:(linkUstteFlag() ? [ {tur:'link', url:''}, {tur:'metin', id:yeniId(), metin:''} ] : [ {tur:'metin', id:yeniId(), metin:''}, {tur:'link', url:''} ]) };
    manuelStore().push({ afterUid: afterUid||'', item: it });
    XE._dirty=true;
    XE._yenidenPlanla();
  };
  // [BÖLÜM SIRALA] Kartı görsel sırada hedefBi konumuna taşı -> havuzu yeni görsel sıraya diz (/api/manual/
  // reorder) -> yeniden planla. Böylece editör sırası = havuz sırası (eşleşme). hedefBi 0-tabanlı birim indeksi.
  XE._bolumTasiYap = async function(bi, hedefBi){
    var B=XE.belge.birimler||[];
    if(bi<0 || bi>=B.length) return;
    if(hedefBi<0) hedefBi=0; if(hedefBi>B.length-1) hedefBi=B.length-1;
    if(hedefBi===bi) return;
    XE._pushUndo();
    var arr=B.slice(); var moved=arr.splice(bi,1)[0]; arr.splice(hedefBi,0,moved);
    var yeniSira=[]; for(var k=0;k<arr.length;k++){ if(arr[k].item && arr[k].item.index!=null) yeniSira.push(arr[k].item.index-1); }
    var _srt=yeniSira.slice().sort(function(a,b){return a-b;}), _perm=(yeniSira.length>0);
    for(var s=0;s<_srt.length && _perm;s++){ if(_srt[s]!==s) _perm=false; }
    XE._dirty=true; _busy=true;
    try{
      if(_perm){
        var _farkli=false; for(var q=0;q<yeniSira.length;q++){ if(yeniSira[q]!==q){ _farkli=true; break; } }
        if(_farkli){ try{ await fetch('/api/manual/reorder', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({order:yeniSira})}); }catch(e){} }
        await XE.ac({});   // havuzdan yeni sırayla yeniden kur
      } else { XE.belge.birimler=arr; XE._ciz(); }   // index'siz birim (eski manuel) -> yalnız görsel diz
    } finally { _busy=false; }
  };
  // ===== GALERİ / SIRALA görünümü: bölümleri kart ızgarasında göster + sürükle-bırak ile sırala.
  // İKİ MOD: iki kartın ARASINA bırak = araya ekle (kaydırma); bir kartın ÜSTÜNE bırak = yer değiştir (swap).
  // Profil-önce kuralı XE.ac re-plan'inde ZATEN uygulanır (profil kartı grubunun en üstünde kalır). =====
  XE._galeriModu = false;
  XE.galeriToggle = function(){
    XE._galeriModu = !XE._galeriModu;
    var serit=document.getElementById('editor-serit'); if(serit){ serit.style.display = XE._galeriModu ? 'none' : ''; }
    var btn=document.querySelector('#editorModal .ed-ik-galeri'); if(btn){ if(XE._galeriModu){ btn.classList.add('aktif'); } else { btn.classList.remove('aktif'); } }
    if(XE._galeriModu){ XE._galeriCiz(); } else { XE._ciz(); }
  };
  XE._galeriCiz = function(){
    var root=document.getElementById('editor-root'); if(!root) return;
    var B=XE.belge.birimler||[];
    if(!B.length){ root.innerHTML='<div class="ed-bos">Henüz bölüm yok. Düzenleme görünümünde "+ Bölüm" ile ekleyebilirsin.</div>'; return; }
    var h='<div class="ed-gal-ipucu">Kartları sürükleyip sırala: iki kartın <b>arasına</b> bırak = araya ekle; bir kartın <b>üstüne</b> bırak = yer değiştir. (Profil kartı her zaman grubunun en üstünde kalır.)</div><div class="ed-gal-grid">';
    for(var i=0;i<B.length;i++){
      var b=B[i]||{}, it=b.item||{};
      var bas = (b.h2!=null && String(b.h2).trim()!=='') ? String(b.h2) : ((b.h1!=null && String(b.h1).trim()!=='') ? String(b.h1) : (it.title||''));
      var imgUrl='';   // x-editor.js scope: birincil görsel (item.image_b64) + edGorselHarita (parça-görsel) ikizini kullan
      if(it.image_b64){ imgUrl='data:'+(it.image_mime||'image/jpeg')+';base64,'+it.image_b64; }
      else { try{ var gm=edGorselHarita(it); for(var gk in gm){ if(gm[gk] && gm[gk].b64){ imgUrl='data:'+(gm[gk].mime||'image/jpeg')+';base64,'+gm[gk].b64; break; } } }catch(_g){} }
      var metin='';
      if(!bas && !imgUrl && it.parcalar){ for(var pp=0;pp<it.parcalar.length;pp++){ var pc=it.parcalar[pp]; if(pc && pc.tur==='metin' && pc.metin){ metin=(''+pc.metin).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,100); if(metin) break; } if(pc && pc.tur==='link' && pc.url && !metin){ metin=(''+pc.url).slice(0,100); } } }
      var ust = bas ? ('<div class="ed-gal-bas">'+esc(bas)+'</div>') : '';
      var gorsel = imgUrl ? ('<div class="ed-gal-img"><img src="'+imgUrl+'" alt=""></div>') : '';
      var govde = '';
      if(!ust && !gorsel){ govde = metin ? ('<div class="ed-gal-metin">'+esc(metin)+'</div>') : '<div class="ed-gal-bas ed-gal-bassiz">(içeriksiz bölüm)</div>'; }
      h+='<div class="ed-gal-card" draggable="true" data-i="'+i+'" title="Sürükleyerek bölümün sırasını değiştir"><div class="ed-gal-no">'+(i+1)+'</div>'+ust+gorsel+govde+'</div>';
    }
    h+='</div>';
    root.innerHTML=h;
    XE._galeriDndKur(root);
  };
  XE._galeriDndKur = function(root){
    var grid=root.querySelector('.ed-gal-grid'); if(!grid) return;
    var _from=-1;
    function _temizle(){ var ks=grid.querySelectorAll('.ed-gal-card'); for(var z=0;z<ks.length;z++){ ks[z].classList.remove('swap-hedef','ekle-sol','ekle-sag'); } }
    function _zon(card, clientX){ var r=card.getBoundingClientRect(); var x=clientX-r.left; var w=r.width||1; if(x < w*0.28) return 'once'; if(x > w*0.72) return 'sonra'; return 'swap'; }
    grid.addEventListener('dragstart', function(e){ var c=(e.target && e.target.closest) ? e.target.closest('.ed-gal-card') : null; if(!c) return; _from=+c.getAttribute('data-i'); c.classList.add('suruklenen'); try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', String(_from)); }catch(_){} });
    grid.addEventListener('dragover', function(e){ var c=(e.target && e.target.closest) ? e.target.closest('.ed-gal-card') : null; if(!c || _from<0) return; e.preventDefault(); try{ e.dataTransfer.dropEffect='move'; }catch(_){} var to=+c.getAttribute('data-i'); _temizle(); if(to===_from) return; var z=_zon(c, e.clientX); if(z==='swap'){ c.classList.add('swap-hedef'); } else if(z==='once'){ c.classList.add('ekle-sol'); } else { c.classList.add('ekle-sag'); } });
    grid.addEventListener('drop', function(e){ var c=(e.target && e.target.closest) ? e.target.closest('.ed-gal-card') : null; if(!c || _from<0) return; e.preventDefault(); var to=+c.getAttribute('data-i'); var z=_zon(c, e.clientX); _temizle(); var f=_from; _from=-1; if(to===f) return; XE._galeriTasi(f, to, z); });
    grid.addEventListener('dragend', function(){ _from=-1; var ks=grid.querySelectorAll('.ed-gal-card'); for(var z=0;z<ks.length;z++){ ks[z].classList.remove('suruklenen','swap-hedef','ekle-sol','ekle-sag'); } });
  };
  XE._galeriTasi = function(from, to, mod){
    var B=XE.belge.birimler||[]; if(from<0||from>=B.length||to<0||to>=B.length) return;
    var arr=B.slice();
    if(mod==='swap'){ var t=arr[from]; arr[from]=arr[to]; arr[to]=t; }
    else { var hedef=(mod==='sonra')?to+1:to; var moved=arr.splice(from,1)[0]; if(from<hedef) hedef--; arr.splice(hedef,0,moved); }
    XE._galeriUygula(arr);
  };
  XE._galeriUygula = async function(arr){
    var B=XE.belge.birimler||[]; if(!arr || arr.length!==B.length) return;
    var ayni=true; for(var z=0;z<arr.length;z++){ if(arr[z]!==B[z]){ ayni=false; break; } } if(ayni) return;
    XE._pushUndo();
    var yeniSira=[]; for(var k=0;k<arr.length;k++){ if(arr[k].item && arr[k].item.index!=null) yeniSira.push(arr[k].item.index-1); }
    var _srt=yeniSira.slice().sort(function(a,b){return a-b;}), _perm=(yeniSira.length>0);
    for(var s=0;s<_srt.length && _perm;s++){ if(_srt[s]!==s) _perm=false; }
    XE._dirty=true; _busy=true;
    try{
      if(_perm){
        var _farkli=false; for(var q=0;q<yeniSira.length;q++){ if(yeniSira[q]!==q){ _farkli=true; break; } }
        if(_farkli){ try{ await fetch('/api/manual/reorder', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({order:yeniSira})}); }catch(e){} }
        await XE.ac({});   // havuzdan yeni sırayla yeniden kur (profil-önce re-plan'de uygulanır; galeri yeniden çizilir)
      } else { XE.belge.birimler=arr; if(XE._galeriModu){ XE._galeriCiz(); } else { XE._ciz(); } }
    } finally { _busy=false; }
  };
  // Bir KARTA (bölüm/havuz) pos KONUMUNA parça ekle. tur: baslik/metin/link/gorsel. ekstra={b64,mime}.
  XE._parcaEkle = function(i, tur, ekstra, pos){
    var b=XE.belge.birimler[i]; if(!b||!b.item) return;
    XE._pushUndo();
    if(!b.item.parcalar) b.item.parcalar=[];
    if(pos==null || pos<0 || pos>b.item.parcalar.length) pos=b.item.parcalar.length;
    if(tur==='baslik'){ if(b.item.h2_override==null||b.item.h2_override===''){ b.item.h2_override='Başlık'; b.h2='Başlık'; } XE._ovSet(i); XE._ciz(); return; }
    if(tur==='panoSlot'){
      // #3: pano görseli INLINE yapıştırma yuvası (popup YOK) -> boş gorsel işaretçisi ekle; _ciz onu
      // odaklı yapıştırma kutusu çizer, kullanıcı oraya Ctrl+V yapınca görsel dolar ("metin ekler gibi").
      var _gi0=-1; for(var _g0=0;_g0<b.item.parcalar.length;_g0++){ if(b.item.parcalar[_g0].tur==='gorsel'){ _gi0=_g0; break; } }
      if(_gi0<0){ b.item.parcalar.splice(pos,0,{tur:'gorsel'}); _gi0=pos; }   // yoksa boş yuva ekle
      b.item._panoBekle=true; b.item._panoBekleP=_gi0;   // _ciz paste kutusunu odaklasın
      XE._ovSet(i); XE._ciz(); return;
    }
    if(tur==='gorselSlot'){
      // [ÇOKLU GÖRSEL] HER ZAMAN yeni BOŞ görsel parçası ekle (üst üste yığılabilsin); _ciz kutuyu
      // çizer (Ctrl+V + 📁 PC-seç) ve o parçayı odaklar. Görsel o PARÇANIN b64'üne yazılır.
      // ÖNCE: birincil görsel (item.image_b64 — eklenti/kazıma/eski) bir parçada "yüzüyorsa" onu O PARÇAYA
      // PİNLE -> yeni kutu ÜSTE de ALTA da eklense birincil görsel kaymaz/çalınmaz. (image_b64+XLocalImages
      // DURUR -> reload güvenli; edGorselHarita/birimGorselleri pinli birincili çift kullanmaz.)
      if(cokluGorselAcik() && b.item.image_b64){
        var _pin=-1; for(var _pp=0;_pp<b.item.parcalar.length;_pp++){ if(b.item.parcalar[_pp].tur==='gorsel' && !b.item.parcalar[_pp].b64){ _pin=_pp; break; } }
        if(_pin>=0){ b.item.parcalar[_pin].b64=b.item.image_b64; b.item.parcalar[_pin].mime=b.item.image_mime||'image/jpeg'; }
      }
      b.item.parcalar.splice(pos,0,{tur:'gorsel'});
      b.item._panoBekle=true; b.item._panoBekleP=pos;   // yeni eklenen kutuyu odakla
      XE._ovSet(i); XE._ciz(); return;
    }
    if(tur==='gorsel'){ if(!(ekstra&&ekstra.b64)) return; b.item.image_b64=ekstra.b64; b.item.image_mime=ekstra.mime||'image/png';
      // B2/FIX-IMG-RACE: birleşik manuel öğenin görseli SENKRON olarak XLocalImages'a (sentetik link anahtarı)
      // yazılır -> ardından gelen havuz yeniden-fetch/kaydet görseli kaçırmaz (sunucuya GİTMEZ, yerel kalır).
      if(edManual(b.item.link) && window.XLocalImages && window.XLocalImages.put){
        try{ window.XLocalImages.put(b.item.link, 'data:'+b.item.image_mime+';base64,'+b.item.image_b64, b.item.image_mime); }catch(e){}
      }
      var gi=-1; for(var gg=0;gg<b.item.parcalar.length;gg++){ if(b.item.parcalar[gg].tur==='gorsel'){ gi=gg; break; } }
      if(gi>=0){ var g=b.item.parcalar.splice(gi,1)[0]; if(gi<pos) pos--; b.item.parcalar.splice(pos,0,g); }
      else { b.item.parcalar.splice(pos,0,{tur:'gorsel'}); }
      XE._ovSet(i); XE._ciz(); return;
    }
    // [SORUN 2] Kullanıcının EKLEDİĞİ link parçasını işaretle (_ekLink) -> asıl (eklenti/kazıma) linkiyle karışmaz;
    // boş kalır, item.link'e düşmez. KONUMDAN BAĞIMSIZ (görsel üstüne/altına eklense de asıl link yerinde kalır).
    var yeni = (tur==='metin') ? {tur:'metin', id:yeniId(), metin:''} : (tur==='link') ? {tur:'link', url:'', _ekLink:true} : null;
    if(!yeni) return;
    b.item.parcalar.splice(pos,0,yeni); XE._ovSet(i); XE._ciz();
    if(tur==='metin'){ var el=document.querySelector('#editor-root .ed-card[data-i="'+i+'"] .ed-metin[data-p="'+pos+'"]'); if(el){ el.scrollIntoView({block:'center'}); el.focus(); } }
  };
  // [ÇOKLU GÖRSEL] Bir görsel parçasına görsel yaz (Ctrl+V ve 📁 PC-seç ortak yolu). Çoklu AÇIKSA görsel
  // O PARÇANIN b64'üne (parcalar'da -> overlay/snapshot ile kalıcı). KAPALIYSA eski: öğenin image_b64'ü + XLocalImages.
  XE._gorselParcaYaz = function(bi, pp, b64, mime){
    var b=XE.belge.birimler[bi]; if(!b||!b.item) return;
    XE._pushUndo();
    mime=mime||'image/png';
    if(cokluGorselAcik() && b.item.parcalar && b.item.parcalar[pp] && b.item.parcalar[pp].tur==='gorsel'){
      b.item.parcalar[pp].b64=b64; b.item.parcalar[pp].mime=mime;   // parçanın kendi görseli (birincil item.image_b64'e dokunma)
    } else {
      b.item.image_b64=b64; b.item.image_mime=mime;
      if(edManual(b.item.link) && window.XLocalImages && window.XLocalImages.put){ try{ window.XLocalImages.put(b.item.link, 'data:'+mime+';base64,'+b64, mime); }catch(_){} }
    }
    b.item._panoBekle=false; b.item._panoBekleP=null;
    XE._ovSet(bi); XE._ciz();
  };
  // [ÇOKLU GÖRSEL] Bir görsel parçasını editörden SİL (manuel eklenen VE eklenti/kazıma görseli).
  // Parça kendi b64'ünü taşıyorsa yalnız parça kaldırılır. Birincil görseli (item.image_b64 — eklenti/
  // kazıma/eski) kullanıyorsa item.image_b64 + XLocalImages de temizlenir (tekrar enjekte edilip GERİ GELMESİN).
  XE._gorselSil = function(bi, pp){
    var b=XE.belge.birimler[bi]; if(!b||!b.item||!b.item.parcalar) return;
    var p=b.item.parcalar[pp]; if(!p || p.tur!=='gorsel') return;
    XE._pushUndo();
    // Bu parça BİRİNCİL görseli (item.image_b64 — eklenti/kazıma/eski) GERÇEKTEN mi kullanıyor?
    // = kendi b64'ü YOK + item.image_b64 VAR + kendisinden ÖNCE b64'süz görsel parçası YOK (birincili
    // İLK b64'süz görsel parçası alır; edGorselHarita ikizi). Aksi halde (ör. görselin ALTINA eklenen
    // BOŞ KUTU) birincile DOKUNMA -> yalnız o boş parçayı kaldır (eklenti görseli silinmesin).
    var usesPrimary=false;
    if(b.item.image_b64){
      // Birincil görsel (item.image_b64) bir parçaya PİNLİ mi? (part.b64===image_b64)
      var pinIdx=-1; for(var r=0;r<b.item.parcalar.length;r++){ if(b.item.parcalar[r].tur==='gorsel' && b.item.parcalar[r].b64===b.item.image_b64){ pinIdx=r; break; } }
      if(pinIdx>=0){ usesPrimary=(pinIdx===pp); }   // PİNLİ: yalnız O parçayı silmek birincili temizler (boş kutu silinince DOKUNMA)
      else if(!p.b64){                               // PİNSİZ: YÜZEN birincil = ilk b64'süz görsel parçası
        var oncekiBosGorsel=false;
        for(var q=0;q<pp;q++){ var pq=b.item.parcalar[q]; if(pq && pq.tur==='gorsel' && !pq.b64){ oncekiBosGorsel=true; break; } }
        usesPrimary=!oncekiBosGorsel;
      }
    }
    if(usesPrimary){
      b.item.image_b64=''; b.item.image_mime='';
      if(b.item.link && window.XLocalImages && window.XLocalImages.remove){ try{ window.XLocalImages.remove(b.item.link); }catch(_){} }
    }
    b.item.parcalar.splice(pp,1);   // görsel parçasını kaldır
    XE._ovSet(bi); XE._ciz();
  };
  // [GÖRSEL HİZA] Bir görsel parçasının hizasını ayarla (Sol/Orta/Sağ). v boş -> override kaldır (genel g_align miras).
  XE._gorselHiza = function(bi, pp, v){
    if(!gorselHizaAcik()) return;
    var b=XE.belge.birimler[bi]; if(!b||!b.item||!b.item.parcalar) return;
    var p=b.item.parcalar[pp]; if(!p || p.tur!=='gorsel') return;
    XE._pushUndo();
    if(v==='center'||v==='right'||v==='left'){ p.align=v; } else { try{ delete p.align; }catch(_){ p.align=''; } }
    XE._ovSet(bi); XE._dirty=true; XE._ciz();
  };
  // [GÖRSEL HİZA] Seçilen hizayı TÜM görsellere uygula: genel g_align'ı yaz (per-rapor editorStyle'a gider) +
  // her görselin parça override'ını temizle -> hepsi genel hizayı izler ("en üstten").
  XE._gorselHizaTum = function(v){
    if(!gorselHizaAcik()) return;
    v=(v==='center'||v==='right')?v:'left';
    XE._pushUndo();
    var el=document.getElementById('g_align'); if(el){ el.value=v; }
    if(typeof window.xSaveStyles==='function'){ try{ window.xSaveStyles(); }catch(_){} }
    (XE.belge.birimler||[]).forEach(function(b, bi){
      if(!b || !b.item || !b.item.parcalar) return;
      var vardi=false;
      b.item.parcalar.forEach(function(pp){ if(pp && pp.tur==='gorsel' && pp.align!=null){ try{ delete pp.align; }catch(_){ pp.align=''; } vardi=true; } });
      if(vardi) XE._ovSet(bi);
    });
    try{ window.__xPoolDirty=true; }catch(_){}
    XE._dirty=true; XE._ciz();
  };
  // #2: Manuel bloğu sürükleyerek başka konuma taşı (afterUid güncelle).
  var _clDrag=null;
  XE._manuelTasi = function(uid, afterUid){
    var mc=manuelStore(), ent=null; for(var i=0;i<mc.length;i++){ if(mc[i].item.uid===uid){ ent=mc[i]; break; } }
    if(!ent || ent.afterUid===(afterUid||'')){ return; }   // [6] no-op: konum değişmiyorsa atla
    XE._pushUndo();
    ent.afterUid=afterUid||'';
    XE._dirty=true;
    XE._yenidenPlanla();
  };
  // #2: PC'den görsel seç -> base64 (manuel görsel bloğu için). Görsel yalnız panelde/snapshot'ta kalır.
  XE._gorselSec = function(cb){
    var inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
    inp.addEventListener('change', function(){ var f=inp.files&&inp.files[0]; if(!f) return;
      var rd=new FileReader(); rd.onload=function(){ var du=String(rd.result||''); var ci=du.indexOf(','); if(ci<0) return;
        var mime=(du.slice(5, (du.indexOf(';')>0?du.indexOf(';'):ci)))||'image/png'; try{ cb(du.slice(ci+1), mime); }catch(e){} };
      rd.readAsDataURL(f); });
    inp.click();
  };
  // #2: PANODAN görsel al (kopyalanan görsel) -> base64.
  // GÜVENLİ-OLMAYAN bağlamda (panel LAN IP'de http ile sunulur, localhost/https DEĞİL) navigator.clipboard
  // YOK -> ODAKLI YAPIŞTIRMA PENCERESİ aç: net bir hedef kutusu (contenteditable, otomatik odaklı);
  // kullanıcı "havaya" değil o kutuya Ctrl+V yapar (eski clipboardData API insecure context'te ÇALIŞIR).
  function _panoYapistirBekle(cb){
    var done=false;
    var ov=document.createElement('div'); ov.className='modal active'; ov.style.zIndex='3200';
    ov.innerHTML='<div class="modal-content" style="max-width:460px;">'
      +'<div class="modal-header"><h2 class="x-shead" style="margin:0;"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7.5" cy="8" r="1.3"/><path d="M4 14l4-3.5 3 2.5 3-2 2 2"/></svg>Panodan Görsel</h2><span class="close-btn" data-x="1">&times;</span></div>'
      +'<div class="modal-body">'
        +'<div class="x-pano-hedef" contenteditable="true" spellcheck="false" style="min-height:130px; border:2px dashed #9ab; border-radius:12px; display:flex; align-items:center; justify-content:center; text-align:center; color:#57606a; font-size:14px; padding:16px; outline:none; background:#f7fafd; cursor:text;">Görseli buraya <b style="margin:0 5px;">Ctrl+V</b> (⌘V) ile yapıştırın</div>'
      +'</div>'
      +'<div class="modal-footer" style="gap:10px;"><button type="button" class="btn btn-secondary" data-x="1" style="margin:0;">Vazgeç</button></div>'
      +'</div>';
    document.body.appendChild(ov);
    var hedef=ov.querySelector('.x-pano-hedef');
    function kapat(){ if(done) return; done=true; try{ ov.classList.remove('active'); ov.remove(); }catch(e){} }
    hedef.addEventListener('paste', function(e){
      var cd=e.clipboardData||(e.originalEvent&&e.originalEvent.clipboardData); if(!cd) return;
      var its=cd.items||[], i;
      for(i=0;i<its.length;i++){ var it=its[i];
        if(it && it.type && it.type.indexOf('image/')===0){ var blob=it.getAsFile(); if(!blob) continue;
          e.preventDefault();
          var rd=new FileReader(); rd.onload=function(){ var du=String(rd.result||''); var ci=du.indexOf(','); if(ci<0) return; try{ cb(du.slice(ci+1), blob.type||'image/png'); }catch(_){} }; rd.readAsDataURL(blob);
          kapat(); return; }
      }
      e.preventDefault(); hedef.innerHTML='Panoda görsel yok. Önce bir görsel kopyalayıp tekrar <b>Ctrl+V</b> yapın.';   // metin değil -> uyar, pencere açık kalsın
    });
    ov.addEventListener('click', function(e){ if(e.target===ov || (e.target.getAttribute && e.target.getAttribute('data-x'))) kapat(); });
    ov.addEventListener('keydown', function(e){ if(e.key==='Escape') kapat(); });
    setTimeout(function(){ try{ hedef.focus(); }catch(e){} }, 50);
  }
  XE._panoGorsel = function(cb){
    if(navigator.clipboard && navigator.clipboard.read){
      navigator.clipboard.read().then(function(items){
        for(var i=0;i<items.length;i++){ var it=items[i], imgT=null;
          for(var t=0;t<it.types.length;t++){ if(it.types[t].indexOf('image/')===0){ imgT=it.types[t]; break; } }
          if(imgT){ (function(mt){ it.getType(mt).then(function(blob){ var rd=new FileReader(); rd.onload=function(){ var du=String(rd.result||''); var ci=du.indexOf(','); if(ci<0) return; try{ cb(du.slice(ci+1), mt); }catch(e){} }; rd.readAsDataURL(blob); }); })(imgT); return; }
        }
        _panoYapistirBekle(cb);   // panoda görsel yok -> Ctrl+V yoluna düş
      }).catch(function(e){ _panoYapistirBekle(cb); });   // izin yok / insecure -> Ctrl+V yolu
    } else {
      _panoYapistirBekle(cb);
    }
  };

  function _metinKaydet(m){ try{ var bi=+m.getAttribute('data-i'), pk=+m.getAttribute('data-p'); var b=XE.belge.birimler[bi]; if(b&&b.item&&b.item.parcalar[pk]){ b.item.parcalar[pk].metin=sanitizeMetin(m.innerHTML); XE._ovSet(bi); } }catch(e){} }
  function _aktifMetin(){ var sel=window.getSelection(); if(!sel||!sel.anchorNode) return null; var el=sel.anchorNode.nodeType===1?sel.anchorNode:sel.anchorNode.parentNode; return (el&&el.closest)?el.closest('.ed-metin'):null; }

  // ============== SAĞ-TIK BİÇİM PANELİ ==============
  // Araç çubuğu = GENEL stil (üst şerit). SAĞ TIK = o anki seçime özel.
  //  - Başlığa (içerik .ed-h2 / platform .ed-plat) sağ tık -> O BAŞLIĞIN tamamı için biçim (font/boyut/renk/
  //    B-I-U/hiza/Word düzeyi) -> item.h1_ov/h2_ov (XE._hOvSec). Diğer başlıkları ETKİLEMEZ.
  //  - Metinde (.ed-metin) bir kelime/cümle SEÇİP sağ tık -> yalnız o SEÇİME satır-içi biçim (font/renk/
  //    boyut/B-I-U) -> <span style> / <b><i><u> (Faz B). textRuns/textXml bunu docx run'larına çevirir.
  var _rtInfo=null;
  var _inlineBusy=false;   // satır-içi biçim uygulanırken metin input handler'ı undo'yu çift işlemesin
  function _rtEff(bi, rol, prop){
    var b=XE.belge.birimler[bi], o=stilOku(), pre=(rol==='h1')?'b1':'b';
    var ov=((rol==='h1')?(b&&b.h1ov):(b&&b.h2ov))||{};
    if(prop==='font') return (ov.font!=null?ov.font:o[pre+'_font'])||'';
    if(prop==='size') return (ov.size!=null?ov.size:o[pre+'_size'])||'';
    if(prop==='color'){ var c=(ov.color!=null?ov.color:o[pre+'_color'])||'#000000'; return /^#[0-9a-fA-F]{6}$/.test(c)?c:'#000000'; }
    if(prop==='align') return (ov.align!=null?ov.align:o[pre+'_align'])||'left';
    if(prop==='word'){ if(WORD_GECERLI_ED[ov.word]) return ov.word; var gw=o[pre+'_wordstyle']; return WORD_GECERLI_ED[gw]?gw:(rol==='h1'?'Heading1':'Heading2'); }   // tekil -> genel Stil -> OTOMATİK
    if(prop==='bold') return (ov.bold!=null?!!ov.bold:!!o[pre+'_bold']);
    if(prop==='italic') return (ov.italic!=null?!!ov.italic:!!o[pre+'_italic']);
    if(prop==='underline') return (ov.underline!=null?!!ov.underline:!!o[pre+'_underline']);
    return '';
  }
  function _hizaBtnlar(cur){
    var defs=[['left','Sola',['M2 4h12','M2 8h8','M2 12h10']],['center','Ortaya',['M2 4h12','M4 8h8','M3 12h10']],['right','Sağa',['M2 4h12','M6 8h8','M4 12h10']],['both','İki yana',['M2 4h12','M2 8h12','M2 12h12']]];
    var s=''; for(var i=0;i<defs.length;i++){ var d=defs[i], paths=''; for(var j=0;j<d[2].length;j++) paths+='<path d="'+d[2][j]+'"/>';
      s+='<button type="button" class="rt-hb'+(cur===d[0]?' aktif':'')+'" data-v="'+d[0]+'" title="'+d[1]+'"><svg viewBox="0 0 16 16" width="14" height="14"><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none">'+paths+'</g></svg></button>'; }
    return s;
  }
  function _sagTikGoster(info, x, y){
    _rtInfo=info;
    var p=document.getElementById('ed-rt-panel'); if(!p) return;
    var fontOpts=(document.getElementById('b_font')||{}).innerHTML||'';
    var h='';
    if(info.mode==='image'){
      // [GÖRSEL HİZA] bu görselin hizası (parça override -> genel). Sol/Orta/Sağ + tümüne uygula + genele dön.
      var _gb=XE.belge.birimler[info.bi], _gpc=(_gb&&_gb.item&&_gb.item.parcalar)||[], _gp=_gpc[info.pp]||{};
      var _go=stilOku(); var _gcur=gorselEfHiza(_gp.align,_go);
      var _gdefs=[['left','Sola'],['center','Ortaya'],['right','Sağa']];
      h+='<div class="rt-title">Görsel hizalama</div>';
      h+='<div class="rt-row rt-hiza">';
      for(var _gi=0;_gi<_gdefs.length;_gi++){ var _gv=_gdefs[_gi][0];
        var _paths=({left:['M2 4h12','M2 8h8','M2 12h10'],center:['M2 4h12','M4 8h8','M3 12h10'],right:['M2 4h12','M6 8h8','M4 12h10']})[_gv];
        var _ps=''; for(var _gj=0;_gj<_paths.length;_gj++) _ps+='<path d="'+_paths[_gj]+'"/>';
        h+='<button type="button" class="rt-hb rt-ghb'+(_gcur===_gv?' aktif':'')+'" data-v="'+_gv+'" title="'+_gdefs[_gi][1]+'"><svg viewBox="0 0 16 16" width="14" height="14"><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none">'+_ps+'</g></svg></button>';
      }
      h+='</div>';
      h+='<div class="rt-row"><button type="button" class="rt-reset rt-img-tum">Tüm görsellere uygula</button></div>';
      // [GÖRSEL HİZA] override yoksa (zaten genel ayarda) "Genel ayara dön" PASİF -> dönülecek bir şey yok.
      var _hasOv=(_gp.align!=null);
      h+='<div class="rt-row"><button type="button" class="rt-reset rt-img-genel"'+(_hasOv?'':' disabled')+'>↺ Genel ayara dön</button></div>';
      p.innerHTML=h;
      p.querySelectorAll('.rt-ghb').forEach(function(b){ b.addEventListener('click', function(){ var v=b.getAttribute('data-v'); XE._gorselHiza(info.bi,info.pp,v); p.querySelectorAll('.rt-ghb').forEach(function(x){ x.classList.toggle('aktif',x===b); }); var _gb=p.querySelector('.rt-img-genel'); if(_gb) _gb.disabled=false; }); });   // hiza seçilince override oluştu -> "Genel ayara dön" aktifleşir
      p.querySelector('.rt-img-tum').addEventListener('click', function(){ var _gp2=(XE.belge.birimler[info.bi].item.parcalar||[])[info.pp]||{}; XE._gorselHizaTum(gorselEfHiza(_gp2.align,stilOku())); _sagTikKapat(); });
      p.querySelector('.rt-img-genel').addEventListener('click', function(){ XE._gorselHiza(info.bi,info.pp,''); _sagTikKapat(); });
    } else if(info.mode==='heading'){
      var bi=info.bi, rol=info.rol;
      var adv=(rol==='h1')?'Platform Adı':'Başlık';
      h+='<div class="rt-title">'+adv+' — yalnız bu başlık</div>';
      h+='<label class="rt-row">Font <select class="rt-font">'+fontOpts+'</select></label>';
      h+='<div class="rt-row"><label>Boyut <input type="number" class="rt-size" min="6" max="96" value="'+esc(String(_rtEff(bi,rol,'size')))+'" style="width:52px"></label><label>Renk <input type="color" class="rt-color" value="'+_rtEff(bi,rol,'color')+'"></label></div>';
      h+='<div class="rt-row rt-biu"><button type="button" class="rt-tgl'+(_rtEff(bi,rol,'bold')?' aktif':'')+'" data-c="bold" title="Kalın"><b>B</b></button><button type="button" class="rt-tgl'+(_rtEff(bi,rol,'italic')?' aktif':'')+'" data-c="italic" title="Eğik"><i>I</i></button><button type="button" class="rt-tgl'+(_rtEff(bi,rol,'underline')?' aktif':'')+'" data-c="underline" title="Altı çizili"><u>U</u></button></div>';
      h+='<div class="rt-row rt-hiza">'+_hizaBtnlar(_rtEff(bi,rol,'align'))+'</div>';
      h+='<label class="rt-row">Word düzeyi <select class="rt-word"><option value="Heading1">Başlık 1</option><option value="Heading2">Başlık 2</option><option value="Heading3">Başlık 3</option><option value="Heading4">Başlık 4</option><option value="Normal">Normal</option></select></label>';
      h+='<div class="rt-row"><button type="button" class="rt-reset">↺ Varsayılana döndür</button></div>';
      p.innerHTML=h;
      var fs=p.querySelector('.rt-font'); if(fs) fs.value=_rtEff(bi,rol,'font');
      // Word düzeyi: bu başlığın efektif düzeyi (tekil override varsa o; yoksa genel/varsayılan). Değiştirince
      // bu başlığa özel olur; genele döndürmek için "Varsayılana döndür".
      var ws=p.querySelector('.rt-word'); if(ws) ws.value=_rtEff(bi,rol,'word');
      p.querySelector('.rt-font').addEventListener('change', function(){ XE._hOvSec(bi,rol,'font',this.value); });
      p.querySelector('.rt-size').addEventListener('change', function(){ XE._hOvSec(bi,rol,'size',this.value); });
      p.querySelector('.rt-color').addEventListener('input', function(){ XE._hOvSec(bi,rol,'color',this.value); });   // [RENK ANLIK] seçerken uygula
      p.querySelectorAll('.rt-tgl').forEach(function(b){ b.addEventListener('click', function(){ var c=b.getAttribute('data-c'); var nv=!_rtEff(bi,rol,c); XE._hOvSec(bi,rol,c,nv); b.classList.toggle('aktif',nv); }); });
      p.querySelectorAll('.rt-hb').forEach(function(b){ b.addEventListener('click', function(){ var v=b.getAttribute('data-v'); XE._hOvSec(bi,rol,'align',v); p.querySelectorAll('.rt-hb').forEach(function(x){ x.classList.toggle('aktif',x===b); }); }); });
      p.querySelector('.rt-word').addEventListener('change', function(){ XE._hOvSec(bi,rol,'word', this.value); });   // bu başlığa özel Word düzeyi
      p.querySelector('.rt-reset').addEventListener('click', function(){ XE._hOvSifirla(bi,rol); _sagTikKapat(); });
    } else {
      // satır-içi (metin seçimi)
      var an=info.range&&info.range.startContainer; var pe=an&&(an.nodeType===1?an:an.parentNode);
      var cs=pe?window.getComputedStyle(pe):null;
      var curFont=cs?(cs.fontFamily||'').split(',')[0].replace(/['"]/g,'').trim():'';
      var curSize=cs?Math.round(parseFloat(cs.fontSize)/1.3333):'';   // px->pt (kaba)
      var curColor=cs?_rgbToHex(cs.color):'#000000';
      h+='<div class="rt-title">Seçili metin</div>';
      h+='<label class="rt-row">Font <select class="rt-font"><option value="">(değiştirme)</option>'+fontOpts+'</select></label>';
      h+='<div class="rt-row"><label>Boyut <input type="number" class="rt-size" min="6" max="96" value="'+esc(String(curSize))+'" style="width:52px"></label><label>Renk <input type="color" class="rt-color" value="'+curColor+'"></label></div>';
      h+='<div class="rt-row rt-biu"><button type="button" class="rt-tgl" data-c="bold" title="Kalın"><b>B</b></button><button type="button" class="rt-tgl" data-c="italic" title="Eğik"><i>I</i></button><button type="button" class="rt-tgl" data-c="underline" title="Altı çizili"><u>U</u></button></div>';
      // [HARF DÜZENİ] Word'deki "Aa" -> seçili metnin büyük/küçük harf düzeni (biçimi korur). Bayrak x_harf_duzeni='0' gizler.
      var _harfAcik=true; try{ if(localStorage.getItem('x_harf_duzeni')==='0') _harfAcik=false; }catch(_){}
      if(_harfAcik){
        h+='<label class="rt-row">Harf <select class="rt-harf"><option value="">Aa (düzen)</option><option value="sentence">Tümce düzeni</option><option value="lower">küçük harf</option><option value="upper">BÜYÜK HARF</option><option value="title">Her Sözcüğü Büyük Harfle Başlat</option><option value="toggle">tOGGLE (ters çevir)</option></select></label>';
      }
      // [SATIR-İÇİ LİNK] seçim link içindeyse "Linki kaldır", değilse URL girişi (seçim URL ise ön-dolu) + "Link yap"
      var _selTxt2=(info.range?String(info.range).trim():'');
      var _preUrl2=(/^\S+\.\S+/.test(_selTxt2) && !/\s/.test(_selTxt2)) ? _selTxt2 : '';
      var _lnkSvg='<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 11.5a3 3 0 0 0 4.24.17l2.3-2.3a3 3 0 0 0-4.24-4.24l-1.1 1.1"/><path d="M11.5 8.5a3 3 0 0 0-4.24-.17l-2.3 2.3a3 3 0 0 0 4.24 4.24l1.1-1.1"/></svg>';
      if(_linkIcinde(info.range)){
        h+='<div class="rt-row"><button type="button" class="rt-reset rt-linksil">'+_lnkSvg+' Linki kaldır</button></div>';
      } else {
        h+='<div class="rt-row rt-linkrow"><input type="text" class="rt-linkurl" placeholder="https://… link URL" value="'+esc(_preUrl2)+'"><button type="button" class="rt-linkyap" title="Seçimi link yap">'+_lnkSvg+'</button></div>';
      }
      h+='<div class="rt-row"><button type="button" class="rt-reset rt-temizle">↺ Biçimi temizle</button></div>';
      p.innerHTML=h;
      var fs2=p.querySelector('.rt-font'); if(fs2 && curFont){ for(var oi=0;oi<fs2.options.length;oi++){ if(fs2.options[oi].value===curFont){ fs2.selectedIndex=oi; break; } } }
      p.querySelector('.rt-temizle').addEventListener('click', function(){ _inlineTemizle(); _sagTikKapat(); });
      p.querySelector('.rt-font').addEventListener('change', function(){ if(this.value) _inlineUygula('font',this.value); });
      p.querySelector('.rt-size').addEventListener('change', function(){ if(this.value) _inlineUygula('size',this.value); });
      p.querySelector('.rt-color').addEventListener('input', function(){ _inlineUygula('color',this.value); });   // [RENK ANLIK] seçerken uygula
      p.querySelectorAll('.rt-tgl').forEach(function(b){ b.addEventListener('click', function(){ _inlineUygula(b.getAttribute('data-c'),null); b.classList.toggle('aktif'); }); });
      // [HARF DÜZENİ] seçimden uygula, sonra seçimi '' yap ki aynı seçenek tekrar tetiklenebilsin + panel açık kalsın
      var _hf=p.querySelector('.rt-harf'); if(_hf){ _hf.addEventListener('change', function(){ if(this.value){ _inlineHarf(this.value); this.value=''; } }); }
      // [SATIR-İÇİ LİNK] handler'lar
      var _lkYap=p.querySelector('.rt-linkyap'), _lkInput=p.querySelector('.rt-linkurl'), _lkSil=p.querySelector('.rt-linksil');
      if(_lkYap && _lkInput){ _lkYap.addEventListener('click', function(){ _inlineLink(_lkInput.value); _sagTikKapat(); }); _lkInput.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); _inlineLink(_lkInput.value); _sagTikKapat(); } }); }
      if(_lkSil){ _lkSil.addEventListener('click', function(){ _inlineLinkKaldir(); _sagTikKapat(); }); }
    }
    // konumlandır (imleç yakınına, görünüm içine sıkıştır)
    p.style.display='block'; p.style.visibility='hidden'; p.style.left='0px'; p.style.top='0px';
    var pw=p.offsetWidth||240, ph=p.offsetHeight||200;
    var L=x+4; if(L+pw>window.innerWidth-6) L=window.innerWidth-pw-6; if(L<6) L=6;
    var T=y+4; if(T+ph>window.innerHeight-6) T=y-ph-4; if(T<6) T=6;
    p.style.left=L+'px'; p.style.top=T+'px'; p.style.visibility='visible';
  }
  function _sagTikKapat(){ var p=document.getElementById('ed-rt-panel'); if(p){ p.style.display='none'; p.innerHTML=''; } _rtInfo=null; }
  function _rgbToHex(c){ try{ var m=String(c).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i); if(!m) return /^#[0-9a-fA-F]{6}$/.test(c)?c:'#000000'; function h(n){ n=(parseInt(n,10)||0).toString(16); return n.length<2?'0'+n:n; } return '#'+h(m[1])+h(m[2])+h(m[3]); }catch(e){ return '#000000'; } }
  function _spanSar(styleObj){
    var sel=window.getSelection(); if(!sel.rangeCount) return; var range=sel.getRangeAt(0); if(range.collapsed) return;
    var span=document.createElement('span'); for(var k in styleObj){ if(styleObj.hasOwnProperty(k)) span.style[k]=styleObj[k]; }
    try{ range.surroundContents(span); }
    catch(e){ try{ var frag=range.extractContents(); span.appendChild(frag); range.insertNode(span); }catch(_){ return; } }
    var nr=document.createRange(); nr.selectNodeContents(span); sel.removeAllRanges(); sel.addRange(nr);
  }
  function _inlineUygula(prop, value){
    var el=_rtInfo&&_rtInfo.metinEl, rng=_rtInfo&&_rtInfo.range; if(!el||!rng) return;
    XE._alanBlur();      // odak-oturumunun bekleyen anlığını bırak (sıra karışmasın)
    XE._pushUndo();      // TEK net undo adımı (değişiklik öncesi) -> font/renk/boyut da geri alınabilir
    _inlineBusy=true;    // execCommand'ın tetiklediği input, _alanGiris'i ÇİFT işlemesin
    try{ el.focus(); var sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(rng); }catch(e){ _inlineBusy=false; return; }
    if(prop==='bold'||prop==='italic'||prop==='underline'){
      try{ document.execCommand('styleWithCSS', false, false); }catch(_){}
      try{ document.execCommand(prop, false, null); }catch(_){}
    } else if(prop==='color'){
      // [RENK ANLIK] execCommand foreColor -> renk seçicide ANLIK (input) uygulanınca tekrar tekrar İÇ İÇE span
      // oluşmaz (browser var olan rengi günceller; _spanSar her input'ta yeni span sarardı).
      try{ document.execCommand('styleWithCSS', false, true); }catch(_){}
      try{ document.execCommand('foreColor', false, value); }catch(_){}
    } else {
      var so={};
      if(prop==='font') so.fontFamily="'"+value+"', sans-serif";
      else if(prop==='size') so.fontSize=(parseInt(value,10)||12)+'pt';
      _spanSar(so);
    }
    _inlineBusy=false;
    try{ var ns=window.getSelection(); if(ns.rangeCount) _rtInfo.range=ns.getRangeAt(0).cloneRange(); }catch(_){}
    _metinKaydet(el);
  }
  // Seçili metnin satır-içi biçimini temizle (font/renk/boyut/B-I-U kaldırır -> metin varsayılanına döner).
  function _inlineTemizle(){
    var el=_rtInfo&&_rtInfo.metinEl, rng=_rtInfo&&_rtInfo.range; if(!el||!rng) return;
    XE._alanBlur(); XE._pushUndo(); _inlineBusy=true;
    try{ el.focus(); var sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(rng); }catch(e){ _inlineBusy=false; return; }
    try{ document.execCommand('styleWithCSS', false, false); }catch(_){}
    try{ document.execCommand('removeFormat', false, null); }catch(_){}
    // removeFormat bazı <span style>'leri bırakabilir -> seçimdeki biçim span'lerini elle aç.
    try{ _spanAc(el, sel.rangeCount?sel.getRangeAt(0):rng); }catch(_){}
    _inlineBusy=false;
    try{ var ns=window.getSelection(); if(ns.rangeCount) _rtInfo.range=ns.getRangeAt(0).cloneRange(); }catch(_){}
    _metinKaydet(el);
  }
  // [HARF DÜZENİ] Seçili metnin harf düzenini değiştir. Biçimi (link/renk/font span) KORUR:
  // seçimdeki metin düğümlerini (text node) topla -> tek metin gibi dönüştür (karakter sayısı sabit) -> aynı düğümlere geri yaz.
  function _inlineHarf(mode){
    var el=_rtInfo&&_rtInfo.metinEl, rng=_rtInfo&&_rtInfo.range; if(!el||!rng) return;
    XE._alanBlur(); XE._pushUndo(); _inlineBusy=true;
    try{ el.focus(); var sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(rng); }catch(e){ _inlineBusy=false; return; }
    try{
      var range=sel.getRangeAt(0); if(range.collapsed){ _inlineBusy=false; return; }
      var pieces=[], full='';
      var walker=document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      var n;
      while(n=walker.nextNode()){
        if(!range.intersectsNode(n)) continue;
        var s=0, e=n.data.length;
        if(n===range.startContainer && range.startContainer.nodeType===3) s=range.startOffset;
        if(n===range.endContainer && range.endContainer.nodeType===3) e=range.endOffset;
        if(s>=e) continue;
        pieces.push({node:n,s:s,e:e,base:full.length}); full+=n.data.substring(s,e);
      }
      if(pieces.length){
        var out=_harfDonustur(full, mode);
        for(var i=0;i<pieces.length;i++){ var pc=pieces[i]; var seg=out.substr(pc.base, pc.e-pc.s); pc.node.data = pc.node.data.substring(0,pc.s)+seg+pc.node.data.substring(pc.e); }
        try{ var first=pieces[0], last=pieces[pieces.length-1]; var nr=document.createRange(); nr.setStart(first.node, first.s); nr.setEnd(last.node, last.e); sel.removeAllRanges(); sel.addRange(nr); }catch(_){}
      }
    }catch(e){}
    _inlineBusy=false;
    try{ var ns=window.getSelection(); if(ns.rangeCount) _rtInfo.range=ns.getRangeAt(0).cloneRange(); }catch(_){}
    _metinKaydet(el);
  }
  // [HARF DÜZENİ] Türkçe-duyarlı dönüşüm (i<->İ, ı<->I doğru). Karakter SAYISINI değiştirmez.
  function _harfDonustur(t, mode){
    function U(x){ try{ return x.toLocaleUpperCase('tr-TR'); }catch(_){ return x.toUpperCase(); } }
    function L(x){ try{ return x.toLocaleLowerCase('tr-TR'); }catch(_){ return x.toLowerCase(); } }
    function harfMi(c){ return U(c)!==L(c); }   // harf = büyük/küçük karşılığı farklı olan karakter
    if(mode==='upper') return U(t);
    if(mode==='lower') return L(t);
    if(mode==='toggle'){ var o=''; for(var i=0;i<t.length;i++){ var c=t.charAt(i), cu=U(c), cl=L(c); o+=(c===cu && c!==cl)?cl:cu; } return o; }
    if(mode==='title'){ var low=L(t), r='', yeni=true; for(var j=0;j<low.length;j++){ var ch=low.charAt(j); if(/\s/.test(ch)){ r+=ch; yeni=true; } else if(yeni && harfMi(ch)){ r+=U(ch); yeni=false; } else { r+=ch; if(harfMi(ch)) yeni=false; } } return r; }
    if(mode==='sentence'){ var lw=L(t), s2='', cap=true; for(var k=0;k<lw.length;k++){ var d=lw.charAt(k); if(cap && harfMi(d)){ s2+=U(d); cap=false; } else { s2+=d; } if(/[.!?…]/.test(d)||/[\r\n]/.test(d)) cap=true; } return s2; }
    return t;
  }
  // [SATIR-İÇİ LİNK] Seçim bir <a> içinde mi? (Link kaldır seçeneğini göstermek için.)
  function _linkIcinde(range){ try{ var n=range&&range.commonAncestorContainer; n=(n&&n.nodeType===1)?n:(n&&n.parentNode); return !!(n&&n.closest&&n.closest('a')); }catch(e){ return false; } }
  // [SATIR-İÇİ LİNK] Seçimi YERİNDE <a href> ile sar (metnin akışında, taşımadan). _inlineUygula deseni.
  function _inlineLink(url){
    var el=_rtInfo&&_rtInfo.metinEl, rng=_rtInfo&&_rtInfo.range; if(!el||!rng) return;
    url=_temizUrl(url); if(!url) return;
    XE._alanBlur(); XE._pushUndo(); _inlineBusy=true;
    try{ el.focus(); var sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(rng); }catch(e){ _inlineBusy=false; return; }
    try{ var range=sel.getRangeAt(0); if(!range.collapsed){
      var a=document.createElement('a'); a.setAttribute('href', url);
      try{ range.surroundContents(a); }
      catch(e){ try{ var frag=range.extractContents(); a.appendChild(frag); range.insertNode(a); }catch(_){} }
      var nr=document.createRange(); nr.selectNodeContents(a); sel.removeAllRanges(); sel.addRange(nr);
    } }catch(e){}
    _inlineBusy=false;
    try{ var ns=window.getSelection(); if(ns.rangeCount) _rtInfo.range=ns.getRangeAt(0).cloneRange(); }catch(_){}
    _metinKaydet(el);
  }
  // [SATIR-İÇİ LİNK] Seçimle kesişen link(ler)i kaldır (düz metne çevir, yerinde).
  function _inlineLinkKaldir(){
    var el=_rtInfo&&_rtInfo.metinEl, rng=_rtInfo&&_rtInfo.range; if(!el||!rng) return;
    XE._alanBlur(); XE._pushUndo(); _inlineBusy=true;
    try{ var aList=el.querySelectorAll('a');
      for(var i=aList.length-1;i>=0;i--){ var a=aList[i]; if(rng.intersectsNode && !rng.intersectsNode(a)) continue; while(a.firstChild) a.parentNode.insertBefore(a.firstChild, a); a.parentNode.removeChild(a); }
    }catch(e){}
    _inlineBusy=false;
    _metinKaydet(el);
  }
  // Verilen aralıkla kesişen, biçim taşıyan <span>'leri aç (içeriği koru). Basit ve güvenli temizleme.
  function _spanAc(root, range){
    var spans=root.querySelectorAll('span[style]');
    for(var i=spans.length-1;i>=0;i--){ var s=spans[i];
      if(range && range.intersectsNode && !range.intersectsNode(s)) continue;
      while(s.firstChild) s.parentNode.insertBefore(s.firstChild, s);
      s.parentNode.removeChild(s);
    }
  }
  function _sagTikKur(){
    if(document.getElementById('ed-rt-panel')) return;
    var p=document.createElement('div'); p.id='ed-rt-panel'; (document.body||document.documentElement).appendChild(p);
    p.addEventListener('mousedown', function(e){ e.stopPropagation(); });   // panel içine tıklama kapatmasın
    document.addEventListener('contextmenu', function(e){
      var modal=document.getElementById('editorModal'); if(!modal||!modal.classList.contains('active')) return;
      var t=e.target; if(!t||!t.closest) return;
      var h2=t.closest('.ed-h2'), plat=t.closest('.ed-plat'), metin=t.closest('.ed-metin'), gorsel=t.closest('.ed-img');
      // Başlık override'ı x_h_ov bayrağına bağlı -> kapalıysa başlık sağ-tık paneli AÇILMAZ (yazma da olmaz).
      if(hOvAcik() && h2 && h2.getAttribute('data-i')!=null){ e.preventDefault(); _sagTikGoster({mode:'heading',rol:'h2',bi:+h2.getAttribute('data-i')}, e.clientX, e.clientY); }
      else if(hOvAcik() && plat && plat.getAttribute('data-i')!=null){ e.preventDefault(); _sagTikGoster({mode:'heading',rol:'h1',bi:+plat.getAttribute('data-i')}, e.clientX, e.clientY); }
      // [GÖRSEL HİZA] görsele sağ-tık -> hizalama paneli (bu görsel + tüm görsellere/genele dön). Bayrak x_gorsel_hiza.
      else if(gorselHizaAcik() && gorsel && gorsel.getAttribute('data-i')!=null){ e.preventDefault(); _sagTikGoster({mode:'image', bi:+gorsel.getAttribute('data-i'), pp:+gorsel.getAttribute('data-p')}, e.clientX, e.clientY); }
      else if(metin){ var sel=window.getSelection(); if(sel && !sel.isCollapsed && sel.rangeCount && metin.contains(sel.anchorNode) && metin.contains(sel.focusNode)){ e.preventDefault(); _sagTikGoster({mode:'inline',metinEl:metin,range:sel.getRangeAt(0).cloneRange()}, e.clientX, e.clientY); } }
    });
    // [KEŞİF] Metin SEÇİLİNCE biçim/link panelini OTOMATİK göster (sağ-tık'a gerek yok; tarayıcıdan bağımsız).
    // Part 1 (font/renk/boyut) zaten sağ-tıkla vardı ama keşfi zordu -> seçimde auto. Bayrak x_secim_toolbar='0' kapatır.
    document.addEventListener('mouseup', function(e){
      try{ if(localStorage.getItem('x_secim_toolbar')==='0') return; }catch(_){}
      var modal=document.getElementById('editorModal'); if(!modal||!modal.classList.contains('active')) return;
      if(e.target && e.target.closest && e.target.closest('#ed-rt-panel')) return;
      setTimeout(function(){ try{
        var sel=window.getSelection(); if(!sel || sel.isCollapsed || !sel.rangeCount) return;
        if(String(sel).trim().length<1) return;
        var rng=sel.getRangeAt(0); var an=rng.commonAncestorContainer; var pe=(an.nodeType===1?an:an.parentNode);
        var metin=(pe&&pe.closest)?pe.closest('.ed-metin'):null;
        if(!metin || !metin.contains(sel.anchorNode) || !metin.contains(sel.focusNode)) return;
        var rect=rng.getBoundingClientRect();
        _sagTikGoster({mode:'inline',metinEl:metin,range:rng.cloneRange()}, rect.left, rect.bottom);
      }catch(_){} }, 10);
    });
    document.addEventListener('mousedown', function(e){ var pp=document.getElementById('ed-rt-panel'); if(pp && pp.style.display==='block' && !(e.target.closest && e.target.closest('#ed-rt-panel'))) _sagTikKapat(); });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') _sagTikKapat(); });
    window.addEventListener('scroll', function(){ _sagTikKapat(); }, true);
  }

  // [TAŞIMA HEDEFLERİ] Bir öğeyi "başka bölüme taşı" (kalem menüsü) için geçerli hedef bölümler.
  // #2: ad = düzenlenmiş başlık (item.h2_override) öncelikli -> kalem menüsü güncel başlığı gösterir.
  // #1: BAŞLIKSIZ bölüm (etkin başlığı boş) hedef OLMAZ -> öğe başlıksız bölüm altına dahil edilemez.
  function hedeflerHesapla(B){
    B=B||[]; var hedefler=[], _hg={};
    for(var _bi=0;_bi<B.length;_bi++){ var _bb=B[_bi];
      if(_bb.manual && !edManual((_bb.item&&_bb.item.link)||'')) continue;
      var _tkey = (_bb.grup!=null) ? _bb.grup : ('__solo:'+((_bb.item&&_bb.item.uid)||_bi));
      if(_hg[_tkey]) continue; _hg[_tkey]=1;
      var _tad = (_bb.item && _bb.item.h2_override!=null && String(_bb.item.h2_override).trim()!=='') ? String(_bb.item.h2_override).trim()
               : (_bb.grupBaslik && String(_bb.grupBaslik).trim()) ? String(_bb.grupBaslik).trim()
               : (_bb.h2!=null && String(_bb.h2).trim()!=='') ? String(_bb.h2).trim()
               : '';
      if(!_tad) continue;   // #1: başlıksız bölüm hedef değildir
      hedefler.push({ key:_tkey, ad:_tad });
    }
    return hedefler;
  }
  // [TAŞIMA MENÜSÜ] Bir kartın (bi) "başka bölüme taşı" menü seçenekleri HTML'i — GÜNCEL hedeflerden kurulur.
  // Menü AÇILIRKEN yeniden kurulur -> sonradan adlandırılan/eklenen bölümler de gelir, gidenler düşer.
  function kumeMenuHtml(bi){
    var B=XE.belge.birimler||[], b=B[bi]; if(!b||!b.item) return '';
    var hedefler=hedeflerHesapla(B);
    var selfKey=(b.grup!=null)?b.grup:('__solo:'+((b.item&&b.item.uid)||bi));
    var km='';
    for(var j=0;j<hedefler.length;j++){ if(hedefler[j].key!==selfKey) km+='<button class="ed-kume-opt" data-i="'+bi+'" data-k="'+esc(hedefler[j].key)+'">'+esc(hedefler[j].ad)+'</button>'; }
    var grpN=0; if(b.grup!=null){ for(var g=0;g<B.length;g++){ if(B[g]&&B[g].grup===b.grup) grpN++; } }
    var ayir=(grpN>1)||!!(b.item&&b.item.group_override);
    if(ayir) km+='<button class="ed-kume-opt" data-i="'+bi+'" data-k="__yeni">➕ Kendi başlığı (ayır)</button>';
    return km;
  }
  XE._ciz = function(){
    var root=document.getElementById('editor-root'); if(!root) return;
    var B=XE.belge.birimler||[];
    var o=stilOku(), c1=stilCss(o,'b1'), c2=stilCss(o,'b'), cm=stilCss(o,'m'), cl=stilCss(o,'l');
    // C (istediğin bölüme taşı): TÜM bölümler hedef olabilir — hem çok-üyeli kümeler hem de
    // tek-başına (standalone) öğeler. Okunur etiket; ham mc-/xmanual anahtarı ASLA gösterilmez.
    var hedefler=hedeflerHesapla(B);   // #1/#2: başlıksız hedef yok + düzenlenmiş başlık adı (ortak fonksiyon)
    // #2: bölümler-arası "+ Bölüm Ekle" zonu (hover'da çıkar) — boş bir bölüm ekler; içini sonra doldurursun.
    function _ez(after, hep){ var a=esc(after||''); return '<div class="ed-ekle-zon'+(hep?' hep':'')+'" data-after="'+a+'"><button class="ed-bolum-ekle" data-after="'+a+'" title="Buraya yeni bir BÖLÜM ekle (içine başlık/metin/görsel/link koyarsın)">'+(hep?'+ Bölüm Ekle':'+ Bölüm')+'</button></div>'; }
    // #2: parça-ARASI ekleme — imleç gelince küçük bir "+" çıkar; tıklayınca o konuma eklenecek tür menüsü.
    function _pz(ci, pos, manual){ return '<div class="ed-pz" data-i="'+ci+'" data-pos="'+pos+'"><span class="ed-pz-wrap"><button class="ed-pz-art" title="Buraya içerik ekle — başlık, metin, görsel veya link">+</button><span class="ed-pz-menu">'
      +(manual?'<button class="ed-pe" data-i="'+ci+'" data-pos="'+pos+'" data-t="baslik">Başlık</button>':'')
      +'<button class="ed-pe" data-i="'+ci+'" data-pos="'+pos+'" data-t="metin">Metin</button>'
      // [ÇOKLU GÖRSEL] AÇIK: tek "Görsel" -> kutu açar (içinde Ctrl+V + 📁 PC-seç). KAPALI: eski Görsel+Pano.
      +(cokluGorselAcik()
         ? '<button class="ed-pe" data-i="'+ci+'" data-pos="'+pos+'" data-t="gorsel">Görsel</button>'
         : '<button class="ed-pe" data-i="'+ci+'" data-pos="'+pos+'" data-t="gorsel">Görsel</button><button class="ed-pe" data-i="'+ci+'" data-pos="'+pos+'" data-t="pano">📋 Pano</button>')
      +'<button class="ed-pe" data-i="'+ci+'" data-pos="'+pos+'" data-t="link">Link</button></span></span></div>'; }
    var h=['<div class="ed-root">'], i, k;
    if(!B.length){ h.push('<div class="ed-bos">Henüz içerik yok. Aşağıdaki <b>+ Bölüm Ekle</b> ile bir bölüm açıp içine başlık/metin/görsel/link ekleyerek rapor oluşturabilirsin.</div>'); }
    h.push(_ez('', !B.length));   // en üstteki ekleme zonu — havuz BOŞKEN daima görünür (hover gerekmez)
    for(i=0;i<B.length;i++){ var b=B[i];
      if(b.h1) h.push('<div class="ed-plat" contenteditable="true" spellcheck="false" data-i="'+i+'" style="'+stilCssOv(o,'b1',b.h1ov)+'" title="Platform adını düzenle (tıkla-yaz). Tek bu başlığı ayrı biçimlemek için sağ tıkla.">'+esc(b.h1)+'</div>');
      h.push('<div class="ed-card'+(b.manual?' ed-card-man':'')+'" data-i="'+i+'">');
      // [BÖLÜM SIRALA] "✕ Sil"in hemen soluna: ▲ (yukarı) + düzenlenebilir SIRA NO (yaz+Enter) + ▼ (aşağı).
      // Silik (düşük opaklık), üstüne/kart-hover'da opak ("+" ekle butonu gibi). No = kartın 1-tabanlı sırası.
      h.push('<div class="ed-kart-ust"><span class="ed-sira" title="Bölümü taşı: ▲▼ ya da sıra no yaz (Enter)">'
        +'<button class="ed-sira-btn" data-i="'+i+'" data-yon="-1" title="Yukarı taşı"'+(i===0?' disabled':'')+'>&#9650;</button>'
        +'<input class="ed-sira-no" type="number" min="1" max="'+B.length+'" data-i="'+i+'" value="'+(i+1)+'" title="Sıra no yaz ve Enter">'
        +'<button class="ed-sira-btn" data-i="'+i+'" data-yon="1" title="Aşağı taşı"'+(i===B.length-1?' disabled':'')+'>&#9660;</button>'
        +'</span><button class="ed-del" data-i="'+i+'" title="Öğeyi sil">✕ Sil</button></div>');
      if(b.manual) h.push('<div class="ed-kltut" draggable="true" data-uid="'+esc(b.item.uid||'')+'" title="Bu bloğu sürükleyerek başka konuma taşı"><svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" style="vertical-align:-2px"><circle cx="6" cy="4" r="1.35"/><circle cx="10" cy="4" r="1.35"/><circle cx="6" cy="8" r="1.35"/><circle cx="10" cy="8" r="1.35"/><circle cx="6" cy="12" r="1.35"/><circle cx="10" cy="12" r="1.35"/></svg> taşı</div>');
      // C (istediğin bölüme taşı): taşıma menüsü HER kartta (hover'da çıkar) — hedefte TÜM diğer
      // bölümler (kümeler + tek-başına öğeler) okunur adlarıyla. YALNIZ eski (link='') manuel bloklar
      // hariç (onlar ⠿ ile sürüklenir). Birleşik xmanual:// öğeler gerçek havuz öğesi -> menüde yer alır.
      // C (başka bölüme taşı): büyük açılır kutu YERİNE başlığın hemen SAĞINDA KALEM ikonu -> tıklayınca
      // hedef bölümler menüsü açılır ("+" menü deseni: ed-pz-wrap/.acik/ed-pz-menu yeniden kullanılır).
      var _kalemHtml='';
      if(!b.manual || edManual(b.item.link)){
        var _selfKey = (b.grup!=null) ? b.grup : ('__solo:'+((b.item&&b.item.uid)||i));
        var _diger=[]; for(var _ki=0;_ki<hedefler.length;_ki++){ if(hedefler[_ki].key!==_selfKey) _diger.push(hedefler[_ki]); }
        // "Ayır" anlamlı mı? = öğe grubunda BAŞKA üye var (tek grup kalsa bile içeriği ayırabilmeli) VEYA
        // elle taşınmış (group_override). Böylece _diger=0 olsa DA kalem görünür -> "Kendi başlığına ayır"a erişilir.
        var _grpN=0; if(b.grup!=null){ for(var _gn=0;_gn<B.length;_gn++){ if(B[_gn] && B[_gn].grup===b.grup) _grpN++; } }
        var _ayir=(_grpN>1) || !!(b.item && b.item.group_override);
        if(_diger.length>0 || _ayir){
          var _km='';
          for(var _kj=0;_kj<_diger.length;_kj++){ _km+='<button class="ed-kume-opt" data-i="'+i+'" data-k="'+esc(_diger[_kj].key)+'">'+esc(_diger[_kj].ad)+'</button>'; }
          if(_ayir) _km+='<button class="ed-kume-opt" data-i="'+i+'" data-k="__yeni">➕ Kendi başlığı (ayır)</button>';
          if(_km) _kalemHtml='<span class="ed-pz-wrap ed-kume-wrap"><button class="ed-kume-kalem" title="Bu öğeyi başka bölüme taşı / kendi başlığına ayır"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3"/><path d="M9 4L2.5 10.5V13H5L11.5 6.5z"/></svg></button><span class="ed-pz-menu ed-kume-menu">'+_km+'</span></span>';
        }
      }
      // Başlık (h2) inline-block -> text-align tek başına KONUMLANDIRMAZ. Blok SARMALAYICIYA hizalamayı koy
      // -> başlık gerçekten sola/ortaya/sağa gider (docx jc ile uyumlu). Kalem başlığın SAĞINDA; başlık
      // yoksa (devam öğesi) kalem küçük bir satırda kartın başında.
      if(b.h2!=null){
        // [BAŞLIK OVERRIDE] içerik başlığı: rol varsayılanı (b) + o başlığa özel override (b.h2ov).
        var _hc=stilCssOv(o,'b',b.h2ov), _ha=((hOvAcik()&&b.h2ov&&b.h2ov.align)||o.b_align);
        var _h2j=({left:'flex-start',center:'center',right:'flex-end',both:'flex-start'}[_ha]||'flex-start');
        h.push('<div class="ed-h2-row"><span class="ed-kume-gutter">'+_kalemHtml+'</span><div class="ed-h2-sar" style="justify-content:'+_h2j+'"><div class="ed-h2" contenteditable="true" data-i="'+i+'" spellcheck="false" style="'+_hc+'">'+esc(b.h2)+'</div></div></div>'); }
      else if(_kalemHtml){ h.push('<div class="ed-h2-row"><span class="ed-kume-gutter">'+_kalemHtml+'</span></div>'); }
      var pc=(b.item&&b.item.parcalar)||[];
      var _gm=edGorselHarita(b.item);   // [ÇOKLU GÖRSEL] parça-indeksi -> {b64,mime}
      h.push(_pz(i, 0, b.manual));   // ilk parçadan ÖNCE ekleme noktası
      for(k=0;k<pc.length;k++){ var p=pc[k];
        h.push('<div class="ed-parca" data-i="'+i+'" data-p="'+k+'">');
        h.push('<div class="ed-tut" draggable="true" data-i="'+i+'" data-p="'+k+'" title="Sürükleyerek taşı"><svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><circle cx="6" cy="4" r="1.35"/><circle cx="10" cy="4" r="1.35"/><circle cx="6" cy="8" r="1.35"/><circle cx="10" cy="8" r="1.35"/><circle cx="6" cy="12" r="1.35"/><circle cx="10" cy="12" r="1.35"/></svg></div>');
        h.push('<div class="ed-parca-ic">');
        if(p.tur==='gorsel'){ var _g=_gm[k];
          // [GÖRSEL HİZA] efektif hiza (parça override -> genel) -> margin ile editörde yansıt (sağ-tıkla değiştirilir).
          var _gAl=(_g?gorselEfHiza(_g.align,o):'left');
          var _gSty=(_gAl==='center')?'margin-left:auto;margin-right:auto':(_gAl==='right')?'margin-left:auto;margin-right:0':'';
          h.push((_g && _g.b64)
            ? ('<img class="ed-img" data-i="'+i+'" data-p="'+k+'" src="data:'+(_g.mime||'image/jpeg')+';base64,'+_g.b64+'" alt=""'+(_gSty?(' style="'+_gSty+'"'):'')+'>')
            : ('<div class="ed-img-pano" contenteditable="true" spellcheck="false" data-i="'+i+'" data-p="'+k+'" title="Panodaki görseli Ctrl+V ile buraya yapıştır">📋 Görseli buraya <b>Ctrl+V</b> (⌘V) ile yapıştır<button class="ed-img-pcsec" contenteditable="false" type="button" data-i="'+i+'" data-p="'+k+'" title="Bilgisayardan görsel seç">📁 Bilgisayardan seç</button></div>')); }
        else if(p.tur==='metin'){ h.push('<div class="ed-metin" contenteditable="true" data-i="'+i+'" data-p="'+k+'" spellcheck="false" style="'+cm+'">'+renderMetin(p.metin||'')+'</div>'); }
        else if(p.tur==='link'){ var lk=linkGoster(b.item);
          // [SORUN 2] boş url -> item.link YALNIZ ASIL link parçasına düşsün (konumdan bağımsız: görsel üstüne
          // eklenen boş link asıl linki etkilemez, görünüm takası olmaz); sonradan eklenen ek link boş kalsın.
          var _asilK=_asilLinkIdx(b.item.parcalar);
          var shown=(p.url!=null && p.url!=='') ? p.url : ((yeniLinkBosAcik() && k!==_asilK) ? '' : lk);
          h.push('<div class="ed-link ed-link-edit" contenteditable="true" data-i="'+i+'" data-p="'+k+'" spellcheck="false" style="'+cl+'">'+esc(shown)+'</div>'); }
        h.push('</div>');
        // #4: Word Düzenle (ve genel) için parça TÜRÜ değiştirici — hover'da çıkar (metin/link).
        // [BAŞLIK YALNIZ BÖLÜM BAŞINDA] "Başlık yap" KALDIRILDI: bölüm içindeki bir metin başlık OLAMAZ; başlık
        // yalnız bölüm başındaki title satırıdır (üstteki .ed-h2'den düzenlenir). Bayrak x_baslik_yap='1' -> geri.
        if(p.tur==='metin' || p.tur==='link'){
          var _byAcik=false; try{ _byAcik=(localStorage.getItem('x_baslik_yap')==='1'); }catch(e){}
          h.push('<select class="ed-tur" data-i="'+i+'" data-p="'+k+'" title="Bu parçanın türünü seç (Metin / Link)">'
            +'<option value="metin"'+(p.tur==='metin'?' selected':'')+'>Metin</option>'
            +'<option value="link"'+(p.tur==='link'?' selected':'')+'>Link</option>'
            +(_byAcik?'<option value="baslik">Başlık yap</option>':'')+'</select>');
        }
        if(p.tur==='metin' || p.tur==='link') h.push('<button class="ed-metin-sil" data-i="'+i+'" data-p="'+k+'" title="Bu parçayı sil">&minus;</button>');
        else if(p.tur==='gorsel') h.push('<button class="ed-metin-sil ed-gorsel-sil" data-i="'+i+'" data-p="'+k+'" title="Bu görseli sil">&minus;</button>');   // [ÇOKLU GÖRSEL] görseli editörden sil (manuel + eklenti/kazıma)
        h.push('</div>');
        h.push(_pz(i, k+1, b.manual));   // bu parçadan SONRA ekleme noktası
      }
      h.push('</div>');
      if(b.cizgi) h.push('<hr class="ed-line">');   // ayraç çizgisi: docx ile aynı (A1/manuel sonrası yok)
      h.push(_ez(b.item.uid||''));   // bu karttan sonra ekleme zonu
    }
    h.push('</div>');
    root.innerHTML=h.join('');
    // [scroll zıplamasını önle]: saklanan scroll varsa geri koy (re-render tepeye zıplamasın).
    if(_savedScroll!=null){ var _pb1=document.querySelector('#editorModal .preview-body'); if(_pb1){ try{ _pb1.scrollTop=_savedScroll; }catch(e){} } _savedScroll=null; }

    root.querySelectorAll('.ed-h2').forEach(function(el){
      el.addEventListener('focus', function(){ var bi=+el.getAttribute('data-i'); XE._seritSekmeCtx('b',{kind:'h2',bi:bi}); XE._alanOdak(); });
      el.addEventListener('blur', function(){ XE._alanBlur(); });
      el.addEventListener('input', function(){ XE._alanGiris(); var bi=+el.getAttribute('data-i'); var b=XE.belge.birimler[bi]; if(b&&b.item){ b.item.h2_override=el.textContent; b.h2=el.textContent; XE._ovSet(bi); } });
    });
    root.querySelectorAll('.ed-metin').forEach(function(el){
      el.addEventListener('focus', function(){ XE._seritSekmeCtx('m',{kind:'metin'}); XE._alanOdak(); });
      el.addEventListener('blur', function(){ XE._alanBlur(); });
      el.addEventListener('click', function(e){ var a=e.target&&e.target.closest?e.target.closest('a'):null; if(a){ e.preventDefault(); } });   // [SATIR-İÇİ LİNK] editörde link'e tıklayınca gezinme (düzenleme için)
      el.addEventListener('paste', function(e){
        try{
          var cd=e.clipboardData||window.clipboardData; if(!cd||!cd.getData) return;
          var txt=cd.getData('text/plain');
          if(txt==null||txt===''){ var _h=cd.getData('text/html'); if(_h){ var _tmp=document.createElement('div'); _tmp.innerHTML=_h; txt=_tmp.innerText||_tmp.textContent||''; } }
          if(txt==null||txt===''){
            // [GÖRSELİ METNE YAPIŞTIRMA] metin yok + panoda GÖRSEL var -> metin ögesine YAPIŞTIRMA (görsel kutusuna yapıştır).
            var hasImg=false; try{ var its=cd.items||[]; for(var j=0;j<its.length;j++){ if(its[j]&&its[j].type&&its[j].type.indexOf('image/')===0){ hasImg=true; break; } } }catch(_){}
            if(hasImg){ e.preventDefault(); try{ if(window.showToast) window.showToast('Görsel metin alanına yapıştırılamaz — bir görsel kutusuna yapıştırın.','warning'); }catch(_){} }
            return;   // görselse engellendi; ne metin ne görselse varsayılan
          }
          // [DÜZ-METİN YAPIŞTIR] Normal Ctrl+V kaynağın font/renk/boyut/arka-plan biçimini getirip metni "bozuyordu"
          // (X'ten yapıştırınca arka bant vb.) -> VARSAYILAN "stili eşleştir": DÜZ METİN ekle, satır sonlarını koru.
          // Bayrak x_duz_yapistir='0' -> eski zengin yapıştırma. Biçimi SONRADAN seçip araç çubuğundan uygula.
          if(localStorage.getItem('x_duz_yapistir')==='0') return;
          e.preventDefault();
          var html=esc(String(txt)).replace(/\r\n?/g,'\n').replace(/\n/g,'<br>');
          document.execCommand('insertHTML', false, html);
        }catch(_){}
      });
      el.addEventListener('input', function(){ if(_inlineBusy) return;   // satır-içi biçim uygulaması kendi undo'sunu + kaydını yapar (çift işleme yok)
        XE._alanGiris(); var bi=+el.getAttribute('data-i'), pk=+el.getAttribute('data-p'); var b=XE.belge.birimler[bi]; if(b&&b.item&&b.item.parcalar[pk]){ b.item.parcalar[pk].metin=sanitizeMetin(el.innerHTML); XE._ovSet(bi); } });
    });
    root.querySelectorAll('.ed-link-edit').forEach(function(el){
      el.addEventListener('focus', function(){ XE._seritSekmeCtx('l',{kind:'link'}); XE._alanOdak(); });
      el.addEventListener('blur', function(){ XE._alanBlur(); });
      el.addEventListener('input', function(){ XE._alanGiris(); var bi=+el.getAttribute('data-i'), pk=+el.getAttribute('data-p'); var b=XE.belge.birimler[bi]; if(b&&b.item&&b.item.parcalar[pk]){ b.item.parcalar[pk].url=el.textContent; XE._ovSet(bi); } });
    });
    // #3: INLINE pano yapıştırma kutusu -> buraya Ctrl+V yapınca O PARÇANIN görseli dolar (popup yok).
    root.querySelectorAll('.ed-img-pano').forEach(function(el){
      el.addEventListener('paste', function(e){
        var cd=e.clipboardData||(e.originalEvent&&e.originalEvent.clipboardData); if(!cd) return;
        var its=cd.items||[], j;
        for(j=0;j<its.length;j++){ var it=its[j];
          if(it && it.type && it.type.indexOf('image/')===0){ var blob=it.getAsFile(); if(!blob) continue;
            e.preventDefault();
            var bi=+el.getAttribute('data-i'), pp=+el.getAttribute('data-p'); var b=XE.belge.birimler[bi]; if(!b||!b.item){ return; }
            var rd=new FileReader(); rd.onload=function(){ var du=String(rd.result||''); var ci=du.indexOf(','); if(ci<0) return;
              XE._gorselParcaYaz(bi, pp, du.slice(ci+1), blob.type||'image/png');
            }; rd.readAsDataURL(blob); return; }
        }
        e.preventDefault(); el.innerHTML='Panoda görsel yok. Önce bir görsel kopyalayıp tekrar <b>Ctrl+V</b> yapın.';
      });
    });
    // [ÇOKLU GÖRSEL] Kutu içindeki "📁 Bilgisayardan seç" -> PC dosya seçici -> AYNI parçaya yazar.
    root.querySelectorAll('.ed-img-pcsec').forEach(function(el){
      el.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation();
        var bi=+el.getAttribute('data-i'), pp=+el.getAttribute('data-p');
        XE._gorselSec(function(b64,mime){ XE._gorselParcaYaz(bi, pp, b64, mime); });
      });
    });
    // _panoBekle olan kartın (varsa o PARÇANIN) yapıştırma kutusunu odakla (kullanıcı hemen Ctrl+V yapabilsin).
    (function(){ var bek=-1, bekP=null, Bb=XE.belge.birimler||[]; for(var z=0;z<Bb.length;z++){ if(Bb[z].item && Bb[z].item._panoBekle){ bek=z; bekP=Bb[z].item._panoBekleP; break; } }
      if(bek>=0){ var pel=(bekP!=null && root.querySelector('.ed-card[data-i="'+bek+'"] .ed-img-pano[data-p="'+bekP+'"]')) || root.querySelector('.ed-card[data-i="'+bek+'"] .ed-img-pano'); if(pel){ pel.scrollIntoView({block:'center'}); try{ pel.focus(); }catch(e){} } } })();
    // [+ menüsü tıkla-kalıcı]: "+" tıklanınca menü açılır, DIŞARI tıklayana (ya da bir seçenek seçene)
    // kadar kalır. Hover'a bağlı değil (imleç kaçınca kapanmaz).
    root.querySelectorAll('.ed-pz-art').forEach(function(el){
      el.addEventListener('click', function(e){ e.stopPropagation(); var w=el.closest('.ed-pz-wrap'); if(!w) return;
        var acik=w.classList.contains('acik');
        root.querySelectorAll('.ed-pz-wrap.acik').forEach(function(x){ x.classList.remove('acik'); });   // diğer açık menüleri kapat
        if(!acik) w.classList.add('acik'); });
    });
    if(!window.__edPzOutside){ window.__edPzOutside=true; document.addEventListener('click', function(e){
      if(e.target && e.target.closest && e.target.closest('.ed-pz-wrap')) return;   // menü/+ içine tıklama -> dokunma
      var r=document.getElementById('editor-root'); if(r) r.querySelectorAll('.ed-pz-wrap.acik').forEach(function(x){ x.classList.remove('acik'); });
    }); }
    root.querySelectorAll('.ed-pe').forEach(function(el){
      el.addEventListener('click', function(){ var _w=el.closest('.ed-pz-wrap'); if(_w) _w.classList.remove('acik');   // seçince menüyü kapat
        var bi=+el.getAttribute('data-i'), tur=el.getAttribute('data-t'); var _ps=el.getAttribute('data-pos'); var pos=(_ps==null?null:+_ps);
        // [ÇOKLU GÖRSEL] AÇIK: "Görsel" -> boş görsel kutusu (parça) aç (Ctrl+V + 📁 PC-seç; üst üste yığılır).
        // KAPALI: eski -> "Görsel" PC dosya seçici, "📋 Pano" kutu.
        if(tur==='gorsel'){
          if(cokluGorselAcik()){ XE._parcaEkle(bi,'gorselSlot',null, pos); }
          else { XE._gorselSec(function(b64,mime){ XE._parcaEkle(bi,'gorsel',{b64:b64,mime:mime}, pos); }); }
        }
        else if(tur==='pano'){ XE._parcaEkle(bi,'panoSlot',null, pos); }   // #3: inline yapıştırma yuvası aç (popup yok)
        else { XE._parcaEkle(bi, tur, null, pos); } });
    });
    root.querySelectorAll('.ed-metin-sil').forEach(function(el){
      if(el.classList.contains('ed-gorsel-sil')) return;   // görsel sil -> ayrı handler (item.image_b64+XLocalImages de temizler)
      el.addEventListener('click', function(){ var bi=+el.getAttribute('data-i'), pk=+el.getAttribute('data-p'); var b=XE.belge.birimler[bi]; if(b&&b.item&&b.item.parcalar){ XE._pushUndo(); b.item.parcalar.splice(pk,1); XE._ovSet(bi); XE._ciz(); } });
    });
    root.querySelectorAll('.ed-gorsel-sil').forEach(function(el){
      el.addEventListener('click', function(){ XE._gorselSil(+el.getAttribute('data-i'), +el.getAttribute('data-p')); });
    });
    root.querySelectorAll('.ed-tur').forEach(function(el){
      el.addEventListener('change', function(){ XE._turDegistir(+el.getAttribute('data-i'), +el.getAttribute('data-p'), el.value); });
    });
    // Kalem ikonu: tıklayınca taşıma menüsünü aç/kapa. [#2] AÇARKEN hedef adlarını GÜNCEL başlıklarla tazele
    // (düzenlenen başlık menüde de görünsün); [#1] başlıksız olan hedefi menüden GİZLE (taşınamaz).
    root.querySelectorAll('.ed-kume-kalem').forEach(function(el){
      el.addEventListener('click', function(e){ e.stopPropagation(); var w=el.closest('.ed-pz-wrap'); if(!w) return;
        var acik=w.classList.contains('acik');
        root.querySelectorAll('.ed-pz-wrap.acik').forEach(function(x){ x.classList.remove('acik'); });
        if(!acik){
          // [#2b GECİKME FİX] menüyü AÇARKEN güncel hedeflerden TAM yeniden kur -> sonradan adlandırılan/eklenen
          // bölümler (ör. "Deneme") ANINDA gelir, başlıksız/giden düşer. Eski "yalnız mevcut opt'ları güncelle"
          // yolu yeni hedefi EKLEYEMİYORDU (gecikme: ancak başka bir işlem _ciz'i tetikleyince görünüyordu).
          try{ var card=el.closest('.ed-card'); var bi=card?+card.getAttribute('data-i'):-1; var menu=w.querySelector('.ed-kume-menu'); if(menu && bi>=0) menu.innerHTML=kumeMenuHtml(bi); }catch(_){}
          w.classList.add('acik');
        }
      });
    });
    // Menü seçeneği: öğeyi o bölüme taşı + menüyü kapat. DELEGASYON (menü açılışta yeniden kurulduğu için
    // seçenekler değişir -> tek tek bağlama yerine root'ta bir kez delege et; yeniden-kurulan opt'lar da çalışır).
    if(!window.__edKumeOptBound){ window.__edKumeOptBound=true;
      document.addEventListener('click', function(e){ var opt=e.target && e.target.closest && e.target.closest('.ed-kume-opt'); if(!opt) return;
        e.stopPropagation(); var w=opt.closest('.ed-pz-wrap'); if(w) w.classList.remove('acik');
        XE._kumeTasi(+opt.getAttribute('data-i'), opt.getAttribute('data-k'));
      });
    }
    // Platform başlığı: TIKLA-YAZ ile metni düzenlenebilir (h1_override) + şerit "Platform Adı" (b1) bağlamı.
    root.querySelectorAll('.ed-plat').forEach(function(el){
      el.addEventListener('focus', function(){ XE._seritSekmeCtx('b1',{kind:'plat', bi:+el.getAttribute('data-i')}); XE._alanOdak(); });
      el.addEventListener('blur', function(){ XE._alanBlur(); });
      el.addEventListener('input', function(){ XE._alanGiris(); var bi=+el.getAttribute('data-i'); var b=XE.belge.birimler[bi]; if(b&&b.item){ b.item.h1_override=el.textContent; b.h1=el.textContent; XE._ovSet(bi); } });
    });
    root.querySelectorAll('.ed-bolum-ekle').forEach(function(el){
      el.addEventListener('click', function(){ XE._bolumEkle(el.getAttribute('data-after')); });
    });
    // #2: manuel blok küme-sürükleme -> ekleme zonuna bırakınca o konuma taşınır.
    root.querySelectorAll('.ed-kltut').forEach(function(el){
      el.addEventListener('dragstart', function(e){ _clDrag=el.getAttribute('data-uid'); try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain','x'); }catch(_){} });
      el.addEventListener('dragend', function(){ _clDrag=null; root.querySelectorAll('.ed-ekle-zon.ed-drop').forEach(function(x){ x.classList.remove('ed-drop'); }); });
    });
    root.querySelectorAll('.ed-ekle-zon').forEach(function(z){
      z.addEventListener('dragover', function(e){ if(_clDrag==null) return; e.preventDefault(); z.classList.add('ed-drop'); });
      z.addEventListener('dragleave', function(){ z.classList.remove('ed-drop'); });
      z.addEventListener('drop', function(e){ if(_clDrag==null) return; e.preventDefault(); var u=_clDrag; _clDrag=null; XE._manuelTasi(u, z.getAttribute('data-after')); });
    });
    root.querySelectorAll('.ed-del').forEach(function(el){ el.addEventListener('click', function(){ XE._sil(+el.getAttribute('data-i')); }); });
    // [BÖLÜM SIRALA] ▲▼ -> bir yukarı/aşağı; sıra no (Enter/blur) -> o konuma taşı.
    root.querySelectorAll('.ed-sira-btn').forEach(function(el){
      el.addEventListener('click', function(){ if(el.hasAttribute('disabled')) return; var bi=+el.getAttribute('data-i'), yon=+el.getAttribute('data-yon'); XE._bolumTasiYap(bi, bi+yon); });
    });
    root.querySelectorAll('.ed-sira-no').forEach(function(el){
      function uygula(){ var bi=+el.getAttribute('data-i'); var no=parseInt(el.value,10); if(isNaN(no)) { el.value=bi+1; return; } XE._bolumTasiYap(bi, no-1); }
      el.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); el.blur(); } });
      el.addEventListener('change', uygula);
    });

    // SÜRÜKLE-BIRAK: tutamaktan (⠿) sürükle, aynı kart içinde parçaları yeniden sırala.
    root.querySelectorAll('.ed-tut').forEach(function(el){
      el.addEventListener('dragstart', function(e){ _drag={i:+el.getAttribute('data-i'), p:+el.getAttribute('data-p')}; try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain','x'); }catch(_){} var pr=el.closest('.ed-parca'); if(pr) pr.classList.add('ed-suruk'); _dragY=e.clientY; if(!_dragRaf) _dragRaf=requestAnimationFrame(_autoScrollTick); });
      el.addEventListener('dragend', function(){ _drag=null; if(_dragRaf){ cancelAnimationFrame(_dragRaf); _dragRaf=0; } root.querySelectorAll('.ed-suruk,.ed-ust,.ed-alt').forEach(function(x){ x.classList.remove('ed-suruk','ed-ust','ed-alt'); }); });
    });
    root.querySelectorAll('.ed-parca').forEach(function(pr){
      pr.addEventListener('dragover', function(e){ if(!_drag) return; var ci=+pr.getAttribute('data-i'); if(ci!==_drag.i) return; e.preventDefault(); var r=pr.getBoundingClientRect(); var ust=e.clientY < r.top+r.height/2; pr.classList.toggle('ed-ust',ust); pr.classList.toggle('ed-alt',!ust); });
      pr.addEventListener('dragleave', function(){ pr.classList.remove('ed-ust','ed-alt'); });
      pr.addEventListener('drop', function(e){ if(!_drag) return; var ci=+pr.getAttribute('data-i'); if(ci!==_drag.i){ return; } e.preventDefault(); var pk=+pr.getAttribute('data-p'); var r=pr.getBoundingClientRect(); var ust=e.clientY < r.top+r.height/2; XE._parcaTasi(ci, _drag.p, pk+(ust?0:1)); });
    });
  };

  // Parçayı 'from' konumundan 'to' konumuna taşı (aynı kart).
  XE._parcaTasi = function(i, from, to){
    var b=XE.belge.birimler[i]; if(!b||!b.item||!b.item.parcalar) return;
    var a=b.item.parcalar; if(from<0||from>=a.length) return;
    var t=to; if(from<t) t--; if(t<0) t=0; if(t>a.length-1) t=a.length-1;   // kaldırma SONRASI son indeks
    if(t===from){ return; }   // [6] no-op: aynı konuma bırakma -> undo adımı ekleme
    XE._pushUndo();
    var el=a.splice(from,1)[0];
    a.splice(t,0,el); XE._ovSet(i); XE._ciz();
  };

  XE._sil = async function(i){
    var B=XE.belge.birimler||[]; if(i<0||i>=B.length) return;
    XE._pushUndo();
    var it=B[i].item;
    XE._dirty=true;   // E1: silme de değişikliktir
    // [VERİ KAYBI FİX] Bu SON bölümse silmek raporu BOŞALTIR. XE._sil, deleteManualItem'ın remaining===0
    // açık-boşaltma onayını ATLIYORDU -> boş-ezme koruması boş kaydı engelleyip silmeyi GERİ ALIYORDU
    // (kullanıcı: tek bölümü sildim, galeride + aç-kapa'da GERİ GELDİ). Son bölümde onayı ver. (_sonOge yanlış
    // pozitifi zararsız: onay yalnız BOŞ build'e izin verir; içerik varsa boş build olmaz.)
    var _sonOge = (B.length === 1);
    function _bosaltOnay(){ if(_sonOge && window.xBosaltOnayVer){ try{ window.xBosaltOnayVer(); }catch(e){} } }
    if(it && it.manual){   // #2: manuel blok -> __xManualClusters'tan çıkar
      var mc=manuelStore(); for(var m=0;m<mc.length;m++){ if(mc[m].item.uid===it.uid){ mc.splice(m,1); break; } }
      _bosaltOnay();
      XE._yenidenPlanla(); return;
    }
    var idx=(it && it.index);
    if(idx!=null){
      // Havuz tabanlı öğe: SUNUCUDAN da sil (yoksa Kaydet/Önizle havuzu okuyunca öğe GERİ GELİR).
      _busy=true;   // [5] uçuştayken geri/ileri reddedilsin
      try{
        try{ await fetch('/api/manual/delete/'+idx, { method:'POST' }); }catch(e){}
        try{ if(window.XLocalImages && window.XLocalImages.remove && it.link){ window.XLocalImages.remove(it.link); } }catch(e){}
        _bosaltOnay();   // son havuz öğesi silindi -> boş kayda izin
        await XE.ac({});   // havuz yeniden indexlendi -> taze havuzdan kur (indexler güncel kalsın)
      } finally { _busy=false; }
      return;
    }
    // Havuz tabanlı değil (Word Düzenle dış öğeleri) -> yalnız bellekten çıkar.
    var kalan=[], j; for(j=0;j<B.length;j++){ if(j!==i && B[j].item) kalan.push(B[j].item); }
    _bosaltOnay();
    _busy=true; try{ await XE.ac({ items: kalan }); } finally { _busy=false; }
  };

  XE._kaydir = function(idx){
    var root=document.getElementById('editor-root'); if(!root) return;
    var B=XE.belge.birimler||[], hedef=-1, i;
    for(i=0;i<B.length;i++){ if(B[i].item && B[i].item.index===idx){ hedef=i; break; } }
    if(hedef<0) hedef=Math.max(0, Math.min(B.length-1, idx|0));
    var card=root.querySelector('.ed-card[data-i="'+hedef+'"]'); if(card) card.scrollIntoView({behavior:'smooth', block:'start'});
  };

  // toItems: YALNIZ havuz öğeleri (manuel bloklar hariç -> onlar __birimler ile docx'e gider, gruplamaya girmez).
  XE.toItems = function(){ return (XE.belge.birimler||[]).map(function(b){ return b.item; }).filter(function(it){ return it && (!it.manual || edManual(it.link)); }); };   // B7: birleşik xmanual:// öğeler gerçek havuz öğesi -> gruplamaya girer; YALNIZ eski (link='') manuel bloklar hariç
  XE.toStyleOpts = function(){ return stilOku(); };
  // #2: docx üretiminde editörün GÖRÜNÜMÜNÜ birebir kullan (manuel bloklar + taşımalar dahil).
  XE.docxOpts = function(){ return Object.assign({}, XE.toStyleOpts(), { __birimler: (XE.belge.birimler||[]) }); };
  // [5/7/12]: Editör KAPALIYKEN panel Kaydet/İndir için taze birimler kur (canlı belge/DOM'a dokunMADAN):
  // havuz öğelerini planla + overlay (parcalar/h2/grup) geri yükle + eski __xManualClusters bloklarını enjekte et.
  // Böylece eski (link='') manuel bloklar docx'e GİRER (yoksa __birimler'siz plan onları atlar).
  XE.buildBirimler = async function(items, stil){
    var plan = await XE.planGetir(items||null, stil||stilOku());
    var B = (plan && plan.birimler) || [];
    B.forEach(function(b,i){ if(!b || !b.item) return;
      if(!b.item.uid) b.item.uid=((b.item.link||'oge'))+'#'+i;
      parcaKur(b.item);
      var ov=ovStore().byLink[ovKey(b.item.link)];
      if(ov){ if(ov.parcalar && ov.parcalar.length) b.item.parcalar=JSON.parse(JSON.stringify(ov.parcalar)); if(ov.h2!=null && b.h2!=null){ b.item.h2_override=ov.h2; b.h2=ov.h2; } if(ov.grup!=null){ b.item.group_override=ov.grup; } if(ov.h1over!=null){ b.item.h1_override=ov.h1over; if(b.h1!=null) b.h1=ov.h1over; } if(ov.h1ov){ b.item.h1_ov=ov.h1ov; b.h1ov=ov.h1ov; } if(ov.h2ov){ b.item.h2_ov=ov.h2ov; b.h2ov=ov.h2ov; } }
    });
    // XE._manuelEkle ile AYNI enjeksiyon (ama canlı belge yerine bu B dizisi üzerinde).
    var mc=manuelStore();
    mc.forEach(function(entry){ var it=entry.item;
      var birim={ h1:null, h2:String(it.h2_override!=null ? it.h2_override : ''), item:it, link:'', son:true, manual:true, grup:'m-'+it.uid, grupBaslik:(it.h2_override||'') };
      var pos=B.length;
      if(entry.afterUid===''){ pos=0; }
      else { for(var i=0;i<B.length;i++){ if(B[i].item && B[i].item.uid===entry.afterUid){ pos=i+1; break; } } }
      B.splice(pos, 0, birim);
    });
    return B;
  };

  XE.indir = async function(){
    try {
      if(!window.XLocalDocx) throw new Error('x-local-docx.js yüklü değil');
      var blob=await window.XLocalDocx.generateBlob(XE.docxOpts(), XE.toItems());
      var ad=(typeof window.xIndirmeDosyaAdi==='function') ? window.xIndirmeDosyaAdi() : 'GörüntüX.docx';
      var url=URL.createObjectURL(blob); var a=document.createElement('a');
      a.href=url; a.download=ad; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function(){ try{ URL.revokeObjectURL(url); }catch(e){} }, 1500);
      if(typeof window.showToast==='function') window.showToast('Word indirildi: '+ad, 'success');
    } catch(e){ alert('İndirilemedi: '+(e&&e.message||e)); }
  };

  try { console.log('[XEditor] Faz 4c yüklendi (v'+XE.VERSION+').'); } catch(e){}
})();
'''


@app.route('/x-editor.js', methods=['GET'])
def x_editor_js():
    return _js_yanit(X_EDITOR_JS)

# ----------------- FLASK FRONTEND ROUTES -----------------
@app.route('/', methods=['GET'])
def index():
    return render_template_string(HTML_TEMPLATE, fonts=WORD_POPULER_FONTLAR)

# Faz 3: rapor URL'leri /<slug> -> SPA'yı sun; istemci router pathname slug'ından raporu açar.
# TEK segment (slug / içermez) -> /api/... (çok segment) ve /x-*.js (exact route) buraya DÜŞMEZ.
# Nokta içeren yollar (favicon.ico vb. asset istekleri) SPA'ya yönlenmez -> 404.
@app.route('/<slug>', methods=['GET'])
def spa_slug(slug):
    if '.' in slug:
        return ('', 404)
    return render_template_string(HTML_TEMPLATE, fonts=WORD_POPULER_FONTLAR)

@app.route('/api/tweet/oembed', methods=['GET'])
def get_tweet_oembed():
    tweet_url = request.args.get('url')
    theme = request.args.get('theme', 'dark')
    if not tweet_url:
        return jsonify({"error": "Missing url parameter"}), 400
    try:
        response = requests.get(
            f"https://publish.twitter.com/oembed?url={tweet_url}&theme={theme}&omit_script=true",
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
            timeout=5
        )
        if response.status_code == 200:
            return jsonify(response.json())
        else:
            return jsonify({"error": f"Failed to fetch oEmbed, status {response.status_code}"}), response.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/status', methods=['GET'])
def get_status():
    job = get_client_job()
    pool = get_client_pool()
    heartbeat = job.get("last_extension_heartbeat", 0.0)
    # Eklenti her 2 sn heartbeat gönderir; kısa boşluklara (sayfa geçişi, SW yeniden başlaması)
    # dayanmak için eşiği 20 sn tutuyoruz. Böylece eklenti canlıyken panel "bekleniyor"a düşmez.
    is_connected = (time.time() - heartbeat) < 20.0
    return jsonify({
        "status": job["status"],
        "results_count": job["results_count"],
        "total_count": job["total_count"],
        "is_connected": is_connected,
        # Panelin sundugu .zip'teki surum. Panel bunu KURULU surumle (bridge.js'in
        # yazdigi data-x-rapor-version) kiyaslayip "guncelle" uyarisi gosterir.
        "ext_latest_version": EKLENTI_SURUMU,
        "start_time": job.get("start_time", 0.0),
        "end_time": job.get("end_time", 0.0),
        # [13]: sunucunun efektif birlesme bayragi -> istemci unifyOn() bunu okur (localStorage'tan
        # bagimsiz). X_UNIFY_MANUAL=0 ise ozellik tum tarayicilarda kapanir (airtight geri alma).
        "unify_manual": bool(X_UNIFY_MANUAL),
        "manuel_count": len(pool),
        "manuel_list": [
            {
                "index": i + 1,
                "title": item["title"],
                "link": item["link"] or "",
                "has_image": bool(item["image"]),
                "is_profile": bool(item.get("is_profile", False)),
                "group": pool_group_key(item)
            }
            for i, item in enumerate(pool)
        ]
    })

@app.route('/api/pool/data', methods=['GET'])
def pool_data():
    # İstemci-taraflı (tarayıcıda) Word üretimi için havuzun tam verisini döndürür.
    # Görselleri base64 olarak gömer; böylece panel, sunucuya yük bindirmeden .docx üretebilir.
    # NOT: client_id gönderilmediği için get_client_id() remote_addr'e düşer — bu, sunucu
    # tarafı /api/*/generate ile AYNI havuzu okumayı garanti eder (birebir aynı çıktı).
    pool = get_client_pool()
    items = []
    for _pi, item in enumerate(pool):
        img_b64 = ""
        img_mime = ""
        fp = item.get("image")
        if fp and os.path.exists(fp):
            try:
                with open(fp, "rb") as f:
                    raw = f.read()
                # Gerçek formatı bayt imzasından tespit et (dosya adı .jpg olsa da içerik PNG olabilir).
                if raw[:8].startswith(b'\x89PNG'):
                    img_mime = "image/png"
                elif raw[:3] == b'\xff\xd8\xff':
                    img_mime = "image/jpeg"
                else:
                    img_mime = "image/jpeg"
                img_b64 = base64.b64encode(raw).decode("ascii")
            except Exception:
                pass
        items.append({
            # v3.84: FLAT havuz pozisyonu (1-tabanli) — onizlemede oge silme icin. manual_delete
            # pool[index-1] ile pozisyona gore siliyor; onizleme silme butonu bunu kullanir.
            "index": _pi + 1,
            "title": item.get("title", "") or "",
            "link": item.get("link", "") or "",
            "is_profile": bool(item.get("is_profile", False)),
            # v3.75: RT'li tweet grubu icin. Tarayici .docx ureticisi (LOCAL_DOCX_JS gruplama
            # dongusu) bunu link'ten turetilen sahibe TERCIH eder -> RT yapanin altinda gruplar.
            "group_override": item.get("group_override", "") or "",
            "image_b64": img_b64,
            "image_mime": img_mime
        })
    return jsonify({"items": items})

@app.route('/api/manual/add', methods=['POST'])
def manual_add():
    try:
        data = request.json or {}
        title = data.get("title", "").strip()
        link = x_temizle_link(data.get("link", "").strip())
        image_data = data.get("image", "")
        is_profile = bool(data.get("is_profile", False))
        is_local = bool(data.get("local", False))
        group_override = (data.get("group_override") or "").strip()

        pool = get_client_pool()

        # Eklentideki "Rapora Ekle" butonu dedup ister (dedup=True gonderir). Ayni link
        # havuzda zaten varsa IKINCI KEZ EKLEME -> "duplicate" doner, kullaniciya "zaten
        # havuzda" uyarisi gosterilir. Panelin elle ekleme yolu (addManualContent) dedup
        # GONDERMEZ -> davranisi birebir korunur.
        if data.get("dedup") and link:
            norm = normalize_link_key(link)
            for it in pool:
                if it.get("link") and normalize_link_key(it["link"]) == norm:
                    return jsonify({"status": "duplicate", "message": "Bu içerik zaten havuzda."})

        # v3.75: YEREL MOD. "Rapora Ekle" gorselleri SUNUCUYA GELMEZ; eklenti tarayicidaki
        # IndexedDB'ye birakir (word taramasinin xStripForServer yolunun aynisi -> tikanikligi
        # geri getirmemek icin). local=True ise gorsel beklenmez; havuz ogesi yalnizca
        # baslik+link tasir, gorsel panelde link'e gore IndexedDB'den cozulur.
        filepath = None
        if is_local:
            pass
        else:
            if not image_data or not image_data.startswith("data:image/"):
                return jsonify({"status": "error", "message": "Geçersiz görsel verisi."})
            base64_str = image_data.split(",")[1]
            gorsel_bytes = base64.b64decode(base64_str)
            filepath = save_temp_image(gorsel_bytes)

        title_formatted = baslik_formatla(title)
        item = {
            "title": title_formatted if title_formatted else "",
            "image": filepath,
            "link": link if link else None
        }
        if is_profile:
            item["is_profile"] = True
        # RT'li tweet: RT YAPAN hesabin altinda gruplansin (kullanici karari). Widget
        # socialContext'ten RT yapanin @kullanici adini cikarip gonderir. pool_group_key
        # bunu link'ten turetilen sahibe TERCIH eder.
        if group_override:
            item["group_override"] = group_override
        # FIX-POS (havuz birlesmesi): editor "+" bir bolumu ARALARA ekleyebilsin diye istege bagli
        # konumlu ekleme. after_index 0-tabanli gecerli bir konumsa oraya sokulur, degilse sona eklenir
        # (widget/panel eski davranis: after_index gondermez -> append). Mevcut pozisyonlar korunur.
        after_index = data.get("after_index", None)
        if isinstance(after_index, int) and 0 <= after_index <= len(pool):
            pool.insert(after_index, item)
        else:
            pool.append(item)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

@app.route('/api/manual/reorder', methods=['POST'])
def manual_reorder():
    # Panelden gelen yeni sıraya göre havuzu yeniden dizer. 'order', mevcut 0-tabanlı
    # indekslerin (0..n-1) bir permütasyonudur. Aynı liste nesnesini yerinde güncelleriz.
    pool = get_client_pool()
    data = request.json or {}
    order = data.get("order", [])
    n = len(pool)
    try:
        order = [int(x) for x in order]
    except Exception:
        return jsonify({"status": "error", "message": "Geçersiz sıralama."})
    if sorted(order) != list(range(n)):
        return jsonify({"status": "error", "message": "Sıralama havuzla uyuşmuyor."})
    pool[:] = [pool[i] for i in order]
    return jsonify({"status": "success"})

@app.route('/api/manual/delete/<int:index>', methods=['POST'])
def manual_delete(index):
    try:
        pool = get_client_pool()
        list_idx = index - 1
        if 0 <= list_idx < len(pool):
            item = pool[list_idx]
            img_val = item.get("image")
            if isinstance(img_val, str) and os.path.exists(img_val):
                try:
                    os.remove(img_val)
                except:
                    pass
            pool.pop(list_idx)
            return jsonify({"status": "success", "message": "Icerik silindi.", "remaining": len(pool)})
        return jsonify({"status": "error", "message": "Gecersiz dizin."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

@app.route('/api/manual/image/<int:index>', methods=['GET'])
def manual_image(index):
    try:
        pool = get_client_pool()
        list_idx = index - 1
        if 0 <= list_idx < len(pool):
            item = pool[list_idx]
            img_val = item.get("image")
            if img_val:
                # Bytes (bellekte görsel) -> doğrudan gönder.
                if isinstance(img_val, (bytes, bytearray)):
                    return send_file(io.BytesIO(img_val), mimetype="image/png")
                # Dosya yolu -> varsa gönder, yoksa 404 (500 ile çökme!).
                if isinstance(img_val, str):
                    if os.path.exists(img_val):
                        return send_file(img_val)
                    print(f"[manual_image] Dosya yok (index={index}): {img_val}", flush=True)
        return "Resim bulunamadi", 404
    except Exception as e:
        print(f"[manual_image] hata (index={index}): {e}", flush=True)
        return str(e), 500

@app.route('/api/manual/clear', methods=['POST'])
def manual_clear():
    pool = get_client_pool()
    for item in pool:
        img_val = item.get("image")
        if isinstance(img_val, str) and os.path.exists(img_val):
            try:
                os.remove(img_val)
            except:
                pass
    pool.clear()
    
    # Also reset active job status back to idle so completion screens and timers clear
    job = get_client_job()
    job["status"] = "idle"
    job["job_id"] = None
    job["tweet_urls"] = []
    job["results"] = []
    job["results_count"] = 0
    job["total_count"] = 0
    
    return jsonify({"status": "success"})

@app.route('/api/manual/generate', methods=['POST'])
def manual_generate():
    # Faz 4 (tam kaldırma): sunucu-taraflı Word üretimi EMEKLİYE ayrıldı; rapor artık YALNIZCA
    # tarayıcıda (client-side XLocalDocx) üretilir. Aşağıdaki eski gövde ölü koddur (git geçmişi +
    # backup/server-fallbacks-pre-hard-removal dalında korunuyor). "Word Düzenle" (upload_format) ayrıdır, çalışır.
    return jsonify({"status": "error", "message": "Sunucu Word üretimi emekliye ayrıldı; rapor tarayıcıda üretilir."}), 410
    try:
        b_font = request.form.get("b_font", "Arial")
        b_size = int(request.form.get("b_size", 14))
        b_color = request.form.get("b_color", "#000000")
        b_numbered = request.form.get("b_numbered") == "true"
        b_bold = request.form.get("b_bold") == "true"
        b_italic = request.form.get("b_italic") == "true"
        b_underline = request.form.get("b_underline") == "true"

        l_font = request.form.get("l_font", "Calibri")
        l_size = int(request.form.get("l_size", 10))
        l_color = request.form.get("l_color", "#1DA1F2")
        l_underline = request.form.get("l_underline") == "true"

        doc = docx.Document()
        belgenin_fontunu_ayarla(doc, b_font)
        
        # Margins
        for section in doc.sections:
            section.top_margin = Inches(0.5)
            section.bottom_margin = Inches(0.5)
            section.left_margin = Inches(0.75)
            section.right_margin = Inches(0.75)

        groups = {}
        order = []
        
        for item in get_client_pool():
            link = item.get("link", "")
            username = tweet_kullanici_adi_oku(link)

            # For Instagram links, the username is usually stored in the 'title' property of the item,
            # especially if we couldn't extract it from the URL. Let's use the title as the grouping key
            # if it looks like an Instagram link and the title has a username format.
            if not username and link and "instagram.com" in link.lower():
                item_title = item.get("title", "").strip()
                if item_title:
                    # We can use the item title (which for IG is the username or account name) as the grouping key.
                    username = item_title.lower()
                else:
                    # If the frontend failed to get a username and left title empty
                    username = "@instagram_user"

            if username:
                if username not in groups:
                    # For X/Twitter, the username from URL is lowercase, so let's try to preserve original title if available
                    groups[username] = {
                        "title": item.get("title") or username,
                        "items": []
                    }
                    order.append(("group", username))
                groups[username]["items"].append(item)
            else:
                order.append(("standalone", item))

        header_index = 0

        for key_type, key_value in order:
            if key_type == "group":
                username = key_value
                group_data = groups[username]
                
                if "rendered" in group_data:
                    continue
                group_data["rendered"] = True
                
                # Grup başlığı: en eksiksiz başlığı seç. "Ad (@kullanıcı)" biçimini
                # (parantez içeren) düz "@kullanıcı"ya tercih ederiz.
                baslik_text = ""
                for g_item in group_data["items"]:
                    t = (g_item.get("title") or "").strip()
                    if not t:
                        continue
                    if not baslik_text:
                        baslik_text = t
                    if "(" in t:  # "Ad (@kullanıcı)" biçimi tam başlıktır
                        baslik_text = t
                        break

                # Fallback to username if all titles in group are empty
                if not baslik_text:
                    if not username.startswith("@"):
                        baslik_text = f"@{username}"
                    else:
                        baslik_text = username

                header_index += 1
                if b_numbered:
                    baslik_text = f"{header_index}. {baslik_text}"

                p_head = doc.add_paragraph()
                p_head.style = doc.styles['Heading 2']
                p_head.paragraph_format.space_after = Pt(6)
                run_head = p_head.add_run(baslik_text)
                stili_uygula(run_head, b_font, b_size, b_color, bold=b_bold, italic=b_italic, underline=b_underline)

                # Grup içi sıralama artık HAVUZ SIRASINI izler (kullanıcı panelden sürükleyerek
                # düzenleyebilir). Profil kartı normal akışta ilk yakalandığı için zaten en üste
                # gelir; istenirse sürükleyerek değiştirilebilir.
                ordered_items = group_data["items"]

                for idx, g_item in enumerate(ordered_items):
                    if g_item["image"]:
                        gorsel_ekle_ve_boyutlandir(doc, g_item["image"])

                    p_link = doc.add_paragraph()
                    if idx < len(ordered_items) - 1:
                        p_link.paragraph_format.space_after = Pt(12)
                    else:
                        p_link.paragraph_format.space_after = Pt(18)

                    if g_item["link"]:
                        link_ekle_hyperlink(p_link, g_item["link"], g_item["link"], l_font, l_size, l_color, underline=l_underline)

                    if idx == len(ordered_items) - 1:
                        cizgi_ekle(p_link)
            
            elif key_type == "standalone":
                item = key_value
                baslik_text = item["title"]
                
                if baslik_text:
                    header_index += 1
                    if b_numbered:
                        baslik_text = f"{header_index}. {baslik_text}"
                    
                    p_head = doc.add_paragraph()
                    p_head.style = doc.styles['Heading 2']
                    p_head.paragraph_format.space_after = Pt(6)
                    run_head = p_head.add_run(baslik_text)
                    stili_uygula(run_head, b_font, b_size, b_color, bold=b_bold, italic=b_italic, underline=b_underline)
                
                if item["image"]:
                    gorsel_ekle_ve_boyutlandir(doc, item["image"])
                
                p_link = doc.add_paragraph()
                p_link.paragraph_format.space_after = Pt(18)
                if item["link"]:
                    link_ekle_hyperlink(p_link, item["link"], item["link"], l_font, l_size, l_color, underline=l_underline)
                cizgi_ekle(p_link)

        # Clear memory unless specified otherwise
        clear_memory = request.form.get("clear", "true") == "true"
        if clear_memory:
            get_client_pool().clear()

        m_output = io.BytesIO()
        doc.save(m_output)
        m_output.seek(0)

        return send_file(
            m_output,
            mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            as_attachment=True,
            download_name="GörüntüX_Toplu.docx"
        )
    except Exception as e:
        return f"Hata oluştu: {str(e)}", 500

@app.route('/api/auto/start', methods=['POST'])
def auto_start():
    data = request.json or {}
    urls = data.get("urls", [])
    if not urls:
        return jsonify({"status": "error", "message": "Tweet linki bulunamadı."})

    job = get_client_job()
    job["job_id"] = f"job_{int(time.time())}"
    job["scrape_mode"] = "word"
    job["tweet_urls"] = urls
    job["results"] = []
    job["results_count"] = 0
    job["total_count"] = len(urls)
    job["status"] = "running"
    job["start_time"] = time.time()
    
    # Yeni otomasyon başladığında havuzu temizle.
    # B8 (havuz birlesmesi): X_UNIFY_MANUAL acikken havuzu TEMIZLEME -> editor "+" ile kurulan
    # manuel bolumler + eklenti "Rapora Ekle" ogeleri + onceki sonuclar KORUNUR; yeni tarama
    # AYNI havuza eklenir (kullanici: "Baslat deyince de o ayni havuza eklensin").
    pool = get_client_pool()
    if not X_UNIFY_MANUAL:
        pool.clear()

    return jsonify({"status": "success", "job_id": job["job_id"]})

@app.route('/api/auto/reset', methods=['POST'])
def auto_reset():
    job = get_client_job()
    job["status"] = "idle"
    job["job_id"] = None
    job["tweet_urls"] = []
    job["results"] = []
    job["results_count"] = 0
    job["total_count"] = 0
    return jsonify({"status": "success"})

@app.route('/api/auto/generate', methods=['POST'])
def auto_generate():
    return manual_generate()

@app.route('/api/upload/format', methods=['POST'])
def upload_format():
    try:
        uploaded_files = request.files.getlist("doc_file")
        if not uploaded_files or (len(uploaded_files) == 1 and uploaded_files[0].filename == ""):
            return "Dosya yüklenmedi", 400

        # Natural sort helper to ensure correct numeric order (e.g., 1.docx, 2.docx, 10.docx)
        def natural_sort_key(file_obj):
            filename = file_obj.filename or ""
            return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', filename)]

        uploaded_files = sorted([f for f in uploaded_files if f and f.filename], key=natural_sort_key)

        b_font = request.form.get("b_font", "Arial")
        b_size = int(request.form.get("b_size", 14))
        b_color = request.form.get("b_color", "#000000")
        b_numbered = request.form.get("b_numbered") == "true"
        b_bold = request.form.get("b_bold") == "true"
        b_italic = request.form.get("b_italic") == "true"
        b_underline = request.form.get("b_underline") == "true"

        l_font = request.form.get("l_font", "Calibri")
        l_size = int(request.form.get("l_size", 10))
        l_color = request.form.get("l_color", "#1DA1F2")
        l_underline = request.form.get("l_underline") == "true"

        yeni_doc = docx.Document()
        belgenin_fontunu_ayarla(yeni_doc, b_font)
        
        # Margins
        for section in yeni_doc.sections:
            section.top_margin = Inches(0.5)
            section.bottom_margin = Inches(0.5)
            section.left_margin = Inches(0.75)
            section.right_margin = Inches(0.75)

        tüm_ögeler = []
        file_stats = []
        total_input_links = 0

        for uploaded_file in uploaded_files:
            if not uploaded_file or uploaded_file.filename == "":
                continue
            try:
                orjinal_doc = docx.Document(uploaded_file)
            except Exception as e:
                print(f"[upload_format] Hata (dosya okunamadı): {e}", flush=True)
                continue

            file_link_count = 0

            # Extract images from this file's rels
            images_dict = {}
            for rel in orjinal_doc.part.rels.values():
                if "image" in rel.target_ref:
                    images_dict[rel.rId] = rel.target_part.blob

            dosya_ögeleri = []
            gecici_oge = {"baslik": "", "gorsel_blob": None, "link": None}

            for p in orjinal_doc.paragraphs:
                text = iter_paragraphs_with_hyperlinks(p)
                has_drawing = "w:drawing" in p._p.xml

                if not text and not has_drawing:
                    continue

                is_link = "twitter.com" in text or "x.com" in text or text.startswith("http")
                if is_link:
                    file_link_count += 1

                extracted_rid = None
                if has_drawing:
                    match = re.search(r'r:embed="([^"]+)"', p._p.xml)
                    if match:
                        extracted_rid = match.group(1)

                if is_link:
                    gecici_oge["link"] = text
                    if gecici_oge.get("gorsel_id") and gecici_oge["gorsel_id"] in images_dict:
                        gecici_oge["gorsel_blob"] = images_dict[gecici_oge["gorsel_id"]]
                    gecici_oge.pop("gorsel_id", None)
                    dosya_ögeleri.append(gecici_oge)
                    gecici_oge = {"baslik": "", "gorsel_blob": None, "link": None}
                    continue

                if has_drawing and extracted_rid:
                    if gecici_oge.get("gorsel_id") or gecici_oge.get("gorsel_blob"):
                        if gecici_oge.get("gorsel_id") and gecici_oge["gorsel_id"] in images_dict:
                            gecici_oge["gorsel_blob"] = images_dict[gecici_oge["gorsel_id"]]
                        gecici_oge.pop("gorsel_id", None)
                        dosya_ögeleri.append(gecici_oge)
                        gecici_oge = {"baslik": gecici_oge["baslik"], "gorsel_blob": images_dict.get(extracted_rid), "link": None}
                    else:
                        gecici_oge["gorsel_id"] = extracted_rid

                if text and not is_link:
                    if gecici_oge.get("gorsel_id") or gecici_oge.get("gorsel_blob") or gecici_oge["link"]:
                        if not gecici_oge["link"]:
                            if gecici_oge.get("gorsel_id") and gecici_oge["gorsel_id"] in images_dict:
                                gecici_oge["gorsel_blob"] = images_dict[gecici_oge["gorsel_id"]]
                            gecici_oge.pop("gorsel_id", None)
                            dosya_ögeleri.append(gecici_oge)
                            gecici_oge = {"baslik": text, "gorsel_blob": None, "link": None}
                        else:
                            gecici_oge["baslik"] += " " + text
                    else:
                        if text.startswith("@") and gecici_oge["baslik"]:
                            gecici_oge["baslik"] += f" {text}"
                        elif not gecici_oge["baslik"]:
                            gecici_oge["baslik"] = text
                        else:
                            gecici_oge["baslik"] += " " + text

            # Append last item for this file
            if gecici_oge["baslik"] or gecici_oge.get("gorsel_id") or gecici_oge.get("gorsel_blob") or gecici_oge["link"]:
                if gecici_oge.get("gorsel_id") and gecici_oge["gorsel_id"] in images_dict:
                    gecici_oge["gorsel_blob"] = images_dict[gecici_oge["gorsel_id"]]
                gecici_oge.pop("gorsel_id", None)
                dosya_ögeleri.append(gecici_oge)

            gecerli_ögeler = [o for o in dosya_ögeleri if o["baslik"].strip() or o["gorsel_blob"]]
            tüm_ögeler.extend(gecerli_ögeler)

            file_stats.append({
                "filename": uploaded_file.filename,
                "link_count": file_link_count
            })
            total_input_links += file_link_count

        # Deduplicate items to prevent duplicate tweets in the final output
        unique_items = []
        seen_links = set()
        for oge in tüm_ögeler:
            link = oge.get("link")
            if link:
                norm_link = link.strip().lower()
                norm_link = norm_link.split('?')[0].rstrip('/')
                if norm_link not in seen_links:
                    seen_links.add(norm_link)
                    unique_items.append(oge)
            else:
                unique_items.append(oge)

        output_link_count = len(seen_links)

        header_index = 0
        for i, oge in enumerate(unique_items):
            baslik_raw = oge["baslik"].strip() if oge["baslik"] else ""
            
            if baslik_raw:
                baslik_text = baslik_formatla(baslik_raw)
                header_index += 1
                if b_numbered:
                    baslik_text = f"{header_index}. {baslik_text}"

                p_head = yeni_doc.add_paragraph()
                p_head.style = yeni_doc.styles['Heading 2']
                p_head.paragraph_format.space_after = Pt(6)
                run_head = p_head.add_run(baslik_text)
                stili_uygula(run_head, b_font, b_size, b_color, bold=b_bold, italic=b_italic, underline=b_underline)

            if oge.get("gorsel_blob"):
                gorsel_ekle_ve_boyutlandir(yeni_doc, oge["gorsel_blob"])

            p_link = yeni_doc.add_paragraph()
            p_link.paragraph_format.space_after = Pt(18)
            if oge["link"]:
                link_ekle_hyperlink(p_link, oge["link"], oge["link"], l_font, l_size, l_color, underline=l_underline)
            # Alt cizgi (divider) YALNIZ bir baslik grubunun SON ogesine konur -> tarayici ureticisiyle
            # (LOCAL_DOCX_JS 'son' bayragi: son:(k===ordered.length-1)) AYNI davranis. Grup biter:
            # sonraki oge YENI bir baslik baslatiyorsa VEYA bu son oge ise. Eskiden HER link altina
            # konuyordu (bug: cok gonderili yazarda her posta cizgi; kullanici bildirdi).
            sonraki_yeni_baslik = (i + 1 < len(unique_items)) and bool(
                unique_items[i + 1]["baslik"] and unique_items[i + 1]["baslik"].strip())
            if (i + 1 == len(unique_items)) or sonraki_yeni_baslik:
                cizgi_ekle(p_link)

        output = io.BytesIO()
        yeni_doc.save(output)
        output.seek(0)

        response = send_file(
            output,
            mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            as_attachment=True,
            download_name="GörüntüX_Birlesik.docx"
        )

        import json
        import base64
        stats_json = json.dumps(file_stats)
        stats_b64 = base64.b64encode(stats_json.encode('utf-8')).decode('utf-8')

        response.headers['X-Merge-Total-Links'] = str(total_input_links)
        response.headers['X-Merge-Output-Links'] = str(output_link_count)
        response.headers['X-Merge-File-Stats'] = stats_b64
        response.headers['Access-Control-Expose-Headers'] = 'X-Merge-Total-Links, X-Merge-Output-Links, X-Merge-File-Stats'

        return response
    except Exception as e:
        return f"Hata oluştu: {str(e)}", 500

@app.route('/api/extension/download_zip', methods=['GET'])
def download_extension_zip():
    zip_data = eklenti_zip_olustur()
    if zip_data:
        return send_file(
            io.BytesIO(zip_data),
            mimetype="application/zip",
            as_attachment=True,
            download_name="GörüntüX.zip"
        )
    return "Eklenti dosyaları bulunamadı", 404

# ----------------- CHROME EXTENSION API ENDPOINTS -----------------
@app.route('/api/extension/poll_job', methods=['GET'])
def poll_job():
    job = get_client_job()
    job["last_extension_heartbeat"] = time.time()
    if job["status"] == "running" and job["tweet_urls"]:
        return jsonify({
            "status": "success",
            "job": {
                "job_id": job["job_id"],
                "scrape_mode": "word",
                "tweet_urls": job["tweet_urls"]
            }
        })
    return jsonify({"status": "no_job"})

@app.route('/api/extension/heartbeat', methods=['GET', 'POST'])
def extension_heartbeat():
    # Eklenti aktif görev sürerken bile bunu düzenli çağırır; panelin "Eklenti bekleniyor"
    # durumuna düşmemesi için yalnızca son görülme zamanını günceller.
    job = get_client_job()
    job["last_extension_heartbeat"] = time.time()
    return jsonify({"status": "success"})

@app.route('/api/extension/update_progress', methods=['POST'])
def update_progress():
    job = get_client_job()
    job["last_extension_heartbeat"] = time.time()
    data = request.json or {}
    job_id = data.get("job_id")
    if job["status"] == "idle" or (job_id and job["job_id"] != job_id):
        print(f"[update_progress] REDDEDILDI (cancelled): gelen_job_id={job_id}, sunucu_job_id={job.get('job_id')}, sunucu_status={job.get('status')}", flush=True)
        return jsonify({"status": "cancelled", "message": "Gorev iptal edildi."})
    job["results_count"] = data.get("current", 0)
    job["total_count"] = data.get("total", 0)
    return jsonify({"status": "success"})

@app.route('/api/extension/submit_word_result', methods=['POST'])
def submit_word_result():
    job = get_client_job()
    pool = get_client_pool()
    job["last_extension_heartbeat"] = time.time()
    data = request.json or {}
    job_id = data.get("job_id")
    if job["status"] == "idle" or (job_id and job["job_id"] != job_id):
        print(f"[submit_word_result] REDDEDILDI (cancelled): gelen_job_id={job_id}, sunucu_job_id={job.get('job_id')}, sunucu_status={job.get('status')}, final={data.get('final')}", flush=True)
        return jsonify({"status": "cancelled", "message": "Gorev iptal edildi."})

    results = data.get("results", [])
    is_final = data.get("final", False)
    
    # Append results incrementally to active_job results
    if "results" not in job or not job["results"]:
        job["results"] = []
    
    for res in results:
        # Check if we already have this in active_job["results"]
        link = x_temizle_link(res.get("link", ""))
        norm_link = normalize_link_key(link)
        res_copy = res.copy()
        if "screenshot" in res_copy:
            del res_copy["screenshot"]
        dup_job = any(normalize_link_key(r.get("link", "")) == norm_link for r in job["results"])
        if not dup_job:
            job["results"].append(res_copy)
            
        img_b64 = res.get("screenshot", "")
        img_bytes = None
        if img_b64:
            try:
                if "," in img_b64:
                    img_bytes = base64.b64decode(img_b64.split(",")[1])
                else:
                    img_bytes = base64.b64decode(img_b64)
            except Exception:
                pass
        
        account = res.get("account_name", "")
        username = res.get("username", "")
        is_profile = bool(res.get("is_profile", False))
        if account or username:
            if link and "instagram.com" in link.lower():
                title = username if username else account
            elif username and account and username not in account:
                title = f"{account} ({username})"
            else:
                title = account if account else username
        else:
            title = ""
        title_formatted = baslik_formatla(title)
        
        # Check if we already have this in pool
        # For Instagram and bulk tasks, we should update the item if we have more info now!
        # Especially if we have an image and the previous one doesn't.
        # Aynı gönderinin embed/normal varyasyonlarını tek öğede birleştirmek için
        # linkleri normalleştirerek karşılaştırırız.
        dup_item_idx = None
        for i, item in enumerate(pool):
            if normalize_link_key(item.get("link", "")) == norm_link:
                dup_item_idx = i
                break

        if dup_item_idx is not None:
            existing = pool[dup_item_idx]
            # Görsel: mevcut öğede görsel yoksa yeni geleni ekle.
            # [3]: temp dosyayı YALNIZ kullanılacaksa yaz (mevcut öğede görsel VARSA yazma) -> yetim dosya sızmasın.
            if img_bytes and not existing.get("image"):
                existing["image"] = save_temp_image(img_bytes)
            # Başlık: mevcut başlık boş/genel ise gerçek bir kullanıcı adıyla değiştir;
            # ya da mevcut başlık tamamen boşsa yeni geleni yaz.
            if title_formatted:
                if is_generic_title(existing.get("title")) and not is_generic_title(title_formatted):
                    existing["title"] = title_formatted
                elif not existing.get("title"):
                    existing["title"] = title_formatted
            # Profil kartı bilgisini koru: herhangi bir gönderimde profil olarak
            # işaretlenmişse öğeyi profil kartı say.
            if is_profile:
                existing["is_profile"] = True
        else:
            pool.append({
                "title": title_formatted if title_formatted else "",
                "image": (save_temp_image(img_bytes) if img_bytes else None),
                "link": link,
                "is_profile": is_profile
            })
        
    if is_final:
        job["status"] = "completed"
        job["end_time"] = time.time()
        
    print(f"[submit_word_result] {len(results)} sonuc alindi (final={is_final}), toplam havuz: {len(pool)}", flush=True)
    return jsonify({"status": "success"})

@app.route('/api/extension/generate_single', methods=['POST'])
def generate_single():
    # Faz 4 (tam kaldırma): sunucu-taraflı tekil Word üretimi de emekliye ayrıldı.
    return jsonify({"status": "error", "message": "Sunucu Word üretimi emekliye ayrıldı."}), 410
    data = request.json or {}
    tweet_url = data.get("tweet_url", "")
    account_name = data.get("account_name", "")
    username = data.get("username", "")
    screenshot_b64 = data.get("screenshot", "")

    print(f"[generate_single] tweet_url={tweet_url}, account={account_name}", flush=True)

    doc = docx.Document()
    for section in doc.sections:
        section.top_margin = Inches(0.5)
        section.bottom_margin = Inches(0.5)
        section.left_margin = Inches(0.75)
        section.right_margin = Inches(0.75)

    if "instagram.com" in tweet_url.lower():
        baslik_text = username
    elif username and account_name and username not in account_name:
        baslik_text = f"{account_name} ({username})"
    else:
        baslik_text = account_name if account_name else username
    p_head = doc.add_paragraph()
    p_head.style = doc.styles['Heading 2']
    p_head.paragraph_format.space_after = Pt(6)
    run_head = p_head.add_run(baslik_text)
    run_head.font.name = "Arial"
    run_head.font.size = Pt(14)
    run_head.font.bold = True
    run_head.font.color.rgb = RGBColor(0, 0, 0)

    if screenshot_b64:
        try:
            if "," in screenshot_b64:
                img_bytes = base64.b64decode(screenshot_b64.split(",")[1])
            else:
                img_bytes = base64.b64decode(screenshot_b64)
            gorsel_ekle_ve_boyutlandir(doc, img_bytes)
        except Exception as e:
            print(f"[generate_single] GÖRSEL HATASI: {e}", flush=True)

    if tweet_url:
        p_link = doc.add_paragraph()
        p_link.paragraph_format.space_after = Pt(18)
        run_link = p_link.add_run(tweet_url)
        run_link.font.name = "Arial"
        run_link.font.size = Pt(10)
        run_link.font.color.rgb = RGBColor(29, 155, 240)
        run_link.font.underline = True

    # Bottom line
    p_line = doc.add_paragraph()
    p_line.paragraph_format.space_after = Pt(4)
    pPr = p_line._p.get_or_add_pPr()
    pb = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '6')
    bottom.set(qn('w:space'), '1')
    bottom.set(qn('w:color'), 'D0D0D0')
    pb.append(bottom)
    pPr.append(pb)

    m_output = io.BytesIO()
    doc.save(m_output)
    m_output.seek(0)

    file_id = str(uuid.uuid4())
    temp_files[file_id] = {
        "filename": f"GörüntüX_{username.replace('@', '')}.docx",
        "data": m_output.getvalue()
    }

    host = request.host
    download_url = f"http://{host}/api/extension/download/{file_id}"
    print(f"[generate_single] Dosya hazır: {file_id}", flush=True)
    return jsonify({"status": "success", "download_url": download_url})

@app.route('/api/extension/download/<file_id>', methods=['GET'])
def download_file(file_id):
    if file_id in temp_files:
        f_info = temp_files[file_id]
        return send_file(
            io.BytesIO(f_info["data"]),
            mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            as_attachment=True,
            download_name=f_info["filename"]
        )
    return "Dosya bulunamadı", 404

@app.route('/api/extension/log', methods=['POST'])
def extension_log():
    try:
        data = request.json or {}
        msg = data.get('message', '')
        if msg:
            print(f"[eklenti-log] {msg}", flush=True)
    except Exception:
        pass
    return jsonify({"status": "success"})


# ----------------- MAIN RUNNER -----------------
# v3.78: TEK PORT (3011). Eskiden ayni app 3011 (panel) + 3012 (eklenti API) diye IKI portta
# calisiyordu; ayrim islevsel degil GELENEKti (her iki port da tum route'lari sunuyordu).
# Kullanici karari: sunucu her iki portu SUNMASIN. Eklenti de artik API'yi panelin portundan
# (3011) cagiriyor -> hem panel hem eklenti isi TEK PORTTA. 3012 tamamen kaldirildi.
if __name__ == '__main__':
    print("GörüntüX 3011 portunda başlatılıyor (tek port: panel + eklenti API)...", flush=True)
    try:
        app.run(host='0.0.0.0', port=3011, debug=False, threaded=True)
    except KeyboardInterrupt:
        print("Sunucu kapatılıyor...")
