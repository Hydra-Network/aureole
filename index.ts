import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { rewriteJs } from "./src/js.ts";
import { rewriteCss } from "./src/css.ts";
import { absolutify, isUrl } from "./src/utils.ts";
import { rewriteHtml } from "./src/html.ts";

const PORT = Number(process.env.PORT || 8080);
const app = new Hono();

/* -------------------------------------------------------------------------- */
/*                                UTILITIES                                   */
/* -------------------------------------------------------------------------- */

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
		headers["user-agent"] =
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
	}
	headers["accept-encoding"] = "identity";
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
				"content-security-policy-report-only",
				"x-webkit-csp",
			].includes(key.toLowerCase())
		) {
			headers.set(key, value);
		}
	});
	return headers;
}


app.all("/proxy", async (c) => {
	const target = c.req.query("q");
	if (!target) {
		return c.text("Missing 'q' query parameter", 400);
	}

	const finalUrl = isUrl(target)
		? target
		: isUrl("http://" + target)
			? "http://" + target
			: null;

	if (!finalUrl) {
		return c.text("Invalid or blocked URL", 400);
	}

	let currentUrl = finalUrl;
	let host = new URL(currentUrl).hostname;

	const options: RequestInit = {
		method: c.req.method,
		headers: fixHeaders(c.req.raw),
	};

	if (!["GET", "HEAD"].includes(c.req.method)) {
		options.body = await c.req.text();
	}

	let upstream: Response;
	let redirects = 0;
	const maxRedirects = 10;

	while (true) {
		upstream = await fetch(currentUrl, { ...options, redirect: "manual" });
		if (upstream.status >= 300 && upstream.status < 400 && redirects < maxRedirects) {
			const loc = upstream.headers.get("location");
			if (loc) {
				currentUrl = absolutify(loc, currentUrl);
				redirects++;
				continue;
			}
		}
		break;
	}

	const ct = upstream.headers.get("content-type") || "";
	const sfd = c.req.header("Sec-Fetch-Dest") || "";
	const headers = removeCsp(upstream);

	if (ct.includes("text/html")) {
		const raw = await upstream.text();
		const rewritten = await rewriteHtml(raw, finalUrl, host);
		return c.html(rewritten, { status: upstream.status, headers: Object.fromEntries(headers) });
	}

	if (sfd.includes("style") || ct.includes("text/css")) {
		const raw = await upstream.text();
		const rewritten = rewriteCss(raw, currentUrl);
		headers.set("Content-Type", "text/css");
		return new Response(rewritten, { status: upstream.status, headers });
	}

	if (sfd.includes("script") || ct.includes("javascript")) {
		const raw = await upstream.text();
		const rewritten = rewriteJs(raw, currentUrl, host);
		headers.set("Content-Type", "application/javascript");
		return new Response(rewritten, { status: upstream.status, headers });
	}

	return new Response(upstream.body, {
		status: upstream.status,
		headers,
	});
});

app.use("/*", serveStatic({ root: "./public" }));

export default {
	port: PORT,
	fetch: app.fetch,
};
