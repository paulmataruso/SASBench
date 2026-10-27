import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

// Deployment addressing from the environment: the name radios use to reach the SAS (SAS_FQDN),
// the address every listener binds (SAS_BIND_IP), and the addresses shown as the SAS endpoints.

/** docker compose passes `NAME=` lines from .env as empty strings: treat blank values as unset. */
export function dropBlankEnv(env: NodeJS.ProcessEnv = process.env) {
  for (const [k, v] of Object.entries(env)) {
    if ((k.startsWith('SAS_') || k === 'UI_PORT') && v !== undefined && !v.trim()) delete env[k];
  }
}

export const isWildcard = (ip: string) => ip === '0.0.0.0' || ip === '::';

/** The address a client on this machine uses to reach a listener bound to `bindIp`. */
export const loopbackHost = (bindIp: string) => (isWildcard(bindIp) ? '127.0.0.1' : bindIp);

/** A DNS name or an IP literal, lower-cased; null when the value is neither. */
export function hostOrIp(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (net.isIP(v)) return v;
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/.test(v) ? v.replace(/\.$/, '') : null;
}

// Interfaces created by container runtimes and VPNs: never the address radios use.
const VIRTUAL_IF = /^(docker|br-|veth|virbr|cni|flannel|cali|vxlan|tun|tap|lxc|lxd|podman|kube|zt|wg)/;

/** IPv4 addresses of this machine's LAN interfaces (no loopback or container bridges). */
export function lanIPv4(): string[] {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL_IF.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

/**
 * The machine's main IPv4 address: the source address of its default route (connecting a UDP socket
 * picks it without sending anything), else its first LAN interface address.
 */
export function primaryIPv4(): Promise<string | null> {
  return new Promise((resolve) => {
    const fallback = () => lanIPv4()[0] ?? null;
    const s = dgram.createSocket('udp4');
    const done = (ip: string | null) => {
      try {
        s.close();
      } catch { /* already closed */ }
      resolve(ip);
    };
    s.once('error', () => done(fallback()));
    // 192.0.2.1 is a documentation address (RFC 5737): only the route lookup matters.
    s.connect(9, '192.0.2.1', () => {
      const ip = s.address().address;
      done(ip && ip !== '0.0.0.0' && !ip.startsWith('127.') ? ip : fallback());
    });
  });
}
