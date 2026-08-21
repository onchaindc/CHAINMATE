"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BOARD_THEME_KEY,
  DEFAULT_BOARD_THEME,
  DEFAULT_PIECE_SET,
  PIECE_SET_KEY,
  applyBoardTheme,
  getStoredBoardTheme,
  getStoredPieceSet,
  isBoardThemeId,
  isPieceSetId,
  setStoredBoardTheme,
  setStoredPieceSet,
  type BoardThemeId,
  type PieceSetId,
} from "@/lib/board-prefs";

/**
 * The player's board appearance, remembered across sessions.
 *
 * Both values start at their defaults on the server and on the first client
 * render so hydration matches, then settle to the stored choice in an effect.
 * The board *colours* never actually flash, because BOARD_SCRIPT has already
 * set data-board on <html> before first paint; only the piece set can change
 * on hydration, and only for players who picked the non-default one.
 *
 * A `storage` listener keeps two open tabs in agreement — the same treatment
 * the light/dark preference gets.
 */
export function useBoardPrefs() {
  const [boardTheme, setBoardThemeState] = useState<BoardThemeId>(DEFAULT_BOARD_THEME);
  const [pieceSet, setPieceSetState] = useState<PieceSetId>(DEFAULT_PIECE_SET);

  useEffect(() => {
    const stored = getStoredBoardTheme();
    setBoardThemeState(stored);
    applyBoardTheme(stored);
    setPieceSetState(getStoredPieceSet());
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === BOARD_THEME_KEY && isBoardThemeId(e.newValue)) {
        setBoardThemeState(e.newValue);
        applyBoardTheme(e.newValue);
      } else if (e.key === PIECE_SET_KEY && isPieceSetId(e.newValue)) {
        setPieceSetState(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setBoardTheme = useCallback((id: BoardThemeId) => {
    setBoardThemeState(id);
    applyBoardTheme(id);
    setStoredBoardTheme(id);
  }, []);

  const setPieceSet = useCallback((id: PieceSetId) => {
    setPieceSetState(id);
    setStoredPieceSet(id);
  }, []);

  return { boardTheme, pieceSet, setBoardTheme, setPieceSet };
}
