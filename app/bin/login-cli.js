// 命令行版扫码登录：不依赖网页，用来验证协议和账号可用性
// 用法: node bin/login-cli.js
import QRCode from 'qrcode';
import { Jar, getSign, newQrCode, qrContent, pollQr, secureCheck, userInfo, score } from '../src/xxqg/client.js';

const jar = new Jar();
const state = await getSign(jar);
let code = await newQrCode(jar);
const url = qrContent(code);
console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
console.log('用学习强国 APP 扫码，或直接把下面链接转成二维码：\n', url, '\n');

for (let i = 0; i < 90; i++) {
  const r = await pollQr(jar, code, state);
  if (r.status === 'expired') {
    console.log('二维码过期，重新生成…');
    code = await newQrCode(jar);
    console.log(await QRCode.toString(qrContent(code), { type: 'terminal', small: true }));
    continue;
  }
  if (r.status === 'scanned') {
    await secureCheck(jar, r.tmpCode, state);
    const user = await userInfo(jar);
    console.log('\n登录成功:', user.nick, user.uid);
    console.log('cookie:', jar.header());
    console.log('今日积分:', JSON.stringify((await score(jar)).today));
    process.exit(0);
  }
  await new Promise((res) => setTimeout(res, 2000));
}
console.log('超时未扫码');
process.exit(1);
