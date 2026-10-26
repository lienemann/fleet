/**
 * A walkthrough: the part of a merge request description (or of a Markdown file) that tours the
 * change, with headings for its stops and links into the code.
 */

import { HeadingSlugger, inlineLinks, plainText, scanMarkdown, tableCells, type MarkdownHeading, type TextBlockKind } from './markdown';

/** A heading of the walkthrough that starts a stop of the tour. */
export interface WalkthroughSection {
	/** The heading as plain text. */
	title: string;
	/** Titles of the enclosing sections and this one, outermost first. */
	path: readonly string[];
	level: number;
	/** The heading's anchor in VS Code's Markdown preview. */
	slug: string;
	/** 1-based line of the heading in the walkthrough document. */
	line: number;
}

/** The block of text a link sits in. */
export interface WalkthroughBlock {
	kind: TextBlockKind | 'heading';
	/** The block's Markdown, for display: list and quote markers removed, table cells separated by ` · `. */
	markdown: string;
	/** 1-based line where the block starts. */
	line: number;
}

export interface WalkthroughLink {
	/** Position among the walkthrough's links, from 0. */
	index: number;
	url: string;
	/** The link text as plain text. */
	text: string;
	/** The section the link is in; undefined before the first section heading. */
	section: WalkthroughSection | undefined;
	/** The titles of the `<details>` elements around the link, outermost first, e.g. `Plumbing`; empty elements are left out. */
	parts: readonly string[];
	block: WalkthroughBlock;
}

export interface Walkthrough {
	sections: WalkthroughSection[];
	links: WalkthroughLink[];
}

/** The walkthrough as a Markdown document of its own, as shown in the preview. */
export interface WalkthroughDocument {
	text: string;
	/** Headings of this level and deeper are sections; shallower ones (the title) are not. */
	sectionLevel: number;
	/** Whether the source had a `## Walkthrough` heading; otherwise the whole source is the walkthrough. */
	hasHeading: boolean;
}

const WALKTHROUGH_HEADING = /^walkthrough$/i;

/**
 * The walkthrough part of `source`: from a `## Walkthrough` heading to the next heading of level
 * 1 or 2, or the end; without such a heading, all of `source`.
 */
export function extractWalkthrough(source: string): { markdown: string; hasHeading: boolean } {
	const { blocks } = scanMarkdown(source);
	const index = blocks.findIndex(b => b.type === 'heading' && b.level === 2 && WALKTHROUGH_HEADING.test(plainText(b.text).trim()));
	if (index < 0) {
		return { markdown: source, hasHeading: false };
	}
	const lines = source.split(/\r\n|\r|\n/);
	const heading = blocks[index] as MarkdownHeading;
	const next = blocks.slice(index + 1).find(b => b.type === 'heading' && b.level <= 2);
	const end = next ? next.line - 1 : lines.length;
	return { markdown: lines.slice(heading.endLine, end).join('\n').replace(/^(?:[ \t]*\n)+/, ''), hasHeading: true };
}

/**
 * The walkthrough of `source` as a document titled `title`. With a `## Walkthrough` heading in
 * the source, its `###` headings are the sections, otherwise all headings below the title.
 */
export function walkthroughDocument(source: string, title: string): WalkthroughDocument {
	const { markdown, hasHeading } = extractWalkthrough(source);
	return { text: `# ${title}\n\n${markdown.trimEnd()}\n`, sectionLevel: hasHeading ? 3 : 2, hasHeading };
}

/** The sections and links of a walkthrough document; headings above `sectionLevel` are not sections. */
export function parseWalkthrough(text: string, sectionLevel = 1): Walkthrough {
	const { blocks, definitions, details } = scanMarkdown(text);
	const slugger = new HeadingSlugger();
	const sections: WalkthroughSection[] = [];
	const links: WalkthroughLink[] = [];
	const open: WalkthroughSection[] = [];
	const addLinks = (inline: string, section: WalkthroughSection | undefined, block: WalkthroughBlock) => {
		for (const link of inlineLinks(inline, definitions)) {
			const parts = details.filter(d => d.title !== '' && d.line < block.line && block.line <= d.endLine).map(d => d.title);
			links.push({ index: links.length, url: link.url, text: link.text, section, parts, block });
		}
	};
	for (const block of blocks) {
		if (block.type === 'heading') {
			const slug = slugger.add(block.text);
			while (open.length > 0 && open.at(-1)!.level >= block.level) {
				open.pop();
			}
			const title = plainText(block.text).trim();
			const headingBlock: WalkthroughBlock = { kind: 'heading', markdown: block.text, line: block.line };
			if (block.level < sectionLevel) {
				open.length = 0;
				addLinks(block.text, undefined, headingBlock);
				continue;
			}
			const section = { title, path: [...open.map(s => s.title), title], level: block.level, slug, line: block.line };
			sections.push(section);
			open.push(section);
			addLinks(block.text, section, headingBlock);
			continue;
		}
		const inline = block.lines.join('\n');
		const markdown = block.type === 'tableRow' ? tableCells(inline).join(' · ') : inline;
		addLinks(inline, open.at(-1), { kind: block.type, markdown, line: block.line });
	}
	return { sections, links };
}

/** How the views name a section: `Details › Fast-path eligibility`. */
export function sectionLabel(section: WalkthroughSection | undefined): string {
	return section ? section.path.join(' › ') : 'Introduction';
}

/** How the views name where a link sits: its section, then the collapsible parts of it: `Commit 3 › Plumbing`. */
export function linkLabel({ section, parts }: Pick<WalkthroughLink, 'section' | 'parts'>): string {
	return [sectionLabel(section), ...parts].join(' › ');
}
