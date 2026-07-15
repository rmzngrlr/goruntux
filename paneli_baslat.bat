@echo off
:: Terminal metin rengini tamamen beyaz yapar, yeşili kaldırır
color 07
title GoruntuX - Otomatik Kurulum ve Ofis Ag Sunucusu
cls

echo ==========================================================
echo    1. ADIM: Gerekli Bagimliliklar Kontrol Ediliyor...
echo ==========================================================
echo.

:: Python ve PIP'in kurulu olduğundan emin olmak için güncel kütüphaneleri yükler/kontrol eder
:: --quiet parametresi ile yükleme ekranındaki gereksiz kalabalığı ve yeşil ilerleme çubuklarını gizler, beyaz kalmasını sağlar.
python -m pip install --upgrade pip --quiet
python -m pip install streamlit python-docx Pillow Flask --quiet

echo [+] Tum kütüphaneler güncel ve hazir!
echo.
echo ==========================================================
echo    2. ADIM: Bilgisayarin Ofis IP Adresi Tespit Ediliyor...
echo ==========================================================
echo.

:: Bilgisayarin yerel agdaki IPv4 adresini otomatik bulur ve 'MY_IP' degiskenine atar
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set "MY_IP=%%a"
    goto :found_ip
)
:found_ip
:: IP adresinin basindaki boslugu temizler
set "MY_IP=%MY_IP:~1%"

echo [+] Bilgisayarinizin Ofis Ici IP Adresi: %MY_IP%
echo [+] Ofisteki diger PC'ler tarayiciya sunu yazmali: http://%MY_IP%:3011
echo ==========================================================
echo.
echo    Uygulama Baslatiliyor... Bu pencereyi kapatmayin.
echo.

python app.py

echo.
echo ==========================================================
echo    Uygulama kapatildi. Yeniden baslatmak icin dosyayi acin.
echo ==========================================================
pause