import { expect, test } from 'vitest';
import { cli, copyExample, startPlatform, streamText } from './helpers.ts';

test('streaming to a browser app: CORS for localhost, first chunk before the answer finishes', async () => {
  const platform = await startPlatform();
  await cli(await copyExample('support-team'), 'deploy');
  const origin = 'http://localhost:5173';
  const url = `${platform.url}/api/agents/supportAgent/stream`;

  // the browser's preflight
  const preflight = await fetch(url, {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);

  // the stream itself, read the way a browser's fetch reader would
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: 'tell me something long enough to stream' }),
  });
  expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deltas: number[] = [];
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n\n').slice(0, -1)) if (line.includes('"text-delta"')) deltas.push(performance.now() - t0);
    buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
  }
  const finished = performance.now() - t0;
  expect(deltas.length).toBeGreaterThan(3);
  expect(deltas[0]).toBeLessThan(finished - 100);

  // client-js, as the web example uses it
  const reply = await streamText(platform.client, 'supportAgent', 'hello from the browser');
  expect(reply.text).toBe('supportAgent: hello from the browser');
  expect(reply.firstChunkMs).toBeLessThan(reply.totalMs - 50);

  // only localhost origins are allowed
  const other = await fetch(url, { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' } });
  expect(other.headers.get('access-control-allow-origin')).toBeNull();
});
