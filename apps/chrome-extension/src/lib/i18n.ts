export type ExtensionLocale = "en" | "tr";
export type ExtensionLocaleSetting = "auto" | ExtensionLocale;

const TURKISH: Readonly<Record<string, string>> = {
  Summarize: "Özetle",
  "Summarize Settings": "Özetle Ayarları",
  "Copy summary": "Özeti kopyala",
  Settings: "Ayarlar",
  "Try again": "Tekrar dene",
  "Something went wrong": "Bir şeyler yanlış gitti",
  "View logs": "Günlükleri görüntüle",
  Controls: "Kontroller",
  Size: "Boyut",
  "Text size": "Metin boyutu",
  "Smaller text": "Daha küçük metin",
  "Larger text": "Daha büyük metin",
  Line: "Satır",
  "Line height": "Satır yüksekliği",
  "Tighter line height": "Daha sıkı satır yüksekliği",
  "Looser line height": "Daha geniş satır yüksekliği",
  Advanced: "Gelişmiş",
  Model: "Model",
  Auto: "Otomatik",
  Free: "Ücretsiz",
  "Custom…": "Özel…",
  "Auto…": "Otomatik…",
  "Gemini Nano (on-device)": "Gemini Nano (cihazda)",
  "GPT Fast": "GPT Hızlı",
  "custom model id": "özel model kimliği",
  "Refresh free models": "Ücretsiz modelleri yenile",
  "Scan free": "Ücretsizleri tara",
  "Slides view": "Slayt görünümü",
  "Summary + strip": "Özet + şerit",
  "Slides only": "Yalnızca slaytlar",
  Refresh: "Yenile",
  "Refresh (Shift+Enter)": "Yenile (Shift+Enter)",
  "Clear summary + chat": "Özeti ve sohbeti temizle",
  Clear: "Temizle",
  Connect: "Bağlan",
  Dismiss: "Kapat",
  "Dismiss daemon hint": "Daemon ipucunu kapat",
  "Jump to latest": "En yeniye git",
  "Ask about this page...": "Bu sayfa hakkında soru sorun...",
  Send: "Gönder",
  "Open extension details": "Uzantı ayrıntılarını aç",
  "Settings sections": "Ayar bölümleri",
  "Dismiss error": "Hatayı kapat",
  "Copy token": "Token'ı kopyala",
  "Copy logs": "Günlükleri kopyala",
  "Search by name, domain, or description": "Ada, alana veya açıklamaya göre ara",
  Direct: "Doğrudan",
  Daemon: "Daemon",
  Provider: "Sağlayıcı",
  Browser: "Tarayıcı",
  Port: "Bağlantı noktası",
  "Works locally in Chrome. Connect the daemon for faster media, OCR, and more.":
    "Chrome'da yerel olarak çalışır. Daha hızlı medya, OCR ve daha fazlası için daemon'a bağlanın.",
  "Local companion: Disabled by administrator. Direct and Browser modes remain available.":
    "Yerel yardımcı: Yönetici tarafından devre dışı bırakıldı. Doğrudan ve Tarayıcı modları kullanılabilir.",
  "Auto summarize": "Otomatik özetle",
  "Auto-summarize when the panel is open.": "Panel açıkken otomatik özetle.",
  "Enable Chat in the side panel with a direct provider or the daemon.":
    "Yan panelde doğrudan sağlayıcı veya daemon ile Sohbet'i etkinleştirin.",
  "Enable website automation tools with a direct provider or the daemon.":
    "Doğrudan sağlayıcı veya daemon ile web sitesi otomasyon araçlarını etkinleştirin.",
  "Optional for summarization. Grants": "Özetleme için isteğe bağlıdır. Şunları verir:",
  "for page-context": "sayfa bağlamı",
  "for page-context automation. Debugger-enabled builds add native input and the debugger tool.":
    "sayfa bağlamı otomasyonu. Hata ayıklayıcı etkin derlemeler yerel girdi ve hata ayıklayıcı aracını ekler.",
  "automation. Debugger-enabled builds add native input and the debugger tool.":
    "otomasyonu. Hata ayıklayıcı etkin derlemeler yerel girdi ve hata ayıklayıcı aracını ekler.",
  "Auto-summarize when panel is open.": "Panel açıkken otomatik özetle.",
  "Enable Chat mode in the side panel": "Yan panelde Sohbet modunu etkinleştir",
  "Enable website automation": "Web sitesi otomasyonunu etkinleştir",
  "Hover summaries (experimental)": "Üzerine gelince özetle (deneysel)",
  "Summary timestamps (media only)": "Özet zaman damgaları (yalnızca medya)",
  "Show summary first (parallel slides)": "Önce özeti göster (paralel slaytlar)",
  "Summarize Media Runtime": "Özetle Medya Çalışma Zamanı",
  "Choose how Chrome connects to AI independently from media and slide extraction.":
    "Chrome'un medya ve slayt çıkarmadan bağımsız olarak yapay zekâya nasıl bağlanacağını seçin.",
  "AI connection": "Yapay zekâ bağlantısı",
  "Runs Gemini Nano on-device or calls your configured provider directly from Chrome.":
    "Gemini Nano'yu cihazda çalıştırır veya yapılandırılmış sağlayıcınızı doğrudan Chrome'dan çağırır.",
  "Uses the local Summarize daemon and its configured providers and tools.":
    "Yerel Özetle daemon'unu, yapılandırılmış sağlayıcılarını ve araçlarını kullanır.",
  "Direct provider": "Doğrudan sağlayıcı",
  "API key": "API anahtarı",
  "Stored locally in this Chrome profile": "Bu Chrome profilinde yerel olarak saklanır",
  "Base URL override": "Temel URL geçersiz kılma",
  "Use provider default": "Sağlayıcı varsayılanını kullan",
  "Keys are stored in chrome.storage.local and sent only to the selected provider.":
    "Anahtarlar chrome.storage.local içinde saklanır ve yalnızca seçilen sağlayıcıya gönderilir.",
  "Keys are stored in": "Anahtarlar şurada saklanır:",
  "and sent only to the": "ve yalnızca",
  "selected provider.": "seçilen sağlayıcıya gönderilir.",
  "and sent only to the selected provider.": "ve yalnızca seçilen sağlayıcıya gönderilir.",
  "Media and slide runtime": "Medya ve slayt çalışma zamanı",
  "Browser transcription and frame capture. Fully daemonless for supported media.":
    "Tarayıcıda döküm ve kare yakalama. Desteklenen medya için tamamen daemonsuz.",
  "Broader native media support and OCR through local tools.":
    "Yerel araçlarla daha geniş yerel medya desteği ve OCR.",
  "Checking local companion permission…": "Yerel yardımcı izni kontrol ediliyor…",
  "Local Summarize daemon port (default 8787). Must match the running daemon — see":
    "Yerel Özetle daemon portu (varsayılan 8787). Çalışan daemon ile eşleşmelidir — bkz.",
  "Used only for Daemon mode or daemon-backed media. Direct mode does not need it.":
    "Yalnızca Daemon modu veya daemon destekli medya için kullanılır. Doğrudan modun buna ihtiyacı yoktur.",
  "Browser cache": "Tarayıcı önbelleği",
  "Browser mode keeps summaries, slide text, transcripts, and thumbnails for 30 days.":
    "Tarayıcı modu özetleri, slayt metinlerini, dökümleri ve küçük görselleri 30 gün saklar.",
  "Daemon status": "Daemon durumu",
  "Enable local companion": "Yerel yardımcıyı etkinleştir",
  Token: "Token",
  "Font family (CSS)": "Yazı tipi ailesi (CSS)",
  "Font size": "Yazı tipi boyutu",
  "Automation Skills": "Otomasyon yetenekleri",
  "Export skills": "Yetenekleri dışa aktar",
  "Import skills": "Yetenekleri içe aktar",
  Search: "Ara",
  "No skills created yet.": "Henüz yetenek oluşturulmadı.",
  "Advanced Overrides": "Gelişmiş geçersiz kılmalar",
  Logging: "Günlükleme",
  "Auto model fallback": "Otomatik model geri dönüşü",
  "Auto CLI order": "Otomatik CLI sırası",
  "Summary display": "Özet görünümü",
  "Allow OCR text for slides (off by default).":
    "Slaytlar için OCR metnine izin ver (varsayılan olarak kapalı).",
  "Hover summary prompt": "Üzerine gelme özeti istemi",
  Reset: "Sıfırla",
  "Prompt used for hover summaries in pages.":
    "Sayfalardaki üzerine gelme özetleri için kullanılan istem.",
  Pipeline: "İşlem hattı",
  "Pipeline mode": "İşlem hattı modu",
  "Default (auto)": "Varsayılan (otomatik)",
  "Page (use visible text)": "Sayfa (görünen metni kullan)",
  "URL (force URL extraction)": "URL (URL çıkarmayı zorla)",
  "Page text vs URL extraction.": "Sayfa metni ve URL çıkarma.",
  Off: "Kapalı",
  Always: "Her zaman",
  "Fetches + cleans pages to Markdown via API.":
    "Sayfaları API aracılığıyla alır ve Markdown'a dönüştürür.",
  "Markdown mode": "Markdown modu",
  "Default (readability)": "Varsayılan (readability)",
  Readability: "Readability",
  "HTML → Markdown conversion strategy.": "HTML → Markdown dönüştürme stratejisi.",
  Preprocess: "Ön işleme",
  "Default (off)": "Varsayılan (kapalı)",
  Media: "Medya",
  "YouTube mode": "YouTube modu",
  "Default (config)": "Varsayılan (yapılandırma)",
  "Auto (best transcript)": "Otomatik (en iyi döküm)",
  "No auto captions": "Otomatik altyazı yok",
  Web: "Web",
  Transcriber: "Döküm sağlayıcısı",
  "Default (daemon config)": "Varsayılan (daemon yapılandırması)",
  "Whisper (default)": "Whisper (varsayılan)",
  "Override the daemon's default transcriber.":
    "Daemon'un varsayılan döküm sağlayıcısını geçersiz kıl.",
  Limits: "Sınırlar",
  Timeout: "Zaman aşımı",
  "Overall fetch + model timeout (e.g. 90s, 2m).": "Genel alma + model zaman aşımı (ör. 90s, 2m).",
  Retries: "Yeniden denemeler",
  "LLM retry attempts on timeout (0–5).": "Zaman aşımında LLM yeniden deneme sayısı (0–5).",
  "Max output tokens": "Maks. çıktı token'ı",
  "Hard cap for model output (e.g. 2k).": "Model çıktısı için kesin üst sınır (ör. 2k).",
  "Process Manager": "Süreç yöneticisi",
  "Show completed": "Tamamlananları göster",
  Limit: "Sınır",
  "Log tail": "Günlük sonu",
  Stream: "Akış",
  Merged: "Birleştirilmiş",
  Stdout: "Stdout",
  Stderr: "Stderr",
  Tool: "Araç",
  Status: "Durum",
  Elapsed: "Geçen süre",
  Progress: "İlerleme",
  Run: "Çalıştırma",
  Command: "Komut",
  "Auto refresh": "Otomatik yenile",
  Source: "Kaynak",
  "Tail lines": "Son satırlar",
  Parsed: "Ayrıştırılmış",
  Levels: "Seviyeler",
  Info: "Bilgi",
  Warn: "Uyarı",
  Error: "Hata",
  Verbose: "Ayrıntılı",
  Time: "Zaman",
  Level: "Seviye",
  Event: "Olay",
  Details: "Ayrıntılar",
  "Slides text source": "Slayt metni kaynağı",
  Transcript: "Döküm",
  OCR: "OCR",
  Scheme: "Şema",
  Mode: "Mod",
  Font: "Yazı tipi",
  "San Francisco": "San Francisco",
  System: "Sistem",
  Light: "Açık",
  Dark: "Koyu",
  Short: "Kısa",
  Medium: "Orta",
  Long: "Uzun",
  "Extra Large (XL)": "Çok büyük (XL)",
  "Extra Extra Large (XXL)": "Ekstra çok büyük (XXL)",
  "Custom target around 20,000 characters (soft guideline).":
    "Yaklaşık 20.000 karakterlik özel hedef (esnek kılavuz).",
  "Set a custom length like 1500, 20k, or 1.5k.":
    "1500, 20k veya 1.5k gibi özel bir uzunluk belirleyin.",
  "Custom (e.g. 20k)": "Özel (ör. 20k)",
  Presets: "Hazır ayarlar",
  Page: "Sayfa",
  Video: "Video",
  Slides: "Slaytlar",
  "Checking daemon…": "Daemon kontrol ediliyor…",
  General: "Genel",
  UI: "Arayüz",
  Runtime: "Çalışma zamanı",
  Skills: "Yetenekler",
  Processes: "Süreçler",
  Logs: "Günlükler",
  "Interface language": "Arayüz dili",
  "Automatic (browser)": "Otomatik (tarayıcı)",
  English: "İngilizce",
  Turkish: "Türkçe",
  German: "Almanca",
  Spanish: "İspanyolca",
  French: "Fransızca",
  Italian: "İtalyanca",
  Portuguese: "Portekizce",
  Dutch: "Felemenkçe",
  Swedish: "İsveççe",
  Norwegian: "Norveççe",
  Danish: "Danca",
  Finnish: "Fince",
  Polish: "Lehçe",
  Czech: "Çekçe",
  Russian: "Rusça",
  Ukrainian: "Ukraynaca",
  Arabic: "Arapça",
  Hindi: "Hintçe",
  Japanese: "Japonca",
  Korean: "Korece",
  "Chinese (Simplified)": "Çince (Basitleştirilmiş)",
  "Chinese (Traditional)": "Çince (Geleneksel)",
  "Custom (e.g. en-US / Portuguese (Brazil))": "Özel (ör. en-US / Portekizce (Brezilya))",
  "Auto (detect)": "Otomatik (algıla)",
  Language: "Dil",
  "Prompt · Language · Model": "İstem · Dil · Model",
  "Prompt override": "İstem geçersiz kılma",
  "Custom instructions (prefix). Context + content still appended.":
    "Özel talimatlar (önek). Bağlam + içerik yine eklenir.",
  "Max chars (extracted)": "Maks. karakter (çıkarılan)",
  "Loading...": "Yükleniyor...",
  Unavailable: "Kullanılamıyor",
  "Enable automation permissions": "Otomasyon izinlerini etkinleştir",
  "Report issues on GitHub": "GitHub'da sorun bildirin",
  "Save failed": "Kaydetme başarısız",
  Saved: "Kaydedildi",
  "Token copied": "Token kopyalandı",
  "Copy failed": "Kopyalama başarısız",
  "Token empty": "Token boş",
  "Permission request denied": "İzin isteği reddedildi",
  "Browser cache cleared": "Tarayıcı önbelleği temizlendi",
  "Clear failed": "Temizleme başarısız",
  "Something went wrong.": "Bir şeyler yanlış gitti.",
  "Summarizing…": "Özetleniyor…",
  "Connecting…": "Bağlanıyor…",
  "Starting scan…": "Tarama başlatılıyor…",
  "Fetching website": "Web sitesi alınıyor",
  Copied: "Kopyalandı",
  "Nothing to copy": "Kopyalanacak bir şey yok",
  "Auto-summarize when panel is open": "Panel açıkken otomatik özetle",
  "Enable OCR slide text": "Slayt OCR metnini etkinleştir",
  "Extended logging": "Genişletilmiş günlükleme",
  "Auto CLI fallback": "Otomatik CLI geri dönüşü",
  "Color scheme": "Renk şeması",
  Appearance: "Görünüm",
  Slate: "Arduvaz",
  Cedar: "Sedir",
  Mint: "Nane",
  Ocean: "Okyanus",
  Ember: "Kor",
  Iris: "İris",
  "No page": "Sayfa yok",
  Loading: "Yükleniyor",
  "Preparing summary": "Özet hazırlanıyor",
  Ready: "Hazır",
  "Open a page to summarize.": "Özetlemek için bir sayfa açın.",
  "Click Summarize to start.": "Başlamak için Özetle'ye tıklayın.",
  Slide: "Slayt",
  Collapse: "Daralt",
  Expand: "Genişlet",
  "Stream failed": "Akış başarısız",
  "Slides summary failed": "Slayt özeti başarısız",
  "No active processes.": "Etkin işlem yok.",
  "No matching log entries.": "Eşleşen günlük girdisi yok.",
  "Install method": "Kurulum yöntemi",
  "Copy install command": "Kurulum komutunu kopyala",
  "Copy daemon command": "Daemon komutunu kopyala",
  "Copy status command": "Durum komutunu kopyala",
  "Copy restart command": "Yeniden başlatma komutunu kopyala",
  "Homebrew installs summarize plus the local media dependencies.":
    "Homebrew, summarize'ı ve yerel medya bağımlılıklarını kurar.",
  "2) Register the daemon": "2) Daemon'u kaydet",
  "2) Daemon auto-start": "2) Daemon otomatik başlatma",
  "Not supported on this OS yet.": "Bu işletim sisteminde henüz desteklenmiyor.",
  Troubleshooting: "Sorun giderme",
  "Shows daemon health, version, and token auth status.":
    "Daemon sağlığını, sürümünü ve token kimlik doğrulama durumunu gösterir.",
  "Restarts the daemon if it’s stuck or not responding.":
    "Daemon takılırsa veya yanıt vermiyorsa yeniden başlatır.",
  "Regenerate Token": "Token'ı yeniden oluştur",
  Setup: "Kurulum",
  "Daemon capabilities unavailable": "Daemon yetenekleri kullanılamıyor",
  "Daemon not reachable": "Daemon'a ulaşılamıyor",
  "Check that the LaunchAgent is installed.": "LaunchAgent'ın kurulu olduğunu kontrol edin.",
  "Enabled. Chrome allows this extension to use the installed local companion.":
    "Etkin. Chrome, bu uzantının kurulu yerel yardımcıyı kullanmasına izin veriyor.",
  "Not enabled. Chrome will ask before allowing local companion access.":
    "Etkin değil. Chrome, yerel yardımcı erişimine izin vermeden önce soracak.",
  "Waiting for Chrome permission…": "Chrome izni bekleniyor…",
  "Permission denied. Direct and Browser modes remain active.":
    "İzin reddedildi. Doğrudan ve Tarayıcı modları etkin kalır.",
  "Daemon runtime off — choose Daemon for AI or media to connect":
    "Daemon çalışma zamanı kapalı — bağlanmak için yapay zekâ veya medya için Daemon'u seçin",
  "Extension context stale — reload the extension, then reopen the side panel":
    "Uzantı bağlamı eskimiş — uzantıyı yeniden yükleyin, ardından yan paneli tekrar açın",
  "Native host exited — run `summarize daemon status` and check ~/.summarize/logs/daemon.err.log":
    "Yerel ana makine sonlandı — `summarize daemon status` komutunu çalıştırın ve ~/.summarize/logs/daemon.err.log dosyasını kontrol edin",
  "Native host failed to start — rerun the install command and verify launcher permissions":
    "Yerel ana makine başlatılamadı — kurulum komutunu yeniden çalıştırın ve başlatıcı izinlerini doğrulayın",
  "Native host communication failed — run `summarize daemon status` and check ~/.summarize/logs/daemon.err.log":
    "Yerel ana makine iletişimi başarısız — `summarize daemon status` komutunu çalıştırın ve ~/.summarize/logs/daemon.err.log dosyasını kontrol edin",
  "Native host unavailable — rerun the install command, then reload the extension":
    "Yerel ana makine kullanılamıyor — kurulum komutunu yeniden çalıştırın, ardından uzantıyı yeniden yükleyin",
  "Local companion permission missing — enable it in Runtime settings":
    "Yerel yardımcı izni eksik — Runtime ayarlarından etkinleştirin",
  "Daemon unreachable — run `summarize daemon status`, verify the port, then reload the extension":
    "Daemon'a ulaşılamıyor — `summarize daemon status` komutunu çalıştırın, portu doğrulayın, ardından uzantıyı yeniden yükleyin",
  "Add token to load daemon logs.": "Daemon günlüklerini yüklemek için token ekleyin.",
  "Loading logs…": "Günlükler yükleniyor…",
  "Extension logs unavailable.": "Uzantı günlükleri kullanılamıyor.",
  "No logs returned.": "Günlük döndürülmedi.",
  "tail truncated": "kuyruk kısaltıldı",
  "Add token to load processes.": "İşlemleri yüklemek için token ekleyin.",
  "Loading processes…": "İşlemler yükleniyor…",
  "No process data.": "İşlem verisi yok.",
  RUNNING: "ÇALIŞIYOR",
  DONE: "TAMAM",
  ERROR: "HATA",
  "No skills match your search.": "Aramanızla eşleşen yetenek yok.",
  "Imported ": "İçe aktarılan ",
  "Invalid skills file: expected an array.": "Geçersiz yetenek dosyası: dizi bekleniyordu.",
  "Remove queued message": "Kuyruğa alınmış mesajı kaldır",
  "Queue full": "Kuyruk dolu",
  Typing: "Yazıyor",
  "Tool result:": "Araç sonucu:",
  "Setup required (missing token).": "Kurulum gerekli (token eksik).",
  "Free models updated.": "Ücretsiz modeller güncellendi.",
  "Refresh free failed": "Ücretsiz modeller yenilenemedi",
  "First click “Enable automation permissions” in Settings.":
    "Önce Ayarlar'da “Otomasyon izinlerini etkinleştir” seçeneğine tıklayın.",
  "User Scripts permission is required. Enable it in Options → Automation permissions, then allow “User Scripts” in chrome://extensions.":
    "User Scripts izni gerekir. Seçenekler → Otomasyon izinleri bölümünden etkinleştirin, ardından chrome://extensions sayfasında “User Scripts” iznine izin verin.",
  "Enable Developer mode in chrome://extensions, then reload the extension and try again.":
    "chrome://extensions sayfasında Geliştirici modunu etkinleştirin, ardından uzantıyı yeniden yükleyip tekrar deneyin.",
  "The userScripts API requires Chrome 120 or higher. Please update Chrome.":
    "userScripts API'si Chrome 120 veya üzerini gerektirir. Lütfen Chrome'u güncelleyin.",
  "User Scripts API is not available in this browser.":
    "User Scripts API'si bu tarayıcıda kullanılamıyor.",
  "Auto uses the configured direct provider, or Gemini Nano when no provider is configured. In Daemon mode, Auto uses the daemon. Selecting Gemini Nano always keeps summaries on-device. A provider prefix such as":
    "Otomatik, yapılandırılmış doğrudan sağlayıcıyı veya sağlayıcı yapılandırılmamışsa Gemini Nano'yu kullanır. Daemon modunda Otomatik daemon'u kullanır. Gemini Nano'yu seçmek özetleri her zaman cihazda tutar. Örneğin bir sağlayıcı öneki",
  "overrides the selected direct provider.": "seçili doğrudan sağlayıcıyı geçersiz kılar.",
  "Manage reusable JavaScript libraries for domain-specific automation.":
    "Alan adına özgü otomasyon için yeniden kullanılabilir JavaScript kitaplıklarını yönetin.",
  "Values here override daemon config. Leave blank to use the daemon default.":
    "Buradaki değerler daemon yapılandırmasını geçersiz kılar. Daemon varsayılanını kullanmak için boş bırakın.",
  "Include full input + output in daemon logs. Large; only when daemon logging is enabled.":
    "Daemon günlüklerine tam girdi + çıktıyı dahil eder. Büyük miktardadır; yalnızca daemon günlükleme etkin olduğunda kullanın.",
  "When model is Auto, try coding CLIs if no API model key is configured.":
    "Model Otomatik olduğunda, API model anahtarı yapılandırılmamışsa kodlama CLI'larını deneyin.",
  "Comma-separated providers (claude, gemini, codex, agent, openclaw, opencode, copilot, pi).":
    "Virgülle ayrılmış sağlayıcılar (claude, gemini, codex, agent, openclaw, opencode, copilot, pi).",
  "Include clickable timestamps in summaries for media (default on).":
    "Medya özetlerine tıklanabilir zaman damgaları ekle (varsayılan açık).",
  "Show summary first while slides extract in parallel.":
    "Slaytlar paralel çıkarılırken önce özeti göster.",
  "Show hover summary tooltips in pages. Experimental, default off.":
    "Sayfalarda üzerine gelince özet ipuçlarını göster. Deneyseldir, varsayılan olarak kapalıdır.",
  "Convert PDF/Doc files to text first for better model compatibility.":
    "Daha iyi model uyumluluğu için PDF/Doc dosyalarını önce metne dönüştür.",
  "Auto picks best; Web uses captions; yt-dlp extracts audio; Apify is fallback.":
    "Otomatik en iyisini seçer; Web altyazıları kullanır; yt-dlp ses çıkarır; Apify geri dönüş seçeneğidir.",
  "Track external tools spawned by the daemon (ffmpeg, yt-dlp, tesseract).":
    "Daemon'un başlattığı harici araçları takip et (ffmpeg, yt-dlp, tesseract).",
  "made by": "tarafından",
  "MIT licensed": "MIT lisanslı",
  "· MIT licensed ·": "· MIT lisanslı ·",
  "Select which skills should overwrite existing entries.":
    "Mevcut girdilerin üzerine yazacak yetenekleri seçin.",
  Cancel: "İptal",
  "Cancel (Esc)": "İptal (Esc)",
  "Import selected": "Seçilenleri içe aktar",
  "Edit skill": "Yeteneği düzenle",
  Name: "Ad",
  "Domain patterns (comma-separated)": "Alan adı desenleri (virgülle ayrılmış)",
  "Short description": "Kısa açıklama",
  "Description (Markdown)": "Açıklama (Markdown)",
  "Examples (JavaScript)": "Örnekler (JavaScript)",
  "Library code": "Kitaplık kodu",
  Save: "Kaydet",
  Edit: "Düzenle",
  Delete: "Sil",
  "Disabled by administrator": "Yönetici tarafından devre dışı bırakıldı",
  "Clearing...": "Temizleniyor...",
  "Failed to clear browser cache": "Tarayıcı önbelleği temizlenemedi",
  "Failed to load skills": "Yetenekler yüklenemedi",
  "Open Chrome User Scripts settings": "Chrome Kullanıcı Betikleri ayarlarını aç",
  "Automation permissions granted": "Otomasyon izinleri verildi",
  "Local slides payload not found": "Yerel slayt yükü bulunamadı",
  "Invalid timestamp": "Geçersiz zaman damgası",
  "Extraction failed": "Çıkarma başarısız",
  "Frame capture failed": "Kare yakalama başarısız",
  "Frame restore failed": "Kare geri yükleme başarısız",
  "Unsupported linked content type": "Desteklenmeyen bağlantılı içerik türü",
  "NPM installs the CLI (requires Node.js).": "NPM, CLI'yi kurar (Node.js gerektirir).",
  "Click an element to select • ↑↓ to change depth":
    "Seçmek için bir öğeye tıklayın • derinliği değiştirmek için ↑↓",
  "Abort (Esc)": "Durdur (Esc)",
  "No media element found": "Medya öğesi bulunamadı",
  words: "kelime",
  entries: "girdi",
};

