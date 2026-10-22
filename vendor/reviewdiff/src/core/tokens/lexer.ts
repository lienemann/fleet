/**
 * A configurable lexer for recognising formatting-only changes: two texts with the same tokens are
 * taken to mean the same.
 *
 * The lexer does not need to know the language's grammar, only to be safe for that comparison.
 * That holds as long as every token of the real language lies within one of our tokens (merging is
 * fine, e.g. `+-` as one operator, but splitting is not: `a+ +b` and `a ++b` must differ), and
 * strings and comments are recognised exactly, since whitespace inside them is content. Whatever
 * the lexer cannot handle reliably makes it give up (`LexError`), so nothing in the text counts as
 * formatting-only.
 */

/** `newline` and `indent` mark significant line breaks and indentation, e.g. in Python. */
export type TokenKind = 'word' | 'number' | 'string' | 'comment' | 'doc' | 'punct' | 'newline' | 'indent';

export interface Token {
	kind: TokenKind;
	text: string;
	/** Offset of the first character. */
	start: number;
	/** 1-based line of the first character. */
	line: number;
	/**
	 * Comparison key where the text alone is not enough, e.g. the `(` of `#define F(x)`, which
	 * must differ from the one of `#define F (x)`.
	 */
	key?: string;
}

export interface LexedText {
	tokens: Token[];
	/**
	 * Lexer state at the start of each line (index = 1-based line number) and at the end of the
	 * text (index = line count + 1). Undefined where a token spans the line break, e.g. inside a
	 * multi-line string or comment.
	 */
	lineStates: Array<string | undefined>;
}

/** The text cannot be lexed reliably, e.g. because a string is not terminated. */
export class LexError extends Error {}

export interface Syntax {
	lineComment: string;
	blockComment?: { open: string; close: string; nested: boolean };
	/** Identifiers that belong to a directly following string or character literal, like `b` in `b"…"`. */
	stringPrefixes: ReadonlySet<string>;
	/** Strings may contain line breaks. Otherwise a literal ends at the line break. */
	multilineStrings: boolean;
	/** Apostrophes separate digits, as in C++'s `1'000`. */
	apostropheDigitSeparators?: boolean;
	/** A backslash before a line break joins the lines. */
	lineSplices: boolean;
	/** A line comment ending in a backslash continues on the next line, as in C and C++. */
	continuedLineComments?: boolean;
}

