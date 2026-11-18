// Deterministic bag-of-words hashing embedder for offline tests/evals/benchmarks.
// Not semantic like MiniLM, but shares-words => similar, which is enough to
// exercise retrieval plumbing.
const DIMS = 256;

/** @param {string[]} texts @returns {Promise<Float32Array[]>} */
export async function fakeEmbed(texts) {
  return texts.map((text) => {
    const v = new Float32Array(DIMS);
    for (const word of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) v[hash(word) % DIMS] += 1;
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
}

function hash(word) {
  let h = 5381;
  for (const ch of word) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return h;
}
