/**
 * Locale for the human-facing CLI. This is deliberately separate from
 * OutputLanguage: --language controls model output, while --locale controls
 * help, progress, and CLI status text.
 */
export type CliLocale = "en" | "tr";

const LOCALE_ALIASES: Record<string, CliLocale> = {
  en: "en",
  english: "en",
  "en-us": "en",
  "en-gb": "en",
  tr: "tr",
  turkish: "tr",
  turkce: "tr",
  "tr-tr": "tr",
};

export function resolveCliLocale(raw: string | null | undefined): CliLocale {
  if (typeof raw !== "string") return "en";
  const normalized = raw.trim().toLowerCase().replaceAll("_", "-").split(/[.@]/, 1)[0];
  return LOCALE_ALIASES[normalized] ?? "en";
}

export function resolveCliLocaleFromEnv(
  env: Record<string, string | undefined>,
  explicit?: string | null,
): CliLocale {
  if (explicit != null && explicit.trim()) return resolveCliLocale(explicit);
  return resolveCliLocale(env.SUMMARIZE_LOCALE);
}

export function resolveCliLocaleFromArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): CliLocale {
  const separatorIndex = argv.indexOf("--");
  const optionArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const equals = optionArgs.find((arg) => arg.startsWith("--locale="));
  if (equals) return resolveCliLocaleFromEnv(env, equals.slice("--locale=".length));
  const index = optionArgs.indexOf("--locale");
  return resolveCliLocaleFromEnv(env, index >= 0 ? optionArgs[index + 1] : undefined);
}

