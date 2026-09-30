// Just enough of a zip reader for EPUB: the central directory, stored and deflated entries.
import zlib from 'node:zlib';

export function readZip(buf) {
  // End of central directory: the last "PK\5\6" within the final 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const get = (name) => {
    let e = entries.get(name);
    if (!e) try { e = entries.get(decodeURIComponent(name)); } catch {}
    if (!e) return null;
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const raw = buf.subarray(start, start + e.size);
    if (e.method === 0) return raw;
    // Capped, so a hostile file (a zip bomb) can't take the server's memory.
    if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: 256e6 });
    throw new Error(`Unsupported zip compression (${e.method})`);
  };
  return { names: [...entries.keys()], get, text: (name) => get(name)?.toString('utf8') ?? null };
}
