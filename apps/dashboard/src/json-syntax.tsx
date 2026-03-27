import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import type { CSSProperties } from "react";

SyntaxHighlighter.registerLanguage("json", json);

/**
 * Custom Prism theme matched to the boilerhouse dashboard palette.
 *
 * surface-2: #1A1726   muted: #6E6A7C   muted-light: #9893A6
 * status-blue: #61AFEF   accent-bright: #3DD9B2   status-orange: #D19A66
 * status-yellow: #E5C07B   surface-3: #221F2E
 */
const boilerhouseTheme: Record<string, CSSProperties> = {
	'code[class*="language-"]': {
		background: "transparent",
		color: "#9893A6",
		fontFamily: '"JetBrains Mono", monospace',
		whiteSpace: "pre",
		wordSpacing: "normal",
		wordBreak: "normal",
		lineHeight: "1.5",
		tabSize: 2,
	},
	'pre[class*="language-"]': {
		background: "transparent",
		color: "#9893A6",
		fontFamily: '"JetBrains Mono", monospace',
		whiteSpace: "pre",
		wordSpacing: "normal",
		wordBreak: "normal",
		lineHeight: "1.5",
		tabSize: 2,
		padding: 0,
		margin: 0,
		overflow: "auto",
	},
	// JSON keys
	property: { color: "#61AFEF" },
	// String values
	string: { color: "#3DD9B2" },
	// Numbers
	number: { color: "#D19A66" },
	// Booleans
	boolean: { color: "#E5C07B" },
	// null
	"keyword": { color: "#6E6A7C" },
	".language-json .token.null.keyword": { color: "#6E6A7C" },
	// Punctuation: braces, brackets, commas, colons
	punctuation: { color: "#6E6A7C" },
	operator: { color: "#6E6A7C" },
};

export function JsonSyntax({ data }: { data: unknown }) {
	return (
		<div className="bg-surface-2 rounded-md p-4 text-sm overflow-x-auto">
			<SyntaxHighlighter
				language="json"
				style={boilerhouseTheme}
				customStyle={{ background: "transparent", padding: 0, margin: 0 }}
			>
				{JSON.stringify(data, null, 2)}
			</SyntaxHighlighter>
		</div>
	);
}
