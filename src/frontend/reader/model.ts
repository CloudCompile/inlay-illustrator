/** Pure helpers of the webtoon reader: message text for the quiet text cards. */

export interface TextRun { text: string; emphasis: boolean }

/**
 * Paragraphs (blank-line separated) of a message for its text card. HTML tags are dropped (the card shows prose,
 * not markup) and `*action*` / `**action**` become emphasis runs.
 */
export function readerParagraphs(text: string): TextRun[][] {
  return text
    .replace(/<[^>]*>/gu, "")
    .split(/\r?\n[\t ]*\r?\n\s*/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) =>
      paragraph.split(/(\*{1,2}[^*\n]+\*{1,2})/u).filter(Boolean).map((part) => {
        const emphasis = /^\*{1,2}[^*\n]+\*{1,2}$/u.test(part);
        return { text: emphasis ? part.replace(/^\*+|\*+$/gu, "") : part, emphasis };
      })
    );
}
