// A small JSON Schema (2020-12) subset: enough to validate API input and to publish the same
// schemas unchanged in the OpenAPI 3.1 document. No runtime dependencies.

export type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export interface Schema {
  $ref?: string;
  type?: SchemaType | SchemaType[];
  title?: string;
  description?: string;
  enum?: readonly unknown[];
  const?: unknown;
  default?: unknown;
  examples?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  contentMediaType?: string;
  contentEncoding?: string;
}

export interface Issue {
  path: string;
  message: string;
}

/** Named schemas referenced as { $ref: '#/components/schemas/<name>' }. */
export type SchemaRegistry = Record<string, Schema>;

export function ref(name: string): Schema {
  return { $ref: `#/components/schemas/${name}` };
}

function typeOf(v: unknown): SchemaType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v as SchemaType;
}

function typeMatches(want: SchemaType, v: unknown): boolean {
  const t = typeOf(v);
  if (want === 'number') return t === 'number' || t === 'integer';
  return t === want;
}

function describeTypes(t: SchemaType | SchemaType[]): string {
  const list = Array.isArray(t) ? t : [t];
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
}

const join = (base: string, key: string | number) => (typeof key === 'number' ? `${base}[${key}]` : base ? `${base}.${key}` : key);

/** Validate a value; returns the list of problems (empty when valid). */
export function validate(schema: Schema, value: unknown, registry: SchemaRegistry = {}, path = ''): Issue[] {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = registry[name];
    if (!target) throw new Error(`Unknown schema ${schema.$ref}`);
    return validate(target, value, registry, path);
  }
  const at = path || '(body)';
  if (schema.oneOf || schema.anyOf) {
    const alts = (schema.oneOf ?? schema.anyOf)!;
    const results = alts.map((s) => validate(s, value, registry, path));
    const ok = results.filter((r) => !r.length).length;
    if (schema.oneOf ? ok === 1 : ok >= 1) return [];
    if (schema.oneOf && ok > 1) return [{ path: at, message: 'matches more than one allowed form' }];
    // Report the alternative that got furthest (fewest problems).
    return results.sort((a, b) => a.length - b.length)[0];
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) return [{ path: at, message: `must be ${describeTypes(schema.type)}` }];
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    return [{ path: at, message: `must be ${JSON.stringify(schema.const)}` }];
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    return [{ path: at, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` }];
  }
  const issues: Issue[] = [];
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path: at, message: `must be ≥ ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path: at, message: `must be ≤ ${schema.maximum}` });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path: at, message: schema.minLength === 1 ? 'must not be empty' : `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path: at, message: `must be at most ${schema.maxLength} characters` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) issues.push({ path: at, message: `must match ${schema.pattern}` });
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))) issues.push({ path: at, message: 'must be an RFC 3339 date-time' });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path: at, message: `must have at least ${schema.minItems} item(s)` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path: at, message: `must have at most ${schema.maxItems} items` });
    if (schema.items) value.forEach((v, i) => issues.push(...validate(schema.items!, v, registry, join(path, i))));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) {
      if (obj[k] === undefined) issues.push({ path: join(path, k), message: 'is required' });
    }
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      // Own properties only: "__proto__", "constructor" or "toString" are not declared fields.
      const prop = schema.properties && Object.hasOwn(schema.properties, k) ? schema.properties[k] : undefined;
      if (prop) issues.push(...validate(prop, v, registry, join(path, k)));
      else if (schema.additionalProperties === false) issues.push({ path: join(path, k), message: 'is not a known field' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        issues.push(...validate(schema.additionalProperties, v, registry, join(path, k)));
      }
    }
  }
  return issues;
}

/**
 * Query-string values are strings; convert them to the type the schema asks for before
 * validation. Arrays are comma-separated. Values that cannot be converted are returned as-is
 * so that validation reports them.
 */
export function coerceQuery(schema: Schema, raw: string): unknown {
  if (schema.type === undefined && schema.anyOf) {
    // e.g. S.time(): a number when the value looks like one, else the string.
    const numeric = schema.anyOf.some((s) => s.type === 'integer' || s.type === 'number');
    return numeric && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('array')) {
    const parts = raw === '' ? [] : raw.split(',').map((s) => s.trim()).filter(Boolean);
    return schema.items ? parts.map((p) => coerceQuery(schema.items!, p)) : parts;
  }
  if (types.includes('integer') || types.includes('number')) {
    const n = raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (types.includes('boolean')) {
    if (/^(true|1|yes)$/i.test(raw)) return true;
    if (/^(false|0|no)$/i.test(raw)) return false;
    return raw;
  }
  return raw;
}

// ---------------------------------------------------------------------------- builders
// Terse helpers so route files read like a table.

type Opts = Omit<Schema, 'type'>;

export const S = {
  str: (o: Opts = {}): Schema => ({ type: 'string', ...o }),
  int: (o: Opts = {}): Schema => ({ type: 'integer', ...o }),
  num: (o: Opts = {}): Schema => ({ type: 'number', ...o }),
  bool: (o: Opts = {}): Schema => ({ type: 'boolean', ...o }),
  arr: (items: Schema, o: Opts = {}): Schema => ({ type: 'array', items, ...o }),
  obj: (properties: Record<string, Schema>, required: string[] = [], o: Opts = {}): Schema => ({
    type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false, ...o,
  }),
  /** Free-form JSON object (protocol payloads, harness records). */
  anyObj: (o: Opts = {}): Schema => ({ type: 'object', additionalProperties: true, ...o }),
  any: (o: Opts = {}): Schema => ({ ...o }),
  enum: (values: readonly string[], o: Opts = {}): Schema => ({ type: 'string', enum: values, ...o }),
  nullable: (s: Schema): Schema => {
    const t = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
    if (s.$ref || !t.length) return { anyOf: [s, { type: 'null' }], ...(s.description ? { description: s.description } : {}) };
    return { ...s, type: [...t, 'null'], ...(s.enum ? { enum: [...s.enum, null] } : {}) };
  },
  /** Epoch milliseconds or an RFC 3339 string. */
  time: (o: Opts = {}): Schema => ({
    anyOf: [{ type: 'integer', minimum: 0 }, { type: 'string', format: 'date-time' }],
    ...o,
  }),
  hz: (o: Opts = {}): Schema => ({ type: 'integer', minimum: 0, ...o }),
};

/** Epoch ms from a number or RFC 3339 string (already validated with S.time()). */
export function toMs(v: unknown): number {
  return typeof v === 'number' ? v : Date.parse(String(v));
}
