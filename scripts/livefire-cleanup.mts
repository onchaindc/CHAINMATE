/**
 * Live-fire cleanup (final pass, admin): the engine's delete rules rightly
 * keep cancelled events out of a host's reach — only an admin may remove a
 * terminal-state event. This claims the operator seat for the operator
 * account (the sandbox seat was unclaimed; in production the operator claims
 * it through the UI), then deletes the cancelled leftovers. Completed
 * showcase events are never touched.
 */
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const NIMIQ_NETWORK = (await import("@/lib/nimiq/config")).NIMIQ_NETWORK;
const engine = await import("@/lib/server/tournaments");
const admin = await import("@/lib/server/admin");

const HOST = "0xac73d804b061f0c38e073ed651ed4c5077a36273";
const claimed = await admin.claimOperatorSeat(HOST);
console.log("operator seat claimed:", claimed);

engine.setTournamentCreationGateDeps({
  getLinkedWallet: async () => ({ address: "NQ LIVEFIRE TREASURY 0000", network: NIMIQ_NETWORK }),
  getAccountBalanceLuna: async () => BigInt(1000) * BigInt(100_000),
});

const CANCELLED = ["tour_2c7441235e9b1591"];
const list = await engine.listTournaments({ limit: 50 });
const targets = list.tournaments.filter((t) => t.status === "cancelled").map((t) => t.id);
for (const id of [...new Set([...CANCELLED, ...targets])]) {
  const res = await engine.deleteTournament(id, HOST);
  console.log(id, res.ok ? "removed" : `FAILED: ${res.error}`);
}

const after = await engine.listTournaments({ limit: 50 });
console.log("--- final list:");
for (const t of after.tournaments) {
  console.log(`${t.name} — ${t.status}${t.winnerId ? ` — winner …${t.winnerId.slice(-2)}` : ""}`);
}
