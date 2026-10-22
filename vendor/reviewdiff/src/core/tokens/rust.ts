import { ignorableTrailingCommas, Lexer, LexError, type LexedText, type Token, type TokenKind } from './lexer';

/** `r"…"`, `r#"…"#`, also as byte and C strings (`br`, `cr`). */
const RAW_STRING = /[bc]?r(#*)"/y;
/** `r#match`: a raw identifier. */
const RAW_IDENTIFIER = /r#[\p{ID_Start}_][\p{ID_Continue}]*/uy;
const LIFETIME = /'[\p{ID_Start}_][\p{ID_Continue}]*/uy;
/** `///` and `//!` (but not `////`), `/**` and `/*!` (but not `/***` or `/**\/`). */
const DOC_COMMENT = /^(?:\/\/(?:\/(?!\/)|!)|\/\*(?:\*(?![*/])|!))/;

/** Keywords that can precede a parenthesised expression or tuple, so `(` after them opens no argument list. */
const KEYWORDS = new Set([
	'as', 'async', 'await', 'box', 'break', 'const', 'continue', 'crate', 'do', 'dyn', 'else', 'enum', 'extern',
	'false', 'fn', 'for', 'gen', 'if', 'impl', 'in', 'let', 'loop', 'macro', 'match', 'mod', 'move', 'mut', 'pub',
	'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'try', 'type', 'unsafe', 'use', 'where',
	'while', 'yield',
]);

class RustLexer extends Lexer {
	constructor(src: string) {
		super(src, {
			lineComment: '//',
			blockComment: { open: '/*', close: '*/', nested: true },
			stringPrefixes: new Set(['b', 'c']),
			multilineStrings: true,
			lineSplices: false,
		});
	}

	protected override scanSpecial(): TokenKind | undefined {
		RAW_STRING.lastIndex = this.pos;
		const raw = RAW_STRING.exec(this.src);
		if (raw) {
			const close = `"${raw[1]}`;
			const end = this.src.indexOf(close, this.pos + raw[0].length);
			if (end < 0) {
				throw new LexError('unterminated raw string');
			}
			this.pos = end + close.length;
			this.scanSuffix();
			return 'string';
		}
		return this.matchAt(RAW_IDENTIFIER) === undefined ? undefined : 'word';
	}

	/** `'a'` and `'\n'` are characters, `'a` is a lifetime or label. */
	protected override scanApostrophe(): TokenKind {
		const next = this.src.codePointAt(this.pos + 1);
		const width = next !== undefined && next > 0xffff ? 2 : 1;
		if (this.src[this.pos + 1] === '\\' || this.src[this.pos + 1 + width] === "'") {
			return super.scanApostrophe();
		}
		if (this.isIdentifierStart(this.pos + 1)) {
			this.matchAt(LIFETIME);
			return 'word';
		}
		throw new LexError('unrecognised apostrophe');
	}

	/** Doc comments are attributes (`#[doc = "…"]`) whose text is rendered as Markdown: content, compared exactly. */
	protected override commentKind(text: string): TokenKind {
		return DOC_COMMENT.test(text) ? 'doc' : 'comment';
	}
}

/**
 * Standard macros that take comma-separated expressions or format arguments and accept a trailing
 * comma; inside them, commas follow the rules for ordinary code.
 */
const STANDARD_MACROS = new Set([
	'vec', 'format', 'format_args', 'print', 'println', 'eprint', 'eprintln', 'write', 'writeln', 'panic', 'todo',
	'unimplemented', 'unreachable', 'assert', 'assert_eq', 'assert_ne', 'debug_assert', 'debug_assert_eq',
	'debug_assert_ne', 'matches', 'dbg',
]);

/**
 * Lexes Rust source. A trailing comma before a closing bracket is dropped where it changes
 * nothing, as rustfmt adds and removes them when it reflows a list. It stays where it may matter:
 * `(x,)` is a tuple, `(x)` is not, and macros and attributes get their tokens as written (except
 * the standard macros above and `#[derive(…)]`).
 * Throws `LexError` if lexing is not reliably possible.
 */
export function lexRust(text: string): LexedText {
	const { tokens, lineStates } = new RustLexer(text).lex();
	const before = (open: number, n: number): Token | undefined => tokens[open - n];
	/** The name of the macro invoked as `name!(…)`, if the group opening at `open` is one. */
	const macroName = (open: number) =>
		isPunct(before(open, 1), '!') && before(open, 2)?.kind === 'word' ? before(open, 2)!.text : undefined;
	/** Groups whose tokens are passed on as written: macro inputs, `macro_rules!` bodies, attributes. */
	const isOpaque = (open: number) => {
		const macro = macroName(open);
		if (macro !== undefined) {
			return !STANDARD_MACROS.has(macro);
		}
		if (isPunct(before(open, 2), '!') && before(open, 3)?.text === 'macro_rules') {
			return true;
		}
		const attribute = isPunct(before(open, 1), '#') || isPunct(before(open, 1), '#!');
		return attribute && !(tokens[open + 1]?.text === 'derive' && isPunct(tokens[open + 2], '('));
	};
	const ignorable = ignorableTrailingCommas(tokens, ({ open, commas }, enclosing) => {
		if (isOpaque(open) || enclosing.some(isOpaque)) {
			return false;
		}
		if (tokens[open].text !== '(') {
			return true;
		}
		// `(a, b,)` is `(a, b)`, and `f(a,)` is `f(a)`, but `(a,)` is a one-element tuple.
		const callee = before(open, 1);
		return commas > 1
			|| macroName(open) !== undefined
			|| callee?.kind === 'word' && !KEYWORDS.has(callee.text) && !callee.text.startsWith("'");
	});
	return { tokens: tokens.filter((_, i) => !ignorable.has(i)), lineStates };
}

function isPunct(token: Token | undefined, text: string): boolean {
	return token?.kind === 'punct' && token.text === text;
}
