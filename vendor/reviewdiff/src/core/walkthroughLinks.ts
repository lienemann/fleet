/**
 * Where the code links of a walkthrough point in the review: a link names lines of a file in
 * some commit, which may be the reviewed head or base, or an earlier revision whose lines have
 * to be followed through the later changes.
 */

import type { LineDiff } from './diff';
import { splitLines } from './hunks';
import { lineChanges, mapAlong } from './lineMapping';
import type { FileReview } from './review';
import type { LineRange, RevRange } from './types';
import type { WalkthroughLink } from './walkthrough';

/** Lines of a file in a commit, as a code link names them. */
export interface CodeReference {
	sha: string;
	path: string;
	/** 1-based, inclusive. */
	lines: { start: number; end: number };
}

/** Which side of the review diff a link's commit belongs to. */
export type ReviewSide = 'base' | 'head';

/** Commits of earlier revisions of a merge request, e.g. before a force push. */
export interface EarlierRevisions {
	heads: ReadonlySet<string>;
	bases: ReadonlySet<string>;
}

/** Where a link points in the review. */
export type LinkTarget =
	/** Lines of the reviewed base or head; `shifted` if they moved since the linked commit. */
	| { kind: 'lines'; side: ReviewSide; path: string; range: LineRange; shifted: boolean }
	/** Some of the linked lines were rewritten since the linked commit; `range` spans what replaced them. */
	| { kind: 'changed'; side: ReviewSide; path: string; range: LineRange }
	/** All linked lines were removed since the linked commit; `at` is the line after the gap. */
	| { kind: 'removed'; side: ReviewSide; path: string; at: number }
	/** The file isn't in the reviewed revision, e.g. it was deleted or renamed since. */
	| { kind: 'missingFile'; side: ReviewSide; path: string }
	/** The linked lines don't exist in the linked commit. */
	| { kind: 'invalidLines' }
	/** The linked commit is not in the repository and could not be fetched. */
	| { kind: 'unavailable' };

export interface ResolvedLink {
	link: WalkthroughLink;
	reference: CodeReference;
	side: ReviewSide;
	/** The link names a commit other than the reviewed base or head. */
	earlier: boolean;
	target: LinkTarget;
}

export interface LinkResolutionContext {
	range: RevRange;
	files: readonly FileReview[];
	earlier?: EarlierRevisions;
	/** The text of a file in a commit; undefined if the file doesn't exist there. */
	read(sha: string, path: string): Promise<string | undefined>;
	/** Commits that are not in the repository and could not be fetched. */
	unavailable?: ReadonlySet<string>;
}

/**
 * The side a commit belongs to. Commits other than the reviewed base and head, and other than
 * earlier bases of the merge request, are taken as earlier versions of its head.
 */
export function sideOfCommit(sha: string, range: RevRange, earlier?: EarlierRevisions): { side: ReviewSide; earlier: boolean } {
	if (sha === range.head) {
		return { side: 'head', earlier: false };
	}
	if (sha === range.base) {
		return { side: 'base', earlier: false };
	}
	return { side: earlier?.bases.has(sha) && !earlier.heads.has(sha) ? 'base' : 'head', earlier: true };
}

/** Resolves the links `recognize` accepts as code references; the others are left out. */
export async function resolveLinks(
	links: readonly WalkthroughLink[],
	recognize: (url: string) => CodeReference | undefined,
	context: LinkResolutionContext,
): Promise<ResolvedLink[]> {
	const texts = new Map<string, Promise<string[] | undefined>>();
	const lines = (sha: string, path: string) => {
		const key = `${sha}\0${path}`;
		let text = texts.get(key);
		if (!text) {
			text = context.read(sha, path).then(t => t === undefined ? undefined : splitLines(t));
			texts.set(key, text);
		}
		return text;
	};
	// Many links point into the same few files: diff each pair of versions once.
	const diffs = new Map<string, readonly LineDiff[]>();
	const changes = (from: string, to: string, fromLines: readonly string[], toLines: readonly string[]) => {
		const key = `${from}\0${to}`;
		let diff = diffs.get(key);
		if (!diff) {
			diff = lineChanges(fromLines, toLines);
			diffs.set(key, diff);
		}
		return diff;
	};
	const resolved: ResolvedLink[] = [];
	for (const link of links) {
		const reference = recognize(link.url);
		if (reference) {
			const { side, earlier } = sideOfCommit(reference.sha, context.range, context.earlier);
			resolved.push({ link, reference, side, earlier, target: await resolveTarget(reference, side, context, lines, changes) });
		}
	}
	return resolved;
}

async function resolveTarget(
	reference: CodeReference,
	side: ReviewSide,
	context: LinkResolutionContext,
	lines: (sha: string, path: string) => Promise<string[] | undefined>,
	changes: (from: string, to: string, fromLines: readonly string[], toLines: readonly string[]) => readonly LineDiff[],
): Promise<LinkTarget> {
	if (context.unavailable?.has(reference.sha)) {
		return { kind: 'unavailable' };
	}
	const source = await lines(reference.sha, reference.path);
	if (!source || reference.lines.start > source.length) {
		return { kind: 'invalidLines' };
	}
	const range = { start: reference.lines.start, endExclusive: Math.min(reference.lines.end, source.length) + 1 };
	const reviewed = side === 'head' ? context.range.head : context.range.base;
	if (reference.sha === reviewed) {
		return { kind: 'lines', side, path: reference.path, range, shifted: false };
	}
	const path = reviewedPath(reference.path, side, context.files);
	const target = await lines(reviewed, path);
	if (!target) {
		return { kind: 'missingFile', side, path };
	}
	const mapped = mapAlong(changes(`${reference.sha}:${reference.path}`, `${reviewed}:${path}`, source, target), range);
	switch (mapped.kind) {
		case 'unchanged':
			return { kind: 'lines', side, path, range: mapped.range, shifted: mapped.range.start !== range.start };
		case 'changed':
			return { kind: 'changed', side, path, range: mapped.range };
		case 'removed':
			return { kind: 'removed', side, path, at: mapped.at };
	}
}

/** The path of a linked file in the reviewed revision: the head path of a file the review renames. */
function reviewedPath(path: string, side: ReviewSide, files: readonly FileReview[]): string {
	if (side === 'base') {
		return path;
	}
	const renamed = files.find(f => f.change.status === 'renamed' && f.basePath === path);
	return renamed && !files.some(f => f.change.path === path) ? renamed.change.path : path;
}

