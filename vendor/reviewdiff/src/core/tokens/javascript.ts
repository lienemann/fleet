import { ignorableTrailingCommas, Lexer, LexError, type LexedText, type Token, type TokenKind } from './lexer';

/** Keywords after which `/` starts a regular expression rather than a division. */
const REGEX_AFTER = new Set([
	'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'default', 'do', 'else',
	'yield', 'await',
]);
/** Keywords whose parenthesised condition may be followed by a regular expression: `if (x) /re/.test(y)`. */
const CONDITION_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
/**
 * Words that a line break may not follow without changing the meaning: the restricted productions
 * (`return⏎x` returns nothing) and TypeScript modifiers and declarations that must be followed on
 * the same line (`declare⏎const x` is an expression `declare` and a declaration).
 */
const BREAK_AFTER = new Set([
	'return', 'throw', 'break', 'continue', 'yield', 'async', 'await', 'using',
	'abstract', 'accessor', 'declare', 'enum', 'get', 'global', 'interface', 'module', 'namespace', 'override',
	'private', 'protected', 'public', 'readonly', 'set', 'static', 'type',
]);
/** Tokens that a line break may not precede: postfix `++`/`--`, arrows, and TypeScript's `as` and `satisfies`. */
const BREAK_BEFORE = new Set(['++', '--', '=>', 'as', 'satisfies']);

/**
 * JavaScript and TypeScript. Template literals are split like a JavaScript lexer does: the
 * literal parts are strings compared exactly, the `${…}` substitutions are code. Whether `/`
 * starts a regular expression depends on the token before it.
 */
class JavaScriptLexer extends Lexer {
	/** For each open `{`: whether it is a template substitution `${`. */
	private readonly braces: boolean[] = [];
	/** For each open `(`: whether it follows `if`, `while`, `for` or `with`. */
	private readonly parens: boolean[] = [];
	/** Whether the last closed `(` followed one of those keywords. */
	private closedCondition = false;
	/** The tokens before the current one, without comments. */
	private previous: Token | undefined;
	private beforePrevious: Token | undefined;

	/** @param jsx the file may contain JSX, which is not supported */
	constructor(src: string, private readonly jsx: boolean) {
		super(src, {
			lineComment: '//',
			blockComment: { open: '/*', close: '*/', nested: false },
			stringPrefixes: new Set(),
			multilineStrings: false,
			lineSplices: false,
		});
	}

	protected override state(): string {
		return `${this.braces.map(template => (template ? '$' : '{')).join('')}${this.regexAllowed() ? '/' : ''}`;
	}

	protected override scanSpecial(): TokenKind | undefined {
		const c = this.src[this.pos];
		if (this.pos === 0 && this.src.startsWith('#!')) {
			const end = this.src.indexOf('\n');
			this.pos = end < 0 ? this.src.length : end;
			return 'comment';
		}
		if (c === '"' || c === "'") {
			this.pos = this.quotedEnd(c);
			return 'string';
		}
		if (c === '`' || (c === '}' && this.braces[this.braces.length - 1] === true)) {
			if (c === '}') {
				this.braces.pop();
			}
			this.scanTemplatePart();
			return 'string';
		}
		if (c === '#' && this.isIdentifierStart(this.pos + 1)) {
			// A private name, `#field`.
			this.pos++;
			this.scanSuffix();
			return 'word';
		}
		if (c === '/' && this.regexAllowed()) {
			this.pos = this.regexEnd();
			this.scanSuffix(); // flags
			return 'string';
		}
		if (c === '<' && this.jsx && this.regexAllowed() && (this.isIdentifierStart(this.pos + 1) || this.src[this.pos + 1] === '>')) {
			throw new LexError('JSX');
		}
		return undefined;
	}

	/** `=/re/`, `.#x` and `=<div>` are two tokens each; no JavaScript operator has `/` or `#` after its first character. */
	protected override continuesOperator(p: number): boolean {
		const c = this.src[p];
		return c !== '/' && c !== '#' && !(c === '<' && this.src[p - 1] !== '<');
	}

	protected override afterToken(token: Token): void {
		if (token.kind === 'comment') {
			return;
		}
		if (token.kind === 'punct') {
			switch (token.text) {
				case '{': this.braces.push(false); break;
				case '}': this.braces.pop(); break;
				case '(': this.parens.push(this.opensCondition()); break;
				case ')': this.closedCondition = this.parens.pop() ?? false; break;
			}
		} else if (token.kind === 'string' && (token.text.startsWith('"') || token.text.startsWith("'"))) {
			// The same characters between either quotes are the same string.
			token.key = `quoted:${token.text.slice(1, -1)}`;
		}
		this.beforePrevious = this.previous;
		this.previous = token;
	}

