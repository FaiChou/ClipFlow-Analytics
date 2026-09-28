import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('sync paginates, checkpoints only complete instances, retries partial downloads and is idempotent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'clipflow-analytics-'));
  try {
    await cp(new URL('../src/', import.meta.url), path.join(root, 'src'), { recursive: true });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await writeFile(path.join(root, 'test.p8'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await writeFile(path.join(root, 'mock.mjs'), `
      import assert from 'node:assert/strict';
      import { gzipSync } from 'node:zlib';
      globalThis.fetch = async (input, options = {}) => {
        const url = new URL(input);
        if (url.origin === 'https://download.example') {
          assert.equal(options.headers, undefined);
          if (process.env.FAIL_SEGMENT === '1' && url.pathname === '/s2') return new Response('', { status: 503 });
          return new Response(gzipSync('Date\\tCounts\\n2026-09-14\\t2\\n'));
        }
        assert.equal(url.origin, 'https://api.appstoreconnect.apple.com');
        assert.ok(options.headers.Authorization.startsWith('Bearer '));
        const p = url.pathname;
        let data;
        if (p.endsWith('/analyticsReportRequests')) data = [{ id: 'req', attributes: { accessType: 'ONGOING' } }];
        else if (p.endsWith('/reports')) data = [{ id: 'report', attributes: { name: 'Downloads' } }];
        else if (p.endsWith('/instances')) {
          if (!url.searchParams.has('cursor')) return Response.json({ data: [], links: { next: 'https://api.appstoreconnect.apple.com/v1/analyticsReports/report/instances?cursor=2' } });
          data = [{ id: 'instance', attributes: { processingDate: '2026-09-16' } }];
        } else if (p.endsWith('/segments')) data = ['s1', 's2'].map(id => ({ id, attributes: { url: 'https://download.example/' + id } }));
        else throw new Error('Unexpected endpoint');
        return Response.json({ data });
      };
    `);
    const run = fail => spawnSync(process.execPath, ['--import', path.join(root, 'mock.mjs'), path.join(root, 'src/cli.mjs'), 'sync'], {
      encoding: 'utf8', env: { ...process.env, ASC_ISSUER_ID: 'issuer', ASC_KEY_ID: 'key', ASC_APP_ID: '123', ASC_PRIVATE_KEY_PATH: 'test.p8', FAIL_SEGMENT: fail ? '1' : '0' },
    });
    const failed = run(true);
    assert.equal(failed.status, 1, failed.stderr);
    await assert.rejects(readFile(path.join(root, 'data/manifest.json')), { code: 'ENOENT' });
    const success = run(false);
    assert.equal(success.status, 0, success.stderr);
    const manifest = JSON.parse(await readFile(path.join(root, 'data/manifest.json'), 'utf8'));
    assert.equal(manifest.instances['req/report/instance'].segments.length, 2);
    const again = run(true);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /0 new instances/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
