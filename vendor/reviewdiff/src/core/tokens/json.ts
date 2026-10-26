import { Lexer, type LexedText, type TokenKind } from './lexer';

/** A number with its sign, which JSON allows no space after. */
const NEGATIVE_NUMBER = /-\d(?:[eE][+-]|[\p{ID_Continue}.])*/uy;

/** JSON and JSON with comments. Trailing commas are kept: they are invalid in JSON. */
class JsonLexer extends Lexer {
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
		return this.matchAt(NEGATIVE_NUMBER) === undefined ? undefined : 'number';
	}

	/** JSON has no operators of several characters, so `:-1` is `:` and `-1`. */
	protected override continuesOperator(): boolean {
		return false;
	}
}

/** Lexes JSON. Throws `LexError` if lexing is not reliably possible. */
export function lexJson(text: string): LexedText {
	return new JsonLexer(text).lex();
}
