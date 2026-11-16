// Saving generated text (CSV, vCard) as a file download, entirely in the browser.

const OBJECT_URL_LIFETIME_MS = 2000;

/** Save text as a file through a temporary object URL. */
export function downloadTextFile(fileName, text, mimeType) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const anchor = Object.assign(document.createElement("a"), { href: url, download: fileName });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
}
