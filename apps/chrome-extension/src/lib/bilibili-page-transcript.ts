export type BilibiliPageVideo = { url: string; bvid: string; part: number };

export type BrowserBilibiliTranscript =
  | {
      ok: true;
      url: string;
      text: string;
      transcriptTimedText: string;
      truncated: boolean;
      durationSeconds: number | null;
      language: string;
      generated: boolean;
    }
  | { ok: false; reason: "failed" | "stale"; error: string };

export function parseBilibiliPageVideo(value: string): BilibiliPageVideo | null {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !["www.bilibili.com", "bilibili.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }
    const bvid = url.pathname.match(
      /^\/(?:[a-z]{2}(?:-[A-Za-z]+)?\/)?video\/(BV[\da-zA-Z]{10})\/?$/,
    )?.[1];
    const parts = url.searchParams.getAll("p");
    const part = parts.length === 0 ? 1 : Number(parts[0]);
    if (
      !bvid ||
      parts.length > 1 ||
      (parts.length > 0 && !/^[1-9]\d*$/.test(parts[0] ?? "")) ||
      !Number.isSafeInteger(part) ||
      part < 1
    ) {
      return null;
    }
    return { url: url.href, bvid, part };
  } catch {
    return null;
  }
}

// Chrome serializes this function for MAIN-world injection; keep its helpers local.
export async function fetchBilibiliPageTranscript(
  expected: BilibiliPageVideo,
  maxChars: number,
): Promise<BrowserBilibiliTranscript> {
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const currentPageMatches = () => {
    const current = new URL(location.href);
    const expectedUrl = new URL(expected.url);
    return (
      current.origin === expectedUrl.origin &&
      current.pathname === expectedUrl.pathname &&
      current.searchParams.getAll("p").length <= 1 &&
      (current.searchParams.get("p") ?? "1") === String(expected.part)
    );
  };
  const failure = (error: string): BrowserBilibiliTranscript => ({
    ok: false,
    reason: currentPageMatches() ? "failed" : "stale",
    error,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const loadJson = async (url: string, cookieMode: RequestCredentials): Promise<unknown> => {
    if (!currentPageMatches()) throw new Error("Bilibili video changed during caption retrieval.");
    const response = await fetch(url, {
      credentials: cookieMode,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Bilibili caption request failed.");
    const raw = await response.text();
    if (!currentPageMatches()) throw new Error("Bilibili video changed during caption retrieval.");
    if (raw.length > 4_000_000) throw new Error("Bilibili caption response is too large.");
    return JSON.parse(raw);
  };
  try {
    if (!currentPageMatches()) return failure("Bilibili video changed during caption retrieval.");
    const view = object(
      await loadJson(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(expected.bvid)}`,
        "include",
      ),
    );
    const video = object(view?.data);
    if (view?.code !== 0 || video?.bvid !== expected.bvid || !Array.isArray(video.pages)) {
      return failure("Could not resolve the current Bilibili video.");
    }
    const page = video.pages.map(object).find((entry) => entry?.page === expected.part);
    const cid = page?.cid;
    if (typeof cid !== "number" || !Number.isSafeInteger(cid) || cid <= 0) {
      return failure("Could not resolve the current Bilibili video part.");
    }
    const metadata = object(
      await loadJson(
        `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(expected.bvid)}&cid=${cid}`,
        "include",
      ),
    );
    const data = object(metadata?.data);
    const subtitle = object(data?.subtitle);
    if (metadata?.code !== 0 || data?.cid !== cid || !Array.isArray(subtitle?.subtitles)) {
      return failure("Could not read Bilibili caption tracks in this browser session.");
    }
    const tracks = subtitle.subtitles.flatMap((value) => {
      const track = object(value);
      if (
        typeof track?.lan !== "string" ||
        typeof track.subtitle_url !== "string" ||
        track.is_lock === true
      ) {
        return [];
      }
      let url: URL;
      try {
        url = new URL(track.subtitle_url, "https://www.bilibili.com");
      } catch {
        return [];
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        ![
          "aisubtitle.hdslb.com",
          "i0.hdslb.com",
          "i1.hdslb.com",
          "i2.hdslb.com",
          "subtitle.bilibili.com",
        ].includes(url.hostname)
      ) {
        return [];
      }
      return [
        {
          url: url.href,
          language: track.lan,
          generated: track.lan.startsWith("ai-") || track.type === 1,
        },
      ];
    });
    const priority = (track: (typeof tracks)[number]) => {
      const language = track.language.replace(/^ai-/, "").toLowerCase();
      return (
        (/^en(?:-|$)/.test(language) ? 0 : /^zh(?:-|$)/.test(language) ? 2 : 4) +
        Number(track.generated)
      );
    };
    tracks.sort((left, right) => priority(left) - priority(right));
    if (tracks.length === 0) {
      return failure("No Bilibili caption tracks are available in this browser session.");
    }
    for (const track of tracks) {
      let payload: unknown;
      try {
        payload = await loadJson(track.url, "omit");
      } catch {
        if (!currentPageMatches() || controller.signal.aborted) break;
        continue;
      }
      const body = object(payload)?.body;
      if (!Array.isArray(body)) continue;
      const cues = body.flatMap((value) => {
        const cue = object(value);
        if (
          typeof cue?.from !== "number" ||
          !Number.isFinite(cue.from) ||
          cue.from < 0 ||
          typeof cue.to !== "number" ||
          !Number.isFinite(cue.to) ||
          cue.to <= cue.from ||
          typeof cue.content !== "string"
        ) {
          return [];
        }
        const text = cue.content.replace(/\s+/g, " ").trim();
        return text ? [{ from: cue.from, to: cue.to, text }] : [];
      });
      if (cues.length === 0) continue;
      cues.sort((left, right) => left.from - right.from);
      const timed = cues
        .map((cue) => {
          const seconds = Math.floor(cue.from);
          const minutes = Math.floor(seconds / 60);
          return `[${minutes}:${String(seconds % 60).padStart(2, "0")}] ${cue.text}`;
        })
        .join("\n");
      const limit = Math.max(0, Math.floor(maxChars));
      const clamp = (text: string) =>
        text.length <= limit
          ? text
          : `${text.slice(0, Math.max(0, limit - 13))}\n\n[TRUNCATED]`.slice(0, limit);
      const text = `Transcript:\n${timed}`;
      return {
        ok: true,
        url: expected.url,
        text: clamp(text),
        transcriptTimedText: clamp(timed),
        truncated: text.length > limit,
        durationSeconds:
          typeof page?.duration === "number" && Number.isFinite(page.duration) && page.duration > 0
            ? page.duration
            : null,
        language: track.language,
        generated: track.generated,
      };
    }
    return failure("No usable Bilibili caption transcript was returned.");
  } catch {
    return failure("Bilibili caption retrieval failed. Check the video and your browser login.");
  } finally {
    clearTimeout(timer);
  }
}
