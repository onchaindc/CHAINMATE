Country flags used by components/ui/country-flag.tsx.

One SVG per ISO 3166-1 alpha-2 code in lib/countries.ts. They are served as
static files rather than drawn with emoji: emoji flags are regional-indicator
letter pairs that only render as flags where the platform ships flag glyphs, and
Windows does not — desktop browsers drew two letters instead.

Source: country-flag-icons (3x2 set), MIT-licensed; the flag artwork itself is
public domain. Files were copied in, so the app carries no runtime dependency on
that package.

Adding a country: add it to COUNTRIES in lib/countries.ts and drop <CODE>.svg
here. A missing file is not fatal — the component falls back to an ISO-code chip.
