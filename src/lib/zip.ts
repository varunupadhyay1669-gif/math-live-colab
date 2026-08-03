// A minimal ZIP writer — enough to ship a folder of files from the browser.
//
// The class pack is a PDF plus a JSON sidecar plus folders of images. That is a
// directory, and a browser has no directory to write to, so the whole thing
// leaves as one archive the tutor unzips.
//
// STORE only (no compression). Everything going in is a JPEG, a PNG or a PDF
// with its own compression already applied; deflating them again would burn CPU
// mid-lesson to save nothing. Storing also keeps this small enough to be read
// and tested in one sitting, which a dependency would not be.

const enc = new TextEncoder();

export interface ZipEntry {
  /** Path inside the archive, e.g. "snapshots/snap_1667.png". */
  name: string;
  data: Uint8Array;
}

/** CRC-32, as ZIP requires. Table built once. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]);
}
function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
}

/**
 * Build a ZIP. Entry order is preserved, which matters: two exports of the same
 * session must produce byte-identical archives, and a Map or Set iteration would
 * not guarantee that.
 */
export function buildZip(entries: ZipEntry[]): Blob {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const push = (b: Uint8Array) => { chunks.push(b); offset += b.length; };

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const localOffset = offset;

    // Local file header. Zero date/time keeps repeat exports identical — a
    // timestamp here would make every archive differ for no reason.
    push(u32(0x04034b50));
    push(u16(20));            // version needed
    push(u16(0));             // flags
    push(u16(0));             // method: store
    push(u16(0)); push(u16(0)); // mod time, mod date
    push(u32(crc));
    push(u32(entry.data.length));   // compressed size
    push(u32(entry.data.length));   // uncompressed size
    push(u16(nameBytes.length));
    push(u16(0));             // extra length
    push(nameBytes);
    push(entry.data);

    const c: Uint8Array[] = [];
    c.push(u32(0x02014b50));
    c.push(u16(20)); c.push(u16(20));
    c.push(u16(0)); c.push(u16(0));
    c.push(u16(0)); c.push(u16(0));
    c.push(u32(crc));
    c.push(u32(entry.data.length));
    c.push(u32(entry.data.length));
    c.push(u16(nameBytes.length));
    c.push(u16(0)); c.push(u16(0));
    c.push(u16(0)); c.push(u16(0));
    c.push(u32(0));
    c.push(u32(localOffset));
    c.push(nameBytes);
    central.push(concat(c));
  }

  const centralStart = offset;
  for (const c of central) push(c);
  const centralSize = offset - centralStart;

  push(u32(0x06054b50));
  push(u16(0)); push(u16(0));
  push(u16(entries.length)); push(u16(entries.length));
  push(u32(centralSize));
  push(u32(centralStart));
  push(u16(0));   // no comment

  return new Blob(chunks as BlobPart[], { type: 'application/zip' });
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** "data:image/jpeg;base64,…" → bytes, for putting an image in the archive. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
