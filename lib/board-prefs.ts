/**
 * Board appearance preferences — which board colours and which piece set a
 * player likes. Plain TS so it can be imported from the pre-paint script, a
 * hook, or a server component alike.
 *
 * Two records live in localStorage:
 *   chainmate:board:v1   → "gold" | "walnut" | "slate" | "forest"
 *   chainmate:pieces:v1  → "classic" | "letters"
 *
 * The board theme is applied as `data-board` on <html> before first paint, the
 * same way the light/dark class is (see lib/theme.ts), so the colours are only
 * ever a CSS variable override — nothing recolours in JavaScript.
 */

export const BOARD_THEME_KEY = "chainmate:board:v1";
export const PIECE_SET_KEY = "chainmate:pieces:v1";

export type BoardThemeId = "gold" | "walnut" | "slate" | "forest";
export type PieceSetId = "classic" | "letters";

export const DEFAULT_BOARD_THEME: BoardThemeId = "gold";
export const DEFAULT_PIECE_SET: PieceSetId = "classic";

export interface BoardThemeMeta {
  id: BoardThemeId;
  label: string;
  /**
   * Swatch colours for the picker only. The board itself is painted from the
   * `--board-*` variables in globals.css — these are here so the two squares
   * in the menu can be drawn before the theme is applied.
   */
  swatch: { light: string; dark: string };
}

export const BOARD_THEMES: BoardThemeMeta[] = [
  { id: "gold", label: "Gold", swatch: { light: "41 48% 88%", dark: "31 15% 36%" } },
  { id: "walnut", label: "Walnut", swatch: { light: "33 44% 82%", dark: "24 28% 33%" } },
  { id: "slate", label: "Slate", swatch: { light: "210 14% 85%", dark: "214 16% 33%" } },
  { id: "forest", label: "Forest", swatch: { light: "68 20% 85%", dark: "148 16% 28%" } },
];

export interface PieceSetMeta {
  id: PieceSetId;
  label: string;
  hint: string;
}

export const PIECE_SETS: PieceSetMeta[] = [
  { id: "classic", label: "Classic", hint: "Traditional carved pieces" },
  { id: "letters", label: "Letters", hint: "Initials — clearest when small" },
];

const BOARD_THEME_IDS = BOARD_THEMES.map((t) => t.id);
const PIECE_SET_IDS = PIECE_SETS.map((p) => p.id);

export function isBoardThemeId(value: unknown): value is BoardThemeId {
  return typeof value === "string" && BOARD_THEME_IDS.includes(value as BoardThemeId);
}

export function isPieceSetId(value: unknown): value is PieceSetId {
  return typeof value === "string" && PIECE_SET_IDS.includes(value as PieceSetId);
}

export function getStoredBoardTheme(): BoardThemeId {
  if (typeof localStorage === "undefined") return DEFAULT_BOARD_THEME;
  try {
    const raw = localStorage.getItem(BOARD_THEME_KEY);
    return isBoardThemeId(raw) ? raw : DEFAULT_BOARD_THEME;
  } catch {
    return DEFAULT_BOARD_THEME;
  }
}

export function getStoredPieceSet(): PieceSetId {
  if (typeof localStorage === "undefined") return DEFAULT_PIECE_SET;
  try {
    const raw = localStorage.getItem(PIECE_SET_KEY);
    return isPieceSetId(raw) ? raw : DEFAULT_PIECE_SET;
  } catch {
    return DEFAULT_PIECE_SET;
  }
}

export function setStoredBoardTheme(id: BoardThemeId) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(BOARD_THEME_KEY, id);
  } catch {
    // storage unavailable (private mode etc.) — the choice stays in-memory
  }
}

export function setStoredPieceSet(id: PieceSetId) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PIECE_SET_KEY, id);
  } catch {
    // as above
  }
}

/** Puts the chosen board on <html>. The single place the attribute is written. */
export function applyBoardTheme(id: BoardThemeId) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.board = id;
}

/**
 * Runs before first paint, alongside THEME_SCRIPT, so a player who chose a
 * board never sees the default one flash first. Only the board colours can be
 * restored this early — the piece set is decided by the React renderer, so it
 * settles on hydration instead.
 */
export const BOARD_SCRIPT = `(function(){try{var b=localStorage.getItem("${BOARD_THEME_KEY}");if(${JSON.stringify(
  BOARD_THEME_IDS,
)}.indexOf(b)<0)b="${DEFAULT_BOARD_THEME}";document.documentElement.setAttribute("data-board",b)}catch(e){}})();`;