	protected override endOfText(): void {
		if (this.braces.length > 0 || this.parens.length > 0) {
			throw new LexError('unbalanced brackets');
		}
	}

	/** Whether an operand may start here, so `/` starts a regular expression. */
	private regexAllowed(): boolean {
		const previous = this.previous;
		if (previous === undefined) {
			return true;
		}
		switch (previous.kind) {
			case 'word':
				return REGEX_AFTER.has(previous.text) && !this.previousIsProperty();
			case 'number':
				return false;
			case 'string':
				// After a template part that opens a substitution.
				return previous.text.endsWith('${');
			default:
				switch (previous.text) {
					case ')': return this.closedCondition;
					case ']': case '++': case '--': return false;
					default: return true;
				}
		}
	}

	/** Whether a `(` here opens the condition of `if`, `while`, `for` (also `for await`) or `with`. */
	private opensCondition(): boolean {
		const { previous, beforePrevious } = this;
		if (previous?.kind !== 'word' || this.previousIsProperty()) {
			return false;
		}
		return CONDITION_KEYWORDS.has(previous.text) || (previous.text === 'await' && beforePrevious?.text === 'for');
	}

	/** The previous token is a property name, like `return` in `x.return` or `if` in `x?.if`. */
	private previousIsProperty(): boolean {
		return this.beforePrevious?.kind === 'punct' && this.beforePrevious.text.endsWith('.');
	}

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

	/** Scans a template part from its opening `` ` `` or `}` to the closing `` ` `` or the next `${`. */
	private scanTemplatePart(): void {
		for (let p = this.pos + 1; ; ) {
			const c = this.src[p];
			if (c === undefined) {
				throw new LexError('unterminated template literal');
			}
			if (c === '`') {
				this.pos = p + 1;
				return;
			}
			if (c === '$' && this.src[p + 1] === '{') {
				this.pos = p + 2;
				this.braces.push(true);
				return;
			}
			p += c === '\\' ? 2 : 1;
		}
	}

	/** The end of the regular expression literal starting at `pos`, before its flags. */
	private regexEnd(): number {
		let inClass = false;
		for (let p = this.pos + 1; ; p++) {
			const c = this.src[p];
			if (c === undefined || c === '\n') {
				throw new LexError('unterminated regular expression');
			}
			if (c === '\\') {
				p++;
			} else if (c === '[') {
				inClass = true;
			} else if (c === ']') {
				inClass = false;
			} else if (c === '/' && !inClass) {
				return p + 1;
			}
		}
	}
}

/**
 * Lexes JavaScript or TypeScript. Trailing commas are dropped, as formatters add them when they
 * reflow a list and they change nothing (holes like `[a,,]` excepted). Line breaks are kept as
 * tokens where automatic semicolon insertion or TypeScript makes them significant, see
 * `BREAK_AFTER` and `BREAK_BEFORE`. Throws `LexError` if lexing is not reliably possible.
 *
 * @param jsx the file may contain JSX (plain `.js`); JSX makes the file unsupported
 */
export function lexJavaScript(text: string, jsx: boolean): LexedText {
	const { tokens, lineStates } = new JavaScriptLexer(text, jsx).lex();
	const ignorable = ignorableTrailingCommas(tokens, () => true);
	return { tokens: withSignificantLineBreaks(tokens.filter((_, i) => !ignorable.has(i))), lineStates };
}

/** Inserts a `newline` token after each token whose following line break changes the meaning. */
function withSignificantLineBreaks(tokens: readonly Token[]): Token[] {
	const result: Token[] = [];
	/** Index in `result` of the last token that is not a comment. */
	let last = -1;
	for (const token of tokens) {
		const previous = result[last];
		if (token.kind !== 'comment' && previous !== undefined) {
			const end = previous.line + (previous.text.match(/\n/g)?.length ?? 0);
			if (token.line > end && (BREAK_AFTER.has(previous.text) && previous.kind === 'word' || BREAK_BEFORE.has(token.text))) {
				result.splice(last + 1, 0, { kind: 'newline', text: '\n', start: previous.start + previous.text.length, line: end });
			}
		}
		result.push(token);
		if (token.kind !== 'comment') {
			last = result.length - 1;
		}
	}
	return result;
}
