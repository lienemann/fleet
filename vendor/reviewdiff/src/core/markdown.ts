/**
 * Just enough Markdown (CommonMark plus GitLab's tables) to find the links of a document, the
 * block each link sits in and the headings around it, with the anchors VS Code's Markdown preview
 * gives the headings. Code blocks and HTML blocks are skipped like a renderer would.
 */

/** A block of text that can hold links. */
export type TextBlockKind = 'paragraph' | 'listItem' | 'tableRow' | 'quote';

export interface MarkdownHeading {
	type: 'heading';
	level: number;
	/** The heading's inline Markdown. */
	text: string;
	/** 1-based line where the heading starts; the first text line for setext headings. */
	line: number;
	/** 1-based last line of the heading; the underline for setext headings. */
	endLine: number;
}

export interface MarkdownTextBlock {
	type: TextBlockKind;
	/** The block's lines without list markers, quote markers and the indentation of continuation lines. */
	lines: string[];
	/** 1-based line where the block starts. */
	line: number;
}

export type MarkdownBlock = MarkdownHeading | MarkdownTextBlock;

/** Link reference definitions (`[label]: url`), by normalized label. */
export type LinkDefinitions = ReadonlyMap<string, string>;

/** A `<details>` element: collapsible text with a title. */
export interface MarkdownDetails {
	/** The `<summary>` as plain text; empty without one. */
	title: string;
	/** 1-based line of the opening tag. */
	line: number;
	/** 1-based line of the closing tag; the last line of the text if it is never closed. */
	endLine: number;
}

export interface ScannedMarkdown {
	blocks: MarkdownBlock[];
	definitions: LinkDefinitions;
	/** In order of their opening tags; nested elements are listed after the one around them. */
	details: MarkdownDetails[];
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))??(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const DEFINITION = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+.*)?$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
/** HTML blocks that may interrupt a paragraph and run until a blank line (CommonMark's type 6). */
const HTML_BLOCK_TAGS = new Set([
	'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd',
	'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu',
	'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search', 'section', 'summary', 'table', 'tbody',
	'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul',
]);
const DETAILS_TAG = /<(\/?)details(?:\s[^>]*)?>/gi;
const SUMMARY = /<summary(?:\s[^>]*)?>(.*?)<\/summary>/i;
const HTML_BLOCK_START = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s/>]|$)/;
/** A complete tag alone on its line (type 7): starts an HTML block, but not inside a paragraph. */
const HTML_TAG_LINE = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>[ \t]*$/;

