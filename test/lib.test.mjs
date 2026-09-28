import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { token, parseTSV, profile, aggregate } from '../src/lib.mjs';

test('Apple JWT uses ES256 P1363 signature and ten-minute lifetime', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwt = token({ ASC_KEY_ID: 'test', ASC_ISSUER_ID: 'issuer' }, privateKey);
  const [header, payload, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'ES256');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.exp - claims.iat, 600);
  assert.equal(claims.aud, 'appstoreconnect-v1');
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});
test('TSV handles BOM, CRLF, quoted tabs/newlines, quotes and trailing empty fields', () => {
  const parsed = parseTSV('\uFEFFA\tB\tC\r\n"one\ttwo"\t"line\n""quoted"""\t\r\n');
  assert.deepEqual(parsed.rows, [{ A: 'one\ttwo', B: 'line\n"quoted"', C: '' }]);
  assert.throws(() => parseTSV('A\tB\nx\n'), /column count/);
  assert.throws(() => parseTSV('A\n"x'), /Unclosed/);
});
test('profile uses event date and aggregation rejects suppressed values', () => {
  const input = 'Date\tCounts\tTerritory\n2026-09-13\t2\tUSA\n2026-09-12\t3\tUSA\n';
  assert.equal(profile(input).firstDate, '2026-09-12');
  assert.deepEqual(aggregate(input, 'Counts', ['Territory']), [{ dimensions: { Territory: 'USA' }, value: 5 }]);
  assert.throws(() => aggregate('Counts\n*\n', 'Counts', []), /suppressed/);
  assert.throws(() => aggregate(input, 'Revenue', []), /Unknown column/);
});
