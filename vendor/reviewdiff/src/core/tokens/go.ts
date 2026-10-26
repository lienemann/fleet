import { ignorableTrailingCommas, Lexer, LexError, type LexedText, type Token, type TokenKind } from './lexer';

const KEYWORDS = new Set([
	'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto',
	'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
]);
/** Keywords after which a line break ends the statement. */
const ENDING_KEYWORDS = new Set(['break', 'continue', 'fallthrough', 'return']);
const ENDING_PUNCTUATION = new Set([')', ']', '}', '++', '--']);

/**
 * Go. A line break after a name, a literal, `break`, `continue`, `fallthrough`, `return`, `++`,
 * `--` or a closing bracket ends the statement (Go inserts a semicolon there), so it is a token;
 * other line breaks are free.
 */
class GoLexer extends Lexer {
	/** The last token other than a comment since the last line break, if it may end a statement. */
	private ending: Token | undefined;

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
		if (this.src[this.pos] !== '`') {
			return undefined;
		}
		// A raw string: no escapes, may span lines.
		const end = this.src.indexOf('`', this.pos + 1);
		if (end < 0) {
			throw new LexError('unterminated raw string');
		}
		this.pos = end + 1;
		return 'string';
	}

	protected override afterToken(token: Token): void {
		if (token.kind === 'newline') {
			return;
		}
		if (token.kind === 'comment') {
			// A block comment spanning lines acts like a line break.
			if (token.text.includes('\n')) {
				this.endLine(this.pos, this.pos);
			}
			return;
		}
		this.ending = endsStatement(token) ? token : undefined;
	}

	protected override lineBreak(): void {
		this.endLine(this.pos, this.pos + 1);
	}

	protected override endOfText(): void {
		this.endLine(this.pos, this.pos);
	}

	private endLine(start: number, end: number): void {
		if (this.ending) {
			this.ending = undefined;
			this.push('newline', start, end);
		}
	}
}

function endsStatement({ kind, text }: Token): boolean {
	switch (kind) {
		case 'word': return !KEYWORDS.has(text) || ENDING_KEYWORDS.has(text);
		case 'number': case 'string': return true;
		case 'punct': return ENDING_PUNCTUATION.has(text);
		default: return false;
	}
}

/**
 * Lexes Go source. Trailing commas are dropped: Go requires them before a closing bracket on its
 * own line, and they change nothing elsewhere. Throws `LexError` if lexing is not reliably possible.
 */
export function lexGo(text: string): LexedText {
	const { tokens, lineStates } = new GoLexer(text).lex();
	const ignorable = ignorableTrailingCommas(tokens, () => true);
	return { tokens: tokens.filter((_, i) => !ignorable.has(i)), lineStates };
}
