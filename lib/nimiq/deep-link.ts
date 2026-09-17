/**
 * Nimiq Pay mini-app deep links — official formats from the Nimiq developer
 * docs (nimiq.dev/mini-apps, "Sharing Your Mini App"):
 *
 *   Custom scheme:  nimiqpay://miniapp?url=your-app.com
 *   HTTPS link:     https://nimpay.app/miniapps/open/your-app.com
 *
 * The HTTPS form is the safer default: it works from any browser (on a phone
 * it opens Nimiq Pay, on desktop it still resolves), while the custom scheme
 * only works where the OS has registered the handler.
 *
 * Client-safe module: reads window.location only.
 */

export interface NimiqPayDeepLinks {
  scheme: string;
  https: string;
}

/**
 * Deep links that open the CURRENT page inside Nimiq Pay (host + path —
 * e.g. chainmate-gg.vercel.app/tournaments/tour_123), or null outside a
 * browser (SSR).
 */
export function nimiqPayDeepLinks(): NimiqPayDeepLinks | null {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname === "/" ? "" : window.location.pathname;
  const target = `${window.location.host}${path}`;
  return {
    scheme: `nimiqpay://miniapp?url=${encodeURIComponent(target)}`,
    https: `https://nimpay.app/miniapps/open/${target}`,
  };
}
