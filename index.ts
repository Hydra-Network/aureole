import { Parser } from "htmlparser2";
import ipaddr from "ipaddr.js";
import { DomHandler, DomUtils } from "htmlparser2";
import serialize from "dom-serializer";

const PORT = Number(process.env.PORT || 8080);

/* -------------------------------------------------------------------------- */
/*                                UTILITIES                                   */
/* -------------------------------------------------------------------------- */

function isUrl(u: string): boolean {
	try {
		const parsed = new URL(u);

		if (!["http:", "https:"].includes(parsed.protocol)) return false;

		const hostname = parsed.hostname;

		if (ipaddr.isValid(hostname)) {
			const addr = ipaddr.parse(hostname);
			if (addr.range() === "private" || addr.range() === "loopback" || addr.range() === "linkLocal") {
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

function proxify(url: string): string {
	return `/proxy?q=${encodeURIComponent(url)}`;
}

function absolutify(url: string, base: string) {
	try {
		return new URL(url, base).toString();
	} catch {
		return url;
	}
}

function fixHeaders(req: Request): Record<string, string> {
	const headers: Record<string, string> = {};

	req.headers.forEach((value, key) => {
		const lowerKey = key.toLowerCase();
		if (
			![
				"host",
				"transfer-encoding",
				"content-encoding",
				"content-security-policy",
				"x-content-security-policy",
				"x-webkit-csp",
				"origin",
				"referer",
			].includes(lowerKey)
		) {
			headers[key] = value;
		}
	});

	if (!headers["user-agent"]) {
		headers["user-agent"] = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
	}
	if (!headers["accept"]) {
		headers["accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
	}
	if (!headers["accept-language"]) {
		headers["accept-language"] = "en-US,en;q=0.9";
	}
	if (!headers["accept-encoding"]) {
		headers["accept-encoding"] = "gzip, deflate, br";
	}

	return headers;
}

function removeCsp(upstream: Response): Headers {
	const headers = new Headers();
	upstream.headers.forEach((value, key) => {
		if (
			![
				"transfer-encoding",
				"content-encoding",
				"content-security-policy",
				"x-content-security-policy",
				"x-webkit-csp",
			].includes(key.toLowerCase())
		) {
			headers.set(key, value);
		}
	});
	return headers;
}

/* -------------------------------------------------------------------------- */
/*                                    CSS                                     */
/* -------------------------------------------------------------------------- */

function rewriteCss(css: string, baseUrl: string): string {
	// url(...)
	css = css.replace(/url\((['"]?)([^"')]+)\1\)/g, (_, quote, url) => {
		const abs = absolutify(url, baseUrl);
		return `url(${proxify(abs)})`;
	});

	// @import "foo.css"
	css = css.replace(/@import\s+(url\()?['"]?([^'")]+)['"]?\)?/g, (match, isUrl, url) => {
		const abs = absolutify(url, baseUrl);
		return `@import url(${proxify(abs)})`;
	});

	return css;
}

/* -------------------------------------------------------------------------- */
/*                                    HTML                                    */
/* -------------------------------------------------------------------------- */

function rewriteHtml(html: string, baseUrl: string): Promise<string> {
	return new Promise((resolve) => {
		const handler = new DomHandler((err, dom) => {
			if (err) return resolve(html);


			const rewriteAttr = (name: string | null, attr: string) => {
				DomUtils.findAll(
					(el) =>
						el.type === "tag" &&
						((name ? el.name === name && el.attribs?.[attr] : el.attribs?.[attr])),
					dom
				).forEach((el) => {
					const abs = absolutify(el.attribs[attr], baseUrl);
					el.attribs[attr] = proxify(abs);
				});
			};


			rewriteAttr(null, "src");
			rewriteAttr(null, "href");
			rewriteAttr("video", "poster");
			rewriteAttr("object", "data");
			rewriteAttr("area", "href");
			rewriteAttr("form", "action");

			resolve(serialize(dom, { encodeEntities: false }));
		});

		const parser = new Parser(handler, { decodeEntities: true });
		parser.write(html);
		parser.end();
	});
}

/* -------------------------------------------------------------------------- */
/*                                    SERVER                                  */
/* -------------------------------------------------------------------------- */

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname !== "/proxy") {
			return new Response("Not found", { status: 404 });
		}

		const target = url.searchParams.get("q");
		if (!target) {
			return new Response("Missing 'q' query parameter", { status: 400 });
		}

		const finalUrl = isUrl(target)
			? target
			: isUrl("http://" + target)
				? "http://" + target
				: null;

		if (!finalUrl) {
			return new Response("Invalid or blocked URL", { status: 400 });
		}

		/* ----------------------------- Fetch upstream ---------------------------- */

		let upstream: Response = new Response("Internal Server Error", { status: 500 });
		let currentUrl = finalUrl;

		const options: RequestInit = {
			method: req.method,
			headers: fixHeaders(req),
		};

		if (!["GET", "HEAD"].includes(req.method)) {
			options.body = await req.text();
		}

		let redirects = 0;
		const maxRedirects = 10;

		while (redirects < maxRedirects) {
			upstream = await fetch(currentUrl, { ...options, redirect: "manual" });

			if (upstream.status < 300 || upstream.status >= 400) break;

			const loc = upstream.headers.get("location");
			if (!loc) break;

			currentUrl = absolutify(loc, currentUrl);
			redirects++;
		}

		/* ---------------------------- Handle content ---------------------------- */

		const ct = upstream.headers.get("content-type") || "";
		const headers = removeCsp(upstream);

		// HTML
		if (ct.includes("text/html")) {
			const raw = await upstream.text();
			let rewritten = await rewriteHtml(raw, finalUrl);
			if (rewritten.includes('</head>')) {
				rewritten = rewritten.replace('</head>', `
<script>


    const oldOpen = XMLHttpRequest.prototype.open;
    const proxy = "/proxy?q=${currentUrl}";

    XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
        // Encode the URL and prepend the proxy
        const proxiedUrl = proxy + encodeURIComponent(url);

        console.log(proxiedUrl); // optional: debug
        // Call original open with proxied URL
        return oldOpen.call(this, method, proxiedUrl, async, user, password);
    };    const oldFetch = window.fetch;

    window.fetch = function(input, init) {
        if (input && typeof input === "object" && "url" in input) {
            const proxied = proxy + encodeURIComponent(input.url);
            const newReq = new Request(proxied, input);
            return oldFetch(newReq, init);
        }

        const url = typeof input === "string" ? input : input.toString();
        const proxied = proxy + encodeURIComponent(url);

        console.log(proxied);
        return oldFetch(proxied, init);
    };


</script>
			`
					+ '</head>');
			}
			return new Response(rewritten, { status: upstream.status, headers });
		}

		// CSS
		if (ct.includes("text/css") || currentUrl.endsWith(".css")) {
			const raw = await upstream.text();
			const rewritten = rewriteCss(raw, currentUrl);
			headers.set("Content-Type", "text/css");
			return new Response(rewritten, { status: upstream.status, headers });
		}

		// JS
		if (ct.includes("javascript") || currentUrl.endsWith(".js")) {
			headers.set("Content-Type", "application/javascript");
			return new Response(await upstream.text(), {
				status: upstream.status,
				headers,
			});
		}

		// Stream everything else
		return new Response(upstream.body, {
			status: upstream.status,
			headers,
		});
	},
});

console.log("Proxy running on port", PORT);