export function resolveExtensionLocale(
  setting: ExtensionLocaleSetting = "auto",
  browserLanguage = typeof navigator === "undefined" ? "" : navigator.language,
): ExtensionLocale {
  if (setting === "tr" || setting === "en") return setting;
  return browserLanguage.toLowerCase().startsWith("tr") ? "tr" : "en";
}

export function translateExtensionText(text: string, locale: ExtensionLocale): string {
  if (locale === "en") return text;
  const leading = text.match(/^\s*/)?.[0] ?? "";
  const trailing = text.match(/\s*$/)?.[0] ?? "";
  const normalized = text.trim().replaceAll(/\s+/g, " ");
  const exact = TURKISH[text] ?? TURKISH[normalized];
  if (exact) return `${leading}${exact}${trailing}`;
  const source = text.trim();
  let translated: string | null = null;
  if (source.startsWith("Page · ")) {
    translated = `Sayfa · ${source.slice("Page · ".length).replace(/(\d+) words$/, "$1 kelime")}`;
  } else if (source.startsWith("Context ")) {
    const context = source.match(/^Context (.+?)% · (.+?) msgs · (.+?) chars$/);
    translated = context
      ? `Bağlam ${context[1]}% · ${context[2]} mesaj · ${context[3]} karakter`
      : `Bağlam ${source.slice("Context ".length)}`;
  } else if (source.startsWith("Running: ")) {
    translated = `Çalışıyor: ${source.slice("Running: ".length)}`;
  } else if (source.startsWith("Failed to load skills: ")) {
    translated = `Yetenekler yüklenemedi: ${source.slice("Failed to load skills: ".length)}`;
  } else if (source.startsWith("Edit skill: ")) {
    translated = `Yeteneği düzenle: ${source.slice("Edit skill: ".length)}`;
  } else if (source.startsWith("Delete skill: ")) {
    translated = `Yeteneği sil: ${source.slice("Delete skill: ".length)}`;
  } else if (source.startsWith("Daemon error (")) {
    translated = `Daemon hatası (${source.slice("Daemon error (".length)}`;
  } else if (source.startsWith("Daemon ") && source.endsWith(" connected")) {
    translated = `Daemon ${source.slice("Daemon ".length, -" connected".length)} bağlandı`;
  } else if (source.startsWith("Daemon ") && source.includes(" (token mismatch) — ")) {
    translated = source.replace(
      " (token mismatch) — update token in side panel and Save",
      " (token uyuşmazlığı) — yan panelde token'ı güncelleyin ve Kaydet'e tıklayın",
    );
  } else if (source.startsWith("Daemon ") && source.includes(" (auth failed) — ")) {
    translated = source.replace(
      " (auth failed) — update token in side panel and Save",
      " (kimlik doğrulama başarısız) — yan panelde token'ı güncelleyin ve Kaydet'e tıklayın",
    );
  } else if (source.startsWith("Slides (") && source.includes(") · showing ")) {
    translated = source
      .replace(/^Slides \(/, "Slaytlar (")
      .replace(") · showing ", ") · gösterilen ");
  } else if (source.startsWith("Slides (")) {
    translated = `Slaytlar ${source.slice("Slides ".length)}`;
  } else if (source.startsWith("Slide ")) {
    translated = `Slayt ${source.slice("Slide ".length)}`;
  } else if (source.startsWith("Logs · ")) {
    translated = `Günlükler · ${source.slice("Logs · ".length)}`;
  } else if (/^\d+ words$/.test(source)) {
    translated = `${source.slice(0, -" words".length)} kelime`;
  } else if (/^\d+ entries · /.test(source)) {
    translated = source.replace(" entries · ", " girdi · ");
  } else if (/^\d+ processes$/.test(source)) {
    translated = source.replace(" processes", " işlem");
  } else if (/^Imported \d+ skill\(s\)\.$/.test(source)) {
    translated = source.replace(/^Imported (\d+) skill\(s\)\.$/, "$1 yetenek içe aktarıldı.");
  } else if (/^Queue full \(\d+\)\. Remove one to add more\.$/.test(source)) {
    translated = source.replace(
      /^Queue full \((\d+)\)\. Remove one to add more\.$/,
      "Kuyruk dolu ($1). Daha fazla eklemek için birini kaldırın.",
    );
  } else if (/^Tool result: /.test(source)) {
    translated = source.replace(/^Tool result:/, "Araç sonucu:").replace(" (error)", " (hata)");
  } else if (/^Error: /.test(source)) {
    translated = source.replace(/^Error:/, "Hata:");
  } else if (/^1\) Install summarize \(/.test(source)) {
    translated = source.replace(/^1\) Install summarize/, "1) summarize'ı kur");
  } else if (/^2\) Register the daemon \(/.test(source)) {
    translated = source.replace(/^2\) Register the daemon/, "2) Daemon'u kaydet");
  } else if (/^Chrome \d+ detected\./.test(source)) {
    translated = source
      .replace(/^Chrome (\d+) detected\./, "Chrome $1 algılandı.")
      .replace("To enable User Scripts:", "User Scripts'i etkinleştirmek için:")
      .replace("Go to", "Şuraya gidin:")
      .replace("Find this extension and click", "Bu uzantıyı bulun ve tıklayın")
      .replace("Enable the", "Şunu etkinleştirin:")
      .replace("toggle", "anahtarı")
      .replace("Reload the page and try again", "Sayfayı yeniden yükleyip tekrar deneyin")
      .replace("Enable Developer mode in", "Şurada Geliştirici modunu etkinleştirin:")
      .replace(
        "then reload the extension and try again",
        "ardından uzantıyı yeniden yükleyip tekrar deneyin",
      )
      .replace(
        "The userScripts API requires Chrome 120 or higher. Please update Chrome.",
        "userScripts API'si Chrome 120 veya üzerini gerektirir. Lütfen Chrome'u güncelleyin.",
      );
  } else if (source === "just now") {
    translated = "şimdi";
  } else if (/^\d+[smhd] ago$/.test(source)) {
    translated = source.replace(/^(\d+)([smhd]) ago$/, (_, value: string, unit: string) => {
      const units: Record<string, string> = { s: "saniye", m: "dakika", h: "saat", d: "gün" };
      return `${value} ${units[unit] ?? unit} önce`;
    });
  } else if (/^size .+ · updated .+/.test(source)) {
    translated = source
      .replace(/^size /, "boyut ")
      .replace(" · updated ", " · güncellendi ")
      .replace(" · tail truncated", " · kuyruk kısaltıldı");
  } else if (/^size /.test(source)) {
    translated = source
      .replace(/^size /, "boyut ")
      .replace(" · tail truncated", " · kuyruk kısaltıldı");
  } else if (/^updated /.test(source)) {
    translated = source
      .replace(/^updated /, "güncellendi ")
      .replace(" · tail truncated", " · kuyruk kısaltıldı");
  }
  return translated == null ? text : `${leading}${translated}${trailing}`;
}

