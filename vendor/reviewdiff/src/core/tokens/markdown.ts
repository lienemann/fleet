import type { LexedText, Token, TokenKind } from './lexer';

/**
 * Lines that start a block other than a paragraph, or may interrupt one: headings, quotes, list
 * items, thematic breaks and setext underlines, HTML, tables, definition lists, and extensions
 * such as attribute lists (`{: .class}`) and admonitions (`!!! note`, `??? note`). Generous on
 * purpose: such lines are compared exactly. Fences and math blocks are `RAW_BLOCKS`.
 */
const BLOCK_START = /^\s*(?:[#>*+=_<|:{-]|\d+[.)]|!!!|\?\?\?)/;
/** Link reference definitions and footnotes start a block, but cannot interrupt a paragraph. */
const DEFINITION = /^\s*\[/;
/** A code span: its line endings are spaces. */
const CODE_SPAN = /^(`+)[^]*\1$/;
/** Fenced code, also indented inside list items. */
const FENCE = /^\s*(`{3,}|~{3,})/;
/** Blocks that may contain blank lines, with the line that ends them. */
const RAW_BLOCKS: ReadonlyArray<[RegExp, (match: RegExpExecArray) => RegExp]> = [
	[FENCE, ([, fence]) => new RegExp(String.raw`^\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\s*$`)],
	[/^\s*\$\$/, () => /\$\$\s*$/],
	[/^\s*<!--/, () => /-->/],
	[/^\s*<(pre|script|style|textarea)(?:\s|>|$)/i, ([, tag]) => new RegExp(`</${tag}>`, 'i')],
	[/^\s*<\?/, () => /\?>/],
	[/^\s*<!\[CDATA\[/, () => /\]\]>/],
];
/**
 * Inline constructs in which whitespace is content: code spans, HTML tags, image descriptions
 * (they become `alt` attributes) and link destinations with their titles.
 */
const INLINE_UNITS = /(`+)[^]*?(?<!`)\1(?!`)|<[A-Za-z/!?][^>]*>|!\[[^\]]*\](?:\((?:[^()]|\([^()]*\))*\))?|\]\((?:[^()]|\([^()]*\))*\)/y;

/**
 * Markdown, where only paragraphs can be reflowed: their text is compared word by word, with the
 * indentation of the first line, paragraph breaks and hard line breaks kept. Every other line
 * (headings, lists, quotes, tables, code, HTML, front matter) is compared exactly, as are code
 * spans, inline HTML and link destinations inside paragraphs.
 */
export function lexMarkdown(text: string): LexedText {
	return new MarkdownLexer(text.split('\n')).lex();
}

class MarkdownLexer {
	private readonly tokens: Token[] = [];
	private readonly lineStates: Array<string | undefined> = [];
	/** Offsets of the line starts. */
	private readonly starts: number[] = [];
	/**
	 * `''` at the start or after a raw block, `p` in a paragraph, `pb` in blank lines after one, `x`
	 * in another block (compared line by line until the next blank line), `xb` in blank lines after
	 * such a block, or a raw block (`raw:` and its end) that may contain blank lines.
	 */
	private mode = '';
	private end: RegExp | undefined;
	/** Index of the first line of the paragraph being collected. */
	private paragraph = -1;

	constructor(private readonly lines: readonly string[]) {
		let offset = 0;
		for (const line of lines) {
			this.starts.push(offset);
			offset += line.length + 1;
		}
	}

	lex(): LexedText {
		this.lineStates[1] = this.mode;
		// Front matter (YAML or TOML), which may contain blank lines.
		const front = /^(?:---|\+\+\+)\s*$/.test(this.lines[0]);
		if (front) {
			this.enterRaw(0, this.lines[0].startsWith('-') ? /^(?:---|\.\.\.)\s*$/ : /^\+\+\+\s*$/);
		}
		for (let i = front ? 1 : 0; i < this.lines.length; i++) {
			// A blank line ends a paragraph whether or not blank lines precede it, so its state is
			// the same either way: blank lines added or removed between paragraphs change nothing.
			const blank = this.lines[i].trim() === '';
			this.lineStates[i + 1] = blank && this.mode === 'p' && !this.end ? 'pb' : this.mode;
			this.line(i);
		}
		this.flushParagraph(this.lines.length);
		this.lineStates[this.lines.length + 1] = this.mode;
		return { tokens: this.tokens, lineStates: this.lineStates };
	}

	private line(i: number): void {
		const line = this.lines[i];
		if (this.end) {
			this.exact(i);
			if (this.end.test(line)) {
				this.end = undefined;
				this.mode = 'x';
			}
			return;
		}
		if (line.trim() === '') {
			this.flushParagraph(i);
			if (this.mode === 'p') {
				this.mode = 'pb';
			} else if (this.mode === 'x' || this.mode === 'xb') {
				// Blank lines in and after other blocks count one by one, with their whitespace: they
				// may belong to indented code, or make a list loose.
				this.exact(i);
				this.mode = 'xb';
			}
			return;
		}
		if (this.mode === 'pb') {
			// One paragraph break, however many blank lines, at the start of the next block.
			this.push('newline', i, '', 'paragraph break');
			this.mode = '';
		}
		for (const [start, end] of RAW_BLOCKS) {
			const match = start.exec(line);
			if (match) {
				this.flushParagraph(i);
				this.enterRaw(i, end(match));
				return;
			}
		}
		const blockStart = this.mode === '' || this.mode === 'xb';
		const indentedCode = blockStart && /^(?: {4}|\s*\t)/.test(line);
		if (this.mode === 'x' || indentedCode || BLOCK_START.test(line) || line.includes('|') || (blockStart && DEFINITION.test(line))) {
			this.flushParagraph(i);
			this.exact(i);
			this.mode = 'x';
			return;
		}
		if (blockStart) {
			this.paragraph = i;
			this.mode = 'p';
		}
	}

	/** Starts a block that may contain blank lines and ends at a line matching `end` (inclusive). */
	private enterRaw(i: number, end: RegExp): void {
		this.exact(i);
		this.mode = `raw:${end.source}`;
		// A one-line block, e.g. `<!-- note -->`.
		const rest = this.lines[i].replace(/^\s*(?:<!--|\$\$|<\?|<!\[CDATA\[)/, '');
		if (this.lines[i] === rest || !end.test(rest)) {
			this.end = end;
		} else {
			this.mode = 'x';
		}
	}

	private exact(i: number): void {
		this.push('string', i, this.lines[i]);
	}

	/** Lexes the paragraph collected so far, which ends before line `end`. */
	private flushParagraph(end: number): void {
		if (this.paragraph < 0) {
			return;
		}
		const first = this.paragraph;
		this.paragraph = -1;
		this.push('indent', first, /^\s*/.exec(this.lines[first])![0]);
		// Every line ends with a line break, the last one too: if the paragraph actually continues on
		// a line taken for another block, a hard break at its end still matters.
		const text = `${this.lines.slice(first, end).join('\n')}\n`;
		const base = this.starts[first];
		for (let p = 0; p < text.length; ) {
			const c = text[p];
			if (c === '\n') {
				const line = this.lineAt(base + p);
				// Two spaces or a backslash at the end of a line break it (`\\` is an escaped backslash).
				if (/(?: {2}|(?<!\\)(?:\\\\)*\\)$/.test(this.lines[line])) {
					this.push('newline', line, '', 'hard break');
				}
				p++;
			} else if (/\s/.test(c)) {
				p++;
			} else {
				const start = p;
				const { end, key } = this.word(text, p);
				p = end;
				const token = this.pushAt('word', base + start, text.slice(start, end));
				if (token.text.includes('\n')) {
					token.key = key;
					// The lines that start inside the word (1-based: the line after its first to its last).
					for (let line = token.line + 1; line <= this.lineAt(base + p - 1) + 1; line++) {
						this.lineStates[line] = undefined;
					}
				}
			}
		}
	}

	/**
	 * The word starting at `p`, up to whitespace outside code spans, tags, image descriptions and
	 * link destinations, with its comparison key: the text, except that line endings in code spans
	 * are spaces (the indentation of the next line stays part of the code).
	 */
	private word(text: string, p: number): { end: number; key: string } {
		let key = '';
		while (p < text.length && !/\s/.test(text[p])) {
			INLINE_UNITS.lastIndex = p;
			const unit = INLINE_UNITS.exec(text)?.[0] ?? text[p];
			key += CODE_SPAN.test(unit) ? unit.replaceAll('\n', ' ') : unit;
			p += unit.length;
		}
		return { end: p, key };
	}

	private push(kind: TokenKind, line: number, text: string, key?: string): Token {
		const token = this.pushAt(kind, this.starts[line], text);
		token.key = key;
		return token;
	}

	private pushAt(kind: TokenKind, start: number, text: string): Token {
		const token: Token = { kind, text, start, line: this.lineAt(start) + 1 };
		this.tokens.push(token);
		return token;
	}

	/** 0-based index of the line containing `offset`. */
	private lineAt(offset: number): number {
		let low = 0;
		let high = this.starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >>> 1;
			if (this.starts[mid] <= offset) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		return low;
	}
}
