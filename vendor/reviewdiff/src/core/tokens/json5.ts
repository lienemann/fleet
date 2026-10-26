import { ignorableTrailingCommas, Lexer, LexError, type LexedText, type Token, type TokenKind } from './lexer';

/** A number with its sign, which JSON5 allows no space after: `-1`, `+.5`, `-0x1F`, `-Infinity`. */
const SIGNED_NUMBER = /[+-](?:[eE][+-]|[\p{ID_Continue}.])+/uy;
/** Line terminators that JSON5 knows besides the line break. They end a line comment, which the lexer does not handle. */
const OTHER_LINE_TERMINATORS = /[\u2028\u2029]/;

/**
 * JSON5: comments, strings in single or double quotes that may continue on the next line after a
 * backslash, unquoted keys, signed numbers, `Infinity` and `NaN`.
 */
class Json5Lexer extends Lexer {
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
		if (c === '"' || c === "'") {
			this.pos = this.quotedEnd(c);
			return 'string';
		}
		return this.matchAt(SIGNED_NUMBER) === undefined ? undefined : 'number';
	}

	/** JSON5 has no operators of several characters, so `:-1` is `:` and `-1`. */
	protected override continuesOperator(): boolean {
		return false;
	}

	protected override afterToken(token: Token): void {
		if (token.kind === 'string') {
			// Escapes mean the same between either quotes, so the same characters are the same string.
			token.key = `quoted:${token.text.slice(1, -1)}`;
		} else if (token.kind === 'comment' && OTHER_LINE_TERMINATORS.test(token.text)) {
			throw new LexError('line terminator in a comment');
		}
	}

	/** The end of the string starting at `pos`; a backslash before a line break continues it. */
	private quotedEnd(quote: string): number {
		for (let p = this.pos + 1; ; ) {
			const c = this.src[p];
			if (c === undefined || c === '\n') {
				throw new LexError('unterminated string');
			}
			if (c === quote) {
				return p + 1;
			}
			p += c === '\\' ? 2 : 1;
		}
	}
}

/**
 * Lexes JSON5. Trailing commas are dropped, as JSON5 allows them after the last element or
 * member and they change nothing (`[,]` and `[a,,]` are invalid and keep theirs). Throws
 * `LexError` if lexing is not reliably possible.
 */
export function lexJson5(text: string): LexedText {
	const { tokens, lineStates } = new Json5Lexer(text).lex();
	const ignorable = ignorableTrailingCommas(tokens, () => true);
	return { tokens: tokens.filter((_, i) => !ignorable.has(i)), lineStates };
}
