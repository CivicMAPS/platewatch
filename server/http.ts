import { timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Set by the auth guard. */
  device?: { keyId: string | null };
  staff?: { id: string; name: string; role: StaffRole; team: string | null; branch: string };
  body<T = unknown>(): Promise<T>;
  raw(limit: number): Promise<Buffer>;
}

/** Roster roles (owner 25/11/2026). Officers use handsets; the other roles use the console. */
export type StaffRole = 'officer' | 'dispatch' | 'team_supervisor' | 'compliance_lead';
export const STAFF_ROLES: readonly StaffRole[] = ['officer', 'dispatch', 'team_supervisor', 'compliance_lead'];
export const CONSOLE_ROLES: readonly StaffRole[] = ['dispatch', 'team_supervisor', 'compliance_lead'];
export const MANAGER_ROLES: readonly StaffRole[] = ['team_supervisor', 'compliance_lead'];

type Handler = (c: Ctx) => Promise<unknown>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, (_, k: string) => (keys.push(k), '([^/]+)'))}$`);
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too_large', `Body exceeds ${limit} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, { 'Content-Length': String(body.length), ...headers });
    res.end(body);
    return;
  }
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

/** Constant-time comparison of a presented secret with the configured one. */
export function secretMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

export const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '');
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function need<T>(v: T | null | undefined | '', field: string): T {
  if (v === null || v === undefined || v === '') throw new HttpError(422, 'invalid', `${field} is required.`);
  return v;
}
