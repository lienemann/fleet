import { Lexer, LexError, type LexedText, type Token, type TokenKind } from './lexer';

/** `R"delim(` with an optional encoding prefix; the literal ends at `)delim"`. */
const RAW_STRING = /(?:u8|[uUL])?R"([^ ()\\\t\v\f\n]{0,16})\(/y;
const INCLUDES = new Set(['include', 'include_next', 'import']);
const HAS_INCLUDE = new Set(['__has_include', '__has_include_next']);

/**
 * C and C++. Preprocessor directives end at the line break, so that break is a token: a directive
 * may be reflowed with backslash continuations, but not joined with the following line or split
 * without them.
 */
class CppLexer extends Lexer {
	/** Tokens of the directive being lexed, starting with `#`, without comments; undefined outside directives. */
	private directive: Token[] | undefined;
	/** No token on this logical line yet (a backslash continuation does not start a new one). */
	private atLineStart = true;
	/** The last two tokens other than comments. */
	private recent: Token[] = [];

	constructor(src: string) {
		super(src, {
			lineComment: '//',
			blockComment: { open: '/*', close: '*/', nested: false },
			stringPrefixes: new Set(['u8', 'u', 'U', 'L']),
			multilineStrings: false,
			apostropheDigitSeparators: true,
			lineSplices: true,
			continuedLineComments: true,
		});
	}

	protected override state(): string {
		return `${this.directive ? '#' : ''}${this.atLineStart ? '' : '\\'}`;
	}

	protected override scanSpecial(): TokenKind | undefined {
		RAW_STRING.lastIndex = this.pos;
		const raw = RAW_STRING.exec(this.src);
		if (raw) {
			const close = `)${raw[1]}"`;
			const end = this.src.indexOf(close, this.pos + raw[0].length);
			if (end < 0) {
				throw new LexError('unterminated raw string');
			}
			this.pos = end + close.length;
			this.scanSuffix();
			return 'string';
		}
		if (this.src[this.pos] === '<' && this.expectsHeaderName()) {
			const end = this.src.indexOf('>', this.pos);
			const lineEnd = this.src.indexOf('\n', this.pos);
			if (end >= 0 && (lineEnd < 0 || end < lineEnd)) {
				this.pos = end + 1;
				return 'string';
			}
		}
		return undefined;
	}

	protected override lineBreak(): void {
		this.endDirective(this.pos + 1);
		this.atLineStart = true;
	}

	protected override endOfText(): void {
		this.endDirective(this.pos);
		this.atLineStart = true;
	}

	protected override afterToken(token: Token): void {
		if (token.kind === 'comment' || token.kind === 'newline') {
			return;
		}
		this.recent = [this.recent[this.recent.length - 1], token];
		if (this.atLineStart && token.kind === 'punct' && (token.text.startsWith('#') || token.text.startsWith('%:'))) {
			this.directive = [];
		}
		this.atLineStart = false;
		const directive = this.directive;
		directive?.push(token);
		// `#define F(x)` is a function-like macro, `#define F (x)` an object-like one expanding to `(x)`.
		if (directive?.length === 4 && directive[1].text === 'define' && token.text === '(') {
			const name = directive[2];
			if (token.start === name.start + name.text.length) {
				token.key = 'macro-parameters';
			}
		}
	}

	private endDirective(end: number): void {
		if (this.directive) {
			this.push('newline', this.pos, end);
			this.directive = undefined;
		}
	}

	/** After `#include` and in `__has_include(`, `<…>` is a header name, in which spaces matter. */
	private expectsHeaderName(): boolean {
		if (this.directive?.length === 2 && INCLUDES.has(this.directive[1].text)) {
			return true;
		}
		const [callee, paren] = this.recent;
		return callee !== undefined && HAS_INCLUDE.has(callee.text) && paren.text === '(';
	}
}

/** Lexes C or C++ source. Throws `LexError` if that is not reliably possible. */
export function lexCpp(text: string): LexedText {
	return new CppLexer(text).lex();
}
