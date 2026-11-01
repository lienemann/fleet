import { lexCpp } from './tokens/cpp';
import { lexCSharp } from './tokens/csharp';
import { lexGo } from './tokens/go';
import { lexJava } from './tokens/java';
import { lexJavaScript } from './tokens/javascript';
import { lexJson } from './tokens/json';
import { lexJson5 } from './tokens/json5';
import type { LexedText, Token } from './tokens/lexer';
import { lexMarkdown } from './tokens/markdown';
import { lexPython } from './tokens/python';
import { lexRust } from './tokens/rust';
import type { Hunk, LineRange } from './types';
import { builtinLanguageOf } from './whitespace';

/**
 * Formatting-only hunks: the removed and the added lines consist of the same tokens, so the hunk
 * only reflows code, e.g. a call split from one line into three. Whitespace and line breaks
 * between tokens are dropped; inside strings they are content. Comments count as written, apart
 * from the indentation of their lines, and so does where they sit (see `commentLayout`). In
 * Markdown, the words of paragraphs are the tokens, so a rewrapped paragraph is formatting-only.
 *
 * When in doubt, a hunk is not formatting-only: hiding a real change from the reviewer is far
 * worse than showing a reflow.
 */

export type FormattingLanguage = 'rust' | 'cpp' | 'csharp' | 'python' | 'typescript' | 'javascript' | 'go' | 'java' | 'json' | 'json5' | 'markdown';

const LEXERS: Record<FormattingLanguage, (text: string) => LexedText> = {
	rust: lexRust,
	cpp: lexCpp,
	csharp: lexCSharp,
	python: lexPython,
	typescript: text => lexJavaScript(text, false),
	// Plain `.js` files may contain JSX, which makes them unsupported.
	javascript: text => lexJavaScript(text, true),
	go: lexGo,
	java: lexJava,
	json: lexJson,
	json5: lexJson5,
	markdown: lexMarkdown,
};

/** `.jsx`, `.tsx` and `.mdx` are left out: whitespace in JSX text is content. */
const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, FormattingLanguage> = new Map(Object.entries({
	rs: 'rust',
	// C and C++ share one lexer.
	c: 'cpp', h: 'cpp',
	cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', cp: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', 'h++': 'cpp',
	inl: 'cpp', ipp: 'cpp', tpp: 'cpp', ixx: 'cpp', cppm: 'cpp',
	cs: 'csharp',
	ts: 'typescript', mts: 'typescript', cts: 'typescript',
	js: 'javascript', mjs: 'javascript', cjs: 'javascript',
	go: 'go',
	java: 'java',
	json: 'json', jsonc: 'json',
	json5: 'json5',
	md: 'markdown', markdown: 'markdown', mkd: 'markdown', mkdn: 'markdown', mdwn: 'markdown', mdown: 'markdown',
} satisfies Record<string, FormattingLanguage>));

/** The language whose formatting rules apply to `path`, or undefined if formatting-only changes are not recognised there. */
export function formattingLanguageOf(path: string): FormattingLanguage | undefined {
	// Python files are recognised like for the whitespace policy, which includes file names such as `SConstruct`.
	if (builtinLanguageOf(path) === 'python') {
		return 'python';
	}
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? LANGUAGE_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) : undefined;
}

/** Decides for hunks of one file whether they are formatting-only. */
export type FormattingCheck = (hunk: Hunk) => boolean;

/**
 * A check for `hunks`, the hunks between `baseLines` and `headLines` of `path` in order, as
 * `computeHunks` computes them; it answers for these hunk objects only. Both sides are lexed as a
 * whole on the first call, since a hunk may start inside a multi-line string or comment. Never
 * true for unknown languages or text that does not lex.
 *
 * A hunk is formatting-only if its own lines are, or if it belongs to a run of nearby hunks whose
 * lines, together with the unchanged lines between them, are (see `MAX_RUN_HUNKS`).
 */
