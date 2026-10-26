import { ignorableTrailingCommas, Lexer, LexError, type LexedText, type Token, type TokenKind } from './lexer';

const ESCAPE = String.raw`\\u[\da-fA-F]{4}|\\U[\da-fA-F]{8}`;
/** C# identifiers, generously, with Unicode escapes and an optional `@` (`@class`). */
const IDENTIFIER = new RegExp(
	String.raw`@?(?:[\p{L}\p{Nl}_]|${ESCAPE})(?:[\p{ID_Continue}\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]|${ESCAPE})*`,
	'uy',
);
/** The prefix of a string literal: `"`, `@"`, `$"`, `$@"`, `@$"`, `$$"""`, … */
const STRING_START = /\$*@?\$*"/y;
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * Blanks that C# allows besides spaces and tabs: other space separators, the byte order mark and
 * Ctrl-Z. They are tokens of their own (a change in them needs review), but a directive after
 * them is still at the start of its line.
 */
function isOtherBlank(c: string): boolean {
	return c === BYTE_ORDER_MARK || c === '\x1a' || (c !== ' ' && /^\p{Zs}$/u.test(c));
}
/** The UTF-8 suffix of a string literal. */
const UTF8_SUFFIX = /[uU]8(?![\p{ID_Continue}])/uy;

/**
 * C#. String literals of every kind are one token compared exactly, interpolated ones with their
 * holes, so a reformatted interpolation is a change. Preprocessor directives are line tokens
 * compared exactly and end with a significant line break; code in `#if` regions is lexed whether
 * active or not, so the file is unsupported if any of it does not lex.
 */
class CSharpLexer extends Lexer {
	/** No token on this line yet: a `#` here starts a directive. */
	private atLineStart = true;
	/** A directive was lexed on this line; its line break is a token. */
	private inDirective = false;
	/** Nesting of `#if` regions, active or not. */
	private conditionalDepth = 0;

	constructor(src: string) {
		super(src, {
			lineComment: '//',
			blockComment: { open: '/*', close: '*/', nested: false },
			stringPrefixes: new Set(),
			multilineStrings: false,
			lineSplices: false,
		});
	}

	protected override scanSpecial(): TokenKind | undefined {
		const c = this.src[this.pos];
		if (isOtherBlank(c)) {
			this.pos++;
			return 'punct';
		}
		if (c === '#') {
			if (!this.atLineStart) {
				throw new LexError('`#` after other tokens on its line');
			}
			const end = this.src.indexOf('\n', this.pos);
			this.pos = end < 0 ? this.src.length : end;
			this.inDirective = true;
			return 'punct';
		}
		STRING_START.lastIndex = this.pos;
		if (STRING_START.test(this.src)) {
			this.pos = this.stringEnd(this.pos);
			this.matchAt(UTF8_SUFFIX);
			return 'string';
		}
		if (c === "'") {
			this.pos = this.charEnd(this.pos);
			return 'string';
		}
		if (this.src.startsWith('..', this.pos)) {
			// The range operator, also before a number: `[..2]` is `..` and `2`, not `.` and `.2`.
			this.pos += 2;
			return 'punct';
		}
		return this.matchAt(IDENTIFIER) === undefined ? undefined : 'word';
	}

	/** `!@this`, `=@"…"` and `=..2` are two tokens each: no operator continues with `@`, `#`, `..` or a blank. */
	protected override continuesOperator(p: number): boolean {
		const c = this.src[p];
		return c !== '@' && c !== '#' && !isOtherBlank(c) && !this.src.startsWith('..', p);
	}

	/** `///` and `/**` (but not `////` or `/**\/`) are XML documentation: content, compared exactly. */
	protected override commentKind(text: string): TokenKind {
		return /^\/\/\/(?!\/)|^\/\*\*(?!\/)/.test(text) ? 'doc' : 'comment';
	}

