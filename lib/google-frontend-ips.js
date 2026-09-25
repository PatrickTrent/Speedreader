import { isIP, BlockList } from 'node:net';

/**
 * Google Front End ranges used by Cloud Run, App Engine, and the global
 * external Application Load Balancer. Copied 2026-09-25 from Google's
 * published load-balancer proxy ranges.
 */
export const GOOGLE_FRONTEND_IPV4 = [
  '35.191.0.0/16',
  '130.211.0.0/22',
];

const blockList = new BlockList();
for (const cidr of GOOGLE_FRONTEND_IPV4) {
  const [net, bits] = cidr.split('/');
  blockList.addSubnet(net, Number(bits), 'ipv4');
}

function unwrap(ip) {
  let clean = String(ip || '').trim();
  if (clean.toLowerCase().startsWith('::ffff:')) {
    const mapped = clean.slice(7);
    if (isIP(mapped) === 4) clean = mapped;
  }
  return clean;
}

/** True when the TCP peer is a Google Front End address. */
export function isGoogleFrontendAddress(ip) {
  const clean = unwrap(ip);
  if (isIP(clean) !== 4) return false;
  return blockList.check(clean, 'ipv4');
}

/** True for 127.0.0.0/8 and ::1, including IPv4-mapped loopback. */
export function isLoopbackAddress(ip) {
  const clean = unwrap(ip);
  if (clean === '::1') return true;
  if (isIP(clean) !== 4) return false;
  return Number(clean.split('.')[0]) === 127;
}