/** Splits `text` into headings and text blocks, and collects its link reference definitions. */
export function scanMarkdown(text: string): ScannedMarkdown {
	const lines = text.split(/\r\n|\r|\n/);
	const blocks: MarkdownBlock[] = [];
	const definitions = new Map<string, string>();
	const details: MarkdownDetails[] = [];
	const openDetails: MarkdownDetails[] = [];
	let current: MarkdownTextBlock | undefined;
	let fence: { char: string; length: number } | undefined;
	let html: 'blank' | 'comment' | undefined;
	let inTable = false;
	let afterBlank = true;

	const close = () => {
		if (current) {
			blocks.push(current);
			current = undefined;
		}
		inTable = false;
	};
	const start = (type: TextBlockKind, content: string, line: number) => {
		close();
		current = { type, lines: [content], line };
	};
	const trackDetails = (line: string, lineNumber: number) => {
		for (const tag of line.matchAll(DETAILS_TAG)) {
			if (tag[1] === '') {
				const element = { title: '', line: lineNumber, endLine: lines.length };
				details.push(element);
				openDetails.push(element);
			} else if (openDetails.length > 0) {
				openDetails.pop()!.endLine = lineNumber;
			}
		}
		const summary = SUMMARY.exec(line);
		if (summary && openDetails.length > 0 && openDetails.at(-1)!.title === '') {
			openDetails.at(-1)!.title = plainText(summary[1]).trim();
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNumber = i + 1;
		if (fence) {
			const match = FENCE.exec(line);
			if (match && match[1][0] === fence.char && match[1].length >= fence.length && match[2].trim() === '') {
				fence = undefined;
			}
			continue;
		}
		if (html) {
			if (html === 'blank') {
				trackDetails(line, lineNumber);
			}
			if (html === 'comment' ? line.includes('-->') : line.trim() === '') {
				html = undefined;
				afterBlank = line.trim() === '';
			}
			continue;
		}
		if (line.trim() === '') {
			close();
			afterBlank = true;
			continue;
		}
		const wasAfterBlank = afterBlank;
		afterBlank = false;

		const fenceMatch = FENCE.exec(line);
		if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
			close();
			fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
			continue;
		}
		const heading = ATX_HEADING.exec(line);
		if (heading) {
			close();
			blocks.push({ type: 'heading', level: heading[1].length, text: (heading[2] ?? '').trim(), line: lineNumber, endLine: lineNumber });
			continue;
		}
		const underline = SETEXT_UNDERLINE.exec(line);
		if (underline && current?.type === 'paragraph') {
			blocks.push({ type: 'heading', level: underline[1][0] === '=' ? 1 : 2, text: current.lines.join(' ').trim(), line: current.line, endLine: lineNumber });
			current = undefined;
			continue;
		}
		if (THEMATIC_BREAK.test(line)) {
			close();
			continue;
		}
		if (/^ {0,3}<!--/.test(line)) {
			close();
			html = line.includes('-->') ? undefined : 'comment';
			continue;
		}
		const htmlStart = HTML_BLOCK_START.exec(line);
		if (htmlStart && HTML_BLOCK_TAGS.has(htmlStart[1].toLowerCase()) || HTML_TAG_LINE.test(line) && current?.type !== 'paragraph') {
			close();
			html = 'blank';
			trackDetails(line, lineNumber);
			continue;
		}
		if (inTable) {
			current = { type: 'tableRow', lines: [line.trim()], line: lineNumber };
			blocks.push(current);
			current = undefined;
			continue;
		}
		if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_DELIMITER.test(lines[i + 1])) {
			close();
			blocks.push({ type: 'tableRow', lines: [line.trim()], line: lineNumber });
			inTable = true;
			i++; // the delimiter row
			continue;
		}
		const definition = current?.type === 'paragraph' ? undefined : DEFINITION.exec(line);
		if (definition) {
			close();
			const label = normalizeLabel(definition[1]);
			if (!definitions.has(label)) {
				definitions.set(label, definition[2]);
			}
			continue;
		}
		const item = LIST_ITEM.exec(line);
		if (item && !(item[2] === undefined && current?.type === 'paragraph')) {
			start('listItem', item[2] ?? '', lineNumber);
			continue;
		}
		const quote = QUOTE.exec(line);
		if (quote) {
			if (current?.type === 'quote') {
				current.lines.push(quote[1]);
			} else {
				start('quote', quote[1], lineNumber);
			}
			continue;
		}
		if (current) {
			current.lines.push(line.trim()); // continuation, also lazy continuation of a list item or quote
			continue;
		}
		const indent = indentation(line);
		if (indent >= 2 && wasAfterBlank && blocks.at(-1)?.type === 'listItem') {
			start('listItem', line.trim(), lineNumber); // a further paragraph of a list item
			continue;
		}
		if (indent >= 4 && wasAfterBlank) {
			continue; // indented code
		}
		start('paragraph', line.trim(), lineNumber);
	}
	close();
	return { blocks, definitions, details };
}

function indentation(line: string): number {
	let width = 0;
	for (const char of line) {
		if (char === ' ') {
			width++;
		} else if (char === '\t') {
			width += 4 - width % 4;
		} else {
			break;
		}
	}
	return width;
}

