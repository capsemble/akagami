/**
 * Chapter in, text out, with page numbers kept — the curriculum agent has to
 * cite a page, and the validator has to find the quote again.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export interface Page {
  page: number;
  text: string;
}

export interface ExtractedChapter {
  /** Whole chapter, pages joined with form feeds. */
  text: string;
  pages: Page[];
  source: string;
  /** sha256 of `text` — the cache key for the whole pipeline. */
  hash: string;
  /** Present for PDFs: the raw bytes, so we can send the file inline to Gemini. */
  pdf?: Buffer;
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Pages are joined with \f so a page index can be recovered from an offset. */
export function joinPages(pages: Page[]): string {
  return pages.map((p) => p.text).join('\n\f\n');
}

async function extractPdf(path: string): Promise<ExtractedChapter> {
  // The legacy build is the one that runs under Node without a DOM.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = await readFile(path);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // No worker thread: simpler, and a chapter is small enough not to care.
    disableWorker: true,
    isEvalSupported: false,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await loadingTask.promise;

  const pages: Page[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    pages.push({ page: n, text });
  }
  await loadingTask.destroy();

  const text = joinPages(pages);
  return { text, pages, source: path, hash: hashText(text), pdf: bytes };
}

/** Markdown and plain text have no pages, so we cut them into ~500-word ones. */
function paginatePlainText(raw: string, wordsPerPage = 500): Page[] {
  const words = raw.split(/(\s+)/);
  const pages: Page[] = [];
  let buffer: string[] = [];
  let count = 0;

  for (const token of words) {
    buffer.push(token);
    if (token.trim()) count++;
    if (count >= wordsPerPage) {
      pages.push({ page: pages.length + 1, text: buffer.join('').trim() });
      buffer = [];
      count = 0;
    }
  }
  if (buffer.join('').trim()) pages.push({ page: pages.length + 1, text: buffer.join('').trim() });
  return pages.length > 0 ? pages : [{ page: 1, text: raw }];
}

export async function extractText(input: string): Promise<ExtractedChapter> {
  if (extname(input).toLowerCase() === '.pdf') return extractPdf(input);

  const raw = await readFile(input, 'utf8');
  const pages = paginatePlainText(raw);
  const text = joinPages(pages);
  return { text, pages, source: input, hash: hashText(text) };
}

/** Same, for a chapter pasted straight into the API. */
export function extractFromString(raw: string, source = 'inline'): ExtractedChapter {
  const pages = paginatePlainText(raw);
  const text = joinPages(pages);
  return { text, pages, source, hash: hashText(text) };
}