const TURKISH_TRANSLATIONS: ReadonlyArray<readonly [string, string]> = [
  [
    "Summarize web pages and YouTube links (uses direct provider API keys).",
    "Web sayfalarını ve YouTube bağlantılarını özetleyin (doğrudan sağlayıcı API anahtarlarını kullanır).",
  ],
  [
    "URL, local file path, or - for stdin (text or binary) to summarize",
    "Özetlenecek URL, yerel dosya yolu veya stdin için - (metin ya da ikili veri)",
  ],
  ["Output language:", "Çıktı dili:"],
  ["Output language", "Çıktı dili"],
  ["CLI interface language:", "CLI arayüz dili:"],
  [
    "CLI interface language: auto/en or tr/turkish (default: en; also SUMMARIZE_LOCALE)",
    "CLI arayüz dili: auto/en veya tr/turkish (varsayılan: en; SUMMARIZE_LOCALE ile de ayarlanabilir)",
  ],
  [
    "Output language: auto (match source), en, de, english, german, ... (default: auto; configurable in ~/.summarize/config.json via output.language)",
    "Çıktı dili: auto (kaynakla eşleştir), en, de, english, german, ... (varsayılan: auto; ~/.summarize/config.json içindeki output.language ile yapılandırılabilir)",
  ],
  [
    "YouTube transcript source: auto, web, no-auto (skip auto-generated captions), yt-dlp, apify",
    "YouTube döküm kaynağı: auto, web, no-auto (otomatik oluşturulan altyazıları atla), yt-dlp, apify",
  ],
  [
    "Local transcription stage: auto (default), whisper, parakeet, canary; Groq still runs first when keyed",
    "Yerel döküm aşaması: auto (varsayılan), whisper, parakeet, canary; anahtar varsa Groq yine önce çalışır",
  ],
  [
    "Add speaker labels to YouTube or direct audio/video: auto (ElevenLabs then OpenAI), elevenlabs, openai.",
    "YouTube veya doğrudan ses/video için konuşmacı etiketleri ekle: auto (önce ElevenLabs, sonra OpenAI), elevenlabs, openai.",
  ],
  [
    "Resolve diarization labels to real names using timestamp anchors and OpenAI context.",
    "Konuşmacı ayrımı etiketlerini zaman damgası işaretleri ve OpenAI bağlamıyla gerçek adlara dönüştür.",
  ],
  [
    "Keep generic diarization labels even when speaker identification is configured.",
    "Konuşmacı tanımlama yapılandırılmış olsa bile genel konuşmacı ayrımı etiketlerini koru.",
  ],
  [
    "Speaker profile from ~/.summarize/config.json (implies --identify-speakers).",
    "~/.summarize/config.json içindeki konuşmacı profili (--identify-speakers anlamına gelir).",
  ],
  [
    "Identify the speaker active at a timestamp; repeat for multiple speakers.",
    "Bir zaman damgasında aktif olan konuşmacıyı tanımla; birden fazla konuşmacı için tekrarla.",
  ],
  [
    "Persist resolved mappings and anchors under the selected speaker profile.",
    "Çözülen eşlemeleri ve işaretleri seçilen konuşmacı profiline kaydet.",
  ],
  [
    "Video handling: auto (prefer video understanding if supported), transcript, understand.",
    "Video işleme: auto (destekleniyorsa video anlamayı tercih et), transcript, understand.",
  ],
  [
    "Embedded YouTube handling: auto, off, prefer transcript, or combine article+transcript.",
    "Gömülü YouTube işleme: auto, off, transcript'i tercih et veya makale+dökümü birleştir.",
  ],
  [
    "Disable configured slide extraction for this run.",
    "Bu çalıştırmada yapılandırılmış slayt çıkarmayı devre dışı bırak.",
  ],
  [
    "Show slide image paths instead of rendering inline images.",
    "Satır içi görselleri göstermek yerine slayt görsel yollarını göster.",
  ],
  [
    "Run OCR on extracted slides (requires tesseract).",
    "Çıkarılan slaytlarda OCR çalıştır (tesseract gerektirir).",
  ],
  [
    "Disable configured slide OCR for this run.",
    "Bu çalıştırmada yapılandırılmış slayt OCR'ını devre dışı bırak.",
  ],
  [
    "Base output dir for slides (default: ./slides).",
    "Slaytlar için temel çıktı dizini (varsayılan: ./slides).",
  ],
  [
    "Scene detection threshold for slide changes (0.1-1.0).",
    "Slayt değişiklikleri için sahne algılama eşiği (0.1-1.0).",
  ],
  ["Maximum slides to extract (default: 6).", "Çıkarılacak en fazla slayt sayısı (varsayılan: 6)."],
  [
    "Minimum seconds between slides (default: 2).",
    "Slaytlar arasındaki en az saniye (varsayılan: 2).",
  ],
  ["Include timestamps in transcripts when available.", "Varsa dökümlere zaman damgalarını ekle."],
  [
    "Firecrawl usage: off, auto (fallback), always (try Firecrawl first).",
    "Firecrawl kullanımı: off, auto (geri dönüş), always (önce Firecrawl'ı dene).",
  ],
  [
    "Preprocess inputs for model compatibility: off, auto (fallback), always.",
    "Model uyumluluğu için girdileri ön işle: off, auto (geri dönüş), always.",
  ],
  [
    "Summary length: short|medium|long|xl|xxl (or s/m/l) or a character limit like 20000, 20k (default: long; configurable via ~/.summarize/config.json output.length)",
    "Özet uzunluğu: short|medium|long|xl|xxl (veya s/m/l) ya da 20000, 20k gibi karakter sınırı (varsayılan: long; ~/.summarize/config.json output.length ile yapılandırılabilir)",
  ],
  [
    "Maximum characters to print in --extract (default: unlimited).",
    "--extract ile yazdırılacak en fazla karakter (varsayılan: sınırsız).",
  ],
  [
    "Hard cap for LLM output tokens (e.g. 2000, 2k). Overrides provider defaults.",
    "LLM çıktı token'ları için kesin üst sınır (ör. 2000, 2k). Sağlayıcı varsayılanlarını geçersiz kılar.",
  ],
  [
    "Force LLM summary even when extracted content is shorter than the requested length.",
    "Çıkarılan içerik istenen uzunluktan kısa olsa bile LLM özetini zorla.",
  ],
  [
    "Timeout for content fetching and LLM request: 30 (seconds), 30s, 2m, 5000ms",
    "İçerik alma ve LLM isteği zaman aşımı: 30 (saniye), 30s, 2m, 5000ms",
  ],
  [
    "LLM retry attempts after timeouts or transient API failures (default: 1).",
    "Zaman aşımı veya geçici API hatalarından sonra LLM yeniden deneme sayısı (varsayılan: 1).",
  ],
  [
    "Use the OpenAI fast service tier for OpenAI models (sends service_tier=priority).",
    "OpenAI modelleri için hızlı OpenAI hizmet katmanını kullan (service_tier=priority gönderir).",
  ],
  [
    "Override the summary prompt (instruction prefix; context/content still appended).",
    "Özet istemini geçersiz kıl (talimat ön eki; bağlam/içerik yine eklenir).",
  ],
  ["Read the prompt override from a file.", "İstem geçersiz kılmayı bir dosyadan oku."],
  [
    "Bypass summary cache (LLM). Media/transcript caches stay enabled.",
    "Özet önbelleğini atla (LLM). Medya/döküm önbellekleri etkin kalır.",
  ],
  [
    "Disable media download cache (yt-dlp).",
    "Medya indirme önbelleğini devre dışı bırak (yt-dlp).",
  ],
  ["Print cache stats and exit.", "Önbellek istatistiklerini yazdır ve çık."],
  ["Delete the cache database and exit.", "Önbellek veritabanını sil ve çık."],
  [
    "Output structured JSON (includes prompt + metrics)",
    "Yapılandırılmış JSON çıktısı ver (istem + ölçümleri içerir)",
  ],
  [
    "Keep raw text/markdown output (no ANSI/OSC rendering)",
    "Ham metin/Markdown çıktısını koru (ANSI/OSC işleme yok)",
  ],
  ["Disable ANSI colors in output", "Çıktıda ANSI renklerini devre dışı bırak"],
  [
    "Alias for --verbose (and defaults --metrics to detailed)",
    "--verbose için diğer ad (ve --metrics varsayılanını detailed yapar)",
  ],
  ["Metrics output: off, on, detailed", "Ölçüm çıktısı: off, on, detailed"],
  [
    "Extract slide screenshots from a YouTube URL, direct video URL, or local video file.",
    "YouTube URL'sinden, doğrudan video URL'sinden veya yerel video dosyasından slayt ekran görüntüleri çıkar.",
  ],
  [
    "YouTube URL, direct video URL, or local video file",
    "YouTube URL'si, doğrudan video URL'si veya yerel video dosyası",
  ],
  ["Output JSON payload (no inline rendering).", "JSON yükünü çıktılar (satır içi işleme yok)."],
  [
    "Timeout for video download/extraction (default: 2m).",
    "Video indirme/çıkarma zaman aşımı (varsayılan: 2m).",
  ],
  [
    "Writes ~/.summarize/config.json (models.free) with working OpenRouter :free candidates.",
    "Çalışan OpenRouter :free adaylarıyla ~/.summarize/config.json (models.free) dosyasını yazar.",
  ],
  [
    "Shows the effective model, configured presets, and configured or usable providers.",
    "Etkin modeli, yapılandırılmış hazır ayarları ve yapılandırılmış ya da kullanılabilir sağlayıcıları gösterir.",
  ],
  [
    "Missing providers are omitted. Secrets are never printed.",
    "Eksik sağlayıcılar gösterilmez. Gizli bilgiler asla yazdırılmaz.",
  ],
  [
    "Website/file content format: md|text. For websites: controls the extraction format. For files: controls whether we try to preprocess to Markdown for model compatibility. (default: text; default in --extract mode for URLs: md)",
    "Web sitesi/dosya içerik biçimi: md|text. Web sitelerinde çıkarma biçimini kontrol eder. Dosyalarda model uyumluluğu için Markdown'a ön işlemeyi denetler. (varsayılan: text; URL'ler için --extract modunda varsayılan: md)",
  ],
  [
    "Markdown conversion: off, auto, llm (force LLM), readability. For websites: converts HTML→Markdown. For YouTube/transcripts: llm mode formats raw transcripts into clean markdown with headings and paragraphs.",
    "Markdown dönüştürme: off, auto, llm (LLM'i zorla), readability. Web sitelerinde HTML→Markdown dönüştürür. YouTube/dökümlerde llm modu ham dökümleri başlık ve paragraflarla düzenli Markdown'a dönüştürür.",
  ],
  [
    "LLM model id: auto, <name>, cli/<provider>/<model>, xai/..., openai/..., nvidia/..., minimax/..., google/..., anthropic/..., zai/... or openrouter/<author>/<slug> (default: auto)",
    "LLM model kimliği: auto, <name>, cli/<provider>/<model>, xai/..., openai/..., nvidia/..., minimax/..., google/..., anthropic/..., zai/... veya openrouter/<author>/<slug> (varsayılan: auto)",
  ],
  [
    "OpenAI service tier: default, fast, priority, flex.",
    "OpenAI hizmet katmanı: default, fast, priority, flex.",
  ],
  [
    "Use a CLI provider: claude, gemini, codex, agent, openclaw, opencode, copilot, agy, pi (equivalent to --model cli/<provider>). If omitted, use auto selection with CLI enabled.",
    "Bir CLI sağlayıcısı kullan: claude, gemini, codex, agent, openclaw, opencode, copilot, agy, pi (--model cli/<provider> ile eşdeğer). Belirtilmezse CLI etkin otomatik seçim kullanılır.",
  ],
  [
    "Print extracted content and exit: URLs, media, and local PDFs; stdin is unsupported.",
    "Çıkarılan içeriği yazdır ve çık: URL'ler, medya ve yerel PDF'ler; stdin desteklenmez.",
  ],
  [
    "Stream LLM output: auto (TTY only), on, off. Note: streaming is disabled in --json mode.",
    "LLM çıktısını akış olarak ver: auto (yalnızca TTY), on, off. Not: --json modunda akış devre dışıdır.",
  ],
  [
    "Override terminal width for markdown rendering (default: auto-detect, max 120)",
    "Markdown işleme için terminal genişliğini geçersiz kıl (varsayılan: otomatik algıla, en fazla 120)",
  ],
  ["extracted plain text", "çıkarılan düz metin"],
  [
    "extracted markdown (prefers Firecrawl when configured)",
    "çıkarılan Markdown (yapılandırılmışsa Firecrawl'ı tercih eder)",
  ],
  ["extracted markdown via LLM", "LLM aracılığıyla çıkarılan Markdown"],
  ["transcript as formatted markdown", "biçimlendirilmiş Markdown olarak döküm"],
  ["speaker-labelled transcript", "konuşmacı etiketli döküm"],
  ["summary + inline slides", "özet + satır içi slaytlar"],
  ["slides + OCR extraction", "slaytlar + OCR çıkarma"],
  ["full transcript + inline slides", "tam döküm + satır içi slaytlar"],
  ["slides-only mode with inline thumbnails", "satır içi küçük görsellerle yalnızca slayt modu"],
  [
    "show configured and usable model providers",
    "yapılandırılmış ve kullanılabilir model sağlayıcılarını göster",
  ],
  [
    "Summarize web pages, files, and YouTube links.",
    "Web sayfalarını, dosyaları ve YouTube bağlantılarını özetleyin.",
  ],
  [
    "Extract slides for YouTube/direct video URLs or local video files and render them inline inside the summary narrative (when supported). Combine with --extract to interleave slides in the full transcript.",
    "YouTube/doğrudan video URL'lerinden veya yerel video dosyalarından slaytları çıkarıp (desteklendiğinde) özet metnine satır içi olarak ekle. Tam dökümde slaytları araya yerleştirmek için --extract ile birlikte kullan.",
  ],
  [
    "Extract slides for YouTube/direct video URLs",
    "YouTube/doğrudan video URL'lerinden slaytları çıkar",
  ],
  ["or local video files and render them inline", "veya yerel video dosyalarını satır içinde işle"],
  ["inside the summary narrative (when supported)", "özet metninin içinde (desteklendiğinde)"],
  [
    "Combine with --extract to interleave slides in the full transcript",
    "Tam dökümde slaytları araya yerleştirmek için --extract ile birlikte kullan",
  ],
  ["CLI theme (aurora, ember, moss, mono)", "CLI teması (aurora, ember, moss, mono)"],
  [
    "OpenAI reasoning effort: none, low, medium, high, xhigh (aliases: off, min, mid).",
    "OpenAI akıl yürütme düzeyi: none, low, medium, high, xhigh (diğer adlar: off, min, mid).",
  ],
  ["diarize a local recording", "yerel bir kayıtta konuşmacı ayrımı yap"],
  [
    "configure local ONNX transcription (parakeet/canary)",
    "yerel ONNX dökümünü yapılandır (parakeet/canary)",
  ],
  ["GitHub Models via GITHUB_TOKEN", "GITHUB_TOKEN aracılığıyla GitHub Modelleri"],
  ["config preset", "yapılandırma ön ayarı"],
  ["summarize clipboard content", "panodaki içeriği özetle"],
  [
    "scan/update working OpenRouter :free models",
    "çalışan OpenRouter :free modellerini tara/güncelle",
  ],
  [
    "refresh free-model candidates into ~/.summarize/config.json",
    "ücretsiz model adaylarını ~/.summarize/config.json içine yenile",
  ],
  [
    "show local ONNX setup and transcription fallback order",
    "yerel ONNX kurulumunu ve döküm geri dönüş sırasını göster",
  ],
  [
    "Run summarize --help for full options.",
    "Tüm seçenekler için summarize --help komutunu çalıştırın.",
  ],
  ["Support:", "Destek:"],
  [
    'With --set-default: also sets `model` to "free".',
    '--set-default ile: `model` değerini ayrıca "free" olarak ayarlar.',
  ],
  [
    "Probe supported model-list endpoints without running inference",
    "Çıkarım çalıştırmadan desteklenen model listesi uç noktalarını yokla",
  ],
  [
    "Include executable paths, endpoint hosts, config sources, and preset candidates",
    "Çalıştırılabilir yolları, uç nokta ana bilgisayarlarını, yapılandırma kaynaklarını ve ön ayar adaylarını dahil et",
  ],
  [
    "Install/upgrade daemon autostart, config, and the Chrome native messaging host",
    "Daemon otomatik başlatmasını, yapılandırmasını ve Chrome yerel mesajlaşma ana makinesini kur/güncelle",
  ],
  ["Restart the daemon autostart service", "Daemon otomatik başlatma hizmetini yeniden başlat"],
  [
    "Check daemon service, native host, and daemon health",
    "Daemon hizmetini, yerel ana makineyi ve daemon sağlığını kontrol et",
  ],
  [
    "Remove daemon autostart and the Chrome native messaging host",
    "Daemon otomatik başlatmasını ve Chrome yerel mesajlaşma ana makinesini kaldır",
  ],
  [
    "Run the daemon in the foreground (used by autostart)",
    "Daemon'u ön planda çalıştır (otomatik başlatma tarafından kullanılır)",
  ],
  [
    "Configures local ONNX transcription by printing the required env vars.",
    "Gerekli ortam değişkenlerini yazdırarak yerel ONNX dökümünü yapılandırır.",
  ],
  ["Auto selection:", "Otomatik seçim:"],
  ["parakeet (default) or canary", "parakeet (varsayılan) veya canary"],
  ["optional", "isteğe bağlı"],
  ["required", "gerekli"],
  ["override", "geçersiz kılma"],
  ["overrides", "geçersiz kılar"],
  ["alias", "diğer ad"],
  ["endpoint", "uç noktası"],
  ["binary", "ikili dosya"],
  ["models", "modeller"],
  ["path", "yol"],
  ["also works", "da çalışır"],
  ["disable", "devre dışı bırak"],
  ["OpenAI-compatible", "OpenAI uyumlu"],
  ["API endpoint", "API uç noktası"],
  ["website extraction fallback", "web sitesi çıkarma geri dönüşü"],
  ["YouTube transcript fallback", "YouTube döküm geri dönüşü"],
  ["required for", "için gerekli"],
  ["optional path", "isteğe bağlı yol"],
  ["optional path to Claude CLI binary", "Claude CLI ikili dosyasının isteğe bağlı yolu"],
  ["optional path to Codex CLI binary", "Codex CLI ikili dosyasının isteğe bağlı yolu"],
  ["optional path to Gemini CLI binary", "Gemini CLI ikili dosyasının isteğe bağlı yolu"],
  [
    "optional path to Cursor Agent CLI binary",
    "Cursor Agent CLI ikili dosyasının isteğe bağlı yolu",
  ],
  ["optional path to OpenClaw CLI binary", "OpenClaw CLI ikili dosyasının isteğe bağlı yolu"],
  ["optional path to OpenCode CLI binary", "OpenCode CLI ikili dosyasının isteğe bağlı yolu"],
  [
    "optional path to GitHub Copilot CLI binary",
    "GitHub Copilot CLI ikili dosyasının isteğe bağlı yolu",
  ],
  ["optional path to Antigravity CLI binary", "Antigravity CLI ikili dosyasının isteğe bağlı yolu"],
  ["optional path to pi CLI binary", "pi CLI ikili dosyasının isteğe bağlı yolu"],
  ["path to Claude CLI binary", "Claude CLI ikili dosyasının yolu"],
  ["path to Codex CLI binary", "Codex CLI ikili dosyasının yolu"],
  ["path to Gemini CLI binary", "Gemini CLI ikili dosyasının yolu"],
  ["path to Cursor Agent CLI binary", "Cursor Agent CLI ikili dosyasının yolu"],
  ["path to OpenClaw CLI binary", "OpenClaw CLI ikili dosyasının yolu"],
  ["path to OpenCode CLI binary", "OpenCode CLI ikili dosyasının yolu"],
  ["path to GitHub Copilot CLI binary", "GitHub Copilot CLI ikili dosyasının yolu"],
  ["path to Antigravity CLI binary", "Antigravity CLI ikili dosyasının yolu"],
  ["path to pi CLI binary", "pi CLI ikili dosyasının yolu"],
  ["e.g.", "ör."],
  ["force", "zorla"],
  ["routes", "yönlendirir"],
  ["through", "üzerinden"],
  ["base URL", "temel URL"],
  ["model selection", "model seçimi"],
  ["color", "renk"],
  ["speaker diarization", "konuşmacı ayrımı"],
  ["command to run", "çalıştırılacak komut"],
  ["use", "kullan"],
  ["placeholder", "yer tutucusu"],
  ["cookies source", "çerez kaynağı"],
  ["API key", "API anahtarı"],
  ["audio extraction", "ses çıkarma"],
  ["audio transcription", "ses dökümü"],
  ["alias for", "şunun diğer adı"],
  ["and", "ve"],
  ["for", "için"],
  ["to", "için"],
  ["with", "ile"],
  ["without", "olmadan"],
  ["via", "aracılığıyla"],
  ["or", "veya"],
  ["first", "önce"],
  ["still", "yine"],
  ["runs", "çalışır"],
  ["used", "kullanılan"],
  ["by", "tarafından"],
  ["also", "ayrıca"],
  ["local", "yerel"],
  ["transcription", "döküm"],
  ["Print version and exit", "Sürümü yazdır ve çık"],
  ["Print detailed progress info to stderr", "Ayrıntılı ilerleme bilgisini stderr'e yazdır"],
  ["Show detailed progress info to stderr", "Ayrıntılı ilerleme bilgisini stderr'de göster"],
  ["Examples", "Örnekler"],
  ["Arguments", "Argümanlar"],
  ["display help for command", "komut yardımını göster"],
  ["Env Vars", "Ortam değişkenleri"],
  ["Hint", "İpucu"],
  ["Support", "Destek"],
  ["Usage:", "Kullanım:"],
  ["Options:", "Seçenekler:"],
  ["Commands:", "Komutlar:"],
  ["Notes:", "Notlar:"],
  ["default", "varsayılan"],
  ["choices", "seçenekler"],
  ["preset", "ön ayar"],
  ["Language", "Dil"],
  ["Auto", "Otomatik"],
  ["English", "İngilizce"],
  ["Turkish", "Türkçe"],
  ["German", "Almanca"],
  ["Spanish", "İspanyolca"],
  ["French", "Fransızca"],
  ["Auto (detect)", "Otomatik (algıla)"],
  ["Short", "Kısa"],
  ["Medium", "Orta"],
  ["Long", "Uzun"],
  ["Fetching website", "Web sitesi alınıyor"],
  ["connecting", "bağlanıyor"],
  ["Summarizing", "Özetleniyor"],
  ["Summarizing…", "Özetleniyor…"],
  ["Connecting…", "Bağlanıyor…"],
  ["Starting scan…", "Tarama başlatılıyor…"],
  ["Warning:", "Uyarı:"],
  ["Copied", "Kopyalandı"],
  ["Copy failed", "Kopyalama başarısız"],
  ["Nothing to copy", "Kopyalanacak bir şey yok"],
  ["Cache cleared.", "Önbellek temizlendi."],
  ["Cache is empty.", "Önbellek boş."],
  ["Cache path:", "Önbellek yolu:"],
  ["Size:", "Boyut:"],
  ["Entries:", "Kayıtlar:"],
  [
    "Install ffmpeg + yt-dlp for --slides, and tesseract for --slides-ocr.",
    "--slides için ffmpeg + yt-dlp, --slides-ocr için tesseract kurun.",
  ],
  ["Save failed", "Kaydetme başarısız"],
  ["Saved", "Kaydedildi"],
  ["Try again", "Tekrar dene"],
  ["View logs", "Günlükleri görüntüle"],
  ["Something went wrong", "Bir şeyler yanlış gitti"],
  ["Clear", "Temizle"],
  ["Refresh", "Yenile"],
  ["Settings", "Ayarlar"],
  ["Advanced", "Gelişmiş"],
  ["Model", "Model"],
  ["Free", "Ücretsiz"],
  ["Custom…", "Özel…"],
  ["Slides view", "Slayt görünümü"],
  ["Summary + strip", "Özet + şerit"],
  ["Slides only", "Yalnızca slaytlar"],
  ["Connect", "Bağlan"],
  ["Size", "Boyut"],
  ["Line", "Satır"],
  ["Font", "Yazı tipi"],
  ["Scheme", "Şema"],
  ["Mode", "Mod"],
  ["Page", "Sayfa"],
  ["Video", "Video"],
  ["Slides", "Slaytlar"],
  ["Slide", "Slayt"],
  ["Transcript", "Döküm"],
  ["OCR", "OCR"],
  ["Browser", "Tarayıcı"],
  ["Daemon", "Daemon"],
  ["Direct", "Doğrudan"],
  ["Provider", "Sağlayıcı"],
  ["General", "Genel"],
  ["Runtime", "Çalışma zamanı"],
  ["UI", "Arayüz"],
  ["Skills", "Yetenekler"],
  ["Processes", "Süreçler"],
  ["Logs", "Günlükler"],
  ["Checking daemon…", "Daemon kontrol ediliyor…"],
  ["Loading...", "Yükleniyor..."],
  ["Unavailable", "Kullanılamıyor"],
  ["Enable automation permissions", "Otomasyon izinlerini etkinleştir"],
  ["Enable Chat in the side panel", "Yan panelde Sohbet modunu etkinleştir"],
  ["Enable website automation", "Web sitesi otomasyonunu etkinleştir"],
  ["Prompt override", "İstem geçersiz kılma"],
  ["Max chars (extracted)", "Maks. karakter (çıkarılan)"],
  ["Interface language", "Arayüz dili"],
  ["Automatic (browser)", "Otomatik (tarayıcı)"],
  ["Auto-summarize when the panel is open.", "Panel açıkken otomatik özetle."],
  ["Language-independent selectors", "Dilden bağımsız seçiciler"],
  ["Report issues on GitHub", "GitHub'da sorun bildirin"],
  ["Jump to latest", "En yeniye git"],
  ["Ask about this page...", "Bu sayfa hakkında soru sorun..."],
  ["Send", "Gönder"],
  ["Downloading file", "Dosya indiriliyor"],
  ["Loading file", "Dosya yükleniyor"],
  ["Transcribing", "Döküm oluşturuluyor"],
  ["Transcribing media", "Medyanın dökümü oluşturuluyor"],
  ["Extracting text", "Metin çıkarılıyor"],
  ["Extracting slides", "Slaytlar çıkarılıyor"],
  ["Slides extracted:", "Çıkarılan slayt:"],
  ["Slides dir:", "Slayt dizini:"],
  ["--slides could not extract slide images:", "--slides slayt görsellerini çıkaramadı:"],
  [
    "Usage: summarize slides [options] <source>",
    "Kullanım: summarize slides [seçenekler] <source>",
  ],
  [
    "Inline render mode: auto, kitty, iterm, none.",
    "Satır içi işleme modu: auto, kitty, iterm, none.",
  ],
  ["Alias for --slides-dir.", "--slides-dir için diğer ad."],
  ["Alias for --verbose.", "--verbose için diğer ad."],
  ["Output structured JSON", "Yapılandırılmış JSON çıktısı ver"],
  ["selected/configured", "seçili/yapılandırılmış"],
  ["ONNX cache:", "ONNX önbelleği:"],
  ["ONNX artifacts:", "ONNX yapıtları:"],
  ["cache", "önbellek"],
  ["artifacts", "yapıtlar"],
  ["see", "bkz."],
  ["--cache-stats must be used alone.", "--cache-stats tek başına kullanılmalıdır."],
  [
    "Daemon not installed (missing ~/.summarize/daemon.json)",
    "Daemon kurulu değil (~/.summarize/daemon.json eksik)",
  ],
  [
    "Run: summarize daemon install --token <token>",
    "Çalıştırın: summarize daemon install --token <token>",
  ],
  ["disabled", "devre dışı"],
  ["Total", "Toplam"],
  ["Extract", "Çıkarma"],
  ["Summary", "Özet"],
  ["Transcript", "Döküm"],
  [
    "Chrome native host: macOS and Linux (Windows executable packaging pending)",
    "Chrome yerel ana makinesi: macOS ve Linux (Windows çalıştırılabilir paketlemesi beklemede)",
  ],
  ["Linux: systemd user service", "Linux: systemd kullanıcı hizmeti"],
  ["(required for install)", "(install için gereklidir)"],
  [
    "Install service that runs src/cli.ts via Node (requires --dev)",
    "src/cli.ts dosyasını Node üzerinden çalıştıran hizmeti kur (--dev gerektirir)",
  ],
  ["Bypass slide cache (force re-extract).", "Slayt önbelleğini atla (yeniden çıkarmayı zorla)."],
  ["--render requires a TTY stdout.", "--render için TTY stdout gerekir."],
  ["--render is not supported with --json output.", "--render, --json çıktısıyla desteklenmez."],
  [
    "Slides are disabled (enable --slides-ocr or check arguments).",
    "Slaytlar devre dışı (--slides-ocr seçeneğini etkinleştirin veya bağımsız değişkenleri kontrol edin).",
  ],
  [
    "Slides are only supported for YouTube, direct video URLs, or local video files.",
    "Slaytlar yalnızca YouTube, doğrudan video URL'leri veya yerel video dosyaları için desteklenir.",
  ],
  [
    "summarize slides requires a URL or local video file.",
    "summarize slides için bir URL veya yerel video dosyası gerekir.",
  ],
  [
    "Install service that runs src/cli.ts via Node (repo dev mode)",
    "src/cli.ts dosyasını Node üzerinden çalıştıran hizmeti kur (depo geliştirme modu)",
  ],
  [
    "Dev-only unpacked Chrome extension ID (requires --dev)",
    "Yalnızca geliştirme için paketlenmemiş Chrome uzantı kimliği (--dev gerektirir)",
  ],
  [
    "Custom ports must also be set in Extension Options → Runtime → Daemon → Port.",
    "Özel portlar Uzantı Seçenekleri → Çalışma zamanı → Daemon → Port bölümünde de ayarlanmalıdır.",
  ],
  ["Transcriber setup", "Döküm oluşturucu kurulumu"],
  ["Transcriber mode:", "Döküm oluşturucu modu:"],
  ["Auto order:", "Otomatik sıra:"],
  ["To enable ONNX locally:", "ONNX'i yerelde etkinleştirmek için:"],
  [
    "Install sherpa-onnx from upstream binaries or build; Homebrew may not have a formula.",
    "sherpa-onnx'i upstream ikili dosyalarından kurun veya derleyin; Homebrew'da formül bulunmayabilir.",
  ],
  ["configured", "yapılandırıldı"],
  ["not configured", "yapılandırılmadı"],
  ["present", "mevcut"],
  ["missing", "eksik"],
  ["binary ok", "ikili dosya hazır"],
  ["binary missing", "ikili dosya eksik"],
  ["placeholders:", "yer tutucular:"],
  ["Next:", "Sıradaki:"],
  ["Model:", "Model:"],
  ["Config:", "Yapılandırma:"],
  ["Presets:", "Ön ayarlar:"],
  ["Providers:", "Sağlayıcılar:"],
  ["environment", "ortam"],
  ["source", "kaynak"],
  ["available", "kullanılabilir"],
  ["usable", "kullanılabilir"],
  ["Wrote ", "Yazıldı: "],
  ["--width must be a number >= 20.", "--width en az 20 olan bir sayı olmalıdır."],
  [
    "Use either --prompt or --prompt-file (not both).",
    "--prompt veya --prompt-file seçeneklerinden yalnızca birini kullanın (ikisini birden değil).",
  ],
  ["Prompt must not be empty.", "İstem boş olamaz."],
  ["Unable to resolve cache path (missing HOME).", "Önbellek yolu çözümlenemedi (HOME eksik)."],
  ["--clear-cache must be used alone.", "--clear-cache tek başına kullanılmalıdır."],
  ["Unknown status option:", "Bilinmeyen status seçeneği:"],
  ["via ", "aracılığıyla "],
  ["Downloading", "İndiriliyor"],
  ["Loading", "Yükleniyor"],
  ["Extracting", "Çıkarılıyor"],
  ["Refreshing", "Yenileniyor"],
  ["Scanning", "Taranıyor"],
  ["Refresh Free", "Ücretsiz Yenileme"],
  ["fetching OpenRouter models…", "OpenRouter modelleri alınıyor…"],
  ["filtered", "filtrelenen"],
  ["old", "eski"],
  ["small", "küçük"],
  ["found", "bulundu"],
  ["testing", "test ediliyor"],
  ["concurrency", "eşzamanlılık"],
  ["tested", "test edildi"],
  ["elapsed", "geçen süre"],
  ["selected", "seçildi"],
  ["candidates", "aday"],
  ["sorted", "sıralı"],
  ["latency", "gecikme"],
  ["rate limit hit", "hız sınırına ulaşıldı"],
  ["sleeping", "bekleniyor"],
  ["results", "sonuçlar"],
  ["failed", "başarısız"],
  ["ok", "tamam"],
  ["fail", "başarısız"],
  ["Note:", "Not:"],
  ["refining", "iyileştiriliyor"],
  ["extra runs", "ek çalıştırma"],
];