/** Labels match case-insensitively, with runs of whitespace collapsed. */
function normalizeLabel(label: string): string {
	return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface InlineLink {
	/** The destination as written, with escapes removed. */
	url: string;
	/** The link text as plain text. */
	text: string;
	/** Offset of the link in the inline text. */
	offset: number;
}

// Sticky, to match at a position without copying the rest of the text, which long paragraphs make slow.
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y;
const BARE_URL = /https?:\/\/[^\s<]+/y;
const HTML_TAG = /<\/?[A-Za-z][^>]*>/y;
const TRAILING_PUNCTUATION = /[?!.,:;*_~'"]+$/;

/** Matches the sticky `regex` at `index` of `text`. */
function matchAt(regex: RegExp, text: string, index: number): RegExpExecArray | null {
	regex.lastIndex = index;
	return regex.exec(text);
}

/**
 * The links of a piece of inline Markdown, in order: inline links, reference links, autolinks
 * and bare URLs (which GitLab and the preview turn into links). Images are not links, but a link
 * around an image is.
 */
export function inlineLinks(text: string, definitions: LinkDefinitions = new Map()): InlineLink[] {
	const links: InlineLink[] = [];
	let i = 0;
	while (i < text.length) {
		const char = text[i];
		if (char === '\\') {
			i += 2;
			continue;
		}
		if (char === '`') {
			i = skipCodeSpan(text, i);
			continue;
		}
		if (char === '<') {
			const autolink = matchAt(AUTOLINK, text, i);
			if (autolink) {
				links.push({ url: autolink[1], text: autolink[1], offset: i });
				i += autolink[0].length;
				continue;
			}
			const tag = matchAt(HTML_TAG, text, i);
			i += tag ? tag[0].length : 1;
			continue;
		}
		const isImage = char === '!' && text[i + 1] === '[';
		if (char === '[' || isImage) {
			const open = isImage ? i + 1 : i;
			const link = parseBracketLink(text, open, definitions);
			if (link) {
				if (!isImage) {
					links.push({ url: link.url, text: plainText(link.label), offset: i });
				}
				i = link.end;
				continue;
			}
			i = open + 1;
			continue;
		}
		if ((char === 'h' || char === 'H') && (i === 0 || /[\s(*_~]/.test(text[i - 1]))) {
			const bare = matchAt(BARE_URL, text, i);
			if (bare) {
				const url = trimBareUrl(bare[0]);
				links.push({ url, text: url, offset: i });
				i += url.length;
				continue;
			}
		}
		i++;
	}
	return links;
}

/** The index after the code span starting at `start`, or after its opening backticks if it isn't closed. */
function skipCodeSpan(text: string, start: number): number {
	let run = start;
	while (text[run] === '`') {
		run++;
	}
	const ticks = text.slice(start, run);
	for (let j = text.indexOf(ticks, run); j >= 0; j = text.indexOf(ticks, j + ticks.length)) {
		const end = j + ticks.length;
		if (text[j - 1] !== '`' && text[end] !== '`') {
			return end;
		}
		while (text[j] === '`') {
			j++;
		}
		j -= ticks.length;
	}
	return run;
}

/** The index of the `]` matching the `[` at `open`, skipping escapes and code spans. */
function closingBracket(text: string, open: number): number | undefined {
	let depth = 0;
	for (let i = open; i < text.length;) {
		const char = text[i];
		if (char === '\\') {
			i += 2;
		} else if (char === '`') {
			i = skipCodeSpan(text, i);
		} else {
			if (char === '[') {
				depth++;
			} else if (char === ']' && --depth === 0) {
				return i;
			}
			i++;
		}
	}
	return undefined;
}

function parseBracketLink(text: string, open: number, definitions: LinkDefinitions): { label: string; url: string; end: number } | undefined {
	const close = closingBracket(text, open);
	if (close === undefined) {
		return undefined;
	}
	const label = text.slice(open + 1, close);
	if (text[close + 1] === '(') {
		const destination = parseDestination(text, close + 2);
		if (destination) {
			return { label, url: destination.url, end: destination.end };
		}
	}
	if (text[close + 1] === '[') {
		const refClose = closingBracket(text, close + 1);
		if (refClose !== undefined) {
			const ref = text.slice(close + 2, refClose);
			const url = definitions.get(normalizeLabel(ref === '' ? label : ref));
			return url === undefined ? undefined : { label, url: unescape(url), end: refClose + 1 };
		}
	}
	const url = definitions.get(normalizeLabel(label));
	return url === undefined ? undefined : { label, url: unescape(url), end: close + 1 };
}

/** Parses `dest "title")` from `start`, just after the opening parenthesis. */
function parseDestination(text: string, start: number): { url: string; end: number } | undefined {
	let i = start;
	while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') {
		i++;
	}
	let url = '';
	if (text[i] === '<') {
		const end = text.indexOf('>', i);
		if (end < 0 || text.slice(i, end).includes('\n')) {
			return undefined;
		}
		url = text.slice(i + 1, end);
		i = end + 1;
	} else {
		let depth = 0;
		const from = i;
		for (; i < text.length; i++) {
			const char = text[i];
			if (char === '\\') {
				i++;
			} else if (char === '(') {
				depth++;
			} else if (char === ')') {
				if (depth === 0) {
					break;
				}
				depth--;
			} else if (/\s/.test(char)) {
				break;
			}
		}
		url = text.slice(from, i);
	}
	while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') {
		i++;
	}
	const quote = text[i];
	if (quote === '"' || quote === '\'' || quote === '(') {
		const closing = quote === '(' ? ')' : quote;
		const end = text.indexOf(closing, i + 1);
		if (end < 0) {
			return undefined;
		}
		i = end + 1;
		while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') {
			i++;
		}
	}
	return text[i] === ')' ? { url: unescape(url), end: i + 1 } : undefined;
}

