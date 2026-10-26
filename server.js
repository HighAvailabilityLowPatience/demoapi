// Startup only: load configuration, create the Express app and manage shutdown.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createApi } from './src/app.js';
import { dockerRequest } from './src/services/docker.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apps = JSON.parse(readFileSync(process.env.APPS_FILE || new URL('./apps.json', import.meta.url), 'utf8'));
  const token = process.env.API_TOKEN_FILE ? readFileSync(process.env.API_TOKEN_FILE, 'utf8').trim() : process.env.API_TOKEN;
  const server = http.createServer(createApi({ apps, token, origins: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),
    // Adapter binds the configured socket path to the two-argument transport
    // interface expected by createApi; each call returns dockerRequest's Promise.
    docker: (method, path, body) =>
  dockerRequest(
    process.env.DOCKER_SOCKET || '/var/run/docker.sock',
    method,
    path,
    body
       ) 
     })
  );
  // Bound incoming request/header reception. These are not deadlines for route
  // execution; Docker requests and health probes have their own timeouts above.
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.listen(Number(process.env.PORT || 9000), '0.0.0.0');
  // Signal handler stops accepting connections and lets in-flight requests finish.
  // The close callback exits successfully; the timer callback forces exit after
  // 20 seconds if shutdown stalls. unref() lets the process exit before that timer.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 20000).unref();
  });
}
