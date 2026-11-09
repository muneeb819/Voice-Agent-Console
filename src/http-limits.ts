/** Read an upstream body without buffering an unbounded response first. */
export async function readResponseBuffer(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Upstream response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Upstream response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function readResponseText(res: Response, maxBytes: number): Promise<string> {
  return (await readResponseBuffer(res, maxBytes)).toString('utf8');
}
