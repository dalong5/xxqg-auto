#!/usr/bin/env node
/**
 * 把 platform 里的验证码实现同步到 app（app 的容器构建上下文只含 app/，
 * 不能跨包引用，所以保留一份副本；这里做单一来源同步 + 漂移校验）。
 *
 *   node scripts/sync-captcha.mjs         # platform -> app 覆盖
 *   node scripts/sync-captcha.mjs --check # 只校验是否一致，不一致退出码 1
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, '..', 'platform', 'src', 'domain', 'captcha');
const dst = path.join(root, 'src', 'xxqg', 'captcha');
const files = ['solver.js', 'aliyun.js'];
const checkOnly = process.argv.includes('--check');

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
let drift = 0;

for (const f of files) {
  const s = path.join(src, f);
  const d = path.join(dst, f);
  if (!fs.existsSync(s)) {
    console.error(`缺少源文件 ${s}`);
    process.exit(2);
  }
  const a = fs.readFileSync(s);
  const b = fs.existsSync(d) ? fs.readFileSync(d) : Buffer.alloc(0);
  const same = a.equals(b);
  console.log(`${same ? '=' : '≠'} ${f}  platform=${hash(a)}  app=${hash(b)}`);
  if (!same) {
    drift += 1;
    if (!checkOnly) {
      fs.mkdirSync(dst, { recursive: true });
      fs.writeFileSync(d, a);
      console.log(`  → 已同步到 app/src/xxqg/captcha/${f}`);
    }
  }
}

if (checkOnly && drift) {
  console.error(`检测到 ${drift} 个文件漂移，请运行 node scripts/sync-captcha.mjs`);
  process.exit(1);
}
console.log(drift ? `同步完成（${drift} 个文件）` : '已一致');
