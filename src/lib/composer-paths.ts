/**
 * Composer path/`@`-mention parsing (port of the original pi-autocomplete
 * helpers). Pure functions — used by the composer's live completion logic.
 */

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

export function findLastDelimiter(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
  }
  return -1;
}

export function findUnclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = i;
    }
  }
  return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

export function extractQuotedPrefix(text: string): string | null {
  const quoteStart = findUnclosedQuoteStart(text);
  if (quoteStart === null) return null;
  if (quoteStart > 0 && text[quoteStart - 1] === "@") {
    if (!isTokenStart(text, quoteStart - 1)) return null;
    return text.slice(quoteStart - 1);
  }
  if (!isTokenStart(text, quoteStart)) return null;
  return text.slice(quoteStart);
}

export function extractAtPrefix(text: string): string | null {
  const quotedPrefix = extractQuotedPrefix(text);
  if (quotedPrefix?.startsWith('@"')) return quotedPrefix;
  const lastDelimiterIndex = findLastDelimiter(text);
  const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
  if (text[tokenStart] === "@") return text.slice(tokenStart);
  return null;
}

export function parsePathPrefix(prefix: string): {
  rawPrefix: string;
  isQuotedPrefix: boolean;
} {
  if (prefix.startsWith('@"')) return { rawPrefix: prefix.slice(2), isQuotedPrefix: true };
  if (prefix.startsWith("@")) return { rawPrefix: prefix.slice(1), isQuotedPrefix: false };
  return { rawPrefix: prefix, isQuotedPrefix: false };
}

/**
 * The token at the cursor used for forced (Tab) file completion, or `null`
 * when there is nothing to complete. Mirrors the original
 * `shouldTriggerFileCompletion` branch used by the composer.
 */
export function extractCompletionToken(
  textBeforeCursor: string,
): { prefix: string; quoted: boolean } | null {
  const atPrefix = extractAtPrefix(textBeforeCursor);
  if (atPrefix) {
    return { prefix: atPrefix, quoted: atPrefix.startsWith('@"') };
  }
  const q = extractQuotedPrefix(textBeforeCursor);
  if (q) return { prefix: q, quoted: q.startsWith('"') };
  const lastDelimiterIndex = findLastDelimiter(textBeforeCursor);
  const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
  const token = textBeforeCursor.slice(tokenStart);
  if (token !== "" || textBeforeCursor.endsWith(" ")) {
    return { prefix: token, quoted: false };
  }
  return null;
}
