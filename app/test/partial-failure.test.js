// 单任务失败不应拖垮整轮：普通失败继续，风控/登录失效立刻停
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-partial-'));

// 复制 worker 里的判定逻辑（worker 本体依赖 playwright，这里只测规则）
const SAFETY_STOP =
  /\b(?:401|403|429)\b|captcha|slider|risk|security.?check|too many requests|rate.?limit|unauthorized|forbidden|验证|风控|账号异常|访问异常|登录.*失效|cookie.*失效|请求被拒绝/i;
const isSafetyStop = (message) => SAFETY_STOP.test(String(message || ''));

/** 与 worker.runTaskJob 相同的循环语义，用假 runner 验证 */
async function runTasks(tasks, runners) {
  const failures = [];
  let succeeded = 0;
  const logs = [];
  for (const name of tasks) {
    try {
      const msg = await runners[name]();
      logs.push(`ok:${name}:${msg}`);
      succeeded++;
    } catch (e) {
      const reason = e.message;
      logs.push(`bad:${name}:${reason}`);
      if (isSafetyStop(reason)) throw e;
      failures.push(`${name}：${reason}`);
      continue;
    }
  }
  if (succeeded === 0 && failures.length) throw new Error(`全部任务未完成：${failures.join('；')}`);
  return { logs, failures, succeeded };
}

test('中间任务失败时，后续任务仍会执行', async () => {
  const r = await runTasks(['a', 'b', 'c'], {
    a: async () => 'a 完成',
    b: async () => {
      throw new Error('阅读积分未达标，已停止');
    },
    c: async () => 'c 完成',
  });
  assert.equal(r.succeeded, 2, 'a、c 应成功');
  assert.deepEqual(r.failures, ['b：阅读积分未达标，已停止']);
  assert.ok(r.logs.includes('ok:c:c 完成'), '失败后的 c 仍应执行');
});

test('风控/登录失效立刻中止，不继续跑后面的任务', async () => {
  let cRan = false;
  await assert.rejects(
    runTasks(['a', 'b', 'c'], {
      a: async () => 'a 完成',
      b: async () => {
        throw new Error('平台要求安全验证，访问异常');
      },
      c: async () => {
        cRan = true;
        return 'c';
      },
    }),
    /安全验证/,
  );
  assert.equal(cRan, false, '风控类错误不应继续执行后续任务');
});

test('全部失败时才抛错', async () => {
  await assert.rejects(
    runTasks(['a', 'b'], {
      a: async () => {
        throw new Error('页面异常');
      },
      b: async () => {
        throw new Error('网络超时');
      },
    }),
    /全部任务未完成/,
  );
});

test('全部成功不产生失败记录', async () => {
  const r = await runTasks(['a'], { a: async () => '完成' });
  assert.equal(r.failures.length, 0);
  assert.equal(r.succeeded, 1);
});
