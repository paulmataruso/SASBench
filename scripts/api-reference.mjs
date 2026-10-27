#!/usr/bin/env node
// Generates docs/API-REFERENCE.md from the OpenAPI document that the server builds from its route
// table, so the reference always matches the code. `--check` exits non-zero when the committed file
// is out of date (CI).
//
//   npm run api:docs         # regenerate
//   npm run api:docs:check   # verify
//
// Each operation also gets the real request and response that `npm run api:examples` captured into
// docs/api-examples.json; an operation without one is an error.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'API-REFERENCE.md');
const EXAMPLES = path.join(ROOT, 'docs', 'api-examples.json');
const check = process.argv.includes('--check');

const { buildOpenApi } = await import(path.join(ROOT, 'server', 'src', 'api', 'v1', 'openapi.ts'));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const doc = buildOpenApi(version);
const schemas = doc.components.schemas;
const examples = fs.existsSync(EXAMPLES) ? JSON.parse(fs.readFileSync(EXAMPLES, 'utf8')).examples : {};
const opIds = Object.values(doc.paths).flatMap((m) => Object.values(m).map((op) => op.operationId));
const noExample = opIds.filter((id) => !examples[id]?.length);
const stale = Object.keys(examples).filter((id) => !opIds.includes(id));
if (noExample.length || stale.length) {
  if (noExample.length) console.error(`No example for ${noExample.join(', ')}.`);
  if (stale.length) console.error(`Examples for operations that no longer exist: ${stale.join(', ')}.`);
  console.error('Add or remove them in scripts/api-examples.mjs, then run `npm run api:examples` and `npm run api:docs`.');
  process.exit(1);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const refName = (r) => r.split('/').pop();
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/** One-line type description of a schema, linking named schemas. */
function typeOf(s) {
  if (!s || !Object.keys(s).length) return 'any';
  if (s.$ref) return `[${refName(s.$ref)}](#schema-${slug(refName(s.$ref))})`;
  if (s.anyOf || s.oneOf) {
    const alts = s.anyOf ?? s.oneOf;
    if (alts.length === 2 && alts.some((a) => a.type === 'integer') && alts.some((a) => a.format === 'date-time')) return 'time (epoch ms or RFC 3339)';
    return alts.map(typeOf).join(' \\| ');
  }
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const nullable = types.includes('null');
  const main = types.filter((t) => t !== 'null');
  let t;
  if (s.enum) t = s.enum.filter((v) => v !== null).map((v) => `\`${JSON.stringify(v)}\``).join(' \\| ');
  else if (main[0] === 'array') t = `array of ${typeOf(s.items)}`;
  else if (main[0] === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object' && !Object.keys(s.properties ?? {}).length) t = `map of ${typeOf(s.additionalProperties)}`;
  else t = main.join(' \\| ') || 'any';
  return nullable ? `${t} \\| null` : t;
}

/** Constraints worth showing next to the type. */
function constraints(s) {
  const c = [];
  if (s.minimum !== undefined) c.push(`≥ ${s.minimum}`);
  if (s.maximum !== undefined) c.push(`≤ ${s.maximum}`);
  if (s.minLength !== undefined && s.minLength > 0) c.push(`min length ${s.minLength}`);
  if (s.maxLength !== undefined) c.push(`max length ${s.maxLength}`);
  if (s.minItems !== undefined) c.push(`min ${s.minItems} items`);
  if (s.maxItems !== undefined) c.push(`max ${s.maxItems} items`);
  if (s.pattern) c.push(`pattern \`${s.pattern}\``);
  if (s.default !== undefined) c.push(`default \`${JSON.stringify(s.default)}\``);
  if (s.writeOnly) c.push('write-only');
  return c.join(', ');
}

/** Field table rows for an object schema (nested objects and arrays of objects flattened). */
function fields(s, prefix = '', depth = 0) {
  const rows = [];
  if (s.$ref || !s.properties) return rows;
  const req = new Set(s.required ?? []);
  for (const [k, p] of Object.entries(s.properties)) {
    const name = `${prefix}${k}`;
    rows.push(`| \`${name}\` | ${typeOf(p)} | ${req.has(k) ? 'yes' : ''} | ${esc([p.description, constraints(p)].filter(Boolean).join(' · '))} |`);
    if (depth < 2) {
      const inner = p.type === 'array' || (Array.isArray(p.type) && p.type.includes('array')) ? p.items : p;
      if (inner && !inner.$ref && inner.properties) rows.push(...fields(inner, `${name}${inner === p ? '' : '[]'}.`, depth + 1));
    }
  }
  return rows;
}

function schemaBlock(s) {
  const out = [];
  const rows = fields(s);
  if (rows.length) out.push('| Field | Type | Required | Description |', '|---|---|---|---|', ...rows);
  else out.push(`Type: ${typeOf(s)}${constraints(s) ? ` (${constraints(s)})` : ''}${s.description ? `. ${s.description}` : ''}`);
  return out;
}

/** A captured example: the title, the curl command, and the response it got. */
function exampleBlock(e) {
  const out = [];
  if (e.title) out.push(`*${e.title}${/[.?]$/.test(e.title) ? '' : '.'}*`, '');
  out.push('```bash', e.curl, '```', '');
  if (e.kind === 'empty') out.push(`Response \`${e.status}\`, no body.`, '');
  else if (e.kind === 'json') out.push(`Response \`${e.status}\`:`, '', '```json', e.json, '```', '');
  else if (e.kind === 'text') out.push(`Response \`${e.status}\` (\`${e.contentType}\`):`, '', '```text', e.text, '```', '');
  else out.push(`Response \`${e.status}\`: \`${e.contentType}\`, ${e.bytes.toLocaleString('en-US')} bytes, saved to \`${e.file}\`.`, '');
  if (e.note) out.push(e.note, '');
  return out;
}

const lines = [];
const P = (...l) => lines.push(...l);
P('# SASBench API reference', '');
P(`<!-- Generated by scripts/api-reference.mjs from the route table. Do not edit by hand: run \`npm run api:docs\`. -->`, '');
P(`API version **v1**, SASBench ${version}. Base URL: \`http://<host>:<UI port>/api/v1\` (UI port 8080 by default).`, '');
P('This file lists every endpoint, parameter and schema. Read [API.md](API.md) first for authentication, conventions and worked examples, and [API-ARCHITECTURE.md](API-ARCHITECTURE.md) for the design. The same information is served as an OpenAPI 3.1 document at `GET /api/v1/openapi.json`.', '');
P('**Scopes.** `public`: no credentials needed. `read`: any user (viewer, operator or admin) or API key. `write`: an operator or admin, or their read-write API key. `admin`: an admin, or an admin\'s read-write API key. Credentials are a console session, a user name and password (HTTP Basic) or an API key (`Authorization: Bearer sasb_…`); see [Authentication](API.md#authentication). With `SAS_AUTH=off` every operation is open.', '');
P('**Examples.** Every operation has a real request and the response it got, captured from a running SASBench by `npm run api:examples`. The commands use three shell variables:', '');
P('```bash', 'export API=http://sas.lab.example:8080/api/v1   # your SAS', 'export KEY=sasb_...                             # an API key (console → API keys)', "export PASSWORD='...'                           # the admin password, for the few calls that need one", '```', '');
P('IDs, keys and times come from that capture: use your own. Long responses are shortened. Lists keep their first items and say how many more there were (`"… 12 more"`), large nested objects show as `"{…}"`, and long values and PEM blocks end in `…`.', '');

const tags = doc.tags.map((t) => ({ ...t, ops: [] }));
const byTag = new Map(tags.map((t) => [t.name, t]));
for (const [p, methods] of Object.entries(doc.paths)) {
  for (const [m, op] of Object.entries(methods)) byTag.get(op.tags[0]).ops.push({ path: p, method: m.toUpperCase(), op });
}
const count = tags.reduce((n, t) => n + t.ops.length, 0);
P(`## Contents`, '', `${count} operations in ${tags.length} groups.`, '');
for (const t of tags) {
  P(`- [${t.name}](#${slug(t.name)}) (${t.ops.length})`);
}
P('- [Schemas](#schemas)', '');

for (const t of tags) {
  P(`## ${t.name}`, '', t.description, '');
  P('| Method | Path | Operation | Scope | Summary |', '|---|---|---|---|---|');
  for (const { path: p, method, op } of t.ops) P(`| ${method} | \`${p}\` | [${op.operationId}](#${slug(op.operationId)}) | ${op['x-sasbench-scope']} | ${esc(op.summary)} |`);
  P('');
  for (const { path: p, method, op } of t.ops) {
    P(`### ${op.operationId}`, '', `\`${method} /api/v1${p}\` · scope **${op['x-sasbench-scope']}**`, '', `**${op.summary}.**`);
    if (op.description) P('', op.description);
    P('');
    const exs = examples[op.operationId];
    P(exs.length > 1 ? 'Examples:' : 'Example:', '');
    for (const e of exs) P(...exampleBlock(e));
    const params = op.parameters ?? [];
    const pathParams = params.filter((x) => x.in === 'path');
    const query = params.filter((x) => x.in === 'query');
    if (pathParams.length) {
      P('Path parameters:', '', '| Name | Type | Description |', '|---|---|---|');
      for (const x of pathParams) P(`| \`${x.name}\` | ${typeOf(x.schema)} | ${esc([x.description, constraints(x.schema)].filter(Boolean).join(' · '))} |`);
      P('');
    }
    if (query.length) {
      P('Query parameters:', '', '| Name | Type | Required | Description |', '|---|---|---|---|');
      for (const x of query) {
        const list = x.schema.type === 'array' ? ' Comma-separated.' : '';
        P(`| \`${x.name}\` | ${typeOf(x.schema)} | ${x.required ? 'yes' : ''} | ${esc([x.description + list, constraints(x.schema)].filter(Boolean).join(' · '))} |`);
      }
      P('');
    }
    if (op.requestBody) {
      const c = op.requestBody.content['application/json'];
      P(`Request body (JSON${op.requestBody.required ? ', required' : ', optional'}):`, '');
      P(...schemaBlock(c.schema), '');
    }
    P('Responses:', '', '| Status | Description | Body |', '|---|---|---|');
    const inline = [];
    for (const [status, r] of Object.entries(op.responses)) {
      const [type, media] = Object.entries(r.content ?? {})[0] ?? [];
      const body = !type ? '' : type === 'application/json' ? typeOf(media.schema) : `\`${type}\``;
      P(`| ${status} | ${esc(r.description)} | ${body} |`);
      // Inline (unnamed) JSON bodies are described here; named ones under Schemas.
      if (type === 'application/json') {
        const s = media.schema;
        const obj = s?.properties ? s : s?.type === 'array' && s.items?.properties ? s.items : null;
        if (obj) inline.push([status, obj, obj !== s]);
      }
    }
    P('');
    for (const [status, s, isArray] of inline) {
      P(`Response ${status} body${isArray ? ' (array items)' : ''}:`, '', ...schemaBlock(s), '');
    }
  }
}

P('## Schemas', '', 'Named schemas used in request and response bodies. Response objects contain exactly the fields listed.', '');
for (const name of Object.keys(schemas).sort()) {
  const s = schemas[name];
  P(`### Schema: ${name}`, '');
  if (s.description) P(s.description, '');
  P(...schemaBlock(s), '');
}

const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
if (check) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error('docs/API-REFERENCE.md is out of date: run `npm run api:docs` and commit the result.');
    process.exit(1);
  }
  console.log('docs/API-REFERENCE.md is up to date.');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${count} operations, ${Object.keys(schemas).length} schemas).`);
}
