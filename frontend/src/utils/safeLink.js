// Scraped and chat-sourced URLs are untrusted: only plain https links become anchors.

/** @returns {string | null} the URL when it is https without credentials, else null */
export function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
