// 点选填空的词块匹配：最长前缀优先、退化匹配要消费正确的子串
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-chip-'));
const { pickChip } = await import('../src/xxqg/tasks.js');

test('前缀匹配取最长的词块', () => {
  const chips = ['人民', '人民代表大会', '大会'];
  const r = pickChip('人民代表大会制度', chips);
  assert.equal(r.index, 1, '应选最长的「人民代表大会」');
  assert.equal(r.rest, '制度');
});

test('退化匹配：词块出现在中间时，消费该子串本身而不是前缀', () => {
  // 真实场景：答案文本前面有提示里带的无关字，词块从中间开始
  const chips = ['党的', '领导'];
  const r = pickChip('坚持党的领导', chips, new Set());
  assert.equal(r.index, 0, '「党的」出现在位置 2，应先取最靠前的包含项');
  assert.equal(r.rest, '坚持领导');
});

test('退化匹配后继续匹配不会错位（旧实现按前缀长度截断会算错）', () => {
  const chips = ['党的', '领导'];
  let rest = '坚持党的领导';
  const used = new Set();
  const a = pickChip(rest, chips, used);
  used.add(a.index);
  rest = a.rest;
  const b = pickChip(rest, chips, used);
  assert.equal(b.index, 1);
  assert.equal(b.rest, '坚持');
});

test('词块全用过时返回 -1，交给上层记录日志', () => {
  const chips = ['甲', '乙'];
  const r = pickChip('乙', chips, new Set([0, 1]));
  assert.equal(r.index, -1);
  assert.equal(r.rest, '乙');
});

test('空文本或空词块表安全返回', () => {
  assert.equal(pickChip('', ['甲']).index, -1);
  assert.equal(pickChip('甲', []).index, -1);
});
