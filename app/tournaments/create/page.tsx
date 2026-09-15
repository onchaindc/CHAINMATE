"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Coins, Loader2, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { ErrorNote } from "@/components/ui/states";
import { useIdentity } from "@/lib/identity-context";
import { tournamentApi } from "@/lib/tournament-api";
import type { TournamentFormat } from "@/lib/tournament-types";
import { cn } from "@/lib/utils";

/**
 * Host a tournament — one short form. Phase 2B: an optional exact NIM entry
 * fee turns the event into a PAID tournament with a prize pool built from
 * the verified entries and one of three fixed distribution presets. The
 * event is born in DRAFT; the host opens registration from its page.
 */

const FORMATS: { id: TournamentFormat; name: string; blurb: string }[] = [
  {
    id: "knockout",
    name: "Knockout",
    blurb: "Single elimination. Lose once and you're out; the bracket runs itself.",
  },
  {
    id: "swiss",
    name: "Swiss",
    blurb: "Everyone plays every round. Pair by standings, no eliminations.",
  },
  {
    id: "arena",
    name: "Arena",
    blurb: "Open play for the whole window. Play as many games as you like.",
  },
];

const TIME_CONTROLS = ["3 + 0", "5 + 0", "10 + 0", "15 + 10", "30 + 0"] as const;

const PRESETS: { id: "winner" | "top3" | "top5"; name: string; shares: string }[] = [
  { id: "winner", name: "Winner takes all", shares: "100%" },
  { id: "top3", name: "Top 3", shares: "60 / 25 / 15" },
  { id: "top5", name: "Top 5", shares: "45 / 25 / 15 / 10 / 5" },
];

export default function CreateTournamentPage() {
  const router = useRouter();
  const identity = useIdentity();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [format, setFormat] = useState<TournamentFormat>("swiss");
  const [timeControl, setTimeControl] = useState<string>("10 + 0");
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [swissRounds, setSwissRounds] = useState(5);
  const [entryFeeNim, setEntryFeeNim] = useState("");
  const [prizePreset, setPrizePreset] = useState<"winner" | "top3" | "top5">("winner");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paid = entryFeeNim.trim() !== "" && Number(entryFeeNim) > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await tournamentApi.create(
        {
          name: name.trim(),
          description: description.trim() || undefined,
          format,
          timeControl,
          maxPlayers,
          swissRounds: format === "swiss" ? swissRounds : undefined,
          ...(paid ? { entryFeeNim: entryFeeNim.trim(), prizePreset } : {}),
        },
        identity.playerId,
      );
      router.push(`/tournaments/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the tournament");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        eyebrow="Free to enter"
        title="Host a tournament"
        description="You'll be the host: open registration, lock, start, and finalise whenever you're ready."
      />

      <Panel className="animate-fade-in-up mt-8 [animation-delay:60ms]">
        <form
          className="space-y-5 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block">
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={60}
              placeholder="Friday Night Blitz"
              className="mt-1.5 w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50"
            />
          </label>

          <label className="block">
            <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Description <span className="font-normal normal-case tracking-normal">(optional)</span>
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="What makes this event worth showing up for?"
              className="mt-1.5 w-full resize-none rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50"
            />
          </label>

          <fieldset>
            <legend className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Format
            </legend>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFormat(f.id)}
                  aria-pressed={format === f.id}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-all",
                    format === f.id
                      ? "border-primary/50 bg-primary/5 shadow-[0_0_0_1px_hsl(var(--primary)/0.2)]"
                      : "border-border/70 hover:border-border",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Swords
                      className={cn("h-3.5 w-3.5", format === f.id ? "text-primary" : "text-muted-foreground")}
                      aria-hidden
                    />
                    {f.name}
                  </span>
                  <span className="mt-1 block text-2xs leading-relaxed text-muted-foreground">
                    {f.blurb}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-5 sm:grid-cols-2">
            <label className="block">
              <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Time control
              </span>
              <select
                value={timeControl}
                onChange={(e) => setTimeControl(e.target.value)}
                className="mt-1.5 w-full rounded-md border border-border/70 bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
              >
                {TIME_CONTROLS.map((tc) => (
                  <option key={tc} value={tc}>
                    {tc}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Player limit
              </span>
              <select
                value={maxPlayers}
                onChange={(e) => setMaxPlayers(Number(e.target.value))}
                className="mt-1.5 w-full rounded-md border border-border/70 bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
              >
                {[4, 8, 16, 32, 64].map((n) => (
                  <option key={n} value={n}>
                    {n} players
                  </option>
                ))}
              </select>
            </label>
          </div>

          {format === "swiss" && (
            <label className="block">
              <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Swiss rounds
              </span>
              <select
                value={swissRounds}
                onChange={(e) => setSwissRounds(Number(e.target.value))}
                className="mt-1.5 w-full rounded-md border border-border/70 bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary/50 sm:max-w-40"
              >
                {[3, 5, 7, 9, 11].map((n) => (
                  <option key={n} value={n}>
                    {n} rounds
                  </option>
                ))}
              </select>
            </label>
          )}

          <fieldset className="rounded-lg border border-border/70 p-4">
            <legend className="flex items-center gap-1.5 px-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Coins className="h-3 w-3" aria-hidden />
              Entry fee (optional)
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-2xs text-muted-foreground">
                  Leave empty for a free tournament
                </span>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={entryFeeNim}
                    onChange={(e) => setEntryFeeNim(e.target.value)}
                    placeholder="5"
                    className="w-full rounded-md border border-border/70 bg-background px-3 py-2 font-mono text-sm outline-none transition-colors focus:border-primary/50"
                  />
                  <span className="font-mono text-xs text-muted-foreground">NIM</span>
                </div>
              </label>
              <label className="block">
                <span className="text-2xs text-muted-foreground">Prize distribution</span>
                <select
                  value={prizePreset}
                  onChange={(e) => setPrizePreset(e.target.value as typeof prizePreset)}
                  disabled={!paid}
                  className="mt-1.5 w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none focus:border-primary/50 disabled:opacity-50"
                >
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.shares}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
              {paid
                ? "Players pay the exact fee in NIM to the treasury. The prize pool is built from verified payments only — every entry is verified on-chain before it counts."
                : "A free tournament needs no wallet — anyone can join."}
            </p>
          </fieldset>

          {error && <ErrorNote message={error} />}

          <div className="flex items-center justify-between gap-3 pt-1">
            <Link
              href="/tournaments"
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Cancel
            </Link>
            <Button type="submit" disabled={busy || name.trim().length < 2}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Create tournament
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
