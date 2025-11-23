
import { Parser } from "htmlparser2";
import { DomHandler, DomUtils } from "htmlparser2";
import serialize from "dom-serializer";

// --- CONFIG ---
const PORT = Number(process.env.PORT || 8080);

// --- CSS REWRITER ---
function rewriteCss(str: string, baseUrl: string): string {
	const urlRegex = /url\(['"]?(.+?)['"]?\)/gm;
	const Atruleregex = /@import\s+(url\s*?\(.{0,9999}?\)|['"].{0,9999}?['"]|.{0,9999}?)($|\s|;)/gm;

	str = new String(str).toString();

	str = str.replace(urlRegex, (match: string, url: string) => {
		const absoluteUrl = new URL(url, baseUrl).toString();
		const encodedUrl = `/${absoluteUrl}`;
		return match.replace(url, encodedUrl);
	});

	str = str.replace(Atruleregex, (match, importStatement) => {
		return match.replace(
			importStatement,
			importStatement.replace(
				/^(url\(['"]?|['"]|)(.+?)(['"]|['"]?\)|)$/gm,
				(match: string, firstQuote: string, url: string, endQuote: string) => {
					if (firstQuote.startsWith("url")) return match;
					const absoluteUrl = new URL(url, baseUrl).toString();
					const encodedUrl = `/${absoluteUrl}`;
					return `${firstQuote}${encodedUrl}${endQuote}`;
				}
			)
		);
	});

	return str;
}

// --- SERVER ---
Bun.serve({
	port: PORT,
	async fetch(req) {
		const reqUrl = new URL(req.url);

		// Extract target URL
		let target = reqUrl.pathname.slice(1);
		if (!target) {
			return new Response("Usage: /https://example.com", { status: 400 });
		}

		target = decodeURIComponent(target);

		if (!target.startsWith("http://") && !target.startsWith("https://")) {
			target = "http://" + target;
		}

		// --- Forward ALL request bodies & methods ---
		let body: BodyInit | null = null;

		// Only some methods carry a body
		if (!["GET", "HEAD"].includes(req.method)) {
			body = await req.arrayBuffer();
		}

		// Copy request headers
		const newHeaders = new Headers(req.headers);

		// Remove headers that break proxying
		newHeaders.delete("host");
		newHeaders.delete("content-length");

		let upstream: Response;
		try {
			upstream = await fetch(target, {
				method: req.method,     // forward method
				headers: newHeaders,    // forward headers
				body,                   // forward body (if any)
				redirect: "manual",
			});
		} catch (e) {

			return new Response("Error fetching target URL", { status: 500 });
		}

		// Prepare response headers
		const outHeaders = new Headers();
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
				outHeaders.set(key, value);
			}
		});

		const type = upstream.headers.get("content-type") || "";

		let textBody = await upstream.text();

		// --- HTML Rewriting ---
		if (type.includes("html")) {
			return new Promise<Response>((resolve) => {
				const handler = new DomHandler((error, dom) => {
					if (error) {
						resolve(new Response(textBody, { status: upstream.status, headers: outHeaders }));
						return;
					}

					const rewriteAttr = (selectorFn, attr) => {
						DomUtils.findAll(selectorFn, dom).forEach((node) => {
							try {
								const abs = new URL(node.attribs[attr], target).toString();
								node.attribs[attr] = `/${abs}`;
							} catch { }
						});
					};

					rewriteAttr((e) => e.type === "script" && e.attribs?.src, "src");
					rewriteAttr((e) => e.type === "tag" && e.name === "img" && e.attribs?.src, "src");
					rewriteAttr((e) => e.type === "tag" && e.name === "a" && e.attribs?.href, "href");
					rewriteAttr((e) => e.type === "tag" && e.name === "link" && e.attribs?.href, "href");
					rewriteAttr((e) => e.type === "tag" && e.name === "form" && e.attribs?.action, "action");

					const html = serialize(dom, { encodeEntities: false });

					resolve(new Response(html, { status: upstream.status, headers: outHeaders }));
				});

				const parser = new Parser(handler, { decodeEntities: true });
				parser.write(textBody);
				parser.end();
			});
		}

		// --- JS ---
		if (type.includes("javascript") || target.endsWith(".js")) {
			outHeaders.set("Content-Type", "application/javascript");
			return new Response(textBody, { status: upstream.status, headers: outHeaders });
		}

		// --- CSS ---
		if (type.includes("css") || target.endsWith(".css")) {
			outHeaders.set("Content-Type", "text/css");
			const rewritten = rewriteCss(textBody, target);
			return new Response(rewritten, { status: upstream.status, headers: outHeaders });
		}

		// --- Other content: passthrough ---
		return new Response(textBody, { status: upstream.status, headers: outHeaders });
	},
});



