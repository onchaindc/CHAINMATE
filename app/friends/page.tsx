"use client";

import { Users } from "lucide-react";
import { RequireProfile } from "@/components/auth/require-profile";
import { BackLink, PageHeader } from "@/components/ui/page-header";
import { FriendsPanel } from "@/components/profile/friends-panel";
import { getStore } from "@/lib/store";
import { HostedGameStore } from "@/lib/store/hosted-store";

export default function FriendsPage() {
  return (
    <RequireProfile>
      <FriendsContent />
    </RequireProfile>
  );
}

function FriendsContent() {
  /* The panel loads its own data; RequireProfile above guarantees a real
     signed-in account before this renders. */
  const hostedStore = getStore("hosted") as HostedGameStore;

  return (
    <div className="shell px-4 py-12 sm:px-6 lg:py-14">
      <BackLink href="/profile">Back to profile</BackLink>
      <div className="mt-4">
        <PageHeader
          eyebrow="Your circle"
          eyebrowIcon={Users}
          title="Friends"
          description="Accept requests, manage your list, and find ChainMate players by username."
        />
      </div>
      <div className="mt-6">
        <FriendsPanel store={hostedStore} />
      </div>
    </div>
  );
}