	protected override afterToken(token: Token): void {
		if (token.kind === 'punct' && token.text.startsWith('#')) {
			token.key = `directive:${token.text}`;
			const name = /^#\s*(\w*)/.exec(token.text)![1];
			this.conditionalDepth += name === 'if' ? 1 : name === 'endif' ? -1 : 0;
		} else if (this.conditionalDepth > 0 && token.kind !== 'word' && /\n\s*#/.test(token.text)) {
			// The compiler does not lex inactive code, so a line starting with `#` in a string or
			// comment there is a directive: the string may in fact end elsewhere.
			throw new LexError('directive inside a string or comment in a conditional region');
		}
		if (token.kind !== 'newline' && !isOtherBlank(token.text)) {
			this.atLineStart = false;
		}
	}

	protected override lineBreak(): void {
		this.endDirective(this.pos + 1);
		this.atLineStart = true;
	}

	protected override endOfText(): void {
		this.endDirective(this.pos);
	}

	private endDirective(end: number): void {
		if (this.inDirective) {
			this.inDirective = false;
			this.push('newline', this.pos, end);
		}
	}

	/** The end of the string literal whose prefix starts at `p`. */
	private stringEnd(p: number): number {
		let dollars = 0;
		let verbatim = false;
		for (; this.src[p] === '$' || this.src[p] === '@'; p++) {
			if (this.src[p] === '$') {
				dollars++;
			} else {
				verbatim = true;
			}
		}
		let quotes = 0;
		while (this.src[p + quotes] === '"') {
			quotes++;
		}
		if (quotes >= 3 && !verbatim) {
			return this.rawStringEnd(p, quotes, dollars);
		}
		if (dollars > 1) {
			throw new LexError('several `$` before a string that is not raw');
		}
		return this.quotedStringEnd(p, verbatim, dollars === 1);
	}

	/** A regular or verbatim string, possibly interpolated, from its opening quote at `p`. */
	private quotedStringEnd(p: number, verbatim: boolean, interpolated: boolean): number {
		for (let i = p + 1; ; ) {
			const c = this.src[i];
			if (c === undefined || (c === '\n' && !verbatim)) {
				throw new LexError('unterminated string');
			}
			if (c === '"') {
				if (!verbatim || this.src[i + 1] !== '"') {
					return i + 1;
				}
				i += 2;
			} else if (c === '\\' && !verbatim) {
				i += 2;
			} else if (interpolated && (c === '{' || c === '}')) {
				if (this.src[i + 1] === c) {
					i += 2;
				} else if (c === '{') {
					i = this.holeEnd(i + 1, 1);
				} else {
					throw new LexError('unmatched `}` in an interpolated string');
				}
			} else {
				i++;
			}
		}
	}

	/**
	 * A raw string with `quotes` quotes, from its opening quotes at `p`. With `dollars` dollar
	 * signs, that many braces open an interpolation hole; fewer are content.
	 */
	private rawStringEnd(p: number, quotes: number, dollars: number): number {
		let i = p + quotes;
		const lineEnd = this.src.indexOf('\n', i);
		const multiline = /^[ \t]*$/.test(this.src.slice(i, lineEnd < 0 ? undefined : lineEnd));
		let lineStart = multiline ? lineEnd + 1 : -1;
		for (;;) {
			const c = this.src[i];
			if (c === undefined || (c === '\n' && !multiline)) {
				throw new LexError('unterminated raw string');
			}
			const run = this.runLength(i, c);
			if (c === '"' && run >= quotes) {
				if (run > quotes || (multiline && this.src.slice(lineStart, i).trim() !== '')) {
					throw new LexError('raw string delimiter');
				}
				return i + quotes;
			}
			if (dollars > 0 && (c === '{' || c === '}') && run >= dollars) {
				if (c === '}' || run >= 2 * dollars) {
					throw new LexError('braces in a raw interpolated string');
				}
				i = this.holeEnd(i + run, dollars);
				continue;
			}
			if (c === '\n') {
				lineStart = i + 1;
			}
			i += c === '"' || c === '{' || c === '}' ? run : 1;
		}
	}