const TRANSLATABLE_ATTRIBUTES = ["aria-label", "title", "placeholder"] as const;
let activeObserver: MutationObserver | null = null;
let activeLocale: ExtensionLocale = "en";
const originalText = new WeakMap<Text, string>();
const lastTranslatedText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();
const lastTranslatedAttributes = new WeakMap<Element, Map<string, string>>();

function isApplicationUi(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(
    element?.closest("[data-locale-ui]") &&
    !element.closest("code, pre, script, style, [data-locale-ignore]"),
  );
}

/** Apply the selected locale to static HTML and to later-rendered extension UI nodes. */
export function applyExtensionLocale(locale: ExtensionLocale): () => void {
  activeObserver?.disconnect();
  activeLocale = locale;
  document.documentElement.lang = locale;
  const translateTextNode = (textNode: Text) => {
    const current = textNode.nodeValue ?? "";
    if (!current.trim() || !isApplicationUi(textNode)) return;
    const source = originalText.get(textNode);
    const lastTranslated = lastTranslatedText.get(textNode);
    const resolvedSource =
      source === undefined ||
      (lastTranslated !== undefined && current !== lastTranslated && current !== source)
        ? current
        : (source ?? current);
    originalText.set(textNode, resolvedSource);
    const translated = translateExtensionText(resolvedSource, locale);
    if (current !== translated) textNode.nodeValue = translated;
    lastTranslatedText.set(textNode, translated);
  };
  const translateElementAttributes = (element: Element) => {
    if (!isApplicationUi(element)) return;
    for (const attribute of TRANSLATABLE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const sources = originalAttributes.get(element) ?? new Map<string, string>();
      const lastTranslated = lastTranslatedAttributes.get(element)?.get(attribute);
      const source = sources.get(attribute);
      const resolvedSource =
        source === undefined ||
        (lastTranslated !== undefined && value !== lastTranslated && value !== source)
          ? value
          : (source ?? value);
      sources.set(attribute, resolvedSource);
      originalAttributes.set(element, sources);
      const translated = translateExtensionText(resolvedSource, locale);
      if (value !== translated) element.setAttribute(attribute, translated);
      const translatedValues = lastTranslatedAttributes.get(element) ?? new Map<string, string>();
      translatedValues.set(attribute, translated);
      lastTranslatedAttributes.set(element, translatedValues);
    }
  };
  const translate = (root: ParentNode) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeValue?.trim() && isApplicationUi(node)) textNodes.push(node as Text);
    }
    for (const textNode of textNodes) translateTextNode(textNode);

    if (root instanceof Element) translateElementAttributes(root);
    for (const element of root.querySelectorAll("*")) {
      translateElementAttributes(element);
    }
  };

  translate(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) translate(node as Element);
        else if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text);
      }
      if (record.type === "characterData" && record.target.nodeType === Node.TEXT_NODE) {
        translateTextNode(record.target as Text);
      }
      if (record.type === "attributes" && record.target.nodeType === Node.ELEMENT_NODE) {
        translateElementAttributes(record.target as Element);
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
  });
  activeObserver = observer;
  return () => observer.disconnect();
}

export const extensionTranslationKeys = Object.keys(TURKISH);

export function getActiveExtensionLocale(): ExtensionLocale {
  return activeLocale;
}
