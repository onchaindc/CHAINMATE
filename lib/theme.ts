/**
 * Theme storage and resolution (plain TS — safe to import anywhere).
 *
 * One record lives in localStorage: chainmate:theme:v1, holding "light",
 * "dark" or "system". "system" is the default and follows the OS preference,
 * so a player who has never touched the toggle gets whatever their machine
 * asks for, and keeps following it when they change it.
 *
 * The applied class is only ever `dark` present or absent, which is what
 * Tailwind's darkMode: ["class"] expects — light needs no class because
 * :root in globals.css *is* the light palette.
 */

export const THEME_KEY = "chainmate:theme:v1";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const PREFERENCES: ThemePreference[] = ["light", "dark", "system"];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && PREFERENCES.includes(value as ThemePreference);
}

/** The stored preference, or "system" when unset or storage is unavailable. */
export function getStoredTheme(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return isThemePreference(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export function setStoredTheme(preference: ThemePreference) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(THEME_KEY, preference);
  } catch {
    // storage unavailable (private mode etc.) — theme stays in-memory
  }
}

/** What the OS currently asks for. Defaults to dark when unknowable. */
export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? getSystemTheme() : preference;
}

/** Puts the resolved theme on <html>. The single place the class is written. */
export function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

/**
 * Runs before first paint to stop a light-then-dark flash: React hasn't
 * hydrated yet at this point, so the class has to be set by hand here rather
 * than by the provider. Kept dependency-free and inlined as a string because
 * it ships inside a <script> tag, and wrapped in try/catch so a blocked
 * localStorage can never leave the page unstyled.
 */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_KEY}");if(p!=="light"&&p!=="dark")p=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.classList.toggle("dark",p==="dark")}catch(e){document.documentElement.classList.add("dark")}})();`;
