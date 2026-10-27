// Thin client for the SAS UI REST API (/api/...) and the public API (/api/v1/...).

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Dispatched on window when a request comes back 401: the session ended, so the app signs out. */
export const SIGNED_OUT_EVENT = 'sasb:signed-out';

/** The console API answers {error: "text"}; the public API {error: {message, code, ...}}. */
function errorText(data: any, res: Response): string {
  const e = data && typeof data === 'object' ? data.error : null;
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  return `${res.status} ${res.statusText}`;
}

function failed(res: Response, data: any): ApiError {
  // A wrong password on the sign-in form is not a session ending.
  if (res.status === 401 && new URL(res.url).pathname !== '/api/auth/login') window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  return new ApiError(res.status, errorText(data, res));
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) throw failed(res, data);
  return data as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T = any>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  patch: <T = any>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  del: <T = any>(path: string) => request<T>('DELETE', path),
};

/** Trigger a browser download of a GET endpoint. */
export function download(path: string) {
  const a = document.createElement('a');
  a.href = path;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** POST and save the binary response (e.g. the batch certificate zip). */
export async function postDownload(path: string, body: unknown, fallbackName: string) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    let data: any = null;
    try {
      data = await res.json();
    } catch { /* not JSON */ }
    throw failed(res, data);
  }
  const cd = res.headers.get('Content-Disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function fileToText(file: File): Promise<string> {
  return file.text();
}
