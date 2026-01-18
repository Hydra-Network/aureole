import ipaddr from "ipaddr.js";

export function isUrl(u: string): boolean {
  try {
    const parsed = new URL(u);

    if (!["http:", "https:"].includes(parsed.protocol)) return false;

    const hostname = parsed.hostname;

    if (ipaddr.isValid(hostname)) {
      const addr = ipaddr.parse(hostname);
      if (
        addr.range() === "private" ||
        addr.range() === "loopback" ||
        addr.range() === "linkLocal"
      ) {
        return false;
      }
    } else {
      if (hostname === "localhost") return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function proxify(url: string): string {
  url = decodeURIComponent(url);
  return url.match(/^(#|about:|data:|blob:|mailto:|javascript:|{|\*)/) ||
    url.includes("/aureole/")
    ? url
    : `/aureole/${encodeURIComponent(url)}`;
}

export function absolutify(url: string, base: string) {
  try {
    return new URL(url).toString();
  } catch {
    try {
      return new URL(url, base).toString();
    } catch {
      return url;
    }
  }
}
