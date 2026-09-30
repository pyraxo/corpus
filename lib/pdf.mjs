// PDF metadata, outline and per-page text, read with the vendored pdf.js (legacy build, which
// runs in Node). Pages are drawn in the browser; the server only needs the words.
import { paths } from './paths.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let lib = null;
async function pdfjs() {
  if (lib) return lib;
  // pdf.js warns at load time that it can't draw without a canvas package; the server never draws.
  const warn = console.warn, log = console.log;
  console.warn = console.log = () => {};
  try { lib = await import(pathToFileURL(path.join(paths.public, 'vendor', 'pdfjs', 'pdf.min.mjs')).href); }
  finally { console.warn = warn; console.log = log; }
  lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(paths.public, 'vendor', 'pdfjs', 'pdf.worker.min.mjs')).href;
  return lib;
}

const pdfDate = (s) => { const m = /^D:(\d{4})(\d{2})?(\d{2})?/.exec(s || ''); return m ? [m[1], m[2], m[3]].filter(Boolean).join('-') : null; };
const MAX_PAGES = 3000;

export async function parsePdf(buf) {
  const { getDocument, VerbosityLevel } = await pdfjs();
  const dir = path.join(paths.public, 'vendor', 'pdfjs');
  const task = getDocument({ data: new Uint8Array(buf), verbosity: VerbosityLevel.ERRORS, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, standardFontDataUrl: `${pathToFileURL(path.join(dir, 'standard_fonts')).href}/`, cMapUrl: `${pathToFileURL(path.join(dir, 'cmaps')).href}/`, cMapPacked: true });
  const doc = await task.promise
    .catch(e => { throw new Error(e.name === 'PasswordException' ? 'This PDF is password-protected' : `Couldn’t read this PDF (${e.message})`); });
  try {
    const { info = {} } = await doc.getMetadata().catch(() => ({}));
    const pages = [];
    let titleGuess = null;
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let text = '';
      for (const it of tc.items) { if (!('str' in it)) continue; text += it.str + (it.hasEOL ? '\n' : ''); }
      pages.push(text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
      // No Title in the metadata (most LaTeX papers): the largest text on the first page.
      if (i === 1) {
        const items = tc.items.filter(x => x.str?.trim() && !x.transform[1] && !x.transform[2]); // upright text only (not arXiv's side stamp)
        const max = Math.max(0, ...items.map(x => x.height));
        const big = items.filter(x => x.height >= max * 0.92).map(x => x.str).join(' ').replace(/\s+/g, ' ').trim();
        if (big.length >= 4 && big.length <= 200) titleGuess = big;
      }
      page.cleanup();
    }
    // Outline entries with the page each points at.
    const toc = [];
    const walk = async (items = [], level = 0) => {
      for (const it of items) {
        let page = null;
        try {
          const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
          if (dest?.[0]) page = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
        } catch {}
        if (it.title?.trim() && page != null) toc.push({ title: it.title.trim().slice(0, 160), page, level });
        if (it.items?.length && level < 3) await walk(it.items, level + 1);
      }
    };
    await walk(await doc.getOutline().catch(() => null) || []);
    const split = (s) => String(s || '').split(/[;,]|\s{2,}/).map(x => x.trim()).filter(Boolean);
    return {
      meta: {
        title: info.Title?.trim() && !/^(untitled|microsoft word|document\d*)\b|\.(docx?|pdf|tex)$/i.test(info.Title.trim()) ? info.Title.trim() : titleGuess,
        authors: split(info.Author).filter(a => a.length < 80),
        subjects: [...split(info.Keywords), ...split(info.Subject)].filter(s => s.length < 60).slice(0, 12),
        description: info.Subject && info.Subject.length >= 60 ? info.Subject.trim() : null,
        published: pdfDate(info.CreationDate),
        language: info.Language || null,
        producer: info.Producer || null
      },
      pageCount: doc.numPages,
      pages,
      toc
    };
  } finally { await task.destroy(); }
}
