import http from 'node:http';

/**
 * Send one HTTP request to the Docker Engine over its Unix socket (not TCP).
 * socketPath: filesystem path to the socket; method: GET/POST; path: Docker API route.
 * Resolves to { status, body }, where body is a Buffer, even for non-2xx replies.
 * Rejects on transport failures, inactivity timeout, or responses larger than 2 MiB.
 * Callers interpret HTTP status codes; this function never runs a shell command.
 */
export function dockerRequest(socketPath, method, path, body) {
  // Convert supplied settings into JSON text.
  // Existing calls without a body continue to work.
  const payload =
    body === undefined ? undefined : JSON.stringify(body);
  // The Promise executor starts the request now. Event callbacks complete or reject it.
  return new Promise((resolve, reject) => {
    // This callback runs once Docker sends response headers; collect its body below.
    const req = http.request({
            socketPath,
            method,
            path,
            headers: payload === undefined ? {} : {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          }, res => {
      const chunks = [];
      let size = 0;
      // Each data event supplies another binary chunk; cap memory usage before storing it.
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) req.destroy(new Error('Docker response too large'));
        else chunks.push(chunk);
      });
      // Once the response ends, join the chunks and return the HTTP status and raw body.
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    // Destroying an inactive request triggers its error handler, which rejects the Promise.
    req.setTimeout(15000, () => req.destroy(new Error('Docker request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Convert Docker log bytes into readable text.
 * With a TTY, the response is plain text. Otherwise Docker prefixes each stdout/stderr
 * frame with eight bytes: stream type, padding, and a four-byte payload length.
 * Strip those headers and concatenate payloads in received order. Stream identity
 * is not retained. An incomplete payload raises an error rather than returning it.
 */
export function decodeLogs(buffer, tty) {
  if (tty) return buffer.toString('utf8');
  const chunks = [];
  for (let offset = 0; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + length > buffer.length) throw new Error('Incomplete Docker log frame');
    chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return Buffer.concat(chunks).toString('utf8');
}

