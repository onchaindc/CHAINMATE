"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  applyTheme,
  getStoredTheme,
  getSystemTheme,
  resolveTheme,
  setStoredTheme,
  THEME_KEY,
  isThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

export interface ThemeState {
  /** What the player chose — may be "system". */
  preference: ThemePreference;
  /** What's actually on screen — always "light" or "dark". */
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  /* Server render and first client render must agree, so both start from the
     same constants; the effect below immediately corrects them from storage.
     THEME_SCRIPT has already put the right class on <html> by this point, so
     nothing flashes while these two states are momentarily stale. */
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("dark");

  useEffect(() => {
    const stored = getStoredTheme();
    setPreferenceState(stored);
    const next = resolveTheme(stored);
    setResolved(next);
    applyTheme(next);
  }, []);

  // Follow the OS while the preference is "system" — a player who changes
  // their machine's appearance expects the app to move with it, live.
  useEffect(() => {
    if (preference !== "system") return;
    if (typeof window === "undefined" || !window.matchMedia) return;

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next = getSystemTheme();
      setResolved(next);
      applyTheme(next);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  // Keep tabs in sync: switching theme in one should not leave others stale.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_KEY) return;
      const next = isThemePreference(event.newValue) ? event.newValue : "system";
      setPreferenceState(next);
      const applied = resolveTheme(next);
      setResolved(applied);
      applyTheme(applied);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    setStoredTheme(next);
    const applied = resolveTheme(next);
    setResolved(applied);
    applyTheme(applied);
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
