// 提示解析：官方把答案包在 <font> 里，解析要能扛住嵌套标签和空片段
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-tips-'));
const { parseTips } = await import('../src/xxqg/tasks.js');

test('取出多个 font 片段', () => {
  const html = '<div>正确答案：<font color="red">人民</font>和<font>政府</font></div>';
  assert.deepEqual(parseTips(html), ['人民', '政府']);
});

test('片段里嵌套标签时只保留文字', () => {
  const html = '<font><span style="x">党的</span><b>领导</b></font>';
  assert.deepEqual(parseTips(html), ['党的领导']);
});

test('空白片段和空 font 会被过滤', () => {
  const html = '<font>  </font><font></font><font>有效</font>';
  assert.deepEqual(parseTips(html), ['有效']);
});

test('没有 font 时返回空数组（交给上层走兜底）', () => {
  assert.deepEqual(parseTips('<div>没有答案标签</div>'), []);
});

test('空白/异常输入不抛错', () => {
  assert.deepEqual(parseTips(''), []);
  assert.deepEqual(parseTips(undefined), []);
  assert.deepEqual(parseTips(null), []);
});

test('多行答案里的换行与多余空格被压平', () => {
  const html = '<font>根据\n  事实  </font>';
  assert.deepEqual(parseTips(html), ['根据 事实']);
});
