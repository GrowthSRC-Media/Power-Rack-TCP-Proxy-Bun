import type { DomainRoute } from "./proxy";

/**
 * Extract the SNI hostname from a TLS ClientHello message.
 * Returns null if the buffer is not a valid ClientHello or SNI is absent.
 */
export function extractSniHostname(buf: Buffer): string | null {
  let offset = 0;

  // TLS record header: content_type(1) + version(2) + length(2)
  if (buf.length < 5) return null;
  if (buf[offset] !== 0x16) return null; // not a handshake record
  offset += 1;

  // version (skip)
  offset += 2;

  // record length
  const recordLen = buf.readUInt16BE(offset);
  offset += 2;

  if (buf.length < offset + recordLen) return null;

  // Handshake header: type(1) + length(3)
  if (buf.length < offset + 4) return null;
  if (buf[offset] !== 0x01) return null; // not ClientHello
  offset += 1;

  // handshake length (3 bytes, skip — we'll rely on bounds checks)
  offset += 3;

  // ClientHello body: version(2) + random(32)
  if (buf.length < offset + 34) return null;
  offset += 2; // client version
  offset += 32; // random

  // Session ID: length(1) + data
  if (buf.length < offset + 1) return null;
  const sessionIdLen = buf[offset]!;
  offset += 1 + sessionIdLen;

  // Cipher suites: length(2) + data
  if (buf.length < offset + 2) return null;
  const cipherSuitesLen = buf.readUInt16BE(offset);
  offset += 2 + cipherSuitesLen;

  // Compression methods: length(1) + data
  if (buf.length < offset + 1) return null;
  const compressionLen = buf[offset]!;
  offset += 1 + compressionLen;

  // Extensions: length(2) + data
  if (buf.length < offset + 2) return null;
  const extensionsLen = buf.readUInt16BE(offset);
  offset += 2;

  const extensionsEnd = offset + extensionsLen;
  if (buf.length < extensionsEnd) return null;

  // Iterate extensions
  while (offset + 4 <= extensionsEnd) {
    const extType = buf.readUInt16BE(offset);
    offset += 2;
    const extLen = buf.readUInt16BE(offset);
    offset += 2;

    if (extType === 0x0000) {
      // server_name extension
      // server_name_list_length(2) + name_type(1) + name_length(2) + name
      if (offset + 5 > extensionsEnd) return null;
      offset += 2; // server name list length (skip)
      const nameType = buf[offset];
      offset += 1;
      if (nameType !== 0x00) return null; // not host_name
      const nameLen = buf.readUInt16BE(offset);
      offset += 2;
      if (offset + nameLen > extensionsEnd) return null;
      return buf.subarray(offset, offset + nameLen).toString("ascii").toLowerCase();
    }

    offset += extLen;
  }

  return null;
}

/**
 * Extract the Host header value from an HTTP request buffer.
 * Returns null if the Host header is not found.
 */
export function extractHttpHost(buf: Buffer): string | null {
  // Only scan the first 8KB to avoid processing huge payloads
  const str = buf.subarray(0, Math.min(buf.length, 8192)).toString("ascii");

  const match = str.match(/^host:\s*(.+)/im);
  if (!match) return null;

  let host = match[1]!.trim();
  // Strip port suffix (e.g., ":80" or ":443")
  const colonIdx = host.lastIndexOf(":");
  if (colonIdx > 0) {
    host = host.slice(0, colonIdx);
  }
  return host.toLowerCase();
}

/**
 * Match a hostname against a list of domain routes.
 * Tries exact match first, then wildcard (*.example.com).
 * Returns the first matching route, or null.
 */
export function matchDomain(hostname: string, routes: DomainRoute[]): DomainRoute | null {
  const lower = hostname.toLowerCase();

  // Exact match
  for (const route of routes) {
    if (route.domain.toLowerCase() === lower) {
      return route;
    }
  }

  // Wildcard match: *.example.com matches app.example.com (one level only)
  for (const route of routes) {
    const pattern = route.domain.toLowerCase();
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (lower.endsWith(suffix) && !lower.slice(0, -suffix.length).includes(".")) {
        return route;
      }
    }
  }

  return null;
}
