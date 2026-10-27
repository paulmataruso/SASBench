import type { Route } from './http.ts';
import { ref, type Schema } from './schema.ts';
import { COMPONENTS } from './components.ts';
import { ROUTES } from './routes/index.ts';

// OpenAPI 3.1 document generated from the route table (served at /api/v1/openapi.json and used to
// generate docs/API-REFERENCE.md). JSON Schema 2020-12 is OpenAPI 3.1's schema dialect, so the
// route schemas are published unchanged.

export const TAGS: Array<{ name: string; description: string }> = [
  { name: 'System', description: 'Service index, health, OpenAPI document, status summary, process details, activity and reference data.' },
  { name: 'Tokens', description: 'API tokens (read or write scope) and the identity of the caller.' },
  { name: 'Settings', description: 'Every runtime setting: read, change (validated), describe, profiles and defaults. Listener settings restart the SAS listeners; the call waits for them.' },
  { name: 'CBSDs', description: 'Registered and pending CBSDs: details, availability, grants, logs, and operator actions (approve, deregister, notes, EIRP cap, measurement requests).' },
  { name: 'Grants', description: 'Grants across all CBSDs, and SAS-side actions on them: suspend, resume, terminate, change heartbeat interval, expiry and suggested parameters.' },
  { name: 'SAS protocol', description: 'Send SAS–CBSD protocol requests (registration, spectrumInquiry, grant, heartbeat, relinquishment, deregistration) internally or through the real HTTP/HTTPS listener.' },
  { name: 'Registry', description: 'FCC IDs, user IDs, blacklist, preloaded (conditional) registrations and CPI users.' },
  { name: 'Spectrum', description: 'The band overview: band plan, protections, PPAs, live grants, CBSD locations, incumbents.' },
  { name: 'Protections', description: 'Administrator blocks, ESC, FSS, exclusion zones and DPAs that remove spectrum from CBSDs they cover.' },
  { name: 'DPAs', description: 'Dynamic Protection Areas from the NTIA KML files, and their per-channel activation.' },
  { name: 'PPAs', description: 'PAL Protection Areas: PAL channels reserved for a cluster of CBSDs within an area.' },
  { name: 'Incumbents', description: 'Injected incumbent and zone data (FSS, WISP, PAL, zones, exclusion zones, peer SASs, ESC sensors…) from which protections and PPAs are derived.' },
  { name: 'Faults', description: 'Fault injection rules that alter what the SAS listener sends: response codes, merge patches, HTTP errors, delays, dropped connections, malformed JSON.' },
  { name: 'Logs', description: 'The wire log of every exchange, the event log, exports and the live Server-Sent Events stream.' },
  { name: 'Operations', description: 'Daily activities, measurement-report triggers, harness flags and the state reset.' },
  { name: 'Listeners', description: 'The SAS HTTP and HTTPS listeners: status, restart, TLS reload.' },
  { name: 'Harness', description: 'The WInnForum test harness admin API (WINNF-TS-0096), callable from the REST API, and the harness sas.cfg.' },
  { name: 'Certificates', description: 'The lab PKI: create CAs and certificates, import PEM and PKCS#12, revoke, download in every format, sign CPI data.' },
  { name: 'TLS', description: 'Which certificates the SAS HTTPS listener presents and which CAs it trusts for client certificates; the CA trust bundle.' },
  { name: 'CRLs', description: 'Certificate revocation lists imported from trusted CAs.' },
  { name: 'Map', description: 'Map tile configuration, the offline tile store and tile-set downloads.' },
  { name: 'Terrain', description: 'Elevation tiles for the Category A HAAT check: inventory, elevation and HAAT queries, downloads.' },
  { name: 'Configuration', description: 'Configuration export and import, and a full database backup.' },
  { name: 'Data', description: 'Read-only access to every database table (secrets redacted).' },
];

const ERROR = { 'application/json': { schema: ref('Error') } };
const STD_ERRORS: Record<string, string> = {
  400: 'The request is invalid (validation_failed, invalid_json, bad_request) or the operation was refused (operation_failed).',
  401: 'No valid credentials (unauthorized).',
  403: 'The API token is read-only (forbidden), a browser request came from an origin that is not allowed (origin_not_allowed), or a web page reached the SAS by an unknown host name (host_not_allowed).',
  404: 'The resource does not exist (not_found).',
  409: 'The resource is in a state that does not allow this (conflict).',
};

