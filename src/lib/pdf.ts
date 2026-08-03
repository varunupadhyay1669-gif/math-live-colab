// A very small PDF writer — enough for a class pack, and nothing more.
//
// Why not a library: the only things needed here are pages, Helvetica text and
// JPEG images. JPEG bytes go into a PDF *verbatim* (the DCTDecode filter), and
// the 14 standard fonts need no embedding, so this whole file is smaller than
// the dependency would add to the bundle, has no install step, and can be
// tested byte-for-byte.
//
// The one thing a PDF writer must get right is the cross-reference table: it
// stores the byte offset of every object, so everything is assembled into a
// byte array while offsets are recorded as we go.

const enc = new TextEncoder();

/** Latin-1 is what Helvetica/WinAnsi can actually render. */
function toLatin1(s: string): string {
  return (s || '')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '');   // drop emoji and other non-renderables
}

/** ( ) and \ are structural inside a PDF string literal. */
function escapeText(s: string): string {
  return toLatin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export interface PdfImage {
  /** Raw JPEG bytes — embedded as-is, never re-encoded. */
  jpeg: Uint8Array;
  width: number;
  height: number;
}

type Page =
  | { kind: 'text'; lines: TextLine[] }
  | { kind: 'image'; image: PdfImage; caption: string; subCaption?: string };

export interface TextLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Blank space above this line, in points. */
  gap?: number;
}

export const PAGE_W = 595;   // A4 at 72dpi
export const PAGE_H = 842;
const MARGIN = 48;

export class PdfBuilder {
  private pages: Page[] = [];

  addTextPage(lines: TextLine[]) { this.pages.push({ kind: 'text', lines }); }
  addImagePage(image: PdfImage, caption: string, subCaption?: string) {
    this.pages.push({ kind: 'image', image, caption, subCaption });
  }
  get pageCount() { return this.pages.length; }

  /** Wrap a paragraph to the page width at the given size (Helvetica ≈ 0.5em avg). */
  static wrap(text: string, size = 10, width = PAGE_W - MARGIN * 2): string[] {
    const perLine = Math.max(16, Math.floor(width / (size * 0.5)));
    const out: string[] = [];
    for (const para of toLatin1(text).split('\n')) {
      if (!para.trim()) { out.push(''); continue; }
      let line = '';
      for (const word of para.split(/\s+/)) {
        if (!line.length) { line = word; continue; }
        if ((line + ' ' + word).length <= perLine) line += ' ' + word;
        else { out.push(line); line = word; }
      }
      if (line) out.push(line);
    }
    return out;
  }

  build(): Blob {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const push = (b: Uint8Array | string) => {
      const bytes = typeof b === 'string' ? enc.encode(b) : b;
      chunks.push(bytes);
      length += bytes.length;
    };

    // Object 1 = catalog, 2 = page tree, 3 = font. Pages and images follow.
    const offsets: number[] = [];       // offsets[n] = byte offset of object n
    const objStart = (n: number) => { offsets[n] = length; };

    push('%PDF-1.4\n');
    // A binary comment marks the file as containing binary data (image bytes).
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    // Reserve numbers: 1 catalog, 2 pages, 3 font, then 2 objects per page
    // (page + contents) plus 1 more for each image.
    let next = 4;
    const pageObjs = this.pages.map((p) => {
      const pageNum = next++;
      const contentNum = next++;
      const imageNum = p.kind === 'image' ? next++ : 0;
      return { pageNum, contentNum, imageNum, page: p };
    });

    objStart(1);
    push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);

    objStart(2);
    push(`2 0 obj\n<< /Type /Pages /Kids [${pageObjs.map(p => `${p.pageNum} 0 R`).join(' ')}] /Count ${pageObjs.length} >>\nendobj\n`);

    objStart(3);
    push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
    // Bold is a second font object, numbered after everything else.
    const boldNum = next++;

    for (const { pageNum, contentNum, imageNum, page } of pageObjs) {
      const content = page.kind === 'text'
        ? textContent(page.lines)
        : imageContent(page.image, page.caption, page.subCaption);

      const xobject = imageNum ? `/XObject << /Im0 ${imageNum} 0 R >>` : '';
      objStart(pageNum);
      push(`${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 ${boldNum} 0 R >> ${xobject} >> ` +
        `/Contents ${contentNum} 0 R >>\nendobj\n`);

      const contentBytes = enc.encode(content);
      objStart(contentNum);
      push(`${contentNum} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
      push(contentBytes);
      push('\nendstream\nendobj\n');

      if (imageNum && page.kind === 'image') {
        objStart(imageNum);
        push(`${imageNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.image.width} ` +
          `/Height ${page.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
          `/Filter /DCTDecode /Length ${page.image.jpeg.length} >>\nstream\n`);
        push(page.image.jpeg);
        push('\nendstream\nendobj\n');
      }
    }

    objStart(boldNum);
    push(`${boldNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`);

    // Cross-reference table. Entry 0 is the required free-object head.
    const xrefStart = length;
    const total = next;
    let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let n = 1; n < total; n++) {
      xref += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
    }
    push(xref);
    push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
  }
}

function textContent(lines: TextLine[]): string {
  let y = PAGE_H - MARGIN;
  let out = 'BT\n';
  let currentFont = '';
  for (const line of lines) {
    const size = line.size ?? 10;
    y -= (line.gap ?? 0) + size * 1.45;
    if (y < MARGIN) break;                       // caller paginates; never overflow
    const font = line.bold ? '/F2' : '/F1';
    if (`${font}${size}` !== currentFont) {
      out += `${font} ${size} Tf\n`;
      currentFont = `${font}${size}`;
    }
    out += `1 0 0 1 ${MARGIN} ${y.toFixed(1)} Tm\n(${escapeText(line.text)}) Tj\n`;
  }
  return out + 'ET\n';
}

function imageContent(img: PdfImage, caption: string, subCaption?: string): string {
  const availW = PAGE_W - MARGIN * 2;
  const availH = PAGE_H - MARGIN * 2 - 40;               // leave room for the caption
  const scale = Math.min(availW / img.width, availH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = (PAGE_W - w) / 2;
  const y = PAGE_H - MARGIN - 40 - h;
  let out = 'BT\n/F2 12 Tf\n';
  out += `1 0 0 1 ${MARGIN} ${PAGE_H - MARGIN} Tm\n(${escapeText(caption)}) Tj\n`;
  if (subCaption) {
    out += `/F1 9 Tf\n1 0 0 1 ${MARGIN} ${PAGE_H - MARGIN - 15} Tm\n(${escapeText(subCaption)}) Tj\n`;
  }
  out += 'ET\n';
  out += `q\n${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`;
  return out;
}

/** "data:image/jpeg;base64,…" → raw bytes. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
