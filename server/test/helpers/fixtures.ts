import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cove-fixtures-'));

export async function jpegWithGps(width = 640, height = 480): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#3a7' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'secret-owner', Artist: 'Camera Person' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 46/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '122/1 25/1 0/1' } })
    .toBuffer();
}

export const png = (w = 64, h = 64) => sharp({ create: { width: w, height: h, channels: 3, background: '#a53' } }).png().toBuffer();

export const noisyPng = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png({ compressionLevel: 0 }).toBuffer();

function ffmpeg(args: string[], out: string): Buffer {
  const file = path.join(dir, out);
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args, file]);
  return fs.readFileSync(file);
}

export const mp4WithLocation = () =>
  ffmpeg(
    ['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-metadata', 'location=+37.7749-122.4194/', '-metadata', 'title=private title', '-f', 'mp4'],
    'clip.mp4',
  );

export const webmOpusVoice = () => ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'libopus', '-f', 'webm'], 'voice.webm');

export const mp3 = () => ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=500:duration=1', '-c:a', 'libmp3lame', '-metadata', 'artist=Someone', '-f', 'mp3'], 'tone.mp3');

export const minimalPdf = () =>
  Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  );

/** Build a ZIP (stored, no compression) from name → content. */
export function zip(entries: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

export const docx = () =>
  zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
  });

export const xlsx = () =>
  zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' });

export const exe = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
