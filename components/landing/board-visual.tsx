const FEN = "r1bq1rk1/1pp2ppp/p1np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 8";

const GLYPHS: Record<string, string> = {
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
  K: "♔",
  Q: "♕",
  R: "♖",
  B: "♗",
  N: "♘",
  P: "♙",
};

function fenGrid(): (string | null)[][] {
  const rows: (string | null)[][] = [];
  const pieces = FEN.split(" ")[0].split("/");
  for (const row of pieces) {
    const cells: (string | null)[] = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) cells.push(null);
      } else {
        cells.push(ch);
      }
    }
    rows.push(cells);
  }
  return rows;
}

export function BoardVisual() {
  const grid = fenGrid();

  return (
    <div className="relative mx-auto w-full max-w-md">
      <div className="relative rounded-2xl border border-border/80 bg-card p-3 shadow-2xl shadow-black/50">
        <div className="grid aspect-square grid-cols-8 overflow-hidden rounded-lg">
          {grid.flatMap((row, r) =>
            row.map((piece, c) => {
              const dark = (r + c) % 2 === 1;
              return (
                <div
                  key={`${r}-${c}`}
                  className={`flex items-center justify-center text-[clamp(14px,4.2vw,30px)] leading-none select-none ${
                    dark ? "bg-board-dark" : "bg-board-light"
                  }`}
                >
                  {piece ? (
                    <span
                      className={piece === piece.toUpperCase() ? "text-zinc-900" : "text-zinc-950"}
                      style={{ textShadow: "0 1px 2px rgba(255,255,255,0.35)" }}
                    >
                      {GLYPHS[piece]}
                    </span>
                  ) : null}
                </div>
              );
            }),
          )}
        </div>
      </div>

      {/* Floating commentary card */}
      <div className="absolute -left-6 top-8 hidden w-56 rotate-[-3deg] rounded-xl border border-border bg-card/95 p-3 shadow-xl shadow-black/40 backdrop-blur sm:block">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-xs text-accent">
            ♞
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            AI commentary
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-foreground/90">
          &ldquo;White castles kingside, tucking the king behind a wall of pawns.&rdquo;
        </p>
      </div>

      {/* Floating on-chain chip */}
      <div className="absolute -right-4 bottom-10 hidden rotate-2 rounded-full border border-primary/40 bg-background/90 px-3 py-1.5 text-xs font-medium text-emerald-400 shadow-lg shadow-black/40 backdrop-blur sm:block">
        ● Move 12 validated on-chain
      </div>

      {/* Floating checkmate chip */}
      <div className="absolute -bottom-4 left-1/2 hidden -translate-x-1/2 rounded-full border border-accent/40 bg-background/90 px-3 py-1.5 text-xs font-medium text-accent shadow-lg shadow-black/40 backdrop-blur sm:block">
        ♔ Check — five validators agree
      </div>
    </div>
  );
}
