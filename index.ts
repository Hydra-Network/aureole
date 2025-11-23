
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
		const encodedUrl = `/proxy?q=${encodeURIComponent(absoluteUrl)}`;
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
					const encodedUrl = `/proxy?q=${encodeURIComponent(absoluteUrl)}`;
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
		const url = new URL(req.url);

		// Only route /proxy
		if (url.pathname !== "/proxy") {
			return new Response("Not found", { status: 404 });
		}

		const target = url.searchParams.get("q");
		if (!target) return new Response("Missing 'q' query parameter", { status: 400 });

		const finalUrl =
			target.startsWith("http://") || target.startsWith("https://")
				? target
				: `http://${target}`;

		let upstream: Response = new Response("", { status: 500 });
		let currentUrl = finalUrl;
		try {
			const headers: Record<string, string> = {};

			// Forward headers except listed ones
			req.headers.forEach((value, key) => {
				if (
					![
						"host",
						"transfer-encoding",
						"content-encoding",
						"content-security-policy",
						"x-content-security-policy",
						"x-webkit-csp",
					].includes(key.toLowerCase())
				) {
					headers[key] = value;
				}
			});

			const fetchOptions: RequestInit = {
				method: req.method,
				headers,
			};

			// Include body for POST/PUT requests
			if (req.method !== "GET" && req.method !== "HEAD") {
				fetchOptions.body = await req.text();
			}

		// Follow redirects manually
		let redirectCount = 0;
		const maxRedirects = 10;
		
		while (redirectCount < maxRedirects) {
			upstream = await fetch(currentUrl, { ...fetchOptions, redirect: "manual" });
			

			
			// If not a redirect, break
			if (!upstream.status || upstream.status < 300 || upstream.status >= 400) {
				break;
			}
			
			// Handle redirect
			const location = upstream.headers.get("location");

			if (!location) {
				break;
			}
			
			// Resolve relative URLs
			currentUrl = new URL(location, currentUrl).toString();

			redirectCount++;
		}
		} catch (e) {

			return new Response("Error fetching the URL", { status: 500 });
		}

		const headers = new Headers();

		// Forward headers except listed ones
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

		let body = await upstream.text();
		const type = upstream.headers.get("content-type") || "";

		// --- HTML REWRITE ---
		if (type.includes("html")) {
			return new Promise<Response>((resolve) => {
				const handler = new DomHandler((error, dom) => {
					if (error) {

						resolve(
							new Response(body, {
								status: upstream.status,
								headers,
							})
						);
						return;
					}

					// <script src="">
					DomUtils.findAll(
						(e) => e.type === "script" && !!(e.attribs && e.attribs.src),
						dom
					).forEach((script) => {
						try {
							if (script.attribs?.src) {
								const absolute = new URL(script.attribs.src, finalUrl).toString();
								script.attribs.src = `/proxy?q=${encodeURIComponent(absolute)}`;
							}
						} catch { }
					});

					// <link href="">
					DomUtils.findAll(
						(e) => e.type === "tag" && e.name === "link" && !!(e.attribs && e.attribs.href),
						dom
					).forEach((link) => {
						try {
							if (link.attribs?.href) {
								const absolute = new URL(link.attribs.href, finalUrl).toString();
								link.attribs.href = `/proxy?q=${encodeURIComponent(absolute)}`;
							}
						} catch { }
					});

					// <img src="">
					DomUtils.findAll(
						(e) => e.type === "tag" && e.name === "img" && !!(e.attribs && e.attribs.src),
						dom
					).forEach((img) => {
						try {
							if (img.attribs?.src) {
								const absolute = new URL(img.attribs.src, finalUrl).toString();
								img.attribs.src = `/proxy?q=${encodeURIComponent(absolute)}`;
							}
						} catch { }
					});

					// <a href="">
					DomUtils.findAll(
						(e) => e.type === "tag" && e.name === "a" && !!(e.attribs && e.attribs.href),
						dom
					).forEach((a) => {
						try {
							if (a.attribs?.href) {
								const absolute = new URL(a.attribs.href, finalUrl).toString();
								a.attribs.href = `/proxy?q=${encodeURIComponent(absolute)}`;
							}
						} catch { }
					});

					// <form action="">
					DomUtils.findAll(
						(e) => e.type === "tag" && e.name === "form" && !!(e.attribs && e.attribs.action),
						dom
					).forEach((form) => {
						try {
							if (form.attribs?.action) {
								const absolute = new URL(form.attribs.action, finalUrl).toString();
								form.attribs.action = `/proxy?q=${encodeURIComponent(absolute)}`;
							}
						} catch { }
					});

					const html = serialize(dom, { encodeEntities: false });

					resolve(
						new Response(html, {
							status: upstream.status,
							headers,
						})
					);
				});

				const parser = new Parser(handler, { decodeEntities: true });
				parser.write(body);
				parser.end();
			});
		}

		// --- JS ---
		if (type.includes("javascript") || finalUrl.endsWith(".js")) {
			headers.set("Content-Type", "application/javascript");
			return new Response(body, { status: upstream.status, headers });
		}

		// --- CSS ---
		if (type.includes("css") || finalUrl.endsWith(".css")) {
			headers.set("Content-Type", "text/css");
			const rewritten = rewriteCss(body, finalUrl);
			return new Response(rewritten, { status: upstream.status, headers });
		}

		// Raw passthrough
		return new Response(body, { status: upstream.status, headers });
	},
});