const TRANSLATION_LOOKUP = new Map(TURKISH_TRANSLATIONS);
const TECHNICAL_VALUE_PATTERN =
  /\b(?:auto|off|on|always|detailed|short|medium|long|xl|xxl|none|low|high|xhigh|min|mid|fast|priority|flex|readability|transcript|understand|llm|text|md|kitty|iterm|json|false|true)\b/gi;

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createValueProtector(input: readonly string[]) {
  const values = [...new Set(input.filter(Boolean))].sort((a, b) => b.length - a.length);
  const pattern = values.length > 0 ? new RegExp(values.map(escapeRegExp).join("|"), "g") : null;
  return {
    protect: (text: string) =>
      pattern
        ? text.replace(pattern, (value) => `\u0000value_${values.indexOf(value)}\u0000`)
        : text,
    restore: (text: string) =>
      text.replace(/\u0000value_(\d+)\u0000/g, (_, index: string) => values[Number(index)] ?? ""),
  };
}

function protectTechnicalTokens(text: string): {
  masked: string;
  restore: (value: string) => string;
} {
  const protectedTokens: string[] = [];
  const mask = (value: string) => {
    const index = protectedTokens.push(value) - 1;
    return `\u0000${index}\u0000`;
  };
  let masked = text;
  for (const pattern of [
    /`[^`\n]*`/g,
    /(?:https?|ftp):\/\/[^\s)]+/g,
    /--[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s]+)?/g,
    /(?:~\/|\.\/|\/)[^\s,)]+/g,
    /\b[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.:@+-]+)+\b/g,
    /\b[A-Z][A-Z0-9_]{2,}\b/g,
    /<[^>\n]+>/g,
    /\b[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.:-]+\b/g,
    /"[^"\n]*"/g,
    TECHNICAL_VALUE_PATTERN,
  ]) {
    masked = masked.replace(pattern, mask);
  }
  masked = masked.replace(
    /(hizmet katmanı:\s*)default\b/gi,
    (_, prefix: string) => `${prefix}${mask("default")}`,
  );
  return {
    masked,
    restore: (value) =>
      value.replace(
        /\u0000(\d+)\u0000/g,
        (_, index: string) => protectedTokens[Number(index)] ?? "",
      ),
  };
}

/** Translate app-owned text; pass interpolated data as protectedValues to preserve it exactly. */
export function translateCliText(
  text: string,
  locale: CliLocale,
  protectedValues: readonly string[] = [],
): string {
  if (locale === "en") return text;
  const values = createValueProtector(protectedValues);
  let translated = values.protect(text);
  for (const [source, target] of TURKISH_TRANSLATIONS.toSorted(
    (a, b) => b[0].length - a[0].length,
  )) {
    const isSingleWord = /^[A-Za-z]+$/.test(source);
    if (isSingleWord) continue;
    translated = translated.replace(new RegExp(escapeRegExp(source), "g"), target);
    const wrappedPattern = source.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
    translated = translated.replace(new RegExp(wrappedPattern, "g"), target);
  }
  const protectedText = protectTechnicalTokens(translated);
  translated = protectedText.masked;
  for (const [source, target] of TURKISH_TRANSLATIONS) {
    if (!/^[A-Za-z]+$/.test(source)) continue;
    translated = translated.replace(new RegExp(`\\b${escapeRegExp(source)}\\b`, "g"), target);
  }
  return values.restore(protectedText.restore(translated));
}

export function hasTurkishTranslation(source: string): boolean {
  return TRANSLATION_LOOKUP.has(source);
}

export const cliTranslationKeys = TURKISH_TRANSLATIONS.map(([source]) => source);
