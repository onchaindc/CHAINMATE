import type { Metadata } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import { ChallengeInbox } from "@/components/game/challenge-inbox";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { IdentityProvider } from "@/lib/identity-context";
import { ThemeProvider } from "@/lib/theme-context";
import { THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

/* next/font downloads and self-hosts these at build time — no CDN request at
   runtime, and no layout shift from a late-arriving webfont. */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/* The display voice. Fraunces is a variable serif with an optical-size axis,
   so headings get real contrast against Inter instead of just more weight. */
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["SOFT", "WONK", "opsz"],
});

/* Clocks and ratings. Tabular by design, which is the whole point — a running
   clock must not reflow as digits change. */
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ChainMate — Play chess. Think deeper.",
  description:
    "Competitive chess with intelligent analysis. Every move validated by an intelligent contract on GenLayer, with AI commentary and post-game reports.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /* No `dark` class here any more — THEME_SCRIPT sets it before first paint
       from the stored preference, falling back to the OS setting.
       suppressHydrationWarning because that script legitimately mutates the
       class before React hydrates, and React would otherwise flag the diff. */
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body
        className={`${inter.variable} ${fraunces.variable} ${jetbrainsMono.variable} font-sans min-h-screen flex flex-col bg-background text-foreground`}
      >
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        >
          {/* Glow colour follows the theme rather than being a fixed gold
              rgba, which read as a dirty smudge on the light background. */}
          <div className="absolute inset-0 bg-[radial-gradient(1100px_480px_at_50%_-8%,hsl(var(--page-glow)/var(--page-glow-alpha)),transparent_62%)]" />
        </div>
        <ThemeProvider>
          <IdentityProvider>
            <SiteNav />
            <main className="flex-1">{children}</main>
            <SiteFooter />
            {/* App-wide: a challenge is a live invitation, so it has to reach the
                player on whatever page they're on. */}
            <ChallengeInbox />
          </IdentityProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