	/**
	 * The end of an interpolation hole whose code starts at `p`, after its `braces` closing braces.
	 * Nested brackets, strings, characters and block comments are skipped; the first `:` outside
	 * them starts the format, which runs to the closing braces.
	 */
	private holeEnd(p: number, braces: number): number {
		let depth = 0;
		for (let i = p; ; ) {
			const c = this.src[i];
			if (c === undefined) {
				throw new LexError('unterminated interpolation');
			}
			if (c === '(' || c === '[' || c === '{') {
				depth++;
				i++;
			} else if (c === ')' || c === ']' || (c === '}' && depth > 0)) {
				depth--;
				i++;
			} else if (c === '}') {
				return this.closingBraces(i, braces);
			} else if (c === ':' && depth === 0 && this.src[i + 1] !== ':' && this.src[i - 1] !== ':') {
				// The format: text up to the closing braces.
				const end = this.src.indexOf('}', i);
				if (end < 0 || /["\n]/.test(this.src.slice(i, end))) {
					throw new LexError('interpolation format');
				}
				return this.closingBraces(end, braces);
			} else if (c === '/' && this.src[i + 1] === '/') {
				throw new LexError('line comment in an interpolation');
			} else if (c === '/' && this.src[i + 1] === '*') {
				const end = this.src.indexOf('*/', i + 2);
				if (end < 0) {
					throw new LexError('unterminated comment');
				}
				i = end + 2;
			} else if (c === "'") {
				i = this.charEnd(i);
			} else if (c === '"' || ((c === '$' || c === '@') && /^[$@]*"/.test(this.src.slice(i, i + 8)))) {
				i = this.stringEnd(i);
			} else {
				i++;
			}
		}
	}

	private closingBraces(i: number, braces: number): number {
		if (this.runLength(i, '}') < braces) {
			throw new LexError('interpolation not closed');
		}
		return i + braces;
	}

	/** The end of the character literal starting at `p`. */
	private charEnd(p: number): number {
		for (let i = p + 1; ; ) {
			const c = this.src[i];
			if (c === undefined || c === '\n') {
				throw new LexError('unterminated character literal');
			}
			if (c === "'") {
				return i + 1;
			}
			i += c === '\\' ? 2 : 1;
		}
	}

	private runLength(i: number, c: string): number {
		let n = 0;
		while (this.src[i + n] === c) {
			n++;
		}
		return n;
	}
}

/**
 * Lexes C# source. A trailing comma is dropped where C# allows one and it changes nothing: in
 * array, collection and object initialisers, anonymous objects, `with` expressions, enum bodies,
 * switch expressions and collection expressions. Throws `LexError` if lexing is not reliably
 * possible.
 */
export function lexCSharp(text: string): LexedText {
	const { tokens, lineStates } = new CSharpLexer(text).lex();
	const lists = commaLists(tokens);
	const ignorable = ignorableTrailingCommas(tokens, ({ open }) => lists.has(open));
	return { tokens: tokens.filter((_, i) => !ignorable.has(i)), lineStates };
}

/** Tokens after which `[` opens a collection expression or a list pattern rather than an element access. */
const BEFORE_COLLECTION = new Set(['=', '(', '=>', ':', '??', '[', 'return', 'in', 'is', 'and', 'or', 'not', 'case']);
/** Punctuation that may occur in a type between `new` and the `{` of its initialiser. */
const TYPE_PUNCTUATION = new Set(['.', '::', '?', '<', '>', '>>', '>>>', ',', '*']);
/** Punctuation that may end a type; a name after it is declared. */
const TYPE_END = new Set(['>', '>>', '>>>', '?', '*', ')', ']']);
/** Stops the search for a `where` constraint (`where T : new()`) before `new`. */
const CLAUSE_END = new Set([';', '{', '}', '=', '(', '=>']);

/**
 * The opening brackets of the groups that may end in a trailing comma: initialisers, enum bodies,
 * switch expressions and collection expressions. A group with a `;` or a directive directly inside
 * never counts.
 */
function commaLists(tokens: readonly Token[]): Set<number> {
	const code = tokens.map((t, i) => i).filter(i => !isComment(tokens[i]));
	const opener = matchingOpeners(tokens, code);
	const lists = new Set<number>();
	const stack: Array<{ open: number; list: boolean }> = [];
	for (let k = 0; k < code.length; k++) {
		const i = code[k];
		const { kind, text } = tokens[i];
		if (kind !== 'punct') {
			continue;
		}
		const previous = k > 0 ? tokens[code[k - 1]] : undefined;
		const enclosing = stack[stack.length - 1];
		if (text === '{') {
			// Nested braces are left out: `{ {1, 2,}, }` may be a nested array initialiser, which
			// allows the comma, or the element initialiser of a collection (`{ { key, value } }`), which does not.
			const list = previous !== undefined && (
				(previous.kind === 'punct' && previous.text === '=')
				|| (previous.kind === 'word' && (previous.text === 'switch' || previous.text === 'with'))
				|| isEnumBody(tokens, code, k)
				|| followsNew(tokens, code, k, opener));
			stack.push({ open: i, list });
		} else if (text === '[') {
			stack.push({ open: i, list: previous !== undefined && BEFORE_COLLECTION.has(previous.text) });
		} else if (text === '(') {
			stack.push({ open: i, list: false });
		} else if (text === '}' || text === ']' || text === ')') {
			const group = stack.pop();
			if (group?.list) {
				lists.add(group.open);
			}
		} else if ((text === ';' || text.startsWith('#')) && enclosing) {
			// A directive may hide commas from the compiler: `A,⏎#if X⏎B⏎#endif⏎,}` is `A, ,}`.
			enclosing.list = false;
		}
	}
	return lists;
}

function isComment(token: Token): boolean {
	return token.kind === 'comment' || token.kind === 'doc';
}

/** For each closing bracket, the opening one; both as positions in `code`. */
function matchingOpeners(tokens: readonly Token[], code: readonly number[]): Map<number, number> {
	const result = new Map<number, number>();
	const stack: number[] = [];
	code.forEach((i, k) => {
		const { kind, text } = tokens[i];
		if (kind !== 'punct') {
			return;
		}
		if (text === '(' || text === '[' || text === '{') {
			stack.push(k);
		} else if (text === ')' || text === ']' || text === '}') {
			const open = stack.pop();
			if (open !== undefined) {
				result.set(k, open);
			}
		}
	});
	return result;
}

/** Whether the `{` at `code[k]` follows `enum Name …` in the same declaration. */
function isEnumBody(tokens: readonly Token[], code: readonly number[], k: number): boolean {
	for (let j = k - 1; j >= 0; j--) {
		const { kind, text } = tokens[code[j]];
		if (kind === 'punct' && (text === ';' || text === '{' || text === '}')) {
			return false;
		}
		if (kind === 'word' && text === 'enum') {
			return true;
		}
	}
	return false;
}

/**
 * Whether the `{` at `code[k]` opens the initialiser of `new T(…)`, `new T[…]`, `new()`, `new { … }`
 * or `stackalloc T[]`: only a type and argument lists lie between. A declaration after a `new`
 * modifier (`new void F()`, `new List<int> Items`, `new int[] Items`: a name right after another
 * name or after the end of a type) and the constraint `where T : new()` do not count.
 */
function followsNew(tokens: readonly Token[], code: readonly number[], k: number, opener: ReadonlyMap<number, number>): boolean {
	/** The token to the right of the current one is a name. */
	let previousWasName = false;
	for (let j = k - 1; j >= 0; j--) {
		const { kind, text } = tokens[code[j]];
		if (kind === 'punct' && previousWasName && TYPE_END.has(text)) {
			return false;
		}
		if (kind === 'punct' && (text === ')' || text === ']')) {
			const open = opener.get(j);
			if (open === undefined) {
				return false;
			}
			j = open;
			previousWasName = false;
		} else if (kind === 'word') {
			if (text === 'new' || text === 'stackalloc') {
				return !isConstraint(tokens, code, j);
			}
			if (previousWasName) {
				return false;
			}
			previousWasName = true;
		} else if (kind === 'punct' && TYPE_PUNCTUATION.has(text)) {
			previousWasName = false;
		} else {
			return false;
		}
	}
	return false;
}

/** Whether the `new` at `code[j]` is a `new()` constraint of a `where` clause. */
function isConstraint(tokens: readonly Token[], code: readonly number[], j: number): boolean {
	const before = tokens[code[j - 1]];
	if (before?.kind !== 'punct' || (before.text !== ':' && before.text !== ',')) {
		return false;
	}
	for (let m = j - 2; m >= 0; m--) {
		const { kind, text } = tokens[code[m]];
		if (kind === 'punct' && CLAUSE_END.has(text)) {
			return false;
		}
		if (kind === 'word' && text === 'where') {
			return true;
		}
	}
	return false;
}
