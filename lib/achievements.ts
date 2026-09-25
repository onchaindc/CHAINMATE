import type { PlayerStats } from "@/lib/types";

/**
 * Achievement definitions. Awarding happens server-side (lib/server/hosted.ts)
 * from trusted game data — never from frontend-only state. Criteria are
 * evaluated against the player's real stats after every completed rated game.
 *
 * Icons are emoji, deliberately. Plain Unicode chess characters (♞ ♛ ♔) and
 * dingbats (⚔ without a variation selector) are not present in the default
 * Windows UI fonts, so half the badge set rendered as empty tofu boxes on
 * desktop while looking fine on phones. Emoji ship with the OS everywhere.
 */

/** Trophy tier. The badge renders as a trophy tinted by tier colour. */
export type AchievementTier = "bronze" | "silver" | "gold" | "diamond" | "legendary";

export interface AchievementDef {
  code: string;
  name: string;
  description: string;
  icon: string;
  /** Visual prestige, shown on the profile card from bronze up to diamond. */
  tier: AchievementTier;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    code: "FIRST_GAME",
    name: "First Game",
    description: "Complete your first match.",
    icon: "🌱",
    tier: "bronze",
  },
  {
    code: "FIRST_VICTORY",
    name: "First Victory",
    description: "Win your first game.",
    icon: "🏆",
    tier: "bronze",
  },
  {
    code: "TEN_GAMES",
    name: "10 Games",
    description: "Complete ten matches.",
    icon: "🧩",
    tier: "silver",
  },
  {
    code: "TEN_WINS",
    name: "Ten Wins",
    description: "Win ten games.",
    icon: "🎯",
    tier: "silver",
  },
  {
    code: "HUNDRED_GAMES",
    name: "100 Games",
    description: "Complete one hundred matches.",
    icon: "💯",
    tier: "gold",
  },
  {
    code: "FIVE_WIN_STREAK",
    name: "Five Win Streak",
    description: "Win five games in a row.",
    icon: "🔥",
    tier: "gold",
  },
  {
    code: "REACH_1200",
    name: "Club Standard",
    description: "Reach a 1200 rating.",
    icon: "🛡️",
    tier: "bronze",
  },
  {
    code: "REACH_1400",
    name: "Class A",
    description: "Reach a 1400 rating.",
    icon: "⭐",
    tier: "silver",
  },
  {
    code: "REACH_1600",
    name: "Candidate Master",
    description: "Reach a 1600 rating.",
    icon: "👑",
    tier: "gold",
  },
  {
    code: "WIN_AGAINST_HIGHER_RATED",
    name: "Upset",
    description: "Defeat an opponent rated above you.",
    icon: "⚔️",
    tier: "diamond",
  },
  {
    code: "FIFTY_GAMES",
    name: "Regular",
    description: "Complete fifty matches.",
    icon: "⏳",
    tier: "silver",
  },
  {
    code: "TWENTY_WINS",
    name: "Twenty Wins",
    description: "Win twenty games.",
    icon: "🎖️",
    tier: "silver",
  },
  {
    code: "FIFTY_WINS",
    name: "Fifty Wins",
    description: "Win fifty games.",
    icon: "🏅",
    tier: "gold",
  },
  {
    code: "TEN_WIN_STREAK",
    name: "Ten Win Streak",
    description: "Win ten games in a row.",
    icon: "☄️",
    tier: "diamond",
  },
  {
    code: "REACH_1800",
    name: "Master",
    description: "Reach a 1800 rating.",
    icon: "💠",
    tier: "diamond",
  },
  {
    code: "FIRST_TOURNAMENT",
    name: "Debutant",
    description: "Play your first tournament match.",
    icon: "🎪",
    tier: "bronze",
  },
  {
    code: "TOURNEY_CHAMPION",
    name: "Champion",
    description: "Win a ChainMate tournament.",
    icon: "👑",
    tier: "legendary",
  },
];

export const achievementByCode = new Map(ACHIEVEMENTS.map((a) => [a.code, a]));

export function getAchievement(code: string): AchievementDef | undefined {
  return achievementByCode.get(code);
}

/** Snapshot of the stats relevant to achievement criteria at evaluation time. */
export interface AchievementContext {
  games: number;
  wins: number;
  rating: number;
  /** Consecutive wins streak after this game. */
  currentStreak: number;
  /** True when this game was won against a higher-rated opponent. */
  beatHigherRated: boolean;
  /** True once the player has completed a tournament match. */
  hasTournamentGame?: boolean;
  /** True when the player won a tournament (final standing 1). */
  hasTournamentTitle?: boolean;
}

/**
 * All codes the player qualifies for right now, given their stats. The caller
 * diffs this against already-earned codes and stores only the new ones.
 */
export function earnedAchievements(ctx: AchievementContext): string[] {
  const earned: string[] = [];
  const add = (code: string, ok: boolean) => {
    if (ok) earned.push(code);
  };

  add("FIRST_GAME", ctx.games >= 1);
  add("FIRST_VICTORY", ctx.wins >= 1);
  add("TEN_GAMES", ctx.games >= 10);
  add("TEN_WINS", ctx.wins >= 10);
  add("HUNDRED_GAMES", ctx.games >= 100);
  add("FIVE_WIN_STREAK", ctx.currentStreak >= 5);
  add("REACH_1200", ctx.rating >= 1200);
  add("REACH_1400", ctx.rating >= 1400);
  add("REACH_1600", ctx.rating >= 1600);
  add("WIN_AGAINST_HIGHER_RATED", ctx.beatHigherRated);
  add("FIFTY_GAMES", ctx.games >= 50);
  add("TWENTY_WINS", ctx.wins >= 20);
  add("FIFTY_WINS", ctx.wins >= 50);
  add("TEN_WIN_STREAK", ctx.currentStreak >= 10);
  add("REACH_1800", ctx.rating >= 1800);
  // Tournament achievements arrive out-of-band (the tournament engine writes
  // them on match completion / tournament win); they are listed here so the
  // profile shelf can render them like any other trophy.
  add("FIRST_TOURNAMENT", ctx.hasTournamentGame === true);
  add("TOURNEY_CHAMPION", ctx.hasTournamentTitle === true);
  return earned;
}

/** Convenience: the codes a PlayerStats record has already earned. */
export function earnedCodes(stats: PlayerStats): Set<string> {
  return new Set((stats.achievements ?? []).map((a) => a.code));
}

/** Validate a display name for account creation. Returns a message or null. */
export function validateUsername(raw: string): string | null {
  const username = raw.trim();
  if (username.length < 3) return "Username must be at least 3 characters.";
  if (username.length > 20) return "Username must be 20 characters or fewer.";
  if (!/^[A-Za-z0-9_]+$/.test(username)) {
    return "Use letters, numbers and underscores only.";
  }
  if (/^[0-9]/.test(username)) return "Username must start with a letter or underscore.";
  const reserved = new Set([
    "chainmate",
    "admin",
    "system",
    "moderator",
    "support",
    "staff",
    "genlayer",
    "guest",
    "you",
    "ai",
    "chess",
    "official",
    "me",
    "search",
    "friends",
    /* Prevents accidental value-like names (e.g. a crash report pasted into
       the field, or mobile autocapitalize turning "undefined" into a name). */
    "undefined",
    "null",
    "none",
  ]);
  if (reserved.has(username.toLowerCase())) {
    return "That username is reserved.";
  }
  return null;
}