const ESCAPE = String.raw`\\u[\da-fA-F]{4}|\\U[\da-fA-F]{8}|\\u\{[\da-fA-F]+\}`;
/** Identifiers, generously: `$` and escapes are included in every language. */
const IDENTIFIER = new RegExp(String.raw`(?:[\p{ID_Start}_$]|${ESCAPE})(?:[\p{ID_Continue}$\u200C\u200D]|${ESCAPE})*`, 'uy');
const IDENTIFIER_START = /[\p{ID_Start}_$]/u;
/** Numbers like C's preprocessing numbers: digits, letters, dots and exponent signs, e.g. `0x1p-3f`. */
const NUMBER = /(?:\d|\.\d)(?:[eEpP][+-]|[\p{ID_Continue}.])*/uy;
const NUMBER_WITH_SEPARATOR = /(?:\d|\.\d)(?:[eEpP][+-]|[\p{ID_Continue}.]|'(?=\p{ID_Continue}))*/uy;
/** Characters that are tokens of their own; everything else that is not a word, number or quote forms operators. */
const SINGLES = new Set('()[]{},;');
/** Characters that end an operator run. */
const NOT_OPERATOR = /[\s\p{ID_Continue}$"'`()[\]{},;]/u;

const OPENING = new Map([[')', '('], [']', '['], ['}', '{']]);

/**
 * Lexes a whole text. Subclasses add what is special about a language through the hooks
 * (`scanSpecial`, `scanApostrophe`, `commentKind`, `continuesOperator`, `lineBreak`,
 * `beforeToken`, `afterToken`, `endOfText`, `state`).
 */
export abstract class Lexer {
	protected pos = 0;
	protected readonly tokens: Token[] = [];
	private readonly lineStates: Array<string | undefined> = [];
	private line = 1;
	private counted = 0;

	protected constructor(protected readonly src: string, protected readonly syntax: Syntax) {}

	lex(): LexedText {
		this.lineStates[1] = this.state();
		for (;;) {
			this.skipWhitespace();
			if (this.pos >= this.src.length) {
				break;
			}
			const start = this.pos;
			this.beforeToken();
			this.push(this.scanComment() ?? this.scanSpecial() ?? this.scanCommon(), start);
		}
		this.endOfText();
		this.lineStates[this.lineAt(this.src.length) + 1] = this.state();
		return { tokens: this.tokens, lineStates: this.lineStates };
	}

	/** Language state at a line boundary; boundaries of a formatting-only hunk must have equal states on both sides. */
	protected state(): string {
		return '';
	}

	/** Scans a language-specific token at `pos`, or returns undefined to fall back to the common rules. */
	protected scanSpecial(): TokenKind | undefined {
		return undefined;
	}

	/** Scans a token starting with `'`; a character literal unless the language says otherwise. */
	protected scanApostrophe(): TokenKind {
		this.scanQuoted("'");
		this.scanSuffix();
		return 'string';
	}

	protected commentKind(_text: string): TokenKind {
		return 'comment';
	}

	/** Called at a line break between tokens, before it is consumed. */
	protected lineBreak(): void {}

	/** Called before scanning a token at `pos`; may push tokens of its own. */
	protected beforeToken(): void {}

	protected afterToken(_token: Token): void {}

	protected endOfText(): void {}

	protected push(kind: TokenKind, start: number, end = this.pos): Token {
		const token: Token = { kind, text: this.src.slice(start, end), start, line: this.lineAt(start) };
		this.tokens.push(token);
		this.afterToken(token);
		return token;
	}

	/** Scans a literal from the opening quote at `pos` to the closing one, honouring backslash escapes. */
	protected scanQuoted(quote: string): void {
		let p = this.pos + 1;
		for (;;) {
			const c = this.src[p];
			if (c === undefined) {
				throw new LexError('unterminated literal');
			}
			if (c === quote) {
				this.pos = p + 1;
				return;
			}
			if (c === '\\') {
				p = this.spliceEnd(p) ?? p + 2;
			} else if (c === '\n' && !this.syntax.multilineStrings) {
				// An unterminated literal, like the apostrophe in `#error don't`. Compilers read it
				// up to the end of the line, and so do we: its text is compared exactly.
				this.pos = p;
				return;
			} else {
				p++;
			}
		}
	}

	/** A literal suffix such as C++'s `"…"_s` belongs to the literal. */
	protected scanSuffix(): void {
		this.matchAt(IDENTIFIER);
	}

	/** Advances past a match of the sticky `pattern` at `pos`; returns the matched text. */
	protected matchAt(pattern: RegExp): string | undefined {
		pattern.lastIndex = this.pos;
		const match = pattern.exec(this.src);
		if (match) {
			this.pos += match[0].length;
		}
		return match?.[0];
	}

	/** If a line splice (backslash, optional blanks, line break) starts at `p`, the offset after it. */
	protected spliceEnd(p: number): number | undefined {
		if (!this.syntax.lineSplices || this.src[p] !== '\\') {
			return undefined;
		}
		let q = p + 1;
		while (this.src[q] === ' ' || this.src[q] === '\t') {
			q++;
		}
		return this.src[q] === '\n' ? q + 1 : undefined;
	}

	protected isIdentifierStart(p: number): boolean {
		const c = this.src.codePointAt(p);
		return c !== undefined && IDENTIFIER_START.test(String.fromCodePoint(c));
	}

	private skipWhitespace(): void {
		for (;;) {
			const c = this.src[this.pos];
			if (c === '\n') {
				this.lineBreak();
				this.pos++;
				this.recordLineState();
			} else if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
				this.pos++;
			} else {
				const end = this.spliceEnd(this.pos);
				if (end === undefined) {
					return;
				}
				if (isBlank(this.src[this.pos - 1]) || isBlank(this.src[end])) {
					this.pos = end;
					this.recordLineState();
				} else {
					// The splice joins two characters, possibly in the middle of a token: keep it as a
					// token, so it only matches the same splice on the other side.
					const start = this.pos;
					this.pos = end;
					this.push('punct', start).key = 'splice';
				}
			}
		}
	}

	private recordLineState(): void {
		this.lineStates[this.lineAt(this.pos)] = this.state();
	}

	private lineAt(offset: number): number {
		for (; this.counted < offset; this.counted++) {
			if (this.src[this.counted] === '\n') {
				this.line++;
			}
		}
		return this.line;
	}

	private scanComment(): TokenKind | undefined {
		const start = this.pos;
		const { lineComment, blockComment } = this.syntax;
		if (this.src.startsWith(lineComment, this.pos)) {
			this.pos = this.lineCommentEnd();
		} else if (blockComment && this.src.startsWith(blockComment.open, this.pos)) {
			this.pos = this.blockCommentEnd(blockComment);
		} else {
			return undefined;
		}
		return this.commentKind(this.src.slice(start, this.pos));
	}

	private lineCommentEnd(): number {
		for (let p = this.pos; ; ) {
			const end = this.src.indexOf('\n', p);
			if (end < 0) {
				return this.src.length;
			}
			// In C and C++, a backslash at the end of the line continues the comment.
			const splice = this.syntax.continuedLineComments ? /\\[ \t]*$/.exec(this.src.slice(p, end)) : null;
			if (!splice) {
				return end;
			}
			p = end + 1;
		}
	}

	private blockCommentEnd({ open, close, nested }: NonNullable<Syntax['blockComment']>): number {
		let depth = 0;
		for (let p = this.pos; p < this.src.length; ) {
			if (this.src.startsWith(close, p)) {
				p += close.length;
				if (--depth === 0) {
					return p;
				}
			} else if (this.src.startsWith(open, p) && (nested || depth === 0)) {
				p += open.length;
				depth++;
			} else {
				p++;
			}
		}
		throw new LexError('unterminated comment');
	}

	private scanCommon(): TokenKind {
		const c = this.src[this.pos];
		if (c === '"') {
			this.scanQuoted('"');
			this.scanSuffix();
			return 'string';
		}
		if (c === "'") {
			return this.scanApostrophe();
		}
		const word = this.matchAt(IDENTIFIER);
		if (word !== undefined) {
			const quote = this.src[this.pos];
			if ((quote === '"' || quote === "'") && this.syntax.stringPrefixes.has(word)) {
				this.scanQuoted(quote);
				this.scanSuffix();
				return 'string';
			}
			return 'word';
		}
		if (this.matchAt(this.syntax.apostropheDigitSeparators ? NUMBER_WITH_SEPARATOR : NUMBER) !== undefined) {
			return 'number';
		}
		if (SINGLES.has(c)) {
			this.pos++;
			return 'punct';
		}
		// A run of operator characters, as greedy as possible.
		do {
			this.pos += this.src.codePointAt(this.pos)! > 0xffff ? 2 : 1;
		} while (this.pos < this.src.length && this.isOperatorChar(this.pos));
		return 'punct';
	}

	private isOperatorChar(p: number): boolean {
		const c = String.fromCodePoint(this.src.codePointAt(p)!);
		if (NOT_OPERATOR.test(c) || this.spliceEnd(p) !== undefined) {
			return false;
		}
		const { lineComment, blockComment } = this.syntax;
		if (this.src.startsWith(lineComment, p) || (blockComment && this.src.startsWith(blockComment.open, p))) {
			return false;
		}
		// `.5` is a number.
		return !(c === '.' && /\d/.test(this.src[p + 1] ?? '')) && this.continuesOperator(p);
	}

	/** Whether the operator character at `p` may extend the operator before it. */
	protected continuesOperator(_p: number): boolean {
		return true;
	}
}

function isBlank(c: string | undefined): boolean {
	return c === undefined || /\s/.test(c);
}

/** A bracketed group, for deciding whether a trailing comma may be ignored. */
export interface BracketGroup {
	/** Index of the opening bracket in the token list. */
	open: number;
	/** Commas directly inside the group, including the trailing one. */
	commas: number;
}

/**
 * Indices of trailing commas (directly before a closing bracket) that `allow` declares
 * meaningless. Unbalanced brackets make every comma count, and so does a comma that follows the
 * opening bracket or another comma, comments aside: in JavaScript, `[a,,]` has two elements and
 * `[a,]` one, `[,]` has one and `[]` none.
 *
 * @param allow decides per group; `enclosing` lists the opening brackets around it, outermost first
 */
export function ignorableTrailingCommas(
	tokens: readonly Token[],
	allow: (group: BracketGroup, enclosing: readonly number[]) => boolean,
): Set<number> {
	const result = new Set<number>();
	const stack: BracketGroup[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const { kind, text } = tokens[i];
		if (kind !== 'punct') {
			continue;
		}
		if (text === '(' || text === '[' || text === '{') {
			stack.push({ open: i, commas: 0 });
		} else if (text === ',') {
			if (stack.length > 0) {
				stack[stack.length - 1].commas++;
			}
		} else if (OPENING.has(text)) {
			const group = stack.pop();
			if (group === undefined || tokens[group.open].text !== OPENING.get(text)) {
				return new Set();
			}
			const isComma = (token: Token) => token.kind === 'punct' && token.text === ',';
			let before = i - 2;
			while (before > group.open && tokens[before].kind === 'comment') {
				before--;
			}
			if (isComma(tokens[i - 1]) && before > group.open && !isComma(tokens[before]) && allow(group, stack.map(g => g.open))) {
				result.add(i - 1);
			}
		}
	}
	return stack.length === 0 ? result : new Set();
}
