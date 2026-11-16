// Clipboard writes, with a fallback for pages where the async clipboard API is blocked.

/** Copy text to the clipboard. @returns {Promise<boolean>} whether it was copied */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyWithTextarea(text);
  }
}

// ---------- private helpers ----------

function copyWithTextarea(text) {
  const textarea = Object.assign(document.createElement("textarea"), { value: text });
  textarea.style.cssText = "position:fixed;opacity:0";
  document.body.append(textarea);
  textarea.select();
  let isCopied = false;
  try { isCopied = document.execCommand("copy"); } catch { /* blocked: caller tells the user to press Ctrl+C */ }
  textarea.remove();
  return isCopied;
}
