// Test helpers: a local HTTPS fixture server with a throwaway certificate.
// The certificate and key are generated per run with OpenSSL in the OS temp
// directory and are never written to the repository.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");
export const fixtureJson = (name) => JSON.parse(fixture(name));

// Hostnames used by network tests. They are never resolved through real DNS:
// tests inject a resolver that maps them to the loopback fixture server.
export const TEST_DOMAIN = "fixture.ourfaces.net";

const OPENSSL_CANDIDATES = [
  "openssl",
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
];

/** Generates a self-signed cert for *.fixture.ourfaces.net. Returns null if OpenSSL is unavailable. */
export function makeCertificate() {
  const dir = mkdtempSync(join(tmpdir(), "tech-brief-cert-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  for (const bin of OPENSSL_CANDIDATES) {
    try {
      execFileSync(
        bin,
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "2",
          "-subj",
          `/CN=${TEST_DOMAIN}`,
          "-addext",
          `subjectAltName=DNS:${TEST_DOMAIN},DNS:*.${TEST_DOMAIN},DNS:other-site.ourfaces.net`,
        ],
        { stdio: "ignore" },
      );
      const result = { key: readFileSync(key), cert: readFileSync(cert) };
      rmSync(dir, { recursive: true, force: true });
      return result;
    } catch {
      // try the next candidate
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return null;
}

/**
 * Starts an HTTPS server on 127.0.0.1. `routes` maps "host path" or "path" to
 * a handler (req, res). Counts TCP connections and requests per path.
 */
export async function startServer(tls, routes) {
  const counts = { connections: 0, requests: {} };
  const server = https.createServer(
    { key: tls.key, cert: tls.cert },
    (req, res) => {
      const host = (req.headers.host ?? "").split(":")[0];
      const path = req.url.split("?")[0];
      counts.requests[`${host}${path}`] =
        (counts.requests[`${host}${path}`] ?? 0) + 1;
      const handler = routes[`${host} ${path}`] ?? routes[path];
      if (!handler) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not found");
      }
      handler(req, res);
    },
  );
  server.on("connection", () => counts.connections++);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    counts,
    url: (path, host = `news.${TEST_DOMAIN}`) =>
      `https://${host}:${port}${path}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A raw TCP server that accepts connections but never answers (connect/TLS timeout). */
export async function startSilentServer() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Resolver mapping every test hostname to loopback, with a call log. */
export function loopbackResolver(map = {}) {
  const calls = [];
  const resolve = async (hostname) => {
    calls.push(hostname);
    const entry = map[hostname] ?? "127.0.0.1";
    const value =
      typeof entry === "function"
        ? entry(calls.filter((h) => h === hostname).length)
        : entry;
    return [value]
      .flat()
      .map((address) => ({ address, family: net.isIP(address) }));
  };
  return { resolve, calls };
}

/** Address policy for tests: only the loopback fixture server is reachable. */
export const onlyLoopback = (address) => address === "127.0.0.1";

export const html =
  (body, status = 200, headers = {}) =>
  (req, res) => {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      ...headers,
    });
    res.end(body);
  };
