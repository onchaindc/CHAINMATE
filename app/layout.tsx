import type { Metadata } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import { ChallengeInbox } from "@/components/game/challenge-inbox";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { IdentityProvider } from "@/lib/identity-context";
import { THEME_SCRIPT } from "@/lib/theme";
import { BOARD_SCRIPT } from "@/lib/board-prefs";
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
  title: "ChainMate: Play chess. Think deeper.",
  description:
    "Competitive chess with intelligent analysis, AI commentary and post-game reports.",
  /* Every icon surface draws from the SAME official art: the SVG for
     browsers, PNGs for iOS/Android home screens and mini-app hosts (Nimiq
     Pay reads these sizes, not the SVG favicon). The webmanifest declares
     the app NAME so hosts render "ChainMate" as their own crisp text below
     the icon instead of the bitmap lettering blurring at small sizes. */
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* The app is dark-only; this just clears any legacy stored theme
            preference and stamps the dark class before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* Same reason, for the chosen board colours — a player who picked
            Walnut should never watch the default board repaint under them. */}
        <script dangerouslySetInnerHTML={{ __html: BOARD_SCRIPT }} />
      </head>
      <body
        className={`${inter.variable} ${fraunces.variable} ${jetbrainsMono.variable} font-sans min-h-screen flex flex-col bg-background text-foreground`}
      >
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        >
          {/* Ambient glow behind the page, straight from the palette. */}
          <div className="absolute inset-0 bg-[radial-gradient(1100px_480px_at_50%_-8%,hsl(var(--page-glow)/var(--page-glow-alpha)),transparent_62%)]" />
        </div>
        <IdentityProvider>
          <SiteNav />
          <main className="flex-1">{children}</main>
          <SiteFooter />
          {/* App-wide: a challenge is a live invitation, so it has to reach the
              player on whatever page they're on. */}
          <ChallengeInbox />
        </IdentityProvider>
      </body>
    </html>
  );
}
