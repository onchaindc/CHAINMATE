/* Entry point for `node --import`. Registers the `@/…` alias resolver in the
   module-loading thread; see loader.mjs. */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./loader.mjs", pathToFileURL(import.meta.filename));
