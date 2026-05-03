if (!window.patched) {
  window.patched = true;

  function getOriginalTarget() {
    const pathname = window.location.pathname;
    const match = pathname.match(/^\/aureole\/(.+)$/);
    if (!match) return null;
    const base64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "==".slice(0, (4 - (base64.length % 4)) % 4);
    try {
      return decodeURIComponent(atob(padded));
    } catch {
      return null;
    }
  }

  function proxify(url) {
    url = decodeURIComponent(url);
    const isExcluded = /^(#|about:|data:|blob:|mailto:|javascript:|\{|\*)/.test(
      url,
    );
    const isProxied = url.includes("/aureole/");

    if (isExcluded || isProxied) return url;

    const originalTarget = getOriginalTarget();
    let absoluteUrl = url;

    try {
      new URL(url);
      absoluteUrl = url;
    } catch {
      if (originalTarget) {
        absoluteUrl = new URL(url, originalTarget).href;
      } else {
        absoluteUrl = new URL(url, location.href).href;
      }
    }

    return (
      "/aureole/" +
      btoa(encodeURIComponent(absoluteUrl))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
    );
  }

  [window, document].forEach((targetParent) => {
    Object.defineProperty(targetParent, "proxyLocation", {
      get: function () {
        return new Proxy(
          {},
          {
            get(_, prop) {
              const originalTarget = getOriginalTarget();
              if (!originalTarget) return undefined;
              const cleanUrlObj = new URL(originalTarget);

              if (
                prop === "href" ||
                prop === "toString" ||
                prop === Symbol.toPrimitive
              ) {
                return prop === "href"
                  ? cleanUrlObj.href
                  : () => cleanUrlObj.href;
              }

              if (prop === "assign" || prop === "replace") {
                return (newAddr) => {
                  const resolved = new URL(newAddr, cleanUrlObj.href).href;
                  window.location[prop](
                    "/aureole/" +
                      btoa(encodeURIComponent(resolved))
                        .replace(/\+/g, "-")
                        .replace(/\//g, "_"),
                  );
                };
              }

              if (prop === "reload") {
                return () => window.location.reload();
              }

              const val = cleanUrlObj[prop];
              return typeof val === "function" ? val.bind(cleanUrlObj) : val;
            },

            set(_, prop, val) {
              const originalTarget = getOriginalTarget();
              const base = originalTarget || window.location.href;
              const cleanUrlObj = new URL(base);

              if (prop === "href") {
                const resolved = new URL(val, base).href;
                window.location.href =
                  "/aureole/" +
                  btoa(encodeURIComponent(resolved))
                    .replace(/\+/g, "-")
                    .replace(/\//g, "_");
              } else if (prop in cleanUrlObj) {
                const updated = new URL(base);
                updated[prop] = val;
                window.location.href =
                  "/aureole/" +
                  btoa(encodeURIComponent(updated.href))
                    .replace(/\+/g, "-")
                    .replace(/\//g, "_");
              }
              return true;
            },
          },
        );
      },
      set: function (val) {
        const cleanUrlString =
          new URLSearchParams(window.location.search).get("q") ||
          window.location.href;
        const originalTarget = getOriginalTarget();
        const base = originalTarget || cleanUrlString;
        const resolved = new URL(val, base).href;
        window.location.href =
          "/aureole/" +
          btoa(encodeURIComponent(resolved))
            .replace(/\+/g, "-")
            .replace(/\//g, "_");
      },
      configurable: true,
    });
  });

  const oldOpen = XMLHttpRequest.prototype.open;
  const oldFetch = window.fetch;

  XMLHttpRequest.prototype.open = function (
    method,
    url,
    async,
    user,
    password,
  ) {
    return oldOpen.call(this, method, proxify(url), async, user, password);
  };

  window.proxyImport = (url) => {
    return import(proxify(url));
  };

  window.fetch = function (input, init) {
    if (input && typeof input === "object" && "url" in input) {
      const newReq = new Request(proxify(input.url), input);
      return oldFetch(newReq, init);
    }
    const url = typeof input === "string" ? input : input.toString();
    return oldFetch(proxify(url), init);
  };
}
