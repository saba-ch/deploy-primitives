import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class CliError extends Error {}

export const platformUrl = (flag?: string) => (flag ?? process.env.MASTRA_PLATFORM_URL ?? 'http://localhost:4200').replace(/\/$/, '');

export async function repoName(repoDir: string, flag?: string) {
  if (flag) return flag;
  const pkg = JSON.parse(await readFile(join(repoDir, 'package.json'), 'utf8'));
  return String(pkg.name).replace(/^@[^/]+\//, '');
}

export async function api<T = any>(base: string, path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...rest,
      ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json', ...rest.headers } } : {}),
    });
  } catch (err: any) {
    throw new CliError(`can't reach the platform at ${base} (${err.cause?.code ?? err.message}); is \`mastra-platform start\` running?`);
  }
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new CliError(body?.error ?? `${res.status} ${text}`);
  return body as T;
}

export { PLATFORM_PKGS, pkgName } from '@mastra/platform/platform-pkgs';
