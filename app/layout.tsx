import type { Metadata, Viewport } from "next";
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

/* iOS Safari zooms the whole page whenever a focused control renders smaller
   than 16px — the tournament form uses text-sm (14px), so tapping the name
   field visibly zoomed the page instead of just raising the keyboard. A
   16px minimum on touch devices neutralizes it app-wide; desktop keeps its
   14px rhythm untouched (max-width: none matches every pointer there). */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /* Belt-and-suspenders against focus zoom: with the 16px input floor in CSS
     this is a no-op on healthy browsers, but it also stops double-tap zoom
     from disturbing the layout while typing on some Android skins. */
  maximumScale: 1,
  /* iOS Safari resizes the *visual viewport* (and rubber-bands the page) when
     the keyboard opens, unless the page opts into the in-page overlay mode.
     `resizes-content` keeps the layout viewport exactly as tall as the visible
     area, so focusing an input no longer scrolls/jumps the whole page. */
  interactiveWidget: "resizes-content",
};

export const metadata: Metadata = {
  title: "ChainMate: Play chess. Think deeper.",
  description:
    "Competitive chess with intelligent analysis and post-game reports.",
  /* Every icon surface draws from the SAME official art: the SVG for
     browsers, PNGs for iOS/Android home screens and mini-app hosts (Nimiq
     Pay reads these sizes, not the SVG favicon). The webmanifest declares
     the app NAME so hosts render "ChainMate" as their own crisp text below
     the icon instead of the bitmap lettering blurring at small sizes. */
  icons: {
    /* The ?v= suffix makes every surface a new URL whenever the official art
       is re-imported, so mini-app hosts (Nimiq Pay) and browsers re-fetch
       instead of showing a stale — previously blurry — cached render. */
    icon: [
      { url: "/favicon.svg?v=2", type: "image/svg+xml" },
      { url: "/icon-192.png?v=2", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png?v=2", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png?v=2",
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
