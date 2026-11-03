import fs from 'node:fs';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
const png = PNG.sync.read(fs.readFileSync('data/shot-qr.png'));
const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
console.log('size', png.width, png.height);
console.log('decoded:', r ? r.data : 'NONE');
