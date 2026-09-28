import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { token, profile, aggregate } from './lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'https://api.appstoreconnect.apple.com';
const [command = 'help', ...args] = process.argv.slice(2);
const commands = ['status', 'setup', 'snapshot', 'reports', 'sync', 'analyze'];
const safe = id => {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Unsafe resource ID');
  return id;
};
async function json(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function atomic(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await rename(temp, file);
}
const save = (file, value) => atomic(file, JSON.stringify(value, null, 2) + '\n');
const manifestPath = path.join(root, 'data/manifest.json');

async function main() {
  if (!commands.includes(command)) {
    if (command !== 'help') throw new Error(`Unknown command: ${command}`);
    console.log('Commands: status | setup | snapshot | reports | sync [exact report name] | analyze [file.tsv metric dimension ...]');
    return;
  }
  if (command === 'analyze') {
    if (args.length) {
      if (args.length < 2) throw new Error('Usage: analyze file.tsv metric [dimension ...]');
      const data = aggregate(await readFile(path.resolve(process.cwd(), args[0]), 'utf8'), args[1], args.slice(2));
      await save(path.join(root, 'output/aggregation.json'), { source: args[0], metric: args[1], warning: 'Single-file totals only; check report semantics, batches and corrections before interpreting.', data });
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const manifest = await json(manifestPath, { instances: {} });
    const files = [];
    for (const instance of Object.values(manifest.instances)) {
      for (const segment of instance.segments) {
        files.push({ report: instance.reportName, accessType: instance.accessType, processingDate: instance.processingDate, file: segment.tsv, ...profile(await readFile(path.join(root, segment.tsv), 'utf8')) });
      }
    }
    const result = { generatedAt: new Date().toISOString(), note: 'Inventory only. Processing date is not event date. Do not sum overlapping snapshots, standard/detailed reports, unique users, or correction batches.', files };
    await save(path.join(root, 'output/summary.json'), result);
    await atomic(path.join(root, 'output/summary.md'), `# ClipFlow Analytics\n\n${files.length} 个已下载分片。\n\n${result.note}\n\n` + files.map(f => `- ${f.report}: ${f.rows} 行，事件日期 ${f.firstDate ?? '无'} 至 ${f.lastDate ?? '无'}；文件 ${f.file}`).join('\n') + '\n');
    console.log(`Analyzed ${files.length} files. See output/summary.md and output/summary.json.`);
    return;
  }

  try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = process.env;
  for (const name of ['ASC_ISSUER_ID', 'ASC_KEY_ID', 'ASC_APP_ID', 'ASC_PRIVATE_KEY_PATH']) if (!config[name]) throw new Error(`Missing ${name}; copy .env.example to .env`);
  const key = await readFile(path.resolve(root, config.ASC_PRIVATE_KEY_PATH));
  const appID = safe(config.ASC_APP_ID);
  async function api(endpoint, body) {
    const url = new URL(endpoint, base);
    if (url.origin !== base || !url.pathname.startsWith('/v1/')) throw new Error('Refusing to send API token outside App Store Connect');
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(url, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: { Authorization: `Bearer ${token(config, key)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!body && (response.status === 429 || response.status >= 500) && attempt < 3) {
        const seconds = Number(response.headers.get('retry-after')) || 2 ** (attempt + 1);
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, Math.min(seconds, 30) * 1000));
        continue;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(`Apple API ${response.status}: ${(payload.errors ?? []).map(e => `${e.code}: ${e.detail ?? e.title}`).join('; ')}`);
      }
      return response.json();
    }
  }
  async function list(endpoint) {
    const items = []; let next = endpoint;
    const seen = new Set();
    while (next) {
      if (seen.has(next)) throw new Error('Repeated pagination link');
      seen.add(next);
      const page = await api(next);
      items.push(...page.data); next = page.links?.next;
    }
    return items;
  }
  const requests = await list(`/v1/apps/${appID}/analyticsReportRequests`);
  if (command === 'status') {
    const app = await api(`/v1/apps/${appID}`);
    console.log(JSON.stringify({ app: { id: app.data.id, name: app.data.attributes.name, bundleId: app.data.attributes.bundleId }, requests: requests.map(r => ({ id: r.id, ...r.attributes })) }, null, 2));
    return;
  }
  if (command === 'setup' || command === 'snapshot') {
    const accessType = command === 'setup' ? 'ONGOING' : 'ONE_TIME_SNAPSHOT';
    const existing = requests.find(r => r.attributes.accessType === accessType && !r.attributes.stoppedDueToInactivity);
    if (existing) { console.log(`Reusing ${accessType} request ${existing.id}`); return; }
    const result = await api('/v1/analyticsReportRequests', { data: { type: 'analyticsReportRequests', attributes: { accessType }, relationships: { app: { data: { type: 'apps', id: appID } } } } });
    await save(path.join(root, `data/request-${accessType}.json`), result);
    console.log(`Created ${accessType} request ${result.data.id}. Initial reports normally take 24–48 hours.`);
    return;
  }
  const reports = [];
  for (const request of requests) {
    for (const report of await list(`/v1/analyticsReportRequests/${safe(request.id)}/reports`)) {
      reports.push({ id: report.id, ...report.attributes, requestID: request.id, accessType: request.attributes.accessType });
    }
  }
  await save(path.join(root, 'data/reports.json'), reports);
  if (command === 'reports') { console.log(JSON.stringify(reports, null, 2)); return; }
  if (requests.some(r => r.attributes.stoppedDueToInactivity)) console.warn('A request is stopped due to inactivity; run setup to resume ongoing reports.');
  const manifest = await json(manifestPath, { appID, instances: {} });
  if (manifest.appID !== appID) throw new Error('Data belongs to another app; use a separate project/data directory');
  const selected = args.length ? reports.filter(r => r.name === args.join(' ')) : reports;
  if (args.length && reports.length && !selected.length) throw new Error('Report name not found; run npm run reports');
  let downloaded = 0;
  for (const report of selected) {
    console.log(`Checking ${report.name} (${report.accessType})`);
    const instances = await list(`/v1/analyticsReports/${safe(report.id)}/instances?filter%5Bgranularity%5D=DAILY`);
    for (const instance of instances) {
      const identity = `${safe(report.requestID)}/${safe(report.id)}/${safe(instance.id)}`;
      if (manifest.instances[identity]) continue;
      const segments = await list(`/v1/analyticsReportInstances/${safe(instance.id)}/segments`);
      if (!segments.length) continue; // A pending instance must remain retryable.
      const stored = [];
      for (const segment of segments) {
        const url = new URL(segment.attributes.url);
        if (url.protocol !== 'https:') throw new Error('Non-HTTPS segment URL');
        // Presigned download URL: never forward the App Store Connect JWT.
        const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
        if (!response.ok) throw new Error(`Segment download HTTP ${response.status}; rerun sync to refresh URLs`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const text = gunzipSync(buffer).toString('utf8');
        profile(text); // Validate before recording successful completion.
        const prefix = `data/raw/${identity}/${safe(segment.id)}`;
        await atomic(path.join(root, `${prefix}.txt.gz`), buffer);
        await atomic(path.join(root, `${prefix}.tsv`), text);
        stored.push({ id: segment.id, tsv: `${prefix}.tsv`, sha256: createHash('sha256').update(buffer).digest('hex') });
      }
      manifest.instances[identity] = { reportName: report.name, accessType: report.accessType, processingDate: instance.attributes.processingDate, segments: stored };
      await save(manifestPath, manifest); downloaded++;
      console.log(`Downloaded ${report.name}: ${instance.attributes.processingDate} (${stored.length} segments)`);
    }
  }
  console.log(`Sync complete: ${downloaded} new instances, ${reports.length} reports available.${reports.length ? '' : ' Reports may still be generating; retry in 24–48 hours.'}`);
}

let lock;
try {
  await mkdir(path.join(root, 'data'), { recursive: true });
  lock = await open(path.join(root, 'data/.lock'), 'wx', 0o600);
  await lock.writeFile(String(process.pid));
  await main();
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Another command holds data/.lock. If a previous process crashed, verify it is no longer running before removing the lock.' : error.message);
  process.exitCode = 1;
} finally {
  if (lock) { await lock.close(); await unlink(path.join(root, 'data/.lock')); }
}
