"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarClock, Coins, Pencil, Swords, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackLink, PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
  /** Schedule — datetime-local string; empty means "open now". */
  const [startsAt, setStartsAt] = useState("");
  const [entryFeeNim, setEntryFeeNim] = useState("");
  const [prizePreset, setPrizePreset] = useState<"winner" | "top3" | "top5">("winner");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The order-confirmation review step before the create request fires. */
  const [reviewing, setReviewing] = useState(false);

  const paid = entryFeeNim.trim() !== "" && Number(entryFeeNim) > 0;

  const createNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const scheduled = startsAt ? new Date(startsAt).getTime() : null;
      if (startsAt && (!scheduled || Number.isNaN(scheduled))) {
        setError("Pick a valid date and time for the schedule (or clear it).");
        setBusy(false);
        return;
      }
      if (scheduled != null && scheduled <= Date.now()) {
        setError("The schedule must be in the future.");
        setBusy(false);
        return;
      }
      const { id } = await tournamentApi.create(
        {
          name: name.trim(),
          description: description.trim() || undefined,
          format,
          timeControl,
          maxPlayers,
          swissRounds: format === "swiss" ? swissRounds : undefined,
          scheduledStartAt: scheduled,
          ...(paid ? { entryFeeNim: entryFeeNim.trim(), prizePreset } : {}),
        },
        identity.playerId,
      );
      router.push(`/tournaments/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the tournament");
      setBusy(false);
      setReviewing(false);
    }
  };

  /** First tap opens the review; creation happens only on Confirm there. */
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim().length < 2) return;
    setReviewing(true);
  };

  const reviewRows: { label: string; value: string }[] = [
    { label: "Name", value: name.trim() },
    ...(description.trim() ? [{ label: "Description", value: description.trim() }] : []),
    { label: "Format", value: FORMATS.find((f) => f.id === format)?.name ?? format },
    { label: "Time control", value: timeControl },
    { label: "Player limit", value: `${maxPlayers} players` },
    ...(format === "swiss" ? [{ label: "Swiss rounds", value: `${swissRounds} rounds` }] : []),
    ...(startsAt
      ? [{ label: "Registration opens", value: new Date(startsAt).toLocaleString() }]
      : [{ label: "Registration", value: "Opens when you open it" }]),
    {
      label: "Entry fee",
      value: paid ? `${entryFeeNim.trim()} NIM per player` : "Free entry",
    },
    ...(paid
      ? [{
          label: "Prize distribution",
          value: PRESETS.find((p) => p.id === prizePreset)?.name ?? prizePreset,
        }]
      : []),
  ];

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6 lg:py-16">
      <BackLink href="/tournaments" className="mb-4">
        Back to tournaments
      </BackLink>
      <PageHeader
        eyebrow="Free to enter"
        title="Host a tournament"
        description="You'll be the host: open registration, lock, start, and finalise whenever you're ready."
      />

      <Panel className="animate-fade-in-up mt-8 [animation-delay:60ms]">
        <form
          className="space-y-5 p-5"
          onSubmit={submit}
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

          <label className="block">
            <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              <CalendarClock className="h-3 w-3" aria-hidden />
              Schedule <span className="font-normal normal-case tracking-normal">(optional)</span>
            </span>
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="mt-1.5 w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary/50 [color-scheme:dark] sm:max-w-xs"
            />
            <span className="mt-1 block text-2xs leading-relaxed text-muted-foreground">
              {startsAt
                ? `Registration opens automatically on ${new Date(startsAt).toLocaleString()}.`
                : "Leave empty to open registration yourself, right away."}
            </span>
          </label>

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
                      {p.name}: {p.shares}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
              {paid
                ? "Players pay the exact fee in NIM to the treasury. The prize pool is built from verified payments only; every entry is verified on-chain before it counts."
                : "A free tournament needs no wallet. Anyone can join."}
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
              <Pencil aria-hidden />
              Review &amp; create
            </Button>
          </div>
        </form>
      </Panel>

      {/* Order-confirmation review: every detail the host entered, shown once
          before the tournament exists. Confirm is the only path that fires. */}
      <ConfirmDialog
        open={reviewing}
        title="Confirm tournament"
        confirmLabel={busy ? "Creating…" : "Create tournament"}
        busy={busy}
        onCancel={() => {
          if (!busy) setReviewing(false);
        }}
        onConfirm={() => void createNow()}
      >
        <dl className="mt-1 space-y-2">
          {reviewRows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {row.label}
              </dt>
              <dd className="min-w-0 break-words text-right text-sm text-foreground/90">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        {paid && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-2 text-2xs leading-relaxed text-warning">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Paid event: every entrant pays the fee from their own wallet to the
            treasury. Once another player has paid, only a ChainMate
            administrator can delete this tournament.
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
