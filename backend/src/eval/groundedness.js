// Groundedness metric: the share of sentences in a generated paragraph whose
// content words are (mostly) present in the source text it was written from.
// It is a lexical proxy for "traceable to source", cheap and deterministic, so
// it can run in CI without an LLM judge.

const MIN_WORD_LENGTH = 4;
const GROUNDED_WORD_SHARE = 0.6;
const STOPWORDS = new Set(["this", "that", "with", "from", "have", "has", "uses", "using", "which", "their", "they", "them", "into", "also", "were", "when", "what", "will", "than", "then", "about", "project", "unknown"]);

/**
 * @param {string} paragraph generated text
 * @param {string} sourceText concatenated source material
 * @returns {{ score: number, sentences: number, ungrounded: string[] }} score is 1 for empty input
 */
export function groundedness(paragraph, sourceText) {
  const sourceWords = new Set(contentWords(sourceText));
  const sentences = splitSentences(paragraph).filter((s) => contentWords(s).length > 0);
  if (!sentences.length) return { score: 1, sentences: 0, ungrounded: [] };
  const ungrounded = sentences.filter((s) => !isGrounded(s, sourceWords));
  return { score: (sentences.length - ungrounded.length) / sentences.length, sentences: sentences.length, ungrounded };
}

// ---------------------------------------------------------------- private helpers
function isGrounded(sentence, sourceWords) {
  const words = contentWords(sentence);
  return words.filter((w) => sourceWords.has(w)).length / words.length >= GROUNDED_WORD_SHARE;
}

function contentWords(text) {
  const words = String(text ?? "").toLowerCase().replace(/\[s\d+\]/g, " ").match(/[a-z0-9][a-z0-9+#.-]*/g) ?? [];
  return words.filter((w) => w.length >= MIN_WORD_LENGTH && !STOPWORDS.has(w));
}

function splitSentences(text) {
  return String(text ?? "").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}
