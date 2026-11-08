// 5. Upload: the build folder (manifest, unit files, node_modules) as a tar.gz stream.
import { Readable } from 'node:stream';
import * as tar from 'tar';
import { api } from '../util.ts';

export async function upload(url: string, repo: string, dir: string) {
  const tgz = Readable.from(tar.c({ gzip: true, cwd: dir, portable: true }, ['.']) as AsyncIterable<Uint8Array>);
  return api(url, `/_platform/deploys/${encodeURIComponent(repo)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/gzip' },
    body: Readable.toWeb(tgz) as ReadableStream<Uint8Array>,
    duplex: 'half',
  } as RequestInit);
}