export function formattingCheck(path: string, baseLines: readonly string[], headLines: readonly string[], hunks: readonly Hunk[]): FormattingCheck {
	const language = formattingLanguageOf(path);
	if (language === undefined) {
		return () => false;
	}
	let formattingOnly: ReadonlySet<Hunk> | undefined;
	return hunk => {
		formattingOnly ??= formattingOnlyHunks(tokenizeBoth(language, baseLines, headLines), hunks);
		return formattingOnly.has(hunk);
	};
}

/**
 * The line diff may split one reflow into several hunks, with lines in between that happen to be
 * the same on both sides: a lone `}` or `)`, an argument that keeps its line, or the body of a
 * multi-line string. Each hunk alone then fails the comparison, while their merged range passes.
 * Comparing a merged range is exactly as sound as comparing one hunk (the same tokens in the same
 * order, in the same state at both ends), so the bounds only keep the search cheap and local:
 * a run has at most `MAX_RUN_HUNKS` hunks, each at most `MAX_RUN_GAP` unchanged lines from the
 * next. The lines a formatter leaves alone in the middle of a reflowed statement are few; in
 * files reformatted by rustfmt, black and prettier, split reflows span two to six hunks with
 * gaps of one to five lines, with one exception: a long comment kept between two hunks.
 */
const MAX_RUN_HUNKS = 6;
const MAX_RUN_GAP = 10;

function formattingOnlyHunks(sides: [ComparableText, ComparableText] | undefined, hunks: readonly Hunk[]): Set<Hunk> {
	const result = new Set<Hunk>();
	if (sides === undefined) {
		return result;
	}
	const [base, head] = sides;
	const sameTokens = (first: Hunk, last: Hunk) => sameRangeTokens(
		base, { start: first.base.start, endExclusive: last.base.endExclusive },
		head, { start: first.head.start, endExclusive: last.head.endExclusive },
	);
	for (let i = 0; i < hunks.length; i++) {
		for (let j = i; j < hunks.length && j - i < MAX_RUN_HUNKS; j++) {
			if (j > i && hunks[j].head.start - hunks[j - 1].head.endExclusive > MAX_RUN_GAP) {
				break;
			}
			if (sameTokens(hunks[i], hunks[j])) {
				hunks.slice(i, j + 1).forEach(hunk => result.add(hunk));
			}
		}
	}
	return result;
}

/** Larger texts are not lexed: lexing them takes long and holds a lot of memory. */
const MAX_TEXT_LENGTH = 2_000_000;

/** One side of a file: comparison keys of its tokens with their lines, and the lexer state per line. */
interface ComparableText {
	keys: string[];
	lines: number[];
	/** Which tokens are comments, whose keys depend on the lines around them. */
	comments: boolean[];
	lineStates: ReadonlyArray<string | undefined>;
}

function tokenizeBoth(language: FormattingLanguage, baseLines: readonly string[], headLines: readonly string[]): [ComparableText, ComparableText] | undefined {
	const base = tokenize(language, baseLines);
	const head = base && tokenize(language, headLines);
	return base && head ? [base, head] : undefined;
}

function tokenize(language: FormattingLanguage, lines: readonly string[]): ComparableText | undefined {
	const text = lines.join('\n');
	if (text.length > MAX_TEXT_LENGTH) {
		return undefined;
	}
	let lexed: LexedText;
	try {
		lexed = LEXERS[language](text);
	} catch {
		// A lexer that gives up (`LexError`), or fails for any other reason, makes the file
		// unsupported rather than the review fail.
		return undefined;
	}
	const { tokens } = lexed;
	return {
		keys: tokens.map((token, i) => tokenKey(token, isComment(token) ? commentLayout(tokens, i, lines) : '')),
		lines: tokens.map(t => t.line),
		comments: tokens.map(isComment),
		lineStates: lexed.lineStates,
	};
}

/**
 * Whether the lines of `baseRange` and `headRange` hold tokens with the same keys, and the lexer
 * states at their boundaries are defined and the same. A token crossing a boundary, e.g. a range
 * starting inside a multi-line string, leaves the state undefined. Comments right before and after
 * the ranges count too: a blank line added under `//go:build` or above `import "C"` changes
 * nothing but the layout of the comment next to it.
 */
