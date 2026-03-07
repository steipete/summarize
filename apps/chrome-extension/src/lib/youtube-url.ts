export function isYouTubeWatchUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "youtu.be") {
      const id = url.pathname.replace(/^\/+/, "").trim();
      return Boolean(id);
    }
    if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return false;
    const path = url.pathname.toLowerCase();
    if (path === "/watch") return Boolean(url.searchParams.get("v")?.trim());
    if (path.startsWith("/shorts/")) return true;
    if (path.startsWith("/live/")) return true;
    return false;
  } catch {
    return false;
  }
}
