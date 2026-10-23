import pkg from "../../package.json" with { type: "json" };

/** fleet's release, from package.json; bumped by hand and tagged `v<version>`. */
export const VERSION: string = pkg.version;
