// [WEBSHOT] GörüntüX toolbar popup'ı (yalnız sosyal-dışı sitelerde; background setPopup ile açılır).
// İki buton: (1) Ekran Görüntüsü Al -> aktif sekmeye webshot.js enjekte et (sayfa üstü kırp aracı);
//            (2) Panele Git -> background goToPanel (mevcut handler).
(function () {
  function kapat() { try { window.close(); } catch (e) {} }

  var panelBtn = document.getElementById('gx-panel');
  var yakalaBtn = document.getElementById('gx-yakala');

  if (panelBtn) panelBtn.addEventListener('click', function () {
    chrome.storage.local.get({ server_origin: "https://goruntux.rgmedya.tr" }, function (res) {
      try {
        chrome.runtime.sendMessage({ action: 'goToPanel', origin: res.server_origin }, function () {
          void chrome.runtime.lastError; kapat();
        });
      } catch (e) { kapat(); }
    });
  });

  if (yakalaBtn) yakalaBtn.addEventListener('click', function () {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || tab.id == null) { kapat(); return; }
      try {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['webshot.js'] }, function () {
          void chrome.runtime.lastError; kapat();   // enjeksiyon hatası olsa da popup kapanır
        });
      } catch (e) { kapat(); }
    });
  });
})();