function sameRangeTokens(base: ComparableText, baseRange: LineRange, head: ComparableText, headRange: LineRange): boolean {
	const a = tokenSpan(base, baseRange);
	const b = tokenSpan(head, headRange);
	if (a === undefined || b === undefined || a.startState !== b.startState || a.endState !== b.endState
		|| a.end - a.first !== b.end - b.first) {
		return false;
	}
	const neighbour = (text: ComparableText, i: number) => (text.comments[i] ? text.keys[i] : '');
	if (neighbour(base, a.first - 1) !== neighbour(head, b.first - 1) || neighbour(base, a.end) !== neighbour(head, b.end)) {
		return false;
	}
	for (let k = 0; k < a.end - a.first; k++) {
		if (base.keys[a.first + k] !== head.keys[b.first + k]) {
			return false;
		}
	}
	return true;
}

/** The tokens on `range`'s lines (indices `first` to `end`), with the lexer states at its boundaries. */
function tokenSpan(text: ComparableText, range: LineRange): { first: number; end: number; startState: string; endState: string } | undefined {
	const startState = text.lineStates[range.start];
	const endState = text.lineStates[range.endExclusive];
	if (startState === undefined || endState === undefined) {
		return undefined;
	}
	return { first: lowerBound(text.lines, range.start), end: lowerBound(text.lines, range.endExclusive), startState, endState };
}

function isComment(token: Token): boolean {
	return token.kind === 'comment' || token.kind === 'doc';
}

/**
 * Where a comment sits: on a line of its own or after code, on the first line or not, and what
 * follows it (a blank line, text, or the end). Directives depend on it, such as `//go:build`
 * (needs a blank line before `package`), `# noqa` and `// eslint-disable-line` (apply to their
 * line), a cgo preamble right above `import "C"`, or a shebang and a Python coding comment.
 * Blank lines added above a comment change nothing, as formatters add them between definitions.
 */
function commentLayout(tokens: readonly Token[], index: number, lines: readonly string[]): string {
	const comment = tokens[index];
	let previous = index - 1;
	while (previous >= 0 && (tokens[previous].kind === 'newline' || tokens[previous].kind === 'indent')) {
		previous--;
	}
	const ownLine = previous < 0 || lastLine(tokens[previous]) < comment.line;
	const next = lines[lastLine(comment)];
	return [
		ownLine ? 'own line' : 'after code',
		comment.line === 1 ? 'first line' : '',
		next === undefined ? 'end' : next.trim() === '' ? 'blank after' : '',
	].join(',');
}

function lastLine(token: Token): number {
	let line = token.line;
	for (let i = token.text.indexOf('\n'); i >= 0; i = token.text.indexOf('\n', i + 1)) {
		line++;
	}
	return line;
}

/** The first index whose value is at least `value`, in an ascending array. */
function lowerBound(values: readonly number[], value: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (values[mid] < value) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

/** @param layout where a comment sits, see `commentLayout` */
function tokenKey(token: Token, layout: string): string {
	if (token.key !== undefined) {
		return `${token.kind}:${token.key}`;
	}
	if (token.kind === 'doc') {
		// Rust doc comments are rendered as Markdown: their text counts as written.
		return `doc:${layout}:${token.text}`;
	}
	if (token.kind === 'comment') {
		return `comment:${layout}:${reindented(token.text)}`;
	}
	if (token.kind === 'newline') {
		// The end of the text ends a line too.
		return 'newline';
	}
	return `${token.kind}:${token.text}`;
}

/**
 * A comment without the indentation of its continuation lines and without trailing blanks, which
 * change when the code around it is re-indented. Everything else in it counts: indentation after
 * the comment marker makes code blocks in doc comments.
 */
function reindented(text: string): string {
	return text.split('\n').map((line, i) => (i === 0 ? line : line.trimStart()).trimEnd()).join('\n');
}
