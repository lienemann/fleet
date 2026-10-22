import { ignorableTrailingCommas, Lexer, LexError, type LexedText, type Token, type TokenKind } from './lexer';

/**
 * Java identifiers (`Character.isJavaIdentifierStart`/`Part`), generously: currency symbols and
 * connector punctuation like `€` and `‿` belong to them, and so do ignorable control characters.
 */
const IDENTIFIER = /[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{ID_Continue}\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}\p{Cf}\0-\x08\x0e-\x1b\x7f-\x9f]*/uy;
/** `non-sealed` is one keyword; `non - sealed` is not. */
const NON_SEALED = /non-sealed(?![\p{ID_Continue}\p{Sc}])/uy;
/** A text block's opening delimiter: three quotes, then only blanks up to the line break. */
const TEXT_BLOCK_OPEN = /"""[ \t\f]*\n/y;
/** A Unicode escape, `\uXXXX` with any number of `u`s; it counts only after an even number of backslashes. */
const UNICODE_ESCAPE = /(\\+)u+([\da-fA-F]{4})/g;
/** Characters that may end a literal or start an escape in it when written as a Unicode escape. */
const SIGNIFICANT_IN_LITERALS = new Set(['"', "'", '\\', '\n', '\r']);
/** Characters that may end a comment when written as a Unicode escape. */
const SIGNIFICANT_IN_COMMENTS = new Set(['\n', '\r', '*', '/']);

/**
 * Java. Text blocks are strings compared exactly, incidental indentation included, and so are
 * Javadoc and Markdown doc comments (`/**`, `///`): they are rendered, and whitespace in `<pre>`
 * and in Markdown code blocks counts. Java translates Unicode escapes before lexing; outside
 * literals and comments, or where they would end one, the lexer gives up on them.
 */
class JavaLexer extends Lexer {
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
		if (this.pos === 0 && this.src.startsWith('#!')) {
			// The command line of a source-file program, compared as written.
			const end = this.src.indexOf('\n');
			this.pos = end < 0 ? this.src.length : end;
			return 'comment';
		}
		if (c === '"') {
			if (this.matchAt(TEXT_BLOCK_OPEN) !== undefined) {
				this.pos = this.literalEnd('"""', true);
			} else {
				this.pos = this.literalEnd('"', false);
			}
			return 'string';
		}
		if (c === "'") {
			this.pos = this.literalEnd("'", false);
			return 'string';
		}
		if (this.matchAt(NON_SEALED) !== undefined || this.matchAt(IDENTIFIER) !== undefined) {
			return 'word';
		}
		return undefined;
	}

	/** Javadoc (`/**`, not `/**\/`) and Markdown doc comments (`///`) are content. */
	protected override commentKind(text: string): TokenKind {
		return /^\/\*\*(?!\/)|^\/\/\//.test(text) ? 'doc' : 'comment';
	}

	/**
	 * Java translates Unicode escapes before lexing, so `"""` is not a string with a quote in
	 * it. Escapes that could change where a token ends make the lexer give up.
	 */
	protected override afterToken({ kind, text }: Token): void {
		const significant = kind === 'string' ? SIGNIFICANT_IN_LITERALS
			: kind === 'comment' || kind === 'doc' ? SIGNIFICANT_IN_COMMENTS
				: undefined;
		if (significant === undefined) {
			// A backslash outside literals and comments can only start a Unicode escape.
			if (text.includes('\\')) {
				throw new LexError('Unicode escape outside literals and comments');
			}
			return;
		}
		for (const [, backslashes, hex] of text.matchAll(UNICODE_ESCAPE)) {
			if (backslashes.length % 2 === 1 && significant.has(String.fromCharCode(parseInt(hex, 16)))) {
				throw new LexError('Unicode escape that may end a literal or comment');
			}
		}
	}

	/** The end of the literal whose content starts at `pos`, after its closing `close`. */
	private literalEnd(close: string, multiline: boolean): number {
		for (let p = multiline ? this.pos : this.pos + 1; ; ) {
			const c = this.src[p];
			if (c === undefined || (c === '\n' && !multiline)) {
				throw new LexError('unterminated literal');
			}
			if (this.src.startsWith(close, p)) {
				return p + close.length;
			}
			p += c === '\\' ? 2 : 1;
		}
	}
}

/**
 * Lexes Java source. A trailing comma is dropped in array initialisers, annotation arrays and
 * enum constants, where Java allows one and it changes nothing (`{,}` keeps it). Throws
 * `LexError` if lexing is not reliably possible.
 */
export function lexJava(text: string): LexedText {
	const { tokens, lineStates } = new JavaLexer(text).lex();
	const lists = commaLists(tokens);
	const ignorable = ignorableTrailingCommas(tokens, ({ open }) => lists.has(open));
	return { tokens: tokens.filter((_, i) => !ignorable.has(i)), lineStates };
}

/** Tokens after which `{` opens an array initialiser (`= {`, `new int[] {`, `{{1}, {2}}`) or an annotation array (`@A({…})`). */
const BEFORE_INITIALISER = new Set(['=', ']', ',', '(']);

/**
 * The opening braces of array initialisers, annotation arrays and enum bodies: the groups that
 * may end in a trailing comma. Blocks and class bodies may not, so a group with a `;` directly
 * inside never counts.
 */
function commaLists(tokens: readonly Token[]): Set<number> {
	const lists = new Set<number>();
	const stack: Array<{ open: number; list: boolean }> = [];
	let previous: Token | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.kind === 'comment' || token.kind === 'doc') {
			continue;
		}
		if (token.kind === 'punct') {
			const enclosing = stack[stack.length - 1];
			if (token.text === '{') {
				const initialiser = previous?.kind === 'punct'
					&& (BEFORE_INITIALISER.has(previous.text) || (previous.text === '{' && enclosing?.list === true));
				stack.push({ open: i, list: initialiser || isEnumBody(tokens, i) });
			} else if (token.text === '}') {
				const group = stack.pop();
				if (group?.list) {
					lists.add(group.open);
				}
			} else if (token.text === ';' && enclosing) {
				enclosing.list = false;
			}
		}
		previous = token;
	}
	return lists;
}

/** Whether the `{` at `open` follows `enum Name …` in the same declaration. */
function isEnumBody(tokens: readonly Token[], open: number): boolean {
	for (let i = open - 1; i >= 0; i--) {
		const { kind, text } = tokens[i];
		if (kind === 'punct' && (text === ';' || text === '{' || text === '}')) {
			return false;
		}
		if (kind === 'word' && text === 'enum') {
			return true;
		}
	}
	return false;
}
