/**
 * Heuristics for blocks that look like moves but carry no review value:
 * licence headers and import blocks are near-identical in many files, so
 * "moving" them between files is almost always coincidence.
 */

import type { LineRange } from './types';

// `#` comments, but not C preprocessor directives such as `#include`.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|--|;|<!--|-->|%|#(?!\s*(include|import|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|error)\b))/;
const SHEBANG = /^#!/;
const LICENCE_WORDING = /copyright|licen[cs]e|spdx|all rights reserved|\(c\)/i;

const isBlank = (line: string) => line.trim() === '';
const isComment = (line: string) => COMMENT_LINE.test(line);

/**
 * True if `range` of `fileLines` is (part of) a licence header: comments only,
 * preceded by nothing but blank lines, a shebang or other comments, and
 * mentioning copyright or licence terms.
 */
export function isLicenseHeader(fileLines: readonly string[], range: LineRange): boolean {
	const before = fileLines.slice(0, range.start - 1);
	const block = fileLines.slice(range.start - 1, range.endExclusive - 1);
	const onTop = before.every((l, i) => isBlank(l) || isComment(l) || (i === 0 && SHEBANG.test(l)));
	const commentsOnly = block.every(l => isBlank(l) || isComment(l));
	return onTop && commentsOnly && block.some(l => LICENCE_WORDING.test(l));
}

const IMPORT_START = [
	/^\s*import(\s|$)/,                     // JS/TS, Java, Kotlin, Python, Go, Swift, Scala
	/^\s*from\s+\S+\s+import\b/,            // Python
	/^\s*export\s+(\*|\{|type\s+\{)/,       // JS/TS re-exports
	/^\s*#\s*(include|import)\b/,           // C, C++, Objective-C
	/^\s*@import\b/,                        // CSS, Sass, Less
	/^\s*using\s+(?!\()/,                   // C#, C++
	/^\s*(pub(\([^)]*\))?\s+)?use\s+/,      // Rust, PHP
	/^\s*(extern\s+crate|mod)\s+\w+\s*;/,   // Rust
	/^\s*package\s+[\w.]+\s*;?\s*$/,        // Java, Kotlin, Go
	/^\s*((const|let|var)\s+.+=\s*)?require\(/, // CommonJS
];

function bracketBalance(line: string): number {
	let balance = 0;
	for (const ch of line) {
		if (ch === '{' || ch === '(' || ch === '[') {
			balance++;
		} else if (ch === '}' || ch === ')' || ch === ']') {
			balance--;
		}
	}
	return balance;
}

/**
 * True if every line is an import-like statement (including the continuation
 * lines of a multi-line import), a comment or blank, and at least one line
 * is an import.
 */
export function isImportBlock(lines: readonly string[]): boolean {
	const kinds = classifyLines(lines);
	return kinds.every(kind => kind !== 'code') && kinds.includes('import');
}

/**
 * The number of leading lines that are imports (with their continuation lines) or blank; 0 if
 * no import is among them. Comments end the prefix: they usually document the code below.
 */
export function importPrefixLength(lines: readonly string[]): number {
	const kinds = classifyLines(lines);
	const length = kinds.findIndex(kind => kind !== 'import' && kind !== 'blank');
	const prefix = length < 0 ? kinds.length : length;
	return kinds.slice(0, prefix).includes('import') ? prefix : 0;
}

type LineKind = 'import' | 'blank' | 'comment' | 'code';

function classifyLines(lines: readonly string[]): LineKind[] {
	let open = 0; // unbalanced brackets of a multi-line import
	return lines.map(line => {
		if (open > 0) {
			open += bracketBalance(line);
			return 'import';
		}
		if (isBlank(line)) {
			return 'blank';
		}
		if (isComment(line)) {
			return 'comment';
		}
		if (!IMPORT_START.some(re => re.test(line))) {
			return 'code';
		}
		open = Math.max(0, bracketBalance(line));
		return 'import';
	});
}
