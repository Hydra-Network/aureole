import { proxify } from "./utils.ts"

export function rewriteCss(css: string, baseUrl: string): string {
	// regex from vk6 (https://github.com/ading2210)
	const Atruleregex =
		/@import\s+(url\s*?\(.{0,9999}?\)|['"].{0,9999}?['"]|.{0,9999}?)($|\s|;)/gm;
	css = css.replace(Atruleregex, (match, importStatement) => {
		return match.replace(
			importStatement,
			importStatement.replace(
				/^(url\(['"]?|['"]|)(.+?)(['"]|['"]?\)|)$/gm,
				(match, firstQuote, url, endQuote) => {
					if (firstQuote.startsWith("url")) {
						return match;
					}
					const encodedUrl = proxify(url.trim())

					return `${firstQuote}${encodedUrl}${endQuote}`;
				}
			)
		);
	});


	const urlRegex = /url\(['"]?(.+?)['"]?\)/gm;
	css = new String(css).toString();
	css = css.replace(urlRegex, (match, url) => {
		const encodedUrl = proxify(url.trim())

		return match.replace(url, encodedUrl);
	});

	return css;

}