const oaPath = (p: string) => p.replace(/\{([A-Za-z]+)\+\}/g, '{$1}');

function operation(r: Route) {
  const parameters: unknown[] = [];
  for (const m of r.path.matchAll(/\{([A-Za-z]+)(\+?)\}/g)) {
    const spec = r.params?.[m[1]];
    parameters.push({
      name: m[1], in: 'path', required: true,
      description: (spec?.description ?? '') + (m[2] ? ' May contain "/" (not encoded).' : ''),
      schema: spec?.schema ?? { type: 'string' },
      ...(m[2] ? { 'x-sasbench-rest': true } : {}),
    });
  }
  for (const [name, q] of Object.entries(r.query ?? {})) {
    const array = q.schema.type === 'array';
    parameters.push({
      name, in: 'query', required: !!q.required, description: q.description, schema: q.schema,
      ...(array ? { style: 'form', explode: false } : {}),
    });
  }

  const responses: Record<string, unknown> = {};
  for (const [status, spec] of Object.entries(r.responses)) {
    const headers: Record<string, unknown> = {};
    if (status === '201') headers.Location = { description: 'URL of the created resource (when it has one).', schema: { type: 'string' } };
    for (const [h, d] of Object.entries(spec.headers ?? {})) headers[h] = { description: d, schema: { type: 'string' } };
    const type = spec.contentType ?? 'application/json';
    const binary = type !== 'application/json';
    responses[status] = {
      description: spec.description,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(status === '204' ? {} : { content: { [type]: { schema: binary ? { type: 'string', format: 'binary' } : (spec.schema ?? {}) } } }),
    };
  }
  const hasInput = !!(r.params || r.query || r.body);
  const errs = [
    ...(hasInput || r.method !== 'GET' ? [400] : []),
    ...(r.scope === 'public' ? [] : [401, 403]),
    ...(r.params ? [404] : []),
    ...(r.method !== 'GET' && r.params ? [409] : []),
    ...(r.errors ?? []),
  ];
  for (const s of errs) if (!responses[s]) responses[s] = { description: STD_ERRORS[s], content: ERROR };
  responses.default = { description: 'Unexpected error.', content: ERROR };

  return {
    operationId: r.operationId, tags: [r.tag], summary: r.summary,
    ...(r.description ? { description: r.description } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(r.body ? {
      requestBody: {
        required: !!r.body.required,
        ...(r.body.description ? { description: r.body.description } : {}),
        content: { 'application/json': { schema: r.body.schema as Schema, ...(r.body.example !== undefined ? { example: r.body.example } : {}) } },
      },
    } : {}),
    responses,
    security: r.scope === 'public' ? [] : [{ bearerAuth: [] }, { basicAuth: [] }],
    'x-sasbench-scope': r.scope,
  };
}

export function buildOpenApi(version: string, routes: Route[] = ROUTES) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const p = (paths[oaPath(r.path)] ??= {});
    p[r.method.toLowerCase()] = operation(r);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'SASBench API', version,
      summary: 'REST API of SASBench, a WInnForum-compliant CBRS Spectrum Access System for lab testing.',
      description: 'Everything the web console can do, and more, over HTTP: CBSDs, grants, spectrum and protections, registry, fault injection, logs and live events, certificates and TLS, harness admin calls, settings, map and terrain data, configuration and backups. See docs/API.md for a guide and docs/API-ARCHITECTURE.md for the design.',
      license: { name: 'See the repository', url: 'https://github.com/paulmataruso/SASBench' },
    },
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    servers: [{ url: '/api/v1', description: 'This SAS (UI port)' }],
    tags: TAGS,
    paths,
    components: {
      schemas: COMPONENTS,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'An API token (sasb_…) created with POST /tokens or in Settings. A read token may call the operations with scope read; everything else (changes, token management, backups, private-key downloads) needs a write token.' },
        basicAuth: { type: 'http', scheme: 'basic', description: 'Any user name and the UI password (setting uiPassword). Full access.' },
      },
    },
    security: [{ bearerAuth: [] }, { basicAuth: [] }],
  };
}
