import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { GameState } from "@/lib/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Merge games from multiple stores by id and sort newest first. */
export function mergeGamesById(games: GameState[]): GameState[] {
  const map = new Map<string, GameState>();
  for (const g of games) map.set(g.id, g);
  return [...map.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** Cryptographically-random hex string (works in browser and Node). */
export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(arr);
  } else {
    // Node < 19 / non-web fallback
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
