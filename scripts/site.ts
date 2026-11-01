// Puts the homepage together in dist/site: the pages in site/, the README's screenshots and the
// app's fonts, so nothing is kept twice in the repository.
//
//   node scripts/site.ts [OUT]
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

/** The latin subset of each face the app uses, by the name the site's stylesheet gives it. */
const FONTS = {
  inter: "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  "source-serif-4":
    "@fontsource-variable/source-serif-4/files/source-serif-4-latin-opsz-normal.woff2",
  "jetbrains-mono":
    "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
};

export function buildSite(out: string): void {
  rmSync(out, { recursive: true, force: true });
  cpSync(join(root, "site"), out, { recursive: true });
  cpSync(join(root, "docs/screenshots"), join(out, "screenshots"), { recursive: true });
  copyFileSync(join(root, "src/web/public/icon.svg"), join(out, "icon.svg"));
  mkdirSync(join(out, "fonts"));
  for (const [name, file] of Object.entries(FONTS)) {
    copyFileSync(join(root, "node_modules", file), join(out, "fonts", `${name}.woff2`));
    // The SIL Open Font License asks for its text to travel with the fonts.
    const pkg = file.split("/files/")[0] ?? file;
    copyFileSync(
      join(root, "node_modules", pkg, "LICENSE"),
      join(out, "fonts", `${name}-LICENSE.txt`),
    );
  }
}

if (import.meta.main) {
  const out = process.argv[2] ?? join(root, "dist/site");
  buildSite(out);
  console.log(`site in ${out}`);
}