function trimBareUrl(url: string): string {
	let trimmed = url.replace(TRAILING_PUNCTUATION, '');
	// A closing parenthesis belongs to the URL only if it closes one inside it.
	while (trimmed.endsWith(')') && count(trimmed, ')') > count(trimmed, '(')) {
		trimmed = trimmed.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
	}
	return trimmed;
}

function count(text: string, char: string): number {
	return text.split(char).length - 1;
}

function unescape(text: string): string {
	return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * Inline Markdown as the text a reader sees: code spans keep their content, links and images
 * their text, HTML tags and emphasis markers go.
 */
export function plainText(markdown: string): string {
	let result = '';
	for (let i = 0; i < markdown.length;) {
		const char = markdown[i];
		if (char === '\\' && i + 1 < markdown.length) {
			result += markdown[i + 1];
			i += 2;
		} else if (char === '`') {
			const end = skipCodeSpan(markdown, i);
			const span = markdown.slice(i, end);
			const ticks = /^`+/.exec(span)![0].length;
			result += end - i > 2 * ticks ? span.slice(ticks, span.length - ticks).replace(/^ (.*) $/s, '$1') : span;
			i = end;
		} else if (char === '<') {
			const tag = matchAt(HTML_TAG, markdown, i);
			if (tag) {
				i += tag[0].length;
			} else {
				result += char;
				i++;
			}
		} else if (char === '[' || char === '!' && markdown[i + 1] === '[') {
			const open = char === '!' ? i + 1 : i;
			const close = closingBracket(markdown, open);
			const destination = close !== undefined && markdown[close + 1] === '(' ? parseDestination(markdown, close + 2) : undefined;
			if (close !== undefined && destination) {
				result += plainText(markdown.slice(open + 1, close));
				i = destination.end;
			} else {
				result += char;
				i++;
			}
		} else if (char === '*' || char === '~' || char === '_' && isEmphasisUnderscore(markdown, i)) {
			i++;
		} else {
			result += char;
			i++;
		}
	}
	return result.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

/** An underscore next to a word character on only one side delimits emphasis; inside `snake_case` it doesn't. */
function isEmphasisUnderscore(text: string, i: number): boolean {
	const word = /[\p{L}\p{N}]/u;
	return !(word.test(text[i - 1] ?? '') && word.test(text[i + 1] ?? ''));
}

/**
 * Gives headings the anchors VS Code's Markdown preview gives them (GitHub's rules): the heading's
 * text in lower case, without punctuation, with spaces as hyphens; repeated anchors get `-1`, `-2`, …
 */
export class HeadingSlugger {
	private readonly seen = new Map<string, number>();

	/** The anchor of the next heading with inline Markdown `heading`. */
	add(heading: string): string {
		const slug = slugify(plainText(heading));
		const count = this.seen.get(slug);
		if (count === undefined) {
			this.seen.set(slug, 0);
			return slug;
		}
		this.seen.set(slug, count + 1);
		return slugify(`${slug}-${count + 1}`);
	}
}

function slugify(text: string): string {
	return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/\s/g, '-');
}

/** The cells of a table row, without the outer pipes; pipes in code spans and escaped pipes don't split. */
export function tableCells(row: string): string[] {
	const cells: string[] = [];
	let cell = '';
	for (let i = 0; i < row.length;) {
		const char = row[i];
		if (char === '\\' && row[i + 1] === '|') {
			cell += '|';
			i += 2;
		} else if (char === '`') {
			const end = skipCodeSpan(row, i);
			cell += row.slice(i, end);
			i = end;
		} else if (char === '|') {
			cells.push(cell);
			cell = '';
			i++;
		} else {
			cell += char;
			i++;
		}
	}
	cells.push(cell);
	const trimmed = cells.map(c => c.trim());
	if (trimmed[0] === '' && row.trimStart().startsWith('|')) {
		trimmed.shift();
	}
	if (trimmed.at(-1) === '' && row.trimEnd().endsWith('|')) {
		trimmed.pop();
	}
	return trimmed;
}
