"use client";

import { RequireProfile } from "@/components/auth/require-profile";
import { Lobby } from "@/components/home/lobby";

/**
 * The player's lobby — where a signed-in player lands to play.
 *
 * This deliberately is not `/`. The landing page speaks for the product and has
 * to stay the front door for everyone, signed in or not; the lobby is the page
 * *after* it. So the marketing CTAs and the nav's Play link point here once
 * there is an account to show, and `/` never changes shape underneath anyone.
 *
 * Guests are sent to /auth: every panel on this page (rating, record, form,
 * challenges, friends) is an account's own data, and there is nothing to show
 * without one.
 */
export default function PlayPage() {
  return (
    <RequireProfile>
      <Lobby />
    </RequireProfile>
  );
}
