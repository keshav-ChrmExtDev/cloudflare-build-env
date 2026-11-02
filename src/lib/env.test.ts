import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeEnv, parseEnv, parsePaste, toPayload, validateRows } from './env.ts';

test('parses a .env with comments, export, quotes and inline comments', () => {
  const { vars, skipped } = parseEnv(`
# comment
export API_KEY="sk_live_123"
DATABASE_URL=postgres://user:pass@host/db # local
NAME='a # b'
EMPTY=
BROKEN LINE
`);

  assert.equal(skipped, 1);
  assert.deepEqual(
    vars.map((row) => [row.var_name, row.value]),
    [
      ['API_KEY', 'sk_live_123'],
      ['DATABASE_URL', 'postgres://user:pass@host/db'],
      ['NAME', 'a # b'],
      ['EMPTY', ''],
    ],
  );
});

test('parses multiline double-quoted values and escapes', () => {
  const { vars } = parseEnv('CERT="line one\\nline two"\nMULTI="a\nb"');
  assert.equal(vars[0]!.value, 'line one\nline two');
  assert.equal(vars[1]!.value, 'a\nb');
});

test('defaults public prefixes to variables and the rest to secrets', () => {
  const { vars } = parseEnv('VITE_PUBLIC_URL=https://x.dev\nSTRIPE_SECRET_KEY=sk\nPUBLIC_NAME=x');
  assert.deepEqual(
    vars.map((row) => row.is_secret),
    [false, true, false],
  );
});

test('merges by name, keeps the existing type and updates values', () => {
  const current = [{ var_name: 'A', value: 'old', is_secret: false }];
  const next = mergeEnv(current, [
    { var_name: 'A', value: 'new', is_secret: true },
    { var_name: 'B', value: 'b', is_secret: true },
  ]);

  assert.deepEqual(next, [
    { var_name: 'A', value: 'new', is_secret: false },
    { var_name: 'B', value: 'b', is_secret: true },
  ]);
});

test('rejects bad names and duplicates but ignores untouched draft rows', () => {
  assert.deepEqual(
    validateRows([
      { var_name: '', value: '', is_secret: true },
      { var_name: 'GOOD', value: '1', is_secret: true },
      { var_name: 'GOOD', value: '2', is_secret: true },
      { var_name: 'BAD NAME', value: '3', is_secret: false },
      { var_name: '', value: 'orphan', is_secret: false },
    ]),
    [
      '“BAD NAME” is not a valid variable name.',
      'A row has a value but no name.',
      '“GOOD” appears more than once.',
    ],
  );
});

test('rejects line breaks, which Cloudflare build fields cannot hold', () => {
  assert.deepEqual(
    validateRows([{ var_name: 'CERT', value: 'line one\nline two', is_secret: true }]),
    ['“CERT” has a line break. Cloudflare\'s build variable field is single-line.'],
  );
});

test('a whole .env pasted into a cell becomes rows', () => {
  const rows = parsePaste('DATABASE_URL=postgres://x\n# note\nVITE_SITE=https://x.dev\n');
  assert.deepEqual(
    rows?.map((row) => [row.var_name, row.value, row.is_secret]),
    [
      ['DATABASE_URL', 'postgres://x', true],
      ['VITE_SITE', 'https://x.dev', false],
    ],
  );
});

test('a single KEY=value pasted into a cell becomes one row', () => {
  assert.deepEqual(parsePaste('API_KEY=sk_123'), [
    { var_name: 'API_KEY', value: 'sk_123', is_secret: true },
  ]);
});

test('columns copied from a spreadsheet keep their type cell', () => {
  assert.deepEqual(parsePaste('NAME\tvalue\tVariable\nTOKEN\t"a b"\tsecret'), [
    { var_name: 'NAME', value: 'value', is_secret: false },
    { var_name: 'TOKEN', value: 'a b', is_secret: true },
  ]);
});

test('an ordinary value is left to the browser to paste', () => {
  assert.equal(parsePaste('dGVzdA=='), null);
  assert.equal(parsePaste('sk_live_abc'), null);
  assert.equal(parsePaste('   '), null);
});

test('payload trims names and drops empty drafts', () => {
  assert.deepEqual(
    toPayload([
      { var_name: '  A  ', value: '1', is_secret: true },
      { var_name: '   ', value: 'ignored', is_secret: true },
    ]),
    [{ var_name: 'A', value: '1', is_secret: true }],
  );
});
