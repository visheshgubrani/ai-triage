/** The theme choice: read by the root layout (server) and written by the theme switch (client). */
export const THEME_COOKIE = "theme";
export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

export const parseTheme = (value: string | undefined): Theme =>
  THEMES.includes(value as Theme) ? (value as Theme) : "system";

/** The class on <html>: none for "system", which leaves it to prefers-color-scheme (globals.css). */
export const themeClass = (theme: Theme): string | undefined => (theme === "system" ? undefined : theme);
