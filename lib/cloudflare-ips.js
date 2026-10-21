import { isIP, BlockList } from 'node:net';

/**
 * Cloudflare published ranges, copied 2026-09-25 from
 * https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6.
 * Replace this list when Cloudflare publishes new ranges.
 */
export const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

export const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const blockList = new BlockList();
for (const cidr of CLOUDFLARE_IPV4) {
  const [net, bits] = cidr.split('/');
  blockList.addSubnet(net, Number(bits), 'ipv4');
}
for (const cidr of CLOUDFLARE_IPV6) {
  const [net, bits] = cidr.split('/');
  blockList.addSubnet(net, Number(bits), 'ipv6');
}

/** True when the TCP peer is a Cloudflare address. IPv4-mapped IPv6 is unwrapped. */
export function isCloudflareAddress(ip) {
  if (!ip) return false;
  let clean = String(ip).trim();
  if (clean.toLowerCase().startsWith('::ffff:')) {
    const mapped = clean.slice(7);
    if (isIP(mapped) === 4) clean = mapped;
  }
  const kind = isIP(clean);
  if (kind === 4) return blockList.check(clean, 'ipv4');
  if (kind === 6) return blockList.check(clean, 'ipv6');
  return false;
}
