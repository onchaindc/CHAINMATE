/**
 * Theme bootstrap (plain TS — safe to import from the pre-paint script).
 *
 * ChainMate is dark-only: the palette in globals.css IS the dark theme, and
 * there is no `.dark` class, no stored preference, and no switcher. The only
 * job left here is the legacy cleanup — a returning player's localStorage may
 * still hold the old `chainmate:theme:v1` record (or the document may still
 * carry a stale `dark` class from a previous session's markup), and this
 * script removes both before first paint so nothing ever renders light.
 */

export const THEME_SCRIPT = `(function(){try{localStorage.removeItem("chainmate:theme:v1")}catch(e){}document.documentElement.classList.remove("light");document.documentElement.classList.add("dark")})();`;
