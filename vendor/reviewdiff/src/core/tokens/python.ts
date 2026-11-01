import { ignorableTrailingCommas, Lexer, LexError, type LexedText, type Token, type TokenKind } from './lexer';

/** The start of a string literal: prefix and opening quotes. */
const STRING_START = /([rRuUbBfFtT]{0,2})("""|'''|"|')/y;
const PREFIXES = new Set(['', 'r', 'u', 'b', 'br', 'rb', 'f', 'fr', 'rf', 't', 'tr', 'rt']);
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
/** Keywords, including the soft keywords that start statements with brackets (`match (a,):`). */
const KEYWORDS = new Set([
	'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue', 'def',
	'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
	'match', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

/**
 * Python. Line breaks outside brackets end statements and indentation opens blocks, so both are
 * tokens: a `newline` at the end of each logical line and an `indent` (the exact leading
 * whitespace) at its start. Inside brackets, and after a backslash continuation, line breaks and
 * indentation are free, which is where formatters reflow.
 */
class PythonLexer extends Lexer {
	private depth = 0;
	/** No token of the current logical line yet. */
	private atLogicalLineStart = true;

	constructor(src: string) {
		super(src, {
			lineComment: '#',
			stringPrefixes: new Set(),
			multilineStrings: false,
			lineSplices: true,
		});
	}

	protected override state(): string {
		return `${this.depth}${this.atLogicalLineStart ? '' : '\\'}`;
	}

	protected override scanSpecial(): TokenKind | undefined {
		STRING_START.lastIndex = this.pos;
		const match = STRING_START.exec(this.src);
		if (!match || !PREFIXES.has(match[1].toLowerCase())) {
			return undefined;
		}
		this.pos = this.stringEnd(this.pos + match[0].length, match[2], match[1].toLowerCase());
		return 'string';
	}

	protected override beforeToken(): void {
		if (this.atLogicalLineStart && this.depth === 0 && this.src[this.pos] !== '#') {
			this.push('indent', this.src.lastIndexOf('\n', this.pos - 1) + 1, this.pos);
		}
	}

	protected override afterToken(token: Token): void {
		if (token.kind === 'comment' || token.kind === 'newline' || token.kind === 'indent') {
			return;
		}
		this.atLogicalLineStart = false;
		if (token.kind === 'string') {
			token.key = stringKey(token.text);
		} else if (token.kind === 'punct' && OPENERS.has(token.text)) {
			this.depth++;
		} else if (token.kind === 'punct' && CLOSERS.has(token.text) && --this.depth < 0) {
			throw new LexError('unbalanced brackets');
		}
	}

	protected override lineBreak(): void {
		if (this.depth === 0) {
			this.endLogicalLine(this.pos + 1);
		}
	}

	protected override endOfText(): void {
		if (this.depth > 0) {
			throw new LexError('unclosed bracket');
		}
		this.endLogicalLine(this.pos);
	}

	private endLogicalLine(end: number): void {
		if (!this.atLogicalLineStart) {
			this.push('newline', this.pos, end);
			this.atLogicalLineStart = true;
		}
	}

	/** The end of a string literal whose body starts at `p`. */
	private stringEnd(p: number, quote: string, prefix: string): number {
		const interpolated = prefix.includes('f') || prefix.includes('t');
		for (;;) {
			const c = this.src[p];
			if (c === undefined || (c === '\n' && quote.length === 1)) {
				throw new LexError('unterminated string');
			}
			if (this.src.startsWith(quote, p)) {
				return p + quote.length;
			}
			if (c === '\\') {
				p += this.escapeLength(p, interpolated && !prefix.includes('r'), interpolated);
			} else if (interpolated && c === '{') {
				p = this.src[p + 1] === '{' ? p + 2 : this.replacementFieldEnd(p + 1);
			} else {
				p++;
			}
		}
	}

	/**
	 * Characters taken by the backslash at `p`: usually two, as an escaped quote does not end the
	 * string (in raw strings too). In f-strings, a brace after a backslash still opens or closes a
	 * replacement field, but `\N{…}` is one escape.
	 */
	private escapeLength(p: number, namedEscapes: boolean, interpolated: boolean): number {
		if (namedEscapes && this.src.startsWith('N{', p + 1)) {
			const close = this.src.indexOf('}', p);
			if (close < 0) {
				throw new LexError('unterminated escape');
			}
			return close + 1 - p;
		}
		const next = this.src[p + 1];
		return interpolated && (next === '{' || next === '}') ? 1 : 2;
	}

	/**
	 * The end of an f-string replacement field whose expression starts at `p`, nested strings
	 * included. The expression may span lines, also in single-quoted f-strings (Python 3.12).
	 */
	private replacementFieldEnd(p: number): number {
		for (let depth = 1; ; ) {
			const c = this.src[p];
			if (c === undefined) {
				throw new LexError('unterminated replacement field');
			}
			STRING_START.lastIndex = p;
			const string = STRING_START.exec(this.src);
			if (string && PREFIXES.has(string[1].toLowerCase())) {
				p = this.stringEnd(p + string[0].length, string[2], string[1].toLowerCase());
				continue;
			}
			if (OPENERS.has(c)) {
				depth++;
			} else if (CLOSERS.has(c) && --depth === 0) {
				return p + 1;
			}
			p++;
		}
	}
}

/**
 * Strings with the same prefix and body have the same value, whatever their quotes: `'a'` is
 * `"a"` and `"""a"""`. Prefix letters are case-insensitive and unordered; `u` changes nothing.
 */
function stringKey(text: string): string {
	const [, prefix, quote] = /^([a-zA-Z]*)("""|'''|"|')/.exec(text)!;
	const letters = [...prefix.toLowerCase().replace('u', '')].sort().join('');
	return `${letters}:${text.slice(prefix.length + quote.length, text.length - quote.length)}`;
}

/**
 * Lexes Python source. Throws `LexError` if lexing is not reliably possible. Tokens that
 * formatters add and remove without changing the code are dropped:
 * - a trailing comma before a closing bracket, as formatters add and remove them when they
 *   reflow a list: always before `}`, and otherwise in groups of several elements, calls and list
 *   displays. It stays in `(a,)` (a tuple) and `x[a,]` (indexing with a tuple);
 * - parentheses around a whole right-hand side, return value or `if`/`elif`/`while` condition
 *   (see `redundantParentheses`).
 */
export function lexPython(text: string): LexedText {
	const { tokens, lineStates } = new PythonLexer(text).lex();
	/** A name or a closing bracket: what a call's `(` or an index's `[` follows. */
	const isCallee = (token: Token | undefined) => token !== undefined
		&& (token.kind === 'word' && !KEYWORDS.has(token.text) || token.kind === 'punct' && CLOSERS.has(token.text));
	const ignorable = ignorableTrailingCommas(tokens, ({ open, commas }) => {
		const before = tokens[open - 1];
		switch (tokens[open].text) {
			case '{':
				return true;
			case '(':
				// `f(a,)` is `f(a)`, but `(a,)` is a tuple.
				return commas > 1 || isCallee(before);
			default:
				// `[a,]` is `[a]`, but `x[a,]` and `"ab"[a,]` index with a tuple.
				return commas > 1 || !(isCallee(before) || before?.kind === 'string' || before?.kind === 'number');
		}
	});
	const redundant = redundantParentheses(tokens);
	return {
		tokens: tokens.filter((_, i) => !ignorable.has(i) && !redundant.has(i)),
		lineStates: redundant.size === 0 ? lineStates : withDroppedParentheses(tokens, lineStates, redundant),
	};
}

const ASSIGNMENT_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '//=', '%=', '@=', '&=', '|=', '^=', '>>=', '<<=', '**=']);
const HEADER_KEYWORDS = new Set(['if', 'elif', 'while']);
const STATEMENT_SEPARATOR = new Set([';']);
const HEADER_END = new Set([':']);
const OPENING_OF: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

function isPunct(token: Token | undefined, texts: ReadonlySet<string>): boolean {
	return token?.kind === 'punct' && texts.has(token.text);
}

/**
 * Indices of parentheses that black and ruff add or remove around a whole expression:
 * - after `=`, an augmented assignment or `return`, closed right at the end of the statement
 *   (`x = (a + b)`, `return (a, b)`);
 * - after `if`, `elif` or `while` that starts a statement, closed right before the header's `:`.
 *
 * Dropping such a pair either leaves the same syntax tree or code that does not parse (a
 * generator `x = (a for a in b)`, a walrus `return (y := 1)`, a tuple `if (a, b):`), and both
 * sides of a reviewed change are taken to parse. Elsewhere parentheses can matter
 * (`assert (x, "m")` asserts a tuple), and `()` is an empty tuple, so those stay.
 */
function redundantParentheses(tokens: readonly Token[]): Set<number> {
	const result = new Set<number>();
	const stack: number[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (isPunct(tokens[i], OPENERS)) {
			stack.push(i);
		} else if (isPunct(tokens[i], CLOSERS)) {
			const open = stack.pop();
			if (open === undefined || OPENING_OF[tokens[i].text] !== tokens[open].text) {
				return new Set();
			}
			if (tokens[i].text === ')' && wrapsWholeExpression(tokens, open, i)) {
				result.add(open).add(i);
			}
		}
	}
	return result;
}

function wrapsWholeExpression(tokens: readonly Token[], open: number, close: number): boolean {
	const skipComments = (i: number) => {
		while (tokens[i]?.kind === 'comment') {
			i++;
		}
		return i;
	};
	const before = tokens[open - 1];
	const after = tokens[skipComments(close + 1)];
	const isRedundant = isPunct(before, ASSIGNMENT_OPERATORS) || (before?.kind === 'word' && before.text === 'return')
		? after?.kind === 'newline' || isPunct(after, STATEMENT_SEPARATOR)
		: before?.kind === 'word' && HEADER_KEYWORDS.has(before.text) && tokens[open - 2]?.kind === 'indent' && isPunct(after, HEADER_END);
	// `()` is an empty tuple, also with a comment inside.
	return isRedundant && skipComments(open + 1) < close;
}

/**
 * The line states, extended by which open brackets are dropped parentheses. Whether a pair is
 * dropped depends on tokens before and after it, so a hunk that starts or ends inside a pair
 * only matches a hunk inside a pair that is dropped on the other side too.
 */
function withDroppedParentheses(tokens: readonly Token[], lineStates: ReadonlyArray<string | undefined>, dropped: ReadonlySet<number>): Array<string | undefined> {
	const result = [...lineStates];
	const stack: number[] = [];
	let i = 0;
	for (let line = 1; line < result.length; line++) {
		for (; i < tokens.length && tokens[i].line < line; i++) {
			if (isPunct(tokens[i], OPENERS)) {
				stack.push(i);
			} else if (isPunct(tokens[i], CLOSERS)) {
				stack.pop();
			}
		}
		if (result[line] !== undefined && stack.length > 0) {
			result[line] += `/${stack.map(open => (dropped.has(open) ? 'd' : '-')).join('')}`;
		}
	}
	return result;
}
