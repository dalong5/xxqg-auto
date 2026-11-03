import fs from 'node:fs';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
const png = PNG.sync.read(fs.readFileSync('data/ui-qr.png'));
const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
console.log('size', png.width, png.height, 'decoded:', r ? r.data : 'NONE');
