import { rewriteJs } from "./js.ts"
import { rewriteCss } from "./css.ts"
import { proxify, absolutify } from "./utils.ts"
import { getPatches } from "./patches.ts"

import { Parser } from "htmlparser2";
import { DomHandler, DomUtils } from "htmlparser2";
import serialize from "dom-serializer";

export function rewriteHtml(html: string, baseUrl: string, host: string): Promise<string> {
	return new Promise((resolve) => {
		const handler = new DomHandler((err, dom) => {
			if (err) return resolve(html);

			const rewriteAttr = (name: string, attr: string) => {
				DomUtils.findAll(
					(el) => el.name === name && el.attribs?.[attr],
					dom,
				).forEach((el) => {
					el.attribs[attr] = proxify(absolutify(el.attribs[attr], baseUrl));
				});
			};

			rewriteAttr("script", "src");
			rewriteAttr("img", "src");
			rewriteAttr("video", "src");
			rewriteAttr("embed", "src");
			rewriteAttr("iframe", "src");
			rewriteAttr("audio", "src");
			rewriteAttr("input", "src");
			rewriteAttr("source", "src");
			rewriteAttr("track", "src");
			rewriteAttr("link", "href");
			rewriteAttr("a", "href");
			rewriteAttr("video", "poster");
			rewriteAttr("object", "data");
			rewriteAttr("area", "href");
			rewriteAttr("form", "action");

			DomUtils.findAll(
				(el) => el.name === "script" && !el.attribs?.src,
				dom,
			).forEach((el) => {
				const rewritten = rewriteJs(DomUtils.textContent(el), baseUrl, host, true);
				// Replace children with a single text node containing rewritten JS
				el.children = [
					{
						type: "text",
						data: rewritten,
						parent: el,
					},
				];
			});

			DomUtils.findAll(
				(el) => el.name === "style",
				dom,
			).forEach((el) => {
				const rewritten = rewriteCss(DomUtils.textContent(el), baseUrl);
				// Replace children with a single text node containing rewritten JS
				el.children = [
					{
						type: "text",
						data: rewritten,
						parent: el,
					},
				];
			});

			let rewritten = serialize(dom, { encodeEntities: false })
			if (rewritten.includes("</head>")) {
				rewritten = rewritten.replace(
					"</head>",
					`
<script>
${getPatches()}
</script>
			` + "</head>",
				);
			}
			resolve(rewritten);
		});

		const parser = new Parser(handler, { decodeEntities: true });
		parser.write(html);
		parser.end();
	});
}
