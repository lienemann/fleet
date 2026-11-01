/**
 * Gutter icons for moved blocks: a bar in the move's colour along the block, an arrow on its
 * first line, and the check mark of approved lines, all in one icon since a line shows only one.
 */

import type { MoveEnd } from './movePresentation';

export type Theme = 'light' | 'dark';

export interface MoveGlyph {
	hue: number;
	/** `from`: the block moved away from here (approved side); `to`: it moved here (head side). */
	end: MoveEnd;
	/** The first line of the block carries the arrow. */
	first: boolean;
	/** Moved with changes or re-indented: the arrow is hollow. */
	edited: boolean;
	/** The line is approved: a check mark, on the first line on top of the arrow. */
	approved: boolean;
}

/** The green of `media/approved.svg`. */
const CHECK_COLOR = '#73c991';

/** The colour of a move, light enough for dark themes and dark enough for light ones. */
export function moveColor(hue: number, theme: Theme): string {
	return theme === 'dark' ? `hsl(${hue}, 70%, 62%)` : `hsl(${hue}, 65%, 42%)`;
}

/** A key per distinct icon, without the theme, which the editor picks. */
export function glyphKey({ hue, end, first, edited, approved }: MoveGlyph): string {
	return [hue, end, first, edited, approved].join('|');
}

/**
 * The SVG of a gutter icon. It is stretched over the whole line (`preserveAspectRatio="none"`),
 * so the bars of consecutive lines join.
 */
export function moveGlyphSvg({ hue, end, first, edited, approved }: MoveGlyph, theme: Theme): string {
	const color = moveColor(hue, theme);
	const parts = [`<rect x="1" y="0" width="3" height="16" fill="${color}"/>`];
	if (first) {
		// To the right where the block came in, to the left where it was taken out.
		const points = end === 'to' ? '6,3 6,13 14,8' : '14,3 14,13 6,8';
		parts.push(edited
			? `<polygon points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`
			: `<polygon points="${points}" fill="${color}"/>`);
		if (approved) {
			// On top of the arrow; the outline keeps it apart from the arrow's colour.
			parts.push(check(EDITOR_BACKGROUND[theme], 4), check(CHECK_COLOR, 2));
		}
	} else if (approved) {
		parts.push(check(CHECK_COLOR, 2));
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" preserveAspectRatio="none">${parts.join('')}</svg>`;
}

/** The editor background of the default themes. */
const EDITOR_BACKGROUND: Record<Theme, string> = { dark: '#1f1f1f', light: '#ffffff' };

function check(color: string, width: number): string {
	return `<path d="M6.5 8.5l2.5 2.5 5-6" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
