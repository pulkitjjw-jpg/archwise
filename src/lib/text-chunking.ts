// Splits a single block of prose into readable chunks for step-card-style display (e.g. the
// Architecture Flow Story), WITHOUT dropping or summarizing any text -- every character of the
// input appears in the output, just grouped differently.
//
// Primary path: split on real blank-line paragraph breaks, if the text actually has any (the Flow
// Story generation prompt asks for "a few short paragraphs", but a real LLM response doesn't
// always insert literal blank lines even when it does write logically distinct steps/sentences).
//
// Fallback path: if that yields only a single chunk (no blank lines present at all -- confirmed to
// happen in practice, not just a theoretical edge case), split into sentences and group them so
// each chunk stays under a target character budget -- this guarantees genuine visual chunking even
// for a real single-paragraph LLM response, which was the actual bug: a "paragraph-break-only"
// split silently did nothing for text that never had one.
const TARGET_CHUNK_CHARS = 220;

export function chunkStoryText(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length > 1) return paragraphs;

  const singleBlock = (paragraphs[0] ?? text.trim());
  if (!singleBlock) return [];

  // Sentence-ish boundary: a period/question/exclamation mark followed by whitespace and a
  // capital letter (or the very end of the string) -- deliberately simple, this doesn't need to
  // be typeset-perfect, just good enough to avoid splitting mid-abbreviation most of the time.
  const sentences = singleBlock.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
  if (sentences.length <= 1) return [singleBlock];

  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (current && candidate.length > TARGET_CHUNK_CHARS) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
