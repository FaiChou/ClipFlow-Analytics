import { sign } from 'node:crypto';

export function token(config, key) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'ES256', kid: config.ASC_KEY_ID, typ: 'JWT' })}.${encode({ iss: config.ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
  return `${payload}.${sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

// TSV supports quoted tabs/newlines and escaped quotes; reject malformed rows.
export function parseTSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || field === '') quoted = !quoted;
      else field += c;
    } else if (!quoted && (c === '\t' || c === '\n' || c === '\r')) {
      row.push(field); field = '';
      if (c !== '\t') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        rows.push(row); row = [];
      }
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed TSV quote');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift() ?? [];
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate TSV headers');
  return { headers, rows: rows.filter(r => !(r.length === 1 && r[0] === '')).map(r => {
    if (r.length !== headers.length) throw new Error('TSV column count mismatch');
    return Object.fromEntries(headers.map((h, i) => [h, r[i]]));
  }) };
}

export function profile(text) {
  const { headers, rows } = parseTSV(text);
  const dates = [...new Set(rows.map(r => r.Date).filter(Boolean))].sort();
  return { columns: headers, rows: rows.length, firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null };
}

export function aggregate(text, metric, dimensions) {
  const { headers, rows } = parseTSV(text);
  for (const field of [metric, ...dimensions]) if (!headers.includes(field)) throw new Error(`Unknown column: ${field}`);
  const groups = new Map();
  for (const row of rows) {
    if (!/^-?\d+(\.\d+)?$/.test(row[metric])) throw new Error(`Non-numeric or suppressed value in ${metric}; refusing to treat it as zero`);
    const key = JSON.stringify(dimensions.map(d => row[d]));
    groups.set(key, (groups.get(key) ?? 0) + Number(row[metric]));
  }
  return [...groups].map(([key, value]) => ({ dimensions: Object.fromEntries(dimensions.map((d, i) => [d, JSON.parse(key)[i]])), value }));
}
