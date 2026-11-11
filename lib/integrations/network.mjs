import { isIP } from 'node:net';

// Reject non-global addresses, including IPv4-mapped IPv6 and metadata ranges.
export function isPublicAddress(address) {
  if (address.startsWith('::ffff:')) {
    const value = address.slice(7);
    if (isIP(value) === 4) return isPublicAddress(value);
    const parts = value.split(':');
    if (parts.length !== 2 || !parts.every(p => /^[0-9a-f]{1,4}$/i.test(p))) return false;
    const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16);
    return isPublicAddress([n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.'));
  }
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  // Global unicast only, excluding documentation and transition mechanisms.
  if (isIP(address) !== 6 || !/^[23]/i.test(address)) return false;
  const [prefix, subnet] = address.split(':').map(part => parseInt(part || '0', 16));
  return !(prefix === 0x2001 && (subnet < 0x200 || subnet === 0xdb8) || prefix === 0x2002 || prefix === 0x3fff);
}
