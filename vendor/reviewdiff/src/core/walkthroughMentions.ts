/**
 * From the code back to the walkthrough: which links point to a hunk or a moved block, how
 * specific each link is, and the order in which the walkthrough discusses the hunks.
 */

import { hunkRefs, type HunkRef } from './navigation';
import type { FileReview } from './review';
import type { HunkId, LineRange, Move } from './types';
import type { ResolvedLink, ReviewSide } from './walkthroughLinks';

/** `about`: the link is about this change. `context`: the link spans much more, such as a whole class. */
export type MentionKind = 'about' | 'context';

export interface Mention {
	link: ResolvedLink;
	kind: MentionKind;
	/** Linked lines outside the hunk or moved block; the fewer, the more specific the link. */
	excess: number;
	/** The move through which the link reaches a hunk at the move's other end. */
	viaMove?: string;
}

export interface WalkthroughMentions {
	/** By hunk, most specific first. */
	hunks: ReadonlyMap<HunkId, readonly Mention[]>;
	/** By move id, most specific first. */
	moves: ReadonlyMap<string, readonly Mention[]>;
}

/** A link is context when it is this many times longer than the change… */
const CONTEXT_RATIO = 4;
/** …and also this many lines longer, so a function linked around a small change still counts as about it. */
const CONTEXT_EXTRA_LINES = 20;

/**
 * The mentions of each hunk and move. A link mentions a hunk when its lines, mapped to the
 * review, overlap the hunk on the link's side: head lines for links to the head, base lines for
 * links to the base. A link to one end of a moved block also mentions the hunks at its other end.
 * Links whose lines were rewritten since their commit mention nothing.
 */
export function walkthroughMentions(links: readonly ResolvedLink[], files: readonly FileReview[], moves: readonly Move[]): WalkthroughMentions {
	const hunks = new Map<HunkId, Mention[]>();
	const moveMentions = new Map<string, Mention[]>();
	const add = (map: Map<string, Mention[]>, id: string, mention: Mention) => {
		const list = map.get(id) ?? [];
		const existing = list.findIndex(m => m.link === mention.link);
		if (existing < 0) {
			list.push(mention);
		} else if (compareMentions(mention, list[existing]) < 0) {
			list[existing] = mention;
		}
		map.set(id, list);
	};
	for (const link of links) {
		const { target } = link;
		if (target.kind !== 'lines') {
			continue;
		}
		for (const file of files) {
			const path = target.side === 'head' ? file.change.path : file.basePath;
			if (path !== target.path) {
				continue;
			}
			for (const hunk of file.hunks) {
				const mention = measure(link, target.range, target.side === 'head' ? hunk.head : hunk.base);
				if (mention) {
					add(hunks, hunk.id, mention);
				}
			}
		}
		for (const move of moves) {
			const [end, other] = target.side === 'head' ? [move.to, move.from] : [move.from, move.to];
			const mention = end.path === target.path ? measure(link, target.range, end.range) : undefined;
			if (!mention) {
				continue;
			}
			add(moveMentions, move.id, mention);
			const otherSide: ReviewSide = target.side === 'head' ? 'base' : 'head';
			for (const hunk of hunksAt(files, other.path, otherSide, other.range)) {
				add(hunks, hunk.id, { ...mention, viaMove: move.id });
			}
		}
	}
	for (const list of [...hunks.values(), ...moveMentions.values()]) {
		list.sort(compareMentions);
	}
	return { hunks, moves: moveMentions };
}

/** The mention of a change at `changed` by a link to `linked`, if they overlap. */
function measure(link: ResolvedLink, linked: LineRange, changed: LineRange): Mention | undefined {
	const changedLength = changed.endExclusive - changed.start;
	// An empty range marks where lines were removed: it counts as the line that follows.
	const overlapStart = Math.max(linked.start, changed.start);
	const overlapEnd = Math.min(linked.endExclusive, changedLength === 0 ? changed.start + 1 : changed.endExclusive);
	if (overlapEnd <= overlapStart) {
		return undefined;
	}
	const linkedLength = linked.endExclusive - linked.start;
	const size = Math.max(changedLength, 1);
	const context = linkedLength > CONTEXT_RATIO * size && linkedLength - size > CONTEXT_EXTRA_LINES;
	return { link, kind: context ? 'context' : 'about', excess: linkedLength - (overlapEnd - overlapStart) };
}

function hunksAt(files: readonly FileReview[], path: string, side: ReviewSide, range: LineRange) {
	const file = files.find(f => (side === 'head' ? f.change.path : f.basePath) === path);
	return (file?.hunks ?? []).filter(h => {
		const r = side === 'head' ? h.head : h.base;
		return r.start < range.endExclusive && range.start < Math.max(r.endExclusive, r.start + 1);
	});
}

/** Most specific first: links about the change before context, fewer extra lines, then walkthrough order. */
export function compareMentions(a: Mention, b: Mention): number {
	return Number(a.kind === 'context') - Number(b.kind === 'context')
		|| a.excess - b.excess
		|| a.link.link.index - b.link.link.index;
}

/**
 * Where the walkthrough mentions a change, most specific first. A place is a block of text, however
 * many of its links point to the change.
 */
export function mentionPlaces(mentions: readonly Mention[] | undefined): Mention[] {
	const lines = new Set<number>();
	return (mentions ?? []).filter(({ link }) => {
		const seen = lines.has(link.link.block.line);
		lines.add(link.link.block.line);
		return !seen;
	});
}

/**
 * The hunks in the order the walkthrough discusses them: hunks some link is about, by the first
 * such link; then hunks with only context links, by the first of them; then the others in file
 * order. Hunks reached by the same link keep their file order.
 */
export function walkthroughOrder(files: readonly FileReview[], mentions: WalkthroughMentions): HunkRef[] {
	const rank = (ref: HunkRef): [number, number] => {
		const list = mentions.hunks.get(ref.hunk.id) ?? [];
		const about = list.filter(m => m.kind === 'about');
		const relevant = about.length > 0 ? about : list;
		if (relevant.length === 0) {
			return [2, 0];
		}
		return [about.length > 0 ? 0 : 1, Math.min(...relevant.map(m => m.link.link.index))];
	};
	return hunkRefs(files)
		.map((ref, position) => ({ ref, position, rank: rank(ref) }))
		.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.position - b.position)
		.map(({ ref }) => ref);
}
