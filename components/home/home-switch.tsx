"use client";

import { Lobby } from "@/components/home/lobby";
import { useIdentity } from "@/lib/identity-context";

/**
 * Chooses what "/" is: the pitch, or the lobby.
 *
 * The marketing tree arrives as `children` rather than being imported here so
 * it stays a server component — Features and the GenLayer section are static
 * markup and have no business in the client bundle.
 *
 * While identity is resolving we render the landing page. Auth lives in
 * localStorage, so the prerendered HTML genuinely cannot know who is asking;
 * showing the pitch is the right answer for guests and crawlers, which is
 * almost everyone, and a signed-in player sees it for the one frame before the
 * identity effect runs. The already-shipped Hero resolves its own buttons the
 * same way, so this is the behaviour the app already has rather than a new one.
 */
export function HomeSwitch({ children }: { children: React.ReactNode }) {
  const identity = useIdentity();
  const showLobby =
    identity.status === "user" &&
    !identity.isGuest &&
    identity.username.trim().length > 0;

  return showLobby ? <Lobby /> : <>{children}</>;
}
