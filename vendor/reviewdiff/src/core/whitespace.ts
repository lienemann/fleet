/**
 * Whitespace policy for hunk identity.
 *
 * Trailing whitespace and line endings never matter. Leading whitespace matters only in
 * indentation-sensitive languages, where re-indenting a line can change semantics.
 * Whitespace inside a line is never touched (it may be part of a string literal).
 *
 * Changing anything here changes hunk ids and therefore resets existing approvals.
 */

/** Language ids whose leading whitespace is significant, unless configured otherwise. */
export const DEFAULT_INDENTATION_SENSITIVE_LANGUAGES: readonly string[] = [
	'python', 'yaml', 'makefile', 'haskell', 'fsharp', 'nim', 'coffeescript', 'pug', 'sass',
];

/** Maps a repository path to a VS Code language id, or undefined if unknown. */
export type LanguageResolver = (path: string) => string | undefined;

const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> = new Map(Object.entries({
	py: 'python', pyi: 'python', pyw: 'python', rpy: 'python', cpy: 'python', gyp: 'python', gypi: 'python', ipy: 'python', pyt: 'python',
	yaml: 'yaml', yml: 'yaml', eyaml: 'yaml', eyml: 'yaml', cff: 'yaml',
	mk: 'makefile', mak: 'makefile',
	hs: 'haskell', lhs: 'haskell',
	fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp', fsscript: 'fsharp',
	nim: 'nim', nims: 'nim', nimble: 'nim',
	coffee: 'coffeescript', cson: 'coffeescript', iced: 'coffeescript',
	pug: 'pug', jade: 'pug',
	sass: 'sass',
}));

const LANGUAGE_BY_FILENAME: ReadonlyMap<string, string> = new Map(Object.entries({
	Makefile: 'makefile', makefile: 'makefile', GNUmakefile: 'makefile', OCamlMakefile: 'makefile',
	SConstruct: 'python', SConscript: 'python',
}));

/**
 * Language detection for the default indentation-sensitive languages, mirroring the file
 * associations of VS Code's built-in language support. It does not need VS Code, so hunk ids
 * come out the same in tests, scripts and the extension.
 */
export const builtinLanguageOf: LanguageResolver = path => {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const byName = LANGUAGE_BY_FILENAME.get(name);
	if (byName !== undefined) {
		return byName;
	}
	const dot = name.lastIndexOf('.');
	return dot > 0 ? LANGUAGE_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) : undefined;
};

/** Whether leading whitespace of lines in `path` is significant. */
export function isIndentationSensitive(
	path: string,
	languages: readonly string[] = DEFAULT_INDENTATION_SENSITIVE_LANGUAGES,
	languageOf: LanguageResolver = builtinLanguageOf,
): boolean {
	const language = languageOf(path);
	return language !== undefined && languages.includes(language);
}

/** Normalizes one line (without terminator) for hashing and whitespace-only comparisons. */
export function normalizeLine(line: string, indentationSensitive: boolean): string {
	return indentationSensitive ? line.trimEnd() : line.trim();
}
