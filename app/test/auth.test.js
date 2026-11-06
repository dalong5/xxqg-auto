import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-auth-'));
const { readVisitor, issueVisitor } = await import('../src/auth.js');

test('malformed cookie is treated as an anonymous visitor', () => {
  assert.equal(readVisitor({ headers: { cookie: 'xxqg_v=%ZZ' } }), null);
});
test('visitor cookie accepts its own signature and rejects a modified id', () => {
  let cookie;
  const id = issueVisitor({ setHeader: (_name, value) => { cookie = value; } });
  assert.equal(readVisitor({ headers: { cookie } }), id);
  assert.equal(readVisitor({ headers: { cookie: cookie.replace(id, 'modified') } }), null);
});
test.after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
